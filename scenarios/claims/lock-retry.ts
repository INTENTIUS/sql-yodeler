import { copyFileSync, cpSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { clickhouseQuery, type ClickHouseEndpoint } from "@intentius/chant-lexicon-sql/clickhouse/http";
import { startKeeperCluster } from "../../test/e2e/keeper-cluster.js";
import { hold, Violation, type Claim, type Ctx } from "../lib/claim.js";
import { postgresSession } from "../lib/db.js";
import { run, type Ran } from "../lib/exec.js";
import { parse, Project } from "../lib/project.js";
import { addColumn, mainTable } from "../lib/schema.js";

/**
 * Postgres: a statement blocked behind another session's lock gives up at
 * the profile's lock_timeout (500 ms in the fixture) instead of queueing
 * everyone behind it, and is retried. Another session holds a SHARE lock
 * on the table until the ALTER TABLE has waited on it past one timeout;
 * the statement times out, is retried, and succeeds once the lock goes, and its history row says it hit the
 * timeout.
 * BREAK: the other session keeps its lock for the whole apply.
 */
async function retryPart(ctx: Ctx, p: Project): Promise<void> {
  addColumn(p, "note");
  const id = await p.newMigration("add-note");
  if (id === undefined) throw new Error("yodel new wrote no migration");
  await p.commit("add note");
  const gated = await p.apply();
  if (gated.ran.code !== 3) throw new Error(`yodel apply did not stop at the gate (exit ${String(gated.ran.code)})`);
  await p.approve(gated.doc.approve);

  const holder = await postgresSession();
  try {
    await holder.query("BEGIN");
    await holder.query(`LOCK TABLE ${ctx.db.name}.${mainTable(ctx)} IN SHARE MODE`);
    ctx.log("another session holds a SHARE lock on the table");
    // The Op's Apply step itself, with the approved digest, so the statement meets the lock while it is held.
    const applying = p.yodel(["apply", p.env, "--execute"], { env: { YODEL_APPROVED_PLAN: gated.doc.planDigest, YODEL_LOCK_RETRIES: "4" } });
    if (!ctx.broken) {
      // Let go once the ALTER TABLE has waited on the lock past one lock_timeout (500 ms), however slow the machine.
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const waiting = await ctx.db.count(`SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE 'ALTER TABLE%${ctx.db.name}.${mainTable(ctx)}%'`);
        if (waiting > 0) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      await new Promise((r) => setTimeout(r, 1_500));
      await holder.query("COMMIT");
      ctx.log("the other session let go");
    }
    const applied = await applying;
    hold(applied.code === 0, `the apply blocked behind the lock did not succeed (exit ${String(applied.code)})`);
    hold(/lock_timeout/.test(applied.err), "the apply never hit the lock timeout");
  } finally {
    await holder.query("COMMIT").catch(() => undefined);
    await holder.end();
  }
  hold(await ctx.db.columnExists(mainTable(ctx), "note"), "the column is not on the server");
  const retried = await ctx.db.count(`SELECT count(*) FROM ${ctx.db.history}.history WHERE migration_id = '${id}' AND kind = 'statement' AND status = 'succeeded' AND note LIKE 'lock_timeout%hit%'`);
  hold(retried === 1, "no succeeded statement row says it hit the lock timeout");
}

/**
 * What the serial part needs of a dialect: a way to keep the first apply
 * from finishing (so a second one meets it mid-run), the history's
 * statement rows, and the column on the server.
 */
interface Serial {
  /** Starts holding back whichever apply gets to its first statement first. */
  arm(): Promise<void>;
  /** Whether the first apply is held mid-run. */
  firstIn(): Promise<boolean>;
  /** Whether both applies are past reading the history (each about to send, or sending, the same statements): only possible with no lock. */
  bothIn(): Promise<boolean>;
  release(): Promise<void>;
  /** The history's highest seq. */
  maxSeq(): Promise<number>;
  /** How many `started` rows each statement has among the rows after seq `after`, as `<migration> <index>: <n>`. */
  started(after: number): Promise<string[]>;
  columnExists(column: string): Promise<boolean>;
}

/** Postgres: a SHARE lock on the table blocks the ALTER TABLE, after its `started` row is written. */
function postgresSerial(ctx: Ctx): Serial {
  let holder: Awaited<ReturnType<typeof postgresSession>> | undefined;
  const table = `${ctx.db.name}.${mainTable(ctx)}`;
  const waiting = () => ctx.db.count(`SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE 'ALTER TABLE%${table}%'`);
  return {
    async arm() {
      holder = await postgresSession();
      await holder.query("BEGIN");
      await holder.query(`LOCK TABLE ${table} IN SHARE MODE`);
    },
    firstIn: async () => (await waiting()) >= 1,
    bothIn: async () => (await waiting()) >= 2,
    async release() {
      await holder?.query("COMMIT").catch(() => undefined);
      await holder?.end().catch(() => undefined);
      holder = undefined;
    },
    maxSeq: async () => ctx.db.count(`SELECT coalesce(max(seq), 0) FROM ${ctx.db.history}.history`),
    started: async (after) =>
      (await ctx.db.scalar(`SELECT coalesce(string_agg(line, ',' ORDER BY line), '') FROM (SELECT migration_id || ' ' || statement_index || ': ' || count(*) AS line FROM ${ctx.db.history}.history WHERE seq > ${String(after)} AND kind = 'statement' AND status = 'started' GROUP BY migration_id, statement_index) s`))
        .split(",")
        .filter(Boolean),
    columnExists: (column) => ctx.db.columnExists(mainTable(ctx), column),
  };
}

/**
 * ClickHouse: the project reaches its server (a replica of a scratch
 * cluster with Keeper) through a proxy here, which, once armed, holds back
 * every write to the history until it is released. The first apply's first
 * row waits there, after it has read the history; a second apply that read
 * it too (only possible with no lock) counts as both in.
 */
async function clickhouseSerial(ctx: Ctx, server: ClickHouseEndpoint): Promise<Serial & { url: string; close(): Promise<void> }> {
  let armed = false;
  let reads = 0;
  let held = 0;
  let open: (() => void) | undefined;
  let gate = Promise.resolve();
  const historyWrite = new RegExp(String.raw`INSERT INTO\s+\S*${ctx.db.history}\S*\.\S*history\b`, "i");
  const historyRead = new RegExp(String.raw`FROM\s+\S*${ctx.db.history}\S*\.\S*history\s+ORDER BY seq`, "i");
  const proxy: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const body = Buffer.concat(chunks);
        const url = new URL(req.url ?? "/", "http://proxy");
        const sql = `${url.searchParams.get("query") ?? ""}\n${body.toString("utf8")}`;
        if (armed && historyRead.test(sql)) reads += 1;
        if (armed && historyWrite.test(sql)) {
          held += 1;
          await gate;
        }
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && !["host", "content-length", "connection"].includes(k)) headers[k] = v;
        try {
          const answer = await fetch(`${server.url}${url.pathname}${url.search}`, { method: req.method ?? "GET", headers, ...(req.method === "POST" ? { body } : {}) });
          const text = Buffer.from(await answer.arrayBuffer());
          res.writeHead(answer.status, { "content-type": answer.headers.get("content-type") ?? "text/plain" });
          res.end(text);
        } catch (e) {
          res.writeHead(502);
          res.end(String(e));
        }
      })();
    });
  });
  await new Promise<void>((ok) => proxy.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${String((proxy.address() as AddressInfo).port)}`;
  const q = (sql: string) => clickhouseQuery(server, sql);
  return {
    url,
    arm() {
      reads = 0;
      held = 0;
      gate = new Promise<void>((ok) => (open = ok));
      armed = true;
      return Promise.resolve();
    },
    firstIn: () => Promise.resolve(held >= 1),
    bothIn: () => Promise.resolve(reads >= 2),
    release() {
      armed = false;
      open?.();
      return Promise.resolve();
    },
    maxSeq: async () => Number((await q(`SELECT max(seq) AS n FROM ${ctx.db.history}.history`))[0]?.n ?? 0),
    started: async (after) =>
      (await q(`SELECT concat(migration_id, ' ', toString(statement_index), ': ', toString(count())) AS line FROM ${ctx.db.history}.history WHERE seq > ${String(after)} AND kind = 'statement' AND status = 'started' GROUP BY migration_id, statement_index ORDER BY line`)).map((r) => String(r.line)),
    columnExists: async (column) => Number((await q(`SELECT count() AS n FROM system.columns WHERE database = '${ctx.db.name}' AND table = '${mainTable(ctx)}' AND name = '${column}'`))[0]?.n ?? 0) === 1,
    async close() {
      open?.();
      await new Promise<void>((ok) => proxy.close(() => { ok(); }));
    },
  };
}

/**
 * Under BREAK, yodel with the lock taken out: the project's yodel copied,
 * its engine's lock acquisition replaced by a lock that holds nothing.
 */
function brokenBuild(ctx: Ctx, p: Project): string[] {
  const pkg = realpathSync(p.path("node_modules", "@intentius", "sql-yodeler"));
  const root = join(ctx.work, "yodel-without-lock");
  mkdirSync(root, { recursive: true });
  cpSync(join(pkg, "dist"), join(root, "dist"), { recursive: true });
  copyFileSync(join(pkg, "package.json"), join(root, "package.json"));
  symlinkSync(p.path("node_modules"), join(root, "node_modules"));
  const engine = join(root, "dist", "versioned", "engine.js");
  const text = readFileSync(engine, "utf8");
  const nothing = `({ kind: "local", owner: "no lock", where: "no lock (a build with it taken out)", heartbeat: async () => {}, release: async () => {} })`;
  const patched = text.replace(/await venv\.driver\.acquireLock\((holder|appliedBy\(options\.processEnv\))\)/, nothing);
  if (patched === text) throw new Error(`the lock acquisition is not in ${engine}; the broken build cannot take it out`);
  writeFileSync(engine, patched);
  ctx.log("BREAK: yodel built without the apply lock");
  return ["node", join(root, "dist", "bin.js")];
}

interface ExecuteDoc {
  status?: string;
  applied?: string[];
  stoodDown?: string;
  lock?: { kind?: string; waited?: { ms: number; heldBy: string } };
}

const doc = (ran: Ran): ExecuteDoc => {
  try {
    return parse<ExecuteDoc>(ran);
  } catch {
    return {};
  }
};

/**
 * Two applies of the same approved plan at once never send a statement
 * twice: the second waits for the lock (--lock-wait), naming who holds it,
 * and, once it has it, finds the migration applied and sends nothing; the
 * wait is in its JSON. A third, with --stand-down, while the lock is still
 * held and main on origin has a newer commit, applies nothing and exits 0 at
 * once instead of waiting. The first apply is held mid-run (Postgres: a
 * SHARE lock on the table blocks its statement; ClickHouse: its history
 * writes are held back), the second starts then, and the first goes on once
 * the second is seen waiting, or seen running too.
 * BREAK: both run a build of yodel with the lock taken out; the history
 * shows each statement started twice.
 */
async function serialPart(ctx: Ctx, p: Project, s: Serial): Promise<void> {
  addColumn(p, "serial");
  const id = await p.newMigration("add-serial");
  if (id === undefined) throw new Error("yodel new wrote no migration");
  await p.commit("add serial");
  const gated = await p.apply();
  if (gated.ran.code !== 3) throw new Error(`yodel apply did not stop at the gate (exit ${String(gated.ran.code)})`);
  await p.approve(gated.doc.approve);

  // main on origin a commit ahead of this checkout: a newer commit whose own apply would apply the environment.
  const origin = join(ctx.work, "origin.git");
  const bare = await run("git", ["init", "-q", "--bare", "-b", "main", origin], { cwd: ctx.work });
  if (bare.code !== 0) throw new Error("git init --bare failed");
  await p.git("remote", "add", "origin", origin);
  await p.git("commit", "-q", "--allow-empty", "-m", "a newer commit");
  await p.git("push", "-q", "origin", "main");
  await p.git("reset", "-q", "--hard", "HEAD~1");

  const bin = ctx.broken ? brokenBuild(ctx, p) : undefined;
  const env = { YODEL_APPROVED_PLAN: gated.doc.planDigest, YODEL_LOCK_RETRIES: "8" };
  let said = "";
  const execute = (extra: string[] = []) =>
    p.yodel(["apply", p.env, "--execute", "--json", "--lock-wait", "2m", ...extra], { env, timeoutMs: 300_000, onOutput: (c) => (said += c), ...(bin ? { bin } : {}) });

  const before = await s.maxSeq();
  await s.arm();
  let both: Promise<Ran[]> | undefined;
  let third: Ran;
  try {
    ctx.log("two applies of the same approved plan, the second once the first is held mid-run");
    const first = execute();
    for (let i = 0; i < 600 && !(await s.firstIn()); i++) await new Promise((r) => setTimeout(r, 100));
    both = Promise.all([first, execute()]);
    const deadline = Date.now() + 60_000;
    let seen = "";
    while (Date.now() < deadline) {
      if (/lock: held by /.test(said)) seen = "an apply waiting for the lock";
      else if (await s.bothIn()) seen = "both applies past reading the history";
      if (seen) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    ctx.log(seen ? `seen: ${seen}` : "seen neither an apply waiting nor both running, after 60 s");
    third = await p.yodel(["apply", p.env, "--execute", "--json", "--lock-wait", "2m", "--stand-down"], { env, timeoutMs: 60_000, ...(bin ? { bin } : {}) });
  } finally {
    await s.release();
  }
  const [a, b] = await both;
  if (!a || !b) throw new Error("the two applies did not both finish");

  // The history first: what the lock is for.
  const started = await s.started(before);
  ctx.log(`started rows per statement since the two applies began: ${started.join(", ")}`);
  const twice = started.filter((l) => !l.endsWith(": 1"));
  hold(twice.length === 0, `a statement was started more than once (${twice.join(", ")}): two applies sent it`);
  hold(started.some((l) => l.startsWith(`${id} `)), `the history has no statement of ${id} started`);
  hold(a.code === 0 && b.code === 0, `the two applies exited ${String(a.code)} and ${String(b.code)}`);
  const docs = [doc(a), doc(b)];
  const applier = docs.find((d) => d.applied?.includes(id));
  const waiter = docs.find((d) => d !== applier);
  hold(applier !== undefined && waiter?.applied?.length === 0, `not one apply applied ${id} and the other nothing: ${JSON.stringify(docs.map((d) => d.applied))}`);
  if (ctx.dialect === "ch") hold(docs.every((d) => d.lock?.kind === "keeper"), `the applies did not lock in Keeper: ${JSON.stringify(docs.map((d) => d.lock?.kind))}`);
  const waited = waiter.lock?.waited;
  hold(waited !== undefined && waited.ms > 0 && waited.heldBy !== "", `the waiting apply's JSON records no wait: ${JSON.stringify(waiter.lock)}`);
  hold(said.includes(`lock: held by ${waited.heldBy}`), `the waiting apply did not say who held the lock (${waited.heldBy})`);
  hold(await s.columnExists("serial"), "the column is not on the server");

  // The third stood down at once, while the lock was held, and applied nothing.
  const stood = doc(third);
  hold(third.code === 0 && stood.status === "stood-down", `yodel apply --stand-down exited ${String(third.code)} (${String(stood.status)}) with a newer commit on origin`);
  hold(/standing down: main on origin is at/.test(third.err + third.out), "yodel apply --stand-down did not say why it stood down");
}

/** The fixture's project with its first migration applied: what both parts build on. */
async function created(ctx: Ctx, p: Project): Promise<Project> {
  await p.newMigration("create");
  if ((await p.approvedApply()).ran.code !== 0) throw new Error("the first migration did not apply");
  return p;
}

/**
 * Each part on its own: under BREAK each breaks its own property, and the
 * run is caught only when every part catches it.
 */
async function parts(ctx: Ctx, list: Array<[string, () => Promise<void>]>): Promise<void> {
  const caught: string[] = [];
  for (const [name, part] of list) {
    try {
      await part();
    } catch (e) {
      if (!(ctx.broken && e instanceof Violation)) throw e;
      ctx.log(`${name} caught: ${e.message}`);
      caught.push(e.message);
    }
  }
  if (ctx.broken && caught.length === list.length) throw new Violation(caught.join("; "));
  if (ctx.broken) ctx.log(`only ${String(caught.length)} of the ${String(list.length)} parts caught their break`);
}

async function postgresBody(ctx: Ctx): Promise<void> {
  const p = await created(ctx, await Project.create(ctx));
  await parts(ctx, [
    ["retry", () => retryPart(ctx, p)],
    ["serial", () => serialPart(ctx, p, postgresSerial(ctx))],
  ]);
}

/** ClickHouse: the serial part on a scratch cluster with Keeper, so the lock is the KeeperMap row. */
async function clickhouseBody(ctx: Ctx): Promise<void> {
  const cluster = await startKeeperCluster("yodel-lock-retry");
  try {
    const s = await clickhouseSerial(ctx, cluster.replicas[0]);
    try {
      const p = await Project.create(ctx);
      p.edit("chant.config.ts", /url: process\.env\.YODEL_CLAIMS_CLICKHOUSE_URL \?\? "[^"]*"/, `url: "${s.url}"`);
      await p.commit("the server: a replica with Keeper, through the claim's proxy");
      await created(ctx, p);
      await parts(ctx, [["serial", () => serialPart(ctx, p, s)]]);
    } finally {
      await s.close();
    }
  } finally {
    await cluster.stop();
  }
}

export const lockRetry: Claim = {
  name: "lock-retry",
  says:
    "Postgres: a statement blocked behind another session's lock times out at lock_timeout and is retried until it succeeds; " +
    "Postgres and ClickHouse with Keeper: two applies at once never send a statement twice, the second waits naming the holder, and --stand-down steps aside for a newer commit",
  dialects: { ch: clickhouseBody, pg: postgresBody },
  shares: ["docker-cluster"],
  stallMinutes: 10,
};
