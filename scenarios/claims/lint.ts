import { copyFileSync, cpSync, mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hold, runParts, type Claim, type Ctx } from "../lib/claim.js";
import { parse, Project } from "../lib/project.js";
import { addColumn, addTable, mainTable } from "../lib/schema.js";

interface Lint {
  p: Project;
  /** The second migration, adding a column; the fork part sets it aside. */
  note?: string;
}

/**
 * The replay check: `yodel lint --replay <env>` applies every migration in
 * order into a fresh database on the env's server and compares each with
 * the schema it recorded; it passes for migrations yodel new wrote, and
 * leaves no replayed database behind.
 * BREAK: a migration's statement is edited (in migration.json and
 * migration.sql alike, its checksum updated with --update-checksum), so it
 * no longer makes the schema it recorded.
 */
export async function replayPart(ctx: Ctx, s: Lint): Promise<void> {
  const { p } = s;
  await p.newMigration("create");
  addColumn(p, "note");
  const id = await p.newMigration("add-note");
  if (id === undefined) throw new Error("yodel new wrote no migration");
  s.note = id;
  if (ctx.broken) {
    const [from, to] = ctx.dialect === "ch" ? ["note String DEFAULT ''", "nope String DEFAULT ''"] : ["note text", "nope text"];
    p.edit(`migrations/${id}/migration.json`, from, to);
    p.edit(`migrations/${id}/migration.sql`, from, to);
    const updated = await p.yodel(["lint", "--update-checksum", id]);
    if (updated.code === 1) throw new Error(`yodel lint --update-checksum ${id} exited 1`);
  }
  await p.commit("two migrations");

  const ran = await p.yodel(["lint", "--replay", p.env, "--json"], { timeoutMs: 600_000 });
  hold(ran.code === 0, `yodel lint --replay exited ${String(ran.code)}: ${JSON.stringify(parse<unknown>(ran)).slice(0, 300)}`);
  const doc = JSON.stringify(parse<unknown>(ran));
  hold(!doc.includes(`"replay"`) || !/"rule":\s*"replay"/.test(doc), "the replay reported a finding");
  hold(!(await ctx.db.tableExists(ctx.dialect === "ch" ? "events" : "orders")), `the replayed ${ctx.db.name} was left on the server`);
}

/**
 * `yodel lint`, as a CI job runs it on a pull request: two branches each
 * added a migration after the same one, and both merged. Lint, offline,
 * exits 3 (an error) with a fork finding naming both migrations; nothing is
 * sent to the server. With only one of them it exits 0.
 * BREAK: only one of the two migrations is there, so there is no fork.
 */
export async function forkPart(ctx: Ctx, s: Lint): Promise<void> {
  const { p } = s;
  const a = s.note;
  if (a === undefined) throw new Error("the replay part wrote no second migration");
  // The column's migration goes on a branch of its own; the other branch adds a table after the same parent.
  const aside = join(ctx.work, "aside");
  p.moveMigration(a, aside);
  addTable(p, "audit");
  const b = await p.newMigration("add-audit");
  if (b === undefined) throw new Error("yodel new wrote no migration");
  const one = await p.yodel(["lint", "--json"]);
  if (one.code !== 0) throw new Error(`yodel lint fails one branch on its own (exit ${String(one.code)})`);
  // Both pull requests merged: the one set aside comes back, following the same parent as b.
  if (!ctx.broken) renameSync(aside, p.path("migrations", a));
  await p.commit("two branches merged");

  const ran = await p.yodel(["lint", "--json"], {
    env: { YODEL_CLAIMS_CLICKHOUSE_URL: "http://127.0.0.1:9", YODEL_CLAIMS_POSTGRES_URL: "postgres://127.0.0.1:9/postgres" },
  });
  hold(ran.code === 3, `yodel lint exited ${String(ran.code)}, not 3, on a directory with a fork`);
  const doc = JSON.stringify(parse<unknown>(ran));
  hold(doc.includes("fork") && doc.includes(a) && doc.includes(b), "yodel lint's findings do not name the fork and both its migrations");
  hold(!(await ctx.db.tableExists(ctx.dialect === "ch" ? "events" : "orders")), "lint changed the server");
}

/**
 * `yodel checkpoint` (#63), on a chain of two migrations yodel new wrote:
 * a checkpoint after the newest migration creates
 * its recorded schema from nothing. `yodel lint --replay` replays the chain,
 * then the checkpoint alone into an empty database, and both give that
 * schema. A fresh environment then applies the checkpoint only, skips the
 * migrations before it, and ends with no drift from the recorded schema:
 * the schema an environment that ran the chain has.
 * BREAK: the checkpoint's CREATE TABLE is edited (a column's type, in
 * migration.json and migration.sql alike, its checksum updated), so it no
 * longer creates the schema it records.
 */
export async function checkpointPart(ctx: Ctx, s: Lint): Promise<void> {
  const { p } = s;
  // The parts before leave two branches, and under BREAK an edited migration: the checkpoint's chain is the first migration and one yodel new writes now.
  for (const id of p.migrationIds()) if (p.migration(id).parent !== null) p.removeMigration(id);
  if ((await p.newMigration("note-and-audit")) === undefined) throw new Error("yodel new wrote no migration");
  const before = p.migrationIds();
  const wrote = await p.yodel(["checkpoint", "base", "--json"]);
  if (wrote.code !== 0) throw new Error(`yodel checkpoint exited ${String(wrote.code)}: ${wrote.err}`);
  const cp = parse<{ id: string }>(wrote).id;
  if (ctx.broken) {
    const doc = JSON.parse(p.read(`migrations/${cp}/migration.json`)) as { steps: Array<{ kind: string; sql?: string }> };
    const [from, to] = ctx.dialect === "ch" ? ["UInt64", "UInt32"] : ["bigint", "integer"];
    const step = doc.steps.find((x) => x.kind === "statement" && x.sql?.includes("CREATE TABLE") && x.sql.includes(from));
    if (!step?.sql) throw new Error(`the checkpoint ${cp} has no CREATE TABLE with ${from}`);
    const old = step.sql;
    step.sql = old.replace(from, to);
    p.write(`migrations/${cp}/migration.json`, `${JSON.stringify(doc, null, 2)}\n`);
    p.edit(`migrations/${cp}/migration.sql`, old, step.sql);
    const updated = await p.yodel(["lint", "--update-checksum", cp]);
    if (updated.code === 1) throw new Error(`yodel lint --update-checksum ${cp} exited 1`);
  }
  await p.commit("a checkpoint");

  const replay = await p.yodel(["lint", "--replay", p.env, "--json"], { timeoutMs: 600_000 });
  hold(replay.code === 0, `yodel lint --replay exited ${String(replay.code)} with the checkpoint ${cp}: ${JSON.stringify(parse<unknown>(replay)).slice(0, 400)}`);
  const replayed = parse<{ replay?: { matched?: Array<{ id: string; checkpoint?: boolean }> } }>(replay).replay?.matched ?? [];
  hold(replayed.some((m) => m.id === cp && m.checkpoint === true), `the replay did not replay the checkpoint ${cp} on its own`);

  // A fresh environment: it starts at the checkpoint.
  const applied = await p.stepsApply();
  hold(applied.code === 0, `yodel apply on a fresh environment exited ${String(applied.code)}: ${applied.err.slice(0, 300)}`);
  const status = (await p.yodel(["status", p.env, "--json"])).out;
  const doc = JSON.parse(status.slice(status.indexOf("{"))) as { applied: Array<{ id: string }>; skipped?: Array<{ id: string; reason: string }> };
  hold(doc.applied.map((a) => a.id).join() === cp, `the fresh environment applied ${doc.applied.map((a) => a.id).join(", ")}, not the checkpoint ${cp} alone`);
  hold((doc.skipped ?? []).map((k) => k.id).sort().join() === before.join(), `the fresh environment did not skip the migrations before the checkpoint: ${JSON.stringify(doc.skipped)}`);
  const drift = await p.yodel(["drift", p.env, "--json"]);
  hold(drift.code === 0, `yodel drift after starting from the checkpoint exited ${String(drift.code)}: the environment is not at the recorded schema`);
}

/** A backfill module (one batch) filling label, and the hand-written statements that undo it. */
function labelData(ctx: Ctx): { module: string; undo: string } {
  const db = ctx.db.name;
  const [fill, undo] =
    ctx.dialect === "ch"
      ? [`ALTER TABLE ${db}.events UPDATE label = kind WHERE 1`, `-- the label backfill, undone\nALTER TABLE ${db}.events UPDATE label = '' WHERE 1;\n`]
      : [`UPDATE ${db}.orders SET label = status`, `-- the label backfill, undone\nUPDATE ${db}.orders SET label = NULL;\n`];
  const module = `import { EffectReceipt } from "@intentius/chant";
import { Op, activity, effect, phase } from "@intentius/chant/op";

export const op = Op({
  name: "backfill-label",
  overview: "label from the row",
  phases: [phase("Backfill", [effect(EffectReceipt("label-all", { effect: "label/all", flavor: "existence" }), [activity("yodelSql", { sql: ${JSON.stringify(fill)}${ctx.dialect === "ch" ? `, settings: { mutations_sync: "2" }` : ""} }, "atMostOnce")])])],
});
`;
  return { module, undo };
}

/**
 * `yodel revert` (#55), compared through the recorded schemas, on a fresh
 * environment that starts from a checkpoint: the chain is the first
 * migration, one yodel new writes, a checkpoint, and a newest migration that
 * adds a column and fills it with a backfill (a data step); applying it runs
 * the checkpoint and that migration. yodel revert, with
 * a hand-written revert step undoing the fill, stops at the migrations Op's
 * gate (exit 3); after chant approve of the digest it printed, it runs:
 * the column is gone, yodel status shows the migration pending and
 * reverted, and yodel drift finds the environment at its parent's recorded
 * schema, the checkpoint's. Reverting the checkpoint itself, or a migration
 * before it (which this environment never ran), is refused (exit 4),
 * naming the checkpoint.
 * BREAK: the hand-written revert step is left out, so the data step cannot
 * be undone and the revert refuses.
 */
export async function revertPart(ctx: Ctx, s: Lint): Promise<void> {
  const { p } = s;
  // The parts before leave two branches, an applied checkpoint, and under BREAK edited migrations: this part starts from the first migration, on an empty server.
  for (const id of p.migrationIds()) if (p.migration(id).parent !== null) p.removeMigration(id);
  await ctx.db.reset();
  const before = await p.newMigration("note-and-audit");
  if (before === undefined) throw new Error("yodel new wrote no migration");
  const wrote = await p.yodel(["checkpoint", "base", "--json"]);
  if (wrote.code !== 0) throw new Error(`yodel checkpoint exited ${String(wrote.code)}: ${wrote.err}`);
  const cp = parse<{ id: string }>(wrote).id;
  addColumn(p, "label");
  const { module, undo } = labelData(ctx);
  p.write("backfills/label.ts", module);
  const id = await p.newMigration("label", ["--backfill", "backfills/label.ts"]);
  if (id === undefined) throw new Error("yodel new wrote no migration");
  await p.commit("a migration with a data step");
  await p.setupApply();

  const step = ctx.broken ? [] : ["--step", "revert-label.sql"];
  if (!ctx.broken) p.write("revert-label.sql", undo);
  await p.commit("its revert step");
  const gated = await p.yodel(["revert", p.env, id, "--json", ...step], { timeoutMs: 600_000 });
  hold(gated.code === 3, `yodel revert ${p.env} ${id} exited ${String(gated.code)}, not 3 at the gate: ${gated.err.split("\n").filter((l) => l.startsWith("yodel revert")).join(" ").slice(0, 300)}`);
  await p.approve(parse<{ approve?: string }>(gated).approve);
  const ran = await p.yodel(["revert", p.env, id, "--json", ...step], { timeoutMs: 600_000 });
  hold(ran.code === 0, `yodel revert after approval exited ${String(ran.code)}`);

  hold(!(await ctx.db.columnExists(mainTable(ctx), "label")), `the revert left the column label on ${mainTable(ctx)}`);
  const status = parse<{ applied: Array<{ id: string }>; pending: Array<{ id: string; reverted?: unknown }> }>(await p.yodel(["status", p.env, "--json"]));
  hold(!status.applied.some((a) => a.id === id) && status.pending.some((x) => x.id === id && x.reverted !== undefined), `yodel status does not show ${id} reverted`);
  const drift = await p.yodel(["drift", p.env, "--json"]);
  hold(drift.code === 0, `yodel drift after the revert exited ${String(drift.code)}: the environment is not at the parent's recorded schema`);

  // The checkpoint is now the newest migration applied here, and the one before it never ran: neither can be reverted.
  for (const target of [cp, before]) {
    const refused = await p.yodel(["revert", p.env, target, "--dry-run"]);
    hold(refused.code === 4 && refused.err.includes(cp), `yodel revert ${target} exited ${String(refused.code)}, not 4 naming the checkpoint ${cp}: ${refused.err.slice(0, 300)}`);
  }
}

/**
 * Under BREAK, yodel with its expectations taken out: the project's yodel
 * copied, its expectationFailure made to find nothing, so every assertion
 * holds.
 */
function withoutExpectations(ctx: Ctx, p: Project): string[] {
  ctx.log("BREAK: yodel built without its expectations");
  return patchedYodel(ctx, p, "yodel-without-expectations", (text) => text.replace(/export function expectationFailure\(e, outcome\) \{/, "$& return undefined;"));
}

/**
 * ClickHouse's break of the test part: yodel test built to leave a
 * rebuild's partition receipts to the server's shared receipts table, as
 * before #112, instead of each case's own store.
 */
function sharedRebuildReceipts(ctx: Ctx, p: Project): string[] {
  ctx.log("BREAK: yodel test built to keep the rebuild's receipts in the server's shared receipts table");
  return patchedYodel(ctx, p, "yodel-shared-rebuild-receipts", (text) => text.replace("await driver.opStep(m, i, { receipts })", "await driver.opStep(m, i)"));
}

/** A copy of the project's yodel with dist/testing/run.js patched; the command that runs it. */
function patchedYodel(ctx: Ctx, p: Project, name: string, patch: (text: string) => string): string[] {
  const pkg = realpathSync(p.path("node_modules", "@intentius", "sql-yodeler"));
  const root = join(ctx.work, name);
  mkdirSync(root, { recursive: true });
  cpSync(join(pkg, "dist"), join(root, "dist"), { recursive: true });
  cpSync(join(pkg, "schemas"), join(root, "schemas"), { recursive: true });
  copyFileSync(join(pkg, "package.json"), join(root, "package.json"));
  symlinkSync(p.path("node_modules"), join(root, "node_modules"));
  const file = join(root, "dist", "testing", "run.js");
  const text = readFileSync(file, "utf8");
  const patched = patch(text);
  if (patched === text) throw new Error(`${file} did not take the patch; the broken build cannot be made`);
  writeFileSync(file, patched);
  return ["node", join(root, "dist", "bin.js")];
}

interface TestDoc {
  summary?: { passed: number; failed: number; errors: number };
  cases?: Array<{ name: string; status: string; failures: string[]; error?: string; after: string[] }>;
}

/**
 * `yodel test` (#54) on the replayed database: tests/label.test.ts in the
 * project, on the chain the revert part left (the first migration,
 * note-and-audit, a checkpoint, then label with its backfill), on a server
 * emptied of the claim's database and history. Three cases: rows seeded
 * after note-and-audit have label filled by the backfill once label runs; a
 * row the table cannot hold is refused (a schema-object case, on the
 * newest schema); and a case that says label stays empty, which must fail.
 * yodel test exits 3 with exactly that case failed, writes the JUnit file
 * with one failure, and leaves no database behind. Then, with the
 * migrations applied to the environment, yodel test refuses it (exit 4),
 * since it has a history, and the table stays.
 *
 * On ClickHouse the chain ends with a sort-key change, a ClickHouseRebuildOp
 * step (#112), and two more cases seed different rows after label, before
 * the same rebuild: each sees its own rows, every one, after it, and the
 * run writes no rebuild receipt to the server's receipts table, since each
 * case keeps its receipts to itself.
 *
 * BREAK: on Postgres, yodel is built with its expectations taken out, so
 * the case that should fail holds. On ClickHouse, yodel test is built to
 * leave the rebuild's receipts to the server's shared table, so the run
 * writes them there.
 */
export async function testPart(ctx: Ctx, s: Lint): Promise<void> {
  const { p } = s;
  await ctx.db.reset();
  const ids = p.migrationIds();
  const at = ids.find((id) => id.endsWith("-note-and-audit"));
  const label = ids.find((id) => id.endsWith("-label"));
  if (at === undefined || label === undefined) throw new Error(`the revert part left no note-and-audit and label migrations: ${ids.join(", ")}`);
  const db = ctx.db.name;
  const ch = ctx.dialect === "ch";
  if (ch) {
    // The same rebuild after label for every case (#112).
    p.edit("src/schema.ts", "ORDER BY (kind, ts)", "ORDER BY (ts, kind)");
    const rekey = await p.newMigration("rekey");
    if (rekey === undefined) throw new Error("yodel new wrote no migration for the sort-key change");
    const steps = p.migration(rekey).steps;
    if (!steps.some((st) => st.kind === "op" && st.op === "ClickHouseRebuildOp")) throw new Error(`the sort-key change is not a ClickHouseRebuildOp step: ${JSON.stringify(steps)}`);
  }
  // Rows in two monthly partitions, different in each case.
  const rows = (ids: number[]) => `INSERT INTO ${db}.events (id, kind, ts) VALUES ${ids.map((id, i) => `(${String(id)}, 'k', now() - toIntervalDay(${String(i % 2 === 0 ? 0 : 35)}))`).join(", ")}`;
  const rebuildCases = (ids: number[], n: number) => ({
    name: `the rebuild copies case ${String(n)}'s rows`,
    at: label,
    seed: [rows(ids)],
    expect: [{ kind: "rows", sql: `SELECT id FROM ${db}.events ORDER BY id`, rows: ids.map((id) => [id]) }],
  });
  const seed = ch ? `INSERT INTO ${db}.events (id, kind, ts) VALUES (1, 'view', now()), (2, 'click', now())` : `INSERT INTO ${db}.orders (amount) VALUES (1), (2)`;
  const cases = [
    { name: "label is filled from the row", at, seed: [seed], expect: [{ kind: "value", sql: ch ? `SELECT count() FROM ${db}.events WHERE label = kind` : `SELECT count(*) FROM ${db}.orders WHERE label = status`, value: 2 }] },
    {
      name: "the table refuses a row it cannot hold",
      expect: [ch ? { kind: "error", sql: `INSERT INTO ${db}.events (id, kind, ts) VALUES ('not a number', 'view', now())` } : { kind: "error", sql: `INSERT INTO ${db}.orders (status) VALUES ('placed')`, match: "amount" }],
    },
    { name: "label stays empty after the migration", at, seed: [seed], expect: [{ kind: "value", sql: ch ? `SELECT count() FROM ${db}.events WHERE label = ''` : `SELECT count(*) FROM ${db}.orders WHERE label IS NULL`, value: 2 }] },
    ...(ch ? [rebuildCases([10, 11, 12], 1), rebuildCases([20, 21, 22, 23, 24], 2)] : []),
  ];
  p.write("tests/label.test.ts", `export default ${JSON.stringify(cases, null, 2)};\n`);
  await p.commit("tests of the label migration");
  const junit = join(ctx.work, "yodel-test.xml");
  const bin = ctx.broken ? { bin: ch ? sharedRebuildReceipts(ctx, p) : withoutExpectations(ctx, p) } : {};
  // The rebuild's receipts the run writes to the server's table, if any: their effects name the claim's table.
  const since = ch ? await ctx.db.scalar("SELECT toString(now64(3))") : "";
  const serverReceipts = async () =>
    (await ctx.db.count("SELECT count() FROM system.tables WHERE database = 'chant_receipts' AND name = 'receipts'")) === 0
      ? 0
      : ctx.db.count(`SELECT count() FROM chant_receipts.receipts WHERE startsWith(effect, 'rebuild/${db}.events/') AND written_at >= toDateTime64('${since}', 3)`);

  const ran = await p.yodel(["test", "--env", p.env, "--json", "--junit", junit], { timeoutMs: 600_000, ...bin });
  const doc = parse<TestDoc>(ran);
  const by = new Map((doc.cases ?? []).map((c) => [c.name, c]));
  const filled = by.get("label is filled from the row");
  if (filled?.status === "error" || by.get("the table refuses a row it cannot hold")?.status === "error") throw new Error(`a case could not run: ${JSON.stringify(doc.cases)}`);
  hold(filled?.status === "passed" && filled.after.includes(label), `the label case did not pass after running ${label}: ${JSON.stringify(filled)}`);
  hold(by.get("the table refuses a row it cannot hold")?.status === "passed", `the refused-row case did not pass: ${JSON.stringify(by.get("the table refuses a row it cannot hold"))}`);
  if (ch) {
    for (const n of [1, 2]) {
      const c = by.get(`the rebuild copies case ${String(n)}'s rows`);
      hold(c?.status === "passed", `case ${String(n)} did not see every row it seeded after the rebuild: ${JSON.stringify(c)}`);
    }
    const written = await serverReceipts();
    hold(written === 0, `yodel test wrote ${String(written)} rebuild receipt(s) to the server's chant_receipts.receipts, where the cases share them`);
  }
  const wrong = by.get("label stays empty after the migration");
  hold(ran.code === 3 && wrong?.status === "failed" && doc.summary?.failed === 1, `yodel test exited ${String(ran.code)} and the case that says label stays empty ${String(wrong?.status)}: an assertion that should fail held`);
  hold(readFileSync(junit, "utf8").includes('failures="1"'), `${junit} does not record the one failure`);
  hold(!(await ctx.db.tableExists(mainTable(ctx))), `yodel test left ${db}.${mainTable(ctx)} on the server`);

  // An environment yodel applies to is never a test target.
  await p.setupApply();
  const refused = await p.yodel(["test", "--env", p.env, "--reset"]);
  hold(refused.code === 4 && /has a migration history/.test(refused.err), `yodel test on an environment with a history exited ${String(refused.code)}, not 4: ${refused.err.slice(-300)}`);
  hold(await ctx.db.tableExists(mainTable(ctx)), `yodel test emptied ${p.env}, an environment yodel applied to`);
}

/** The parts, in order, on one project: two migrations replayed, a second branch forking them, a checkpoint on one chain, a revert, then tests on the replayed database. */
const parts = [
  ["replay", replayPart],
  ["fork", forkPart],
  ["checkpoint", checkpointPart],
  ["revert", revertPart],
  ["test", testPart],
] as const;

async function body(ctx: Ctx): Promise<void> {
  await runParts<Lint>(ctx, { p: await Project.create(ctx) }, parts);
}

export const lintClaim: Claim = {
  name: "lint",
  says: "yodel lint --replay replays the migrations into a fresh database and each gives the schema it recorded; offline, yodel lint fails a migrations directory with a fork (exit 3), naming both migrations; a checkpoint replays alone to its recorded schema, and a fresh environment starts from it; yodel revert undoes the newest migration behind the gate, with a hand-written step for its data step, back to its parent's recorded schema, and refuses a checkpoint or a migration before one; yodel test runs a project's tests on databases replayed from the migrations, a seed meeting the backfill after it, fails a case whose assertion does not hold, and refuses an environment with a history",
  dialects: { ch: body, pg: body },
  parts: parts.map(([name]) => name),
};
