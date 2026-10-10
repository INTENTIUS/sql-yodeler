import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MigrationStep } from "@intentius/chant-lexicon-sql/migration-statements";
import type { ActivityFn } from "@intentius/chant/op/activity-registry";
import { LOCKED, MIGRATION_ROW, type HistoryRow } from "../src/history/index.js";
import { acquireAdvisoryLock, insertRows, LOCK_CLASS, lockKeys, pgHistoryDdl, PostgresHistoryStore } from "../src/history/postgres/index.js";
import { concurrentIndex, DEFAULT_PG_TIMEOUTS, PgStatementError, pgCatalogFingerprint, pgSettings, runPgStatement, type PgStatementOptions } from "../src/versioned/postgres/index.js";
import { classifySteps, closeVersioned, currentDigest, executeApply, inspect, openVersioned, selectToApply, statusReport, type VersionedEnv } from "../src/versioned/index.js";
import { projectFromConfig } from "../src/project.js";
import { writeMigration, type Migration } from "../src/migrations/index.js";
import { renderStatus, statusJson } from "../src/versioned/report.js";
import { collectVersionedPlan } from "../src/pr/model.js";
import { renderPlanMarkdown, renderPlanText } from "../src/pr/render.js";
import { pgMigrationOpConfig, planStep, runPgMigration, STEP_RETAIN } from "../src/steps/index.js";
import { FakePgServer } from "./helpers/fake-postgres.js";
import { migration } from "./helpers/fake-clickhouse.js";

const SCHEMA = "yodel_13_history";

const row = (seq: number, over: Partial<HistoryRow> = {}): HistoryRow => ({
  seq,
  run_id: "r1",
  kind: "migration",
  migration_id: "20261009T1000-one",
  parent: "",
  checksum: "sha256:aa",
  statement_index: MIGRATION_ROW,
  statement_sha: "",
  status: "started",
  error: "",
  applied_by: "tester@host",
  plan_digest: "jcs1-sha256:00",
  silences: "[]",
  note: "",
  ...over,
});

describe("the Postgres history table", () => {
  it("lives in a schema of its own, with the ClickHouse table's columns", () => {
    const [schema, table, comment] = pgHistoryDdl(SCHEMA);
    expect(schema).toBe(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
    expect(table).toContain(`CREATE TABLE IF NOT EXISTS "${SCHEMA}"."history"`);
    for (const c of ["seq bigint NOT NULL PRIMARY KEY", "silences text NOT NULL DEFAULT '[]'", "note text", "recorded_at timestamptz"]) expect(table).toContain(c);
    expect(comment).toContain("append-only");
  });

  it("appends rows as one parameterized INSERT, and reads them back in seq order as the same rows", async () => {
    const { sql, params } = insertRows(SCHEMA, [row(1), row(2, { status: "succeeded" })]);
    expect(sql).toMatch(/^INSERT INTO "yodel_13_history"."history" \(seq, run_id, .*, note\) VALUES \(\$1, .*\), \(\$15, .*\$28\)$/);
    expect(params).toHaveLength(28);

    const server = new FakePgServer();
    const store = new PostgresHistoryStore(await server.connect(), { schema: SCHEMA });
    expect(await store.rows()).toEqual([]);
    await store.ensure();
    await store.append([row(2, { status: "succeeded" }), row(1)]);
    const back = await store.rows();
    expect(back.map((r) => [r.seq, r.status])).toEqual([[1, "started"], [2, "succeeded"]]);
    expect(back[0]).toMatchObject({ ...row(1), recorded_at: expect.stringMatching(/^2026-10-09 /) as unknown });
    const state = await store.state();
    expect(state.byId.get("20261009T1000-one")?.status).toBe("succeeded");
  });
});

describe("the advisory lock", () => {
  it("has fixed keys from the history schema, both non-negative int4", () => {
    const [a, b] = lockKeys(SCHEMA);
    expect(a).toBe(LOCK_CLASS);
    expect(lockKeys(SCHEMA)).toEqual([a, b]);
    expect(lockKeys("yodeler")[1]).not.toBe(b);
    for (const k of [a, b]) expect(k >= 0 && k <= 0x7fffffff).toBe(true);
  });

  it("refuses a second apply with exit 5 naming the session that holds it, and is free again once released", async () => {
    const server = new FakePgServer();
    const first = await acquireAdvisoryLock(await server.connect(), { schema: SCHEMA, holder: "alice@ci" });
    expect(first.kind).toBe("advisory");
    await first.heartbeat();

    const conn = await server.connect();
    const refused = acquireAdvisoryLock(conn, { schema: SCHEMA, holder: "bob@laptop" });
    await expect(refused).rejects.toMatchObject({ exitCode: LOCKED, name: "LockHeldError" });
    await expect(refused).rejects.toThrow(/yodel apply alice@ci#.*pid 100.*pg_terminate_backend\(100\)/);
    expect(conn.ended).toBe(true);

    await first.release();
    const second = await acquireAdvisoryLock(await server.connect(), { schema: SCHEMA, holder: "bob@laptop" });
    await second.release();
  });

  it("does not share one lock between two history schemas", async () => {
    const server = new FakePgServer();
    const a = await acquireAdvisoryLock(await server.connect(), { schema: "a_history", holder: "x" });
    const b = await acquireAdvisoryLock(await server.connect(), { schema: "b_history", holder: "y" });
    await a.release();
    await b.release();
  });

  it("stops the apply when its session no longer holds the lock", async () => {
    const server = new FakePgServer();
    const conn = await server.connect();
    const lock = await acquireAdvisoryLock(conn, { schema: SCHEMA, holder: "x" });
    await conn.end();
    await expect(lock.heartbeat()).rejects.toMatchObject({ exitCode: LOCKED, name: "LockLostError" });
  });
});

describe("runPgStatement", () => {
  const options = (written: string[], over: Partial<PgStatementOptions> = {}): PgStatementOptions => ({
    timeouts: { ...DEFAULT_PG_TIMEOUTS, lockTimeoutMs: 1000 },
    retries: 3,
    retryBaseMs: 1,
    succeeded: (note) => {
      written.push(note);
      return Promise.resolve();
    },
    log: () => undefined,
    sleep: () => Promise.resolve(),
    ...over,
  });

  it("runs a transactional statement and its succeeded row in one transaction, under its timeouts", async () => {
    const server = new FakePgServer();
    const conn = await server.connect();
    const written: string[] = [];
    const store = new PostgresHistoryStore(conn, { schema: SCHEMA });
    await store.ensure();
    const sql = "ALTER TABLE yodel_13.a ADD COLUMN b text";
    await runPgStatement(conn, { sql, class: "metadata", transactional: true }, options(written, { succeeded: (n) => { written.push(n); return store.append([row(1, { status: "succeeded", note: n })]); } }));
    const at = server.log.indexOf("BEGIN");
    expect(server.log.slice(at, at + 4)).toEqual(["BEGIN", "SET LOCAL lock_timeout = '1000ms'", "SET LOCAL statement_timeout = '60000ms'", sql]);
    expect(server.log[at + 4]).toMatch(/^INSERT INTO "yodel_13_history"."history"/);
    expect(server.log[at + 5]).toBe("COMMIT");
    expect(server.rows).toHaveLength(1);
    expect(written).toEqual([""]);
  });

  it("rolls back the statement and its row together when the commit does not happen", async () => {
    const server = new FakePgServer();
    const conn = await server.connect();
    const store = new PostgresHistoryStore(conn, { schema: SCHEMA });
    await store.ensure();
    server.failWith = (sql) => (sql.startsWith("ALTER") ? { message: "column b already exists", code: "42701" } : undefined);
    const run = runPgStatement(conn, { sql: "ALTER TABLE yodel_13.a ADD COLUMN b text", class: "metadata", transactional: true }, options([], { succeeded: () => store.append([row(1, { status: "succeeded" })]) }));
    await expect(run).rejects.toBeInstanceOf(PgStatementError);
    await expect(run).rejects.toMatchObject({ error: "column b already exists", code: "42701", attempts: 1 });
    expect(server.log).toContain("ROLLBACK");
    expect(server.rows).toEqual([]);
  });

  it("retries a statement that hit the lock timeout, with a growing pause, and says so in the note", async () => {
    const server = new FakePgServer();
    const conn = await server.connect();
    let blocked = 2;
    server.failWith = (sql) => (sql.startsWith("ALTER") && blocked-- > 0 ? { message: "canceling statement due to lock timeout", code: "55P03" } : undefined);
    const pauses: number[] = [];
    const written: string[] = [];
    const result = await runPgStatement(conn, { sql: "ALTER TABLE yodel_13.a ADD COLUMN b text", class: "metadata", transactional: true }, options(written, { retryBaseMs: 100, sleep: (n) => { pauses.push(n); return Promise.resolve(); } }));
    expect(result.attempts).toBe(3);
    expect(pauses).toEqual([100, 200]);
    expect(written).toEqual(["lock_timeout 1000ms hit 2 time(s); succeeded on attempt 3"]);
    expect(server.log.filter((s) => s === "ROLLBACK")).toHaveLength(2);
  });

  it("gives up after its retries, naming the lock timeout; any other error fails at once", async () => {
    const server = new FakePgServer();
    const conn = await server.connect();
    server.failWith = () => ({ message: "canceling statement due to lock timeout", code: "55P03" });
    const run = runPgStatement(conn, { sql: "ALTER TABLE yodel_13.a ADD COLUMN b text", class: "metadata", transactional: true }, options([], { retries: 2 }));
    await expect(run).rejects.toThrow(/lock_timeout 1000ms, tried 3 times.*SQLSTATE 55P03/);
    server.failWith = () => ({ message: "syntax error", code: "42601" });
    await expect(runPgStatement(conn, { sql: "ALTER x", class: "metadata", transactional: true }, options([]))).rejects.toMatchObject({ attempts: 1 });
  });

  it("runs CONCURRENTLY outside a transaction, the scan timeout set, dropping an INVALID index of that name first", async () => {
    const server = new FakePgServer();
    const conn = await server.connect();
    server.invalidIndexes.add('"yodel_13"."a_b_idx"');
    const written: string[] = [];
    const sql = "CREATE INDEX CONCURRENTLY a_b_idx ON yodel_13.a (b)";
    await runPgStatement(conn, { sql, class: "concurrently", transactional: false }, options(written));
    expect(server.log).not.toContain("BEGIN");
    expect(server.sent).toEqual(['DROP INDEX CONCURRENTLY IF EXISTS "yodel_13"."a_b_idx"', sql]);
    const at = server.log.indexOf(sql);
    expect(server.log.slice(at - 2, at)).toEqual(["SET lock_timeout = '1000ms'", "SET statement_timeout = '0ms'"]);
    expect(written).toEqual(['dropped INVALID index "yodel_13"."a_b_idx" before building it again']);
  });

  it("drops the INVALID index a failed CONCURRENTLY build leaves, before it retries", async () => {
    const server = new FakePgServer();
    const conn = await server.connect();
    let first = true;
    server.failWith = (sql) => {
      if (!sql.startsWith("CREATE INDEX") || !first) return undefined;
      first = false;
      server.invalidIndexes.add('"yodel_13"."a_b_idx"');
      return { message: "canceling statement due to lock timeout", code: "55P03" };
    };
    await runPgStatement(conn, { sql: "CREATE INDEX CONCURRENTLY a_b_idx ON yodel_13.a (b)", class: "concurrently", transactional: false }, options([]));
    expect(server.sent.filter((s) => s.startsWith("DROP INDEX"))).toHaveLength(1);
    expect(server.invalidIndexes.size).toBe(0);
  });

  it("finds the index a CONCURRENTLY statement builds", () => {
    expect(concurrentIndex("CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS \"Big Idx\" ON ONLY app.\"Users\" (email)")).toBe('"app"."Big Idx"');
    expect(concurrentIndex("create index concurrently i on S.t (x)")).toBe('"s"."i"');
    expect(concurrentIndex("CREATE INDEX CONCURRENTLY i ON t (x)")).toBeUndefined();
    expect(concurrentIndex("CREATE INDEX i ON s.t (x)")).toBeUndefined();
  });
});

describe("Postgres settings and the fingerprint", () => {
  it("maps the history database setting to a schema, takes the profile's timeouts, and retries 5 times by default", () => {
    expect(pgSettings({}, {})).toEqual({ historySchema: "yodeler", timeouts: DEFAULT_PG_TIMEOUTS, lockRetries: 5 });
    expect(pgSettings({ timeouts: { lockTimeoutMs: 250 } }, { YODEL_HISTORY_DATABASE: SCHEMA, YODEL_LOCK_RETRIES: "0" })).toMatchObject({ historySchema: SCHEMA, timeouts: { lockTimeoutMs: 250 }, lockRetries: 0 });
    expect(() => pgSettings({}, { YODEL_LOCK_RETRIES: "lots" })).toThrow(/YODEL_LOCK_RETRIES/);
  });

  it("is the same for the same catalog, and moves when an object does", () => {
    const t = { type: "Postgres::Table", schema: "app", name: "a", statement: "CREATE TABLE app.a (x int)", comment: "" };
    expect(pgCatalogFingerprint([t])).toBe(pgCatalogFingerprint([{ ...t }]));
    expect(pgCatalogFingerprint([{ ...t, statement: "CREATE TABLE app.a (x bigint)" }])).not.toBe(pgCatalogFingerprint([t]));
  });
});

const pgStep = (options: Record<string, unknown>): MigrationStep => ({
  kind: "op",
  object: "users",
  type: "Postgres::Table",
  name: "app.users",
  op: "PostgresMigrationOp",
  importPath: "@intentius/chant-lexicon-sql/postgres",
  options,
  declaration: "",
  changes: [],
  detail: "a rename",
});

describe("a PostgresMigrationOp step", () => {
  it("is a step apply runs, with its options checked", () => {
    expect(planStep(pgStep({ name: "migrate-users-login", env: "<env>", table: "app.users", column: "login" }))).toEqual({
      run: "pgMigration",
      options: { name: "migrate-users-login", table: "app.users", column: "login" },
    });
    expect(planStep(pgStep({ name: "m", table: "app.users", column: "login", retain: "1d", batchSize: 50 }))).toMatchObject({ options: { retain: "1d", batchSize: 50 } });
    expect(planStep(pgStep({ name: "m", table: "app.users" }))).toMatchObject({ run: "refused", reason: expect.stringContaining("without its name, table and column") as unknown });
    expect(planStep(pgStep({ name: "m", table: "t", column: "c", batchSize: -1 }))).toMatchObject({ run: "refused", reason: expect.stringContaining("options.batchSize") as unknown });
  });

  it("is refused in a ClickHouse migration, as a backfill is in a Postgres one", () => {
    const ch = migration("20261009T1000-one", null, []);
    const withStep = { ...ch, document: { ...ch.document, steps: [pgStep({ name: "m", table: "a.b", column: "c" })] } };
    expect(classifySteps(withStep).refusedSteps[0]?.reason).toMatch(/PostgresMigrationOp step in a clickhouse migration/);
    const pg = { ...withStep, document: { ...withStep.document, dialect: "postgres" as const } };
    expect(classifySteps(pg).opSteps).toHaveLength(1);
  });

  it("runs chant's Op without its gates and its onFailure, the contract in the same run unless the step sets retain", async () => {
    const config = await pgMigrationOpConfig({ name: "migrate-users-login", table: "app.users", column: "login" }, { environment: "e2e", projectDir: "/p", buildPath: "/tmp/s.json", lockTimeoutMs: 1000 });
    const steps = config.phases.flatMap((p) => p.steps);
    expect(steps.some((s) => s.kind === "gate")).toBe(false);
    expect(config.onFailure).toBeUndefined();
    expect(config.phases.map((p) => p.name)).toEqual(["Plan", "Expand", "Dual write", "Backfill", "Carry over", "Verify", "Switch", "Retain", "Contract"]);
    const args = (steps[0] as { args: Record<string, unknown> }).args;
    expect(args).toMatchObject({ table: "app.users", column: "login", buildPath: "/tmp/s.json", environment: "e2e", retain: STEP_RETAIN, lockTimeoutMs: 1000, cwd: "/p" });
    const kept = await pgMigrationOpConfig({ name: "m", table: "app.users", column: "login", retain: "3d", lockTimeoutMs: 50 }, { environment: "e2e", projectDir: "/p", buildPath: "/b", lockTimeoutMs: 1000 });
    expect((kept.phases[0]?.steps[0] as { args: Record<string, unknown> }).args).toMatchObject({ retain: "3d", lockTimeoutMs: 50 });
  });

  it("summarizes how far it got from its activities' results", async () => {
    const calls: string[] = [];
    const result = (fn: string, value: unknown): ActivityFn => () => {
      calls.push(fn);
      return Promise.resolve(value);
    };
    const activities: Record<string, ActivityFn> = {
      postgresMigrationPlan: result("plan", { state: "migrate", change: "rename" }),
      postgresMigrationExpand: result("expand", { added: true }),
      postgresMigrationDualWrite: result("dual", {}),
      postgresMigrationBackfill: result("backfill", { filled: 2, skipped: 1, rows: 30 }),
      postgresMigrationCarry: result("carry", { built: 1 }),
      postgresMigrationVerify: result("verify", { rows: 30 }),
      postgresMigrationSwitch: result("switch", { switched: true, oldColumn: "app.users.login__old" }),
      postgresMigrationRetain: result("retain", {}),
      postgresMigrationContract: result("contract", { dropped: true, oldColumn: "app.users.login__old" }),
    };
    const { summary } = await runPgMigration({ name: "m", table: "app.users", column: "login" }, { environment: "e2e", projectDir: process.cwd(), schema: { dialect: "postgres", objects: [] }, activities, base: new Map() });
    expect(calls).toEqual(["plan", "expand", "dual", "backfill", "carry", "verify", "switch", "retain", "contract"]);
    expect(summary).toEqual({ op: "PostgresMigrationOp", table: "app.users", column: "login", state: "migrate", change: "rename", filled: 2, skipped: 1, backfilledRows: 30, carried: 1, verifiedRows: 30, switched: true, oldColumn: "app.users.login__old", dropped: true });
  });
});

describe("executeApply on Postgres", () => {
  const stmt = (sql: string, transactional = true): MigrationStep => ({ kind: "statement", object: "a", type: "Postgres::Table", name: "yodel_13.a", sql, rule: "SQLPG200", class: transactional ? "create" : "concurrently", transactional });
  const pgMigration = (id: string, parent: string | null, steps: MigrationStep[]) => {
    const m = migration(id, parent, steps);
    return { ...m, document: { ...m.document, dialect: "postgres" as const } };
  };
  const m1 = pgMigration("20261009T1000-one", null, [stmt("CREATE TABLE yodel_13.a (id bigint)"), stmt("CREATE INDEX CONCURRENTLY a_id ON yodel_13.a (id)", false), stmt("CREATE TABLE yodel_13.b (id bigint)")]);

  const setup = async (server = new FakePgServer()) => {
    const project = projectFromConfig("/nowhere", "/nowhere/chant.config.ts", { lexicons: ["sql"], sql: { dialect: "postgres", profiles: { e2e: { url: "postgres://pg:5432/db", schemas: ["yodel_13"] } } } });
    const venv = await openVersioned(project, { name: "e2e", profile: { url: "postgres://pg:5432/db" } }, { YODEL_HISTORY_DATABASE: SCHEMA }, undefined, () => server.connect());
    // The fake answers no catalog query; the e2e tests cover chant's catalog reader.
    venv.driver.liveFingerprint = () => Promise.resolve("sha256:fake");
    return { server, venv };
  };
  const apply = async (venv: VersionedEnv, ordered: Migration[]) => {
    const { status } = await inspect(venv, ordered);
    const digest = await currentDigest(venv, status, selectToApply(status, false));
    return executeApply(venv, ordered, { approvedDigest: digest, allowOutOfOrder: false, approve: () => Promise.resolve(), log: () => undefined, processEnv: { USER: "tester" } });
  };

  it("applies under the advisory lock, each transactional statement committed with its row, and resumes at the statement that failed", async () => {
    const { server, venv } = await setup();
    server.failWith = (sql) => (sql.includes("yodel_13.b") ? { message: 'relation "b" already exists', code: "42P07" } : undefined);
    await expect(apply(venv, [m1])).rejects.toMatchObject({ name: "ApplyFailed", statement: 2 });
    expect(server.sent).toEqual(["CREATE TABLE yodel_13.a (id bigint)", "CREATE INDEX CONCURRENTLY a_id ON yodel_13.a (id)"]);
    const first = server.log.indexOf("CREATE TABLE yodel_13.a (id bigint)");
    expect(server.log[first + 1]).toMatch(/^INSERT INTO "yodel_13_history"."history"/);
    expect(server.log[first + 2]).toBe("COMMIT");
    // The failed statement's succeeded row never committed; its failed row did.
    const failedRows = server.rows.filter((r) => r.statement_index === 2);
    expect(failedRows.map((r) => r.status)).toEqual(["started", "failed"]);
    expect(server.locks.size).toBe(0);

    server.failWith = () => undefined;
    const result = await apply(venv, [m1]);
    expect(result.lock.kind).toBe("advisory");
    expect(result.skipped).toEqual([{ id: m1.id, statement: 0 }, { id: m1.id, statement: 1 }]);
    expect(server.sent.at(-1)).toBe("CREATE TABLE yodel_13.b (id bigint)");
    const report = await statusReport(venv, [m1]);
    expect(report.status.applied.map((a) => a.id)).toEqual([m1.id]);
    // Topology is ClickHouse's: a Postgres report leaves it out.
    expect(renderStatus(report).split("\n")[0]).toBe(`Migrations in e2e (postgres 18.6 at pg:5432/db, history ${SCHEMA}.history)`);
    expect(statusJson(report).server).toEqual({ dialect: "postgres", address: "pg:5432/db", version: "18.6" });
    expect(renderStatus(report)).not.toContain("topology");
    expect(statusJson(report)).not.toHaveProperty("topology");
    expect(statusJson(report).history).toEqual({ database: SCHEMA });
    await closeVersioned(venv);
    expect(server.connections.every((c) => c.ended)).toBe(true);
  });

  it("plans with no topology: Postgres has none", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yodel-pg-plan-"));
    try {
      writeMigration(join(dir, "migrations"), m1);
      const project = projectFromConfig(dir, join(dir, "chant.config.ts"), { lexicons: ["sql"], sql: { dialect: "postgres", profiles: { e2e: { url: "postgres://pg:5432/db", schemas: ["yodel_13"] } } } });
      const server = new FakePgServer();
      const venv = await openVersioned(project, { name: "e2e", profile: { url: "postgres://pg:5432/db" } }, { YODEL_HISTORY_DATABASE: SCHEMA }, undefined, () => server.connect());
      venv.driver.liveFingerprint = () => Promise.resolve("sha256:fake");
      const op = { name: "migrate-e2e", filePath: "/p/ops/migrate-e2e.op.ts", gate: "approve-migrate-e2e", quorum: false };
      const plan = await collectVersionedPlan(project, { name: "e2e", profile: { url: "postgres://pg:5432/db" } }, { venv, op, ledger: null });
      expect(plan.history).toBe(`${SCHEMA}.history`);
      expect(renderPlanText(plan).split("\n")[0]).toBe(`Plan for e2e (postgres 18.6 at pg:5432/db, history ${SCHEMA}.history): 0 applied, 1 pending`);
      expect(renderPlanMarkdown(plan)).toContain(`Postgres, history \`${SCHEMA}.history\`: 0 applied`);
      await closeVersioned(venv);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses with exit 5 while another session holds the lock", async () => {
    const { server, venv } = await setup();
    const other = await acquireAdvisoryLock(await server.connect(), { schema: SCHEMA, holder: "someone" });
    await expect(apply(venv, [m1])).rejects.toMatchObject({ exitCode: LOCKED });
    expect(server.sent).toEqual([]);
    await other.release();
    await closeVersioned(venv);
  });
});
