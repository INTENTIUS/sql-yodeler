/**
 * The versioned path end to end against the emulator's Postgres (#13), the
 * end-gate scenarios for Postgres: apply two migrations behind the gate,
 * status, a CONCURRENTLY index outside a transaction, the advisory lock held
 * by another session, a statement blocked behind another session's lock
 * that times out, is retried and succeeds once the lock is released, resume
 * after a failing statement, a checksum mismatch and yodel repair, an
 * out-of-order migration refused and then allowed, a column rename and a
 * type change across kinds as PostgresMigrationOp steps, and yodel init
 * --from recording the baseline.
 *
 * Objects in schema yodel_13, the history in schema yodel_13_history. Each
 * suite drops both first, so a run starts clean and can be run again:
 *
 *   YODEL_E2E_POSTGRES_URL=postgres://$(ipconfig getifaddr en0):5432/postgres \
 *   YODEL_E2E_POSTGRES_USER=postgres YODEL_E2E_POSTGRES_PASSWORD=chant \
 *   npx vitest run test/e2e/postgres-versioned.test.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runChant } from "../../src/chant/process.js";
import type { BuildOutput, BuiltObject } from "../../src/chant/build.js";
import { createMigration, readMigrations, scanMigrations, writeMigration, computeChecksum, serializeDocument, type Migration, type MigrationDocument } from "../../src/migrations/index.js";
import { lockKeys } from "../../src/history/postgres/index.js";
import { json, projectFrom, yodel } from "../helpers/run.js";
import { postgres, postgresReachable, postgresUrl } from "./emulator.js";

const S = "yodel_13";
const HISTORY = "yodel_13_history";

interface StatusDoc {
  applied: Array<{ id: string; checksum: string }>;
  pending: Array<{ id: string; outOfOrder: boolean; partWay: { status: string; resumeAt: number; failedStatement: number | null; done: number[]; error: string } | null }>;
  outOfOrder: string[];
  partWay: Array<{ id: string; resumeAt: number; failedStatement: number | null }>;
  mismatches: Array<{ kind: string; id: string }>;
  planDigest?: string;
  status?: string;
  approve?: string;
  gatePlanDigest?: string;
  history?: { database: string };
}

/** A session of its own on the emulator, for holding a lock while yodel runs. */
async function session(): Promise<pg.Client> {
  const url = new URL(postgresUrl);
  const c = new pg.Client({
    host: url.hostname,
    port: Number(url.port || 5432),
    database: url.pathname.replace(/^\//, "") || "postgres",
    user: process.env.YODEL_E2E_POSTGRES_USER ?? "postgres",
    password: process.env.YODEL_E2E_POSTGRES_PASSWORD ?? "",
  });
  await c.connect();
  return c;
}

const one = async <T = Record<string, unknown>>(sql: string): Promise<T | undefined> => (await postgres<T>(sql))[0];
const n = async (sql: string): Promise<number> => Number((await one<{ n: string | number }>(sql))?.n ?? NaN);

const schema: BuiltObject = { export: "app", type: "Postgres::Schema", ddl: `CREATE SCHEMA ${S}`, dependsOn: [] };
const table = (exp: string, ddl: string): BuiltObject => ({ export: exp, type: "Postgres::Table", ddl, dependsOn: ["app"] });
const index = (exp: string, ddl: string, on: string): BuiltObject => ({ export: exp, type: "Postgres::Index", ddl, dependsOn: [on] });

interface Shape {
  a: string;
  people: string;
  extra?: BuiltObject[];
}
const build = (s: Shape): BuildOutput => ({
  dialect: "postgres",
  objects: [schema, table("a", `CREATE TABLE ${S}.a (${s.a})`), table("people", `CREATE TABLE ${S}.people (${s.people})`), ...(s.extra ?? [])],
});
const nameIdx = index("aName", `CREATE INDEX CONCURRENTLY a_name_idx ON ${S}.a (name)`, "a");
const tableB = table("b", `CREATE TABLE ${S}.b (id bigint PRIMARY KEY)`);
const tableC = table("c", `CREATE TABLE ${S}.c (id bigint PRIMARY KEY)`);
const PEOPLE = "id bigint PRIMARY KEY, login text NOT NULL";

describe.skipIf(!postgresReachable)("the versioned path on postgres", () => {
  let dir = "";
  let dispose = (): void => undefined;
  const saved = process.env.YODEL_HISTORY_DATABASE;
  const at = (...args: string[]) => [...args, "--dir", dir];
  const migrations = () => join(dir, "migrations");
  const ids: string[] = [];
  /** The digest approved for three, which the lock refusal leaves unapplied, and the blocked-statement run then applies. */
  let threeDigest = "";

  const next = (name: string, minute: number, shape: Shape, previous?: Migration): string => {
    const made = createMigration({ name, build: build(shape), previous: previous ?? readMigrations(migrations()).at(-1), now: new Date(Date.UTC(2026, 9, 9, 13, minute)) });
    if (made.id === undefined) throw new Error(`no change for ${name}`);
    writeMigration(migrations(), made);
    ids.push(made.id);
    return made.id;
  };

  const approve = async (command: string | undefined) => {
    expect(command).toMatch(/^chant approve migrate-e2e approve-migrate-e2e --plan jcs1-sha256:[0-9a-f]{64}$/);
    const ran = await runChant((command ?? "").split(" ").slice(1), { cwd: dir });
    expect(ran.code, ran.stderr).toBe(0);
  };

  /** Runs yodel apply to the gate and approves; returns the approved digest. */
  const gateAndApprove = async (...extra: string[]): Promise<string> => {
    const gated = await yodel(at("apply", "e2e", "--json", ...extra));
    expect(gated.code, gated.err).toBe(3);
    const doc = json(gated) as StatusDoc;
    expect(doc.status).toBe("gated");
    expect(doc.gatePlanDigest).toBe(doc.planDigest);
    await approve(doc.approve);
    return String(doc.planDigest);
  };

  /** yodel apply until the gate, approve, apply again: what a person does. */
  const approvedApply = async (...extra: string[]) => {
    await gateAndApprove(...extra);
    return yodel(at("apply", "e2e", "--json", ...extra));
  };

  /** The Op's Apply step itself, handed the approved digest. */
  const execute = async (digest: string) => {
    process.env.YODEL_APPROVED_PLAN = digest;
    try {
      return await yodel(at("apply", "e2e", "--execute"));
    } finally {
      delete process.env.YODEL_APPROVED_PLAN;
    }
  };

  const status = async (code: number) => {
    const ran = await yodel(at("status", "e2e", "--json"));
    expect(ran.code, ran.err).toBe(code);
    return json(ran) as StatusDoc;
  };

  beforeAll(async () => {
    process.env.YODEL_HISTORY_DATABASE = HISTORY;
    await postgres(`DROP SCHEMA IF EXISTS ${S} CASCADE; DROP SCHEMA IF EXISTS ${HISTORY} CASCADE`);
    ({ dir, dispose } = projectFrom("postgres-versioned"));
  });
  afterAll(async () => {
    dispose();
    if (saved === undefined) delete process.env.YODEL_HISTORY_DATABASE;
    else process.env.YODEL_HISTORY_DATABASE = saved;
    await postgres(`DROP SCHEMA IF EXISTS ${S} CASCADE; DROP SCHEMA IF EXISTS ${HISTORY} CASCADE`);
  });

  it("applies two migrations behind the gate, a CONCURRENTLY index outside a transaction, and status lists them applied", async () => {
    next("one", 0, { a: "id bigint PRIMARY KEY, name text", people: PEOPLE });
    next("two", 10, { a: "id bigint PRIMARY KEY, name text, note text", people: PEOPLE, extra: [nameIdx] });
    const concurrently = readMigrations(migrations())[1]?.document.steps.find((s) => s.kind === "statement" && s.sql.includes("CONCURRENTLY"));
    expect(concurrently).toMatchObject({ transactional: false });

    const before = await status(3);
    expect(before.history?.database).toBe(HISTORY);
    expect(before.applied).toEqual([]);
    expect(before.pending.map((p) => p.id)).toEqual(ids.slice(0, 2));
    expect(before.planDigest).toMatch(/^jcs1-sha256:/);

    const applied = await approvedApply();
    expect(applied.code, applied.err).toBe(0);
    expect((json(applied) as StatusDoc).status).toBe("applied");
    expect(applied.err).toMatch(/lock: held in Postgres advisory lock/);

    const after = await status(0);
    expect(after.applied.map((a) => a.id)).toEqual(ids.slice(0, 2));
    expect(after.pending).toEqual([]);
    // Inside a transaction block CREATE INDEX CONCURRENTLY is an error; it ran, and the index is valid.
    expect(await one<{ valid: boolean }>(`SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = '${S}.a_name_idx'::regclass`)).toEqual({ valid: true });
    expect(await n(`SELECT count(*) AS n FROM ${HISTORY}.history WHERE kind = 'migration' AND status = 'succeeded'`)).toBe(2);
    expect(await n(`SELECT count(*) AS n FROM ${HISTORY}.history WHERE plan_digest NOT LIKE 'jcs1-sha256:%'`)).toBe(0);
    expect(await n(`SELECT count(*) AS n FROM ${HISTORY}.history WHERE kind = 'statement' AND status = 'started'`)).toBe(
      await n(`SELECT count(*) AS n FROM ${HISTORY}.history WHERE kind = 'statement' AND status = 'succeeded'`),
    );

    const again = await yodel(at("apply", "e2e", "--json"));
    expect(again.code, again.err).toBe(0);
    expect((json(again) as StatusDoc).status).toBe("unchanged");
  }, 300_000);

  it("refuses with exit 5 while another session holds the advisory lock", async () => {
    next("three", 20, { a: "id bigint PRIMARY KEY, name text, note text, c text", people: PEOPLE, extra: [nameIdx] });
    const digest = await gateAndApprove();
    threeDigest = digest;
    const holder = await session();
    try {
      const [k1, k2] = lockKeys(HISTORY);
      await holder.query("SELECT set_config('application_name', 'someone else', false)");
      await holder.query("SELECT pg_advisory_lock($1::int4, $2::int4)", [k1, k2]);
      const refused = await execute(digest);
      expect(refused.code, refused.err).toBe(5);
      expect(refused.err).toMatch(/another apply holds the lock \(Postgres advisory lock .* yodel_13_history\): owner someone else, pid \d+/);
      expect(refused.err).toMatch(/pg_terminate_backend\(\d+\)/);
    } finally {
      await holder.end();
    }
    expect(await n(`SELECT count(*) AS n FROM information_schema.columns WHERE table_schema = '${S}' AND table_name = 'a' AND column_name = 'c'`)).toBe(0);
  }, 300_000);

  it("retries a statement blocked behind another session's lock, and it succeeds once the lock is released", async () => {
    const digest = threeDigest;
    const holder = await session();
    await holder.query("BEGIN");
    // SHARE: blocks three's ALTER TABLE (ACCESS EXCLUSIVE), not the catalog reads of the digest (ACCESS SHARE).
    await holder.query(`LOCK TABLE ${S}.a IN SHARE MODE`);
    const release = setTimeout(() => void holder.query("COMMIT"), 2_000);
    try {
      const ran = await execute(digest);
      expect(ran.code, ran.err).toBe(0);
      expect(ran.err).toMatch(/lock_timeout 500ms: another session holds a lock this statement needs; trying again/);
    } finally {
      clearTimeout(release);
      await holder.query("COMMIT").catch(() => undefined);
      await holder.end();
    }
    const retried = await n(`SELECT count(*) AS n FROM ${HISTORY}.history WHERE migration_id = '${String(ids[2])}' AND kind = 'statement' AND status = 'succeeded' AND note LIKE 'lock_timeout 500ms hit %'`);
    expect(retried).toBe(1);
    expect(await n(`SELECT count(*) AS n FROM information_schema.columns WHERE table_schema = '${S}' AND table_name = 'a' AND column_name = 'c'`)).toBe(1);
    expect((await status(0)).applied.map((a) => a.id)).toEqual(ids.slice(0, 3));
  }, 300_000);

  it("resumes a migration that failed part way at the statement that failed, never resending the ones that ran", async () => {
    next("four", 30, { a: "id bigint PRIMARY KEY, name text, note text, c text, d text", people: PEOPLE, extra: [nameIdx, tableB] });
    // Table b is there already, so four's CREATE TABLE b fails after ADD COLUMN d committed with its row.
    await postgres(`CREATE TABLE ${S}.b (id bigint PRIMARY KEY)`);
    const failed = await approvedApply();
    expect(failed.code, failed.err).toBe(1);

    const mid = await status(3);
    expect(mid.partWay).toHaveLength(1);
    const pw = mid.pending[0]?.partWay;
    expect(pw?.status).toBe("failed");
    expect(pw?.error).toMatch(/already exists/);
    expect(pw?.done).toContain(0);
    expect(await n(`SELECT count(*) AS n FROM information_schema.columns WHERE table_schema = '${S}' AND table_name = 'a' AND column_name = 'd'`)).toBe(1);

    await postgres(`DROP TABLE ${S}.b`);
    const resumed = await approvedApply();
    expect(resumed.code, resumed.err).toBe(0);
    expect(resumed.err).toContain("statement 0: succeeded in an earlier run; not sent");
    expect(await n(`SELECT count(*) AS n FROM ${HISTORY}.history WHERE migration_id = '${String(ids[3])}' AND kind = 'statement' AND statement_index = 0 AND status = 'started'`)).toBe(1);
    expect((await status(0)).applied.map((a) => a.id)).toEqual(ids.slice(0, 4));
  }, 300_000);

  it("refuses a checksum mismatch until yodel repair, and an out-of-order migration unless --allow-out-of-order", async () => {
    const [, two, three] = readMigrations(migrations()) as [Migration, Migration, Migration];
    const late = createMigration({ name: "late", build: build({ a: "id bigint PRIMARY KEY, name text, note text", people: PEOPLE, extra: [nameIdx, tableC] }), previous: two, now: new Date(Date.UTC(2026, 9, 9, 13, 15)) });
    if (late.id === undefined) throw new Error("no change for late");
    writeMigration(migrations(), late);
    // yodel rebase reads the Postgres history: three is applied there, so it is never moved.
    const notRebased = await yodel(at("rebase", three.id, "--env", "e2e"));
    expect(notRebased.code).toBe(4);
    expect(notRebased.err).toContain(`e2e's history records ${three.id} (applied)`);
    expect((JSON.parse(readFileSync(join(three.dir, "migration.json"), "utf8")) as MigrationDocument).parent).toBe(two.id);
    // Rebased by hand: three now follows late. Its files change, so the history's checksum no longer matches.
    const doc = { ...(JSON.parse(readFileSync(join(three.dir, "migration.json"), "utf8")) as MigrationDocument), parent: late.id };
    const moved = { ...doc, checksum: computeChecksum({ sql: three.files.sql, json: doc }) };
    writeFileSync(join(three.dir, "migration.json"), serializeDocument(moved));

    const mismatch = await status(4);
    expect(mismatch.mismatches).toMatchObject([{ kind: "applied", id: three.id }]);
    const refused = await yodel(at("apply", "e2e"));
    expect(refused.code).toBe(4);
    expect(refused.err).toContain(`${three.id} was applied with checksum`);

    const repaired = await yodel(at("repair", three.id, "e2e", "--reason", `rebased onto ${late.id}`, "--json"));
    expect(repaired.code, repaired.err).toBe(0);
    expect(json(repaired)).toMatchObject({ repaired: true, id: three.id, newChecksum: moved.checksum });
    expect(await one(`SELECT note FROM ${HISTORY}.history WHERE migration_id = '${three.id}' ORDER BY seq DESC LIMIT 1`)).toEqual({ note: `rebased onto ${late.id}` });

    const lateStatus = await status(4);
    expect(lateStatus.mismatches).toEqual([]);
    expect(lateStatus.outOfOrder).toEqual([late.id]);
    const notAllowed = await yodel(at("apply", "e2e"));
    expect(notAllowed.code).toBe(4);
    expect(notAllowed.err).toMatch(new RegExp(`${late.id} is out of order.*--allow-out-of-order`));
    expect(await one<{ t: string | null }>(`SELECT to_regclass('${S}.c')::text AS t`)).toEqual({ t: null });

    const allowed = await approvedApply("--allow-out-of-order");
    expect(allowed.code, allowed.err).toBe(0);
    expect(await one<{ t: string | null }>(`SELECT to_regclass('${S}.c')::text AS t`)).toEqual({ t: `${S}.c` });
    expect((await status(0)).applied.map((a) => a.id).sort()).toEqual([...ids.slice(0, 4), late.id].sort());
  }, 300_000);

  it("runs a column rename as a PostgresMigrationOp step: expand, backfill, switch, contract", async () => {
    await postgres(`INSERT INTO ${S}.people (id, login) SELECT g, 'user' || g FROM generate_series(1, 2500) g`);
    // Follows four, the chain's tip, whose recorded schema has no table c (late made it, out of order).
    const tip = scanMigrations(migrations()).migrations.find((m) => m.id === ids[3]);
    const id = next("rename-login", 40, { a: "id bigint PRIMARY KEY, name text, note text, c text, d text", people: "id bigint PRIMARY KEY,\n  handle text NOT NULL -- previously: login\n", extra: [nameIdx, tableB] }, tip);
    const m = readMigrations(migrations()).find((x) => x.id === id);
    expect(m?.document.steps.map((s) => (s.kind === "op" ? s.op : s.kind))).toEqual(["PostgresMigrationOp"]);

    const st = await status(3);
    expect(st.pending.map((p) => p.id)).toEqual([id]);
    const applied = await approvedApply();
    expect(applied.code, applied.err).toBe(0);
    expect(applied.err).toMatch(/step \d+: PostgresMigrationOp for people/);

    const cols = await postgres<{ c: string }>(`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = '${S}' AND table_name = 'people' ORDER BY ordinal_position`);
    expect(cols.map((c) => c.c)).toEqual(["id", "handle"]);
    expect(await n(`SELECT count(*) AS n FROM ${S}.people WHERE handle = 'user' || id`)).toBe(2500);
    const step = await one<{ note: string }>(`SELECT note FROM ${HISTORY}.history WHERE migration_id = '${id}' AND kind = 'step' AND status = 'succeeded'`);
    expect(JSON.parse(step?.note ?? "{}")).toMatchObject({ op: "PostgresMigrationOp", change: "rename", switched: true, dropped: true });
    expect((await status(0)).pending).toEqual([]);
  }, 600_000);

  it("runs a column type change across kinds as a PostgresMigrationOp step", async () => {
    const shape = (v: string): Shape => ({
      a: "id bigint PRIMARY KEY, name text, note text, c text, d text",
      people: "id bigint PRIMARY KEY,\n  handle text NOT NULL\n",
      extra: [nameIdx, tableB, table("t", `CREATE TABLE ${S}.t (id bigint PRIMARY KEY, v ${v})`)],
    });
    next("add-t", 41, shape("text NOT NULL"));
    const added = await approvedApply();
    expect(added.code, added.err).toBe(0);
    await postgres(`INSERT INTO ${S}.t (id, v) SELECT g, (g * 7)::text FROM generate_series(1, 1500) g`);

    const id = next("t-v-bigint", 42, shape("bigint NOT NULL"));
    const m = readMigrations(migrations()).find((x) => x.id === id);
    expect(m?.document.steps.map((s) => (s.kind === "op" ? s.op : s.kind))).toEqual(["PostgresMigrationOp"]);
    const applied = await approvedApply();
    expect(applied.code, applied.err).toBe(0);
    expect(applied.err).toMatch(/step \d+: PostgresMigrationOp for t/);

    expect(await one(`SELECT data_type FROM information_schema.columns WHERE table_schema = '${S}' AND table_name = 't' AND column_name = 'v'`)).toEqual({ data_type: "bigint" });
    expect(await n(`SELECT count(*) AS n FROM ${S}.t WHERE v = id * 7`)).toBe(1500);
    const step = await one<{ note: string }>(`SELECT note FROM ${HISTORY}.history WHERE migration_id = '${id}' AND kind = 'step' AND status = 'succeeded'`);
    expect(JSON.parse(step?.note ?? "{}")).toMatchObject({ op: "PostgresMigrationOp", change: "type", switched: true, dropped: true });
    expect((await status(0)).pending).toEqual([]);
  }, 600_000);
});

describe.skipIf(!postgresReachable)("yodel init --from on postgres records the baseline", () => {
  let dir = "";
  let dispose = (): void => undefined;
  const saved = process.env.YODEL_HISTORY_DATABASE;
  const at = (...args: string[]) => [...args, "--dir", dir];

  beforeAll(async () => {
    process.env.YODEL_HISTORY_DATABASE = HISTORY;
    await postgres(`DROP SCHEMA IF EXISTS ${S} CASCADE; DROP SCHEMA IF EXISTS ${HISTORY} CASCADE`);
    await postgres(`
      CREATE SCHEMA ${S};
      CREATE TABLE ${S}.customers (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, email text NOT NULL UNIQUE);
      CREATE TABLE ${S}.orders (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, customer_id bigint NOT NULL REFERENCES ${S}.customers(id), amount numeric(12, 2) NOT NULL);
      CREATE INDEX orders_customer_idx ON ${S}.orders (customer_id);`);
    ({ dir, dispose } = projectFrom("init-postgres-13"));
  });
  afterAll(async () => {
    dispose();
    if (saved === undefined) delete process.env.YODEL_HISTORY_DATABASE;
    else process.env.YODEL_HISTORY_DATABASE = saved;
    await postgres(`DROP SCHEMA IF EXISTS ${S} CASCADE; DROP SCHEMA IF EXISTS ${HISTORY} CASCADE`);
  });

  it("records the baseline applied; plan shows no change, status lists it applied, apply has nothing to do", async () => {
    const ran = await yodel(at("init", "--from", "e2e", "--json"));
    expect(ran.code, ran.err).toBe(0);
    const doc = json(ran) as { status: string; migration: { id: string }; recorded: { history: string; note: string } | null };
    expect(doc.status).toBe("adopted");
    expect(doc.recorded).toMatchObject({ history: HISTORY, note: expect.stringMatching(/^baseline: adopted/) as unknown });
    expect(await n(`SELECT count(*) AS n FROM ${HISTORY}.history`)).toBe(1);

    const plan = await yodel(at("plan", "e2e", "--json"));
    expect(plan.code, plan.err).toBe(0);

    const st = await yodel(at("status", "e2e", "--json"));
    expect(st.code, st.err).toBe(0);
    expect((json(st) as StatusDoc).applied.map((a) => a.id)).toEqual([doc.migration.id]);

    const apply = await yodel(at("apply", "e2e", "--json"));
    expect(apply.code, apply.err).toBe(0);
    expect((json(apply) as StatusDoc).status).toBe("unchanged");
  }, 300_000);
});
