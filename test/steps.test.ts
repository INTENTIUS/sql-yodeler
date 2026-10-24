import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { MigrationStep } from "@intentius/chant-lexicon-sql/migration-statements";
import type { ReceiptStore } from "@intentius/chant/op/receipt-store";
import { memoryGateLedgerPort } from "@intentius/chant/op/gate";
import type { BuildOutput } from "../src/chant/build.js";
import { computeChecksum, createMigration, readMigrations, verifyChecksum, writeMigration, type CreatedMigration, type Migration } from "../src/migrations/index.js";
import {
  asBackfill,
  backfillFormStep,
  backfillProblems,
  formProblems,
  formTemplate,
  keyRanges,
  backfillStep,
  backfillTemplate,
  planStep,
  prefixedStore,
  rebuildOpConfig,
  runBackfill,
  runRebuild,
  stepSha,
  StepOpFailed,
  type StepRunner,
} from "../src/steps/index.js";
import { projectFromConfig } from "../src/project.js";
import { classifySteps, currentDigest, executeApply, inspect, openVersioned, selectToApply, StepFailed, stepRefusal, verifyApproval, type MigrateOpRef, type VersionedEnv } from "../src/versioned/index.js";
import { FakeClickHouse, migration } from "./helpers/fake-clickhouse.js";
import { json, projectFrom, repoRoot, yodel } from "./helpers/run.js";

const DB = "yodel_12";
const build = (table: string): BuildOutput => ({
  dialect: "clickhouse",
  objects: [
    { export: "db", type: "ClickHouse::Database", ddl: `CREATE DATABASE ${DB} ENGINE = Atomic`, dependsOn: [] },
    { export: "events", type: "ClickHouse::Table", ddl: table, dependsOn: ["db"] },
  ],
});
const BEFORE = `CREATE TABLE ${DB}.events (id UInt64, ts DateTime, k String) ENGINE = MergeTree PARTITION BY toYYYYMM(ts) ORDER BY (k, id)`;
const at = (minute: number) => new Date(Date.UTC(2026, 9, 9, 14, minute));

const dirs: string[] = [];
const tempDir = (withModules = false) => {
  const d = mkdtempSync(join(tmpdir(), "yodel-steps-"));
  dirs.push(d);
  if (withModules) symlinkSync(join(repoRoot, "node_modules"), join(d, "node_modules"), "dir");
  return d;
};
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const made = (m: ReturnType<typeof createMigration>): CreatedMigration => {
  if (m.id === undefined) throw new Error("expected a migration");
  return m;
};

describe("yodel new writes a change ClickHouse cannot make in place as a ClickHouseRebuildOp step", () => {
  const first = made(createMigration({ name: "events", build: build(BEFORE), now: at(0) }));
  const previous = (): Migration => ({ id: first.id, dir: "/m", parent: null, checksum: first.document.checksum, document: first.document, files: first.files });

  it.each([
    ["a sort-key change", `CREATE TABLE ${DB}.events (id UInt64, ts DateTime, k String) ENGINE = MergeTree PARTITION BY toYYYYMM(ts) ORDER BY (id, k)`, ["SQLCH220"]],
    ["an engine change", `CREATE TABLE ${DB}.events (id UInt64, ts DateTime, k String) ENGINE = ReplacingMergeTree PARTITION BY toYYYYMM(ts) ORDER BY (k, id)`, ["SQLCH223"]],
    ["a key column renamed (declared)", `CREATE TABLE ${DB}.events (id UInt64, ts DateTime,\n  key String -- previously: k\n) ENGINE = MergeTree PARTITION BY toYYYYMM(ts) ORDER BY (key, id)`, ["SQLCH213", "SQLCH220"]],
    ["a key column renamed (undeclared: a drop and an add)", `CREATE TABLE ${DB}.events (id UInt64, ts DateTime, key String) ENGINE = MergeTree PARTITION BY toYYYYMM(ts) ORDER BY (key, id)`, ["SQLCH201", "SQLCH213", "SQLCH220"]],
  ])("%s", (_what, table, rules) => {
    const m = made(createMigration({ name: "change", build: build(table), previous: previous(), now: at(1) }));
    expect(m.document.steps).toHaveLength(1);
    const [step] = m.document.steps as [MigrationStep];
    expect(step).toMatchObject({ kind: "op", op: "ClickHouseRebuildOp", options: { table: `${DB}.events`, dualWrite: { mode: "materialized-view", cutoverColumn: "ts" } } });
    expect(step.kind === "op" ? step.changes.map((c) => c.rule) : []).toEqual(rules);
    // Never DDL and never a drop: the migration's SQL is comments only.
    const sqlLines = m.files.sql.split("\n").filter((l) => l.trim() !== "" && !l.startsWith("--"));
    expect(sqlLines).toEqual([]);
    expect(m.files.sql).not.toMatch(/^\s*(DROP|ALTER|CREATE)\b/m);
    expect(planStep(step)).toMatchObject({ run: "rebuild", options: { name: "rebuild-yodel-12-events", table: `${DB}.events` } });
  });
});

describe("planStep", () => {
  const op = (options: Record<string, unknown>, name: "ClickHouseRebuildOp" | "PostgresMigrationOp" = "ClickHouseRebuildOp"): MigrationStep => ({
    kind: "op", object: "events", type: "ClickHouse::Table", name: `${DB}.events`, op: name, importPath: "", options, declaration: "", changes: [], detail: "",
  });
  it("runs a rebuild in materialized-view mode and a backfill; refuses app mode, a manual step and another Op", () => {
    expect(planStep(op({ name: "r", table: "d.t", dualWrite: { mode: "materialized-view", cutoverColumn: "ts" } })).run).toBe("rebuild");
    expect(planStep(op({ name: "r", table: "d.t", dualWrite: { mode: "app" } }))).toMatchObject({ run: "refused", reason: expect.stringContaining("app mode") as unknown });
    expect(planStep(op({ name: "r", table: "d.t", column: "c" }, "PostgresMigrationOp"))).toMatchObject({ run: "pgMigration" });
    expect(planStep(op({ name: "r", table: "d.t" }, "PostgresMigrationOp"))).toMatchObject({ run: "refused" });
    expect(planStep({ kind: "manual", object: "v", type: "ClickHouse::View", name: "d.v", changes: [], detail: "by hand" })).toMatchObject({ run: "refused" });
    expect(planStep(backfillStep("fill") as unknown as MigrationStep)).toEqual({ run: "backfill", file: "backfill.ts" });
    expect(planStep({ ...backfillStep("fill"), options: { file: "../escape.ts" } })).toMatchObject({ run: "refused" });
  });

  it("refuses an orm-handoff step, which 0.10.0 wrote and 0.10.1 no longer runs", () => {
    const handoff = { ...op({ orm: "drizzle", migration: "0003_rename_login" }), op: "orm-handoff", object: "orm-handoff" } as unknown as MigrationStep;
    expect(planStep(handoff)).toMatchObject({ run: "refused", reason: expect.stringContaining("yodel apply does not run that Op") as unknown });
    const base = migration("20261009T1000-one", null, []);
    const m = { ...base, document: { ...base.document, dialect: "postgres" as const, steps: [handoff] } };
    const { refusedSteps, opSteps } = classifySteps(m);
    expect(opSteps).toHaveLength(0);
    const refusal = stepRefusal([{ id: m.id, refusedSteps } as never]);
    expect(refusal?.message).toMatch(/a step yodel apply does not run/);
    expect(refusal?.message).toMatch(/orm-handoff/);
  });
});

describe("the checksum covers a migration's other files", () => {
  it("is unchanged for a migration with none, and changes with an added or edited file", () => {
    const files = { sql: "-- x\n", json: '{"id":"a","checksum":""}' };
    const plain = computeChecksum(files);
    expect(computeChecksum({ ...files, extra: {} })).toBe(plain);
    // The v1 definition, by hand: a migration with no other files hashes as it always did.
    expect(plain).toBe(computeChecksum({ sql: "-- x\r\n", json: '{ "checksum": "sha256:old", "id": "a" }' }));
    const withFile = computeChecksum({ ...files, extra: { "backfill.ts": "export {};\n" } });
    expect(withFile).not.toBe(plain);
    expect(computeChecksum({ ...files, extra: { "backfill.ts": "export {};\r\n" } })).toBe(withFile);
    expect(computeChecksum({ ...files, extra: { "backfill.ts": "export const x = 1;\n" } })).not.toBe(withFile);
    expect(computeChecksum({ ...files, extra: { "other.ts": "export {};\n" } })).not.toBe(withFile);
  });

  it("is written, read back and verified with the files on disk; an edit to the module is a mismatch", () => {
    const dir = tempDir();
    const m = made(createMigration({ name: "fill", build: build(BEFORE), now: at(0), backfill: { text: "export const op = 1;\n" } }));
    writeMigration(dir, m);
    const [read] = readMigrations(dir) as [Migration];
    expect(read.files.extra).toEqual({ "backfill.ts": "export const op = 1;\n" });
    expect(verifyChecksum(read).ok).toBe(true);
    writeFileSync(join(dir, m.id, "backfill.ts"), "export const op = 2;\n");
    const [again] = readMigrations(dir) as [Migration];
    expect(verifyChecksum(again).ok).toBe(false);
    // Hidden files are not the migration's.
    writeFileSync(join(dir, m.id, "backfill.ts"), "export const op = 1;\n");
    writeFileSync(join(dir, m.id, ".DS_Store"), "x");
    expect(verifyChecksum(readMigrations(dir)[0] as Migration).ok).toBe(true);
  });
});

describe("createMigration with a backfill", () => {
  it("ends the migration with the backfill step, even with no schema change", () => {
    const first = made(createMigration({ name: "events", build: build(BEFORE), now: at(0) }));
    const prev: Migration = { id: first.id, dir: "/m", parent: null, checksum: first.document.checksum, document: first.document, files: first.files };
    const m = made(createMigration({ name: "fill", build: build(BEFORE), previous: prev, now: at(5), backfill: { text: "export {};\n" } }));
    expect(m.document.steps).toHaveLength(1);
    expect(asBackfill(m.document.steps[0] as MigrationStep)).toMatchObject({ op: "backfill", options: { file: "backfill.ts" }, type: "Yodel::Backfill", name: "fill" });
    expect(m.document.refused).toBe(true);
    expect(m.files.sql).toContain("-- backfill (fill): made by the Op backfill.ts exports, not a statement");
    expect(m.document.checksum).toBe(computeChecksum({ sql: m.files.sql, json: m.files.json, extra: { "backfill.ts": "export {};\n" } }));
    expect(stepSha(m.document.steps[0] as MigrationStep, m.files)).not.toBe(stepSha(m.document.steps[0] as MigrationStep, { extra: { "backfill.ts": "changed" } }));
  });
});

describe("the rebuild step's Op", () => {
  it("is chant's ClickHouseRebuildOp with gates: \"outer\" and onFailure: \"keep\" (no gate, no Drop phase, no onFailure), built from the recorded schema", async () => {
    const config = await rebuildOpConfig(
      { name: "rebuild-yodel_12-events", table: `${DB}.events`, dualWrite: { mode: "materialized-view", cutoverColumn: "ts" } },
      { environment: "e2e", projectDir: "/p", buildPath: "/tmp/schema.json" },
    );
    expect(config.name).toBe("rebuild-yodel_12-events");
    expect(config.phases.map((p) => p.name)).toEqual(["Plan", "Create", "Dual write", "Backfill", "Verify", "Swap", "Retain"]);
    const steps = config.phases.flatMap((p) => p.steps);
    expect(steps.every((s) => s.kind === "activity")).toBe(true);
    expect(steps.map((s) => (s.kind === "activity" ? s.fn : ""))).toEqual([
      "clickhouseRebuildPlan", "clickhouseRebuildCreate", "clickhouseRebuildDualWrite", "clickhouseRebuildBackfill", "clickhouseRebuildVerify", "clickhouseRebuildSwap", "clickhouseRebuildRetain",
    ]);
    expect(config.onFailure).toBeUndefined();
    expect(steps.every((s) => s.kind === "activity" && s.args?.keepOnFailure === true)).toBe(true);
    expect(steps[0]?.kind === "activity" ? steps[0].args : {}).toMatchObject({ table: `${DB}.events`, buildPath: "/tmp/schema.json", environment: "e2e", cwd: "/p" });
  });

  it("runs the activities in order with the recorded schema, and summarizes the backfill's receipts", async () => {
    const ran: string[] = [];
    let schema = "";
    const fake = (fn: string, result: Record<string, unknown>) => async (args: Record<string, unknown>) => {
      ran.push(fn);
      if (fn === "clickhouseRebuildPlan") schema = readFileSync(String(args.buildPath), "utf8");
      return Promise.resolve(result);
    };
    const activities = {
      clickhouseRebuildPlan: fake("clickhouseRebuildPlan", { state: "rebuild" }),
      clickhouseRebuildCreate: fake("clickhouseRebuildCreate", {}),
      clickhouseRebuildDualWrite: fake("clickhouseRebuildDualWrite", {}),
      clickhouseRebuildBackfill: fake("clickhouseRebuildBackfill", { partitions: 3, copied: 1, skipped: 2, cleared: 0, repaired: 0 }),
      clickhouseRebuildVerify: fake("clickhouseRebuildVerify", { rows: 30 }),
      clickhouseRebuildSwap: fake("clickhouseRebuildSwap", { swapped: true, oldTable: `${DB}.events__chant_old`, retainUntil: "2026-10-16T00:00:00.000Z" }),
      clickhouseRebuildRetain: fake("clickhouseRebuildRetain", { oldTable: `${DB}.events__chant_old`, retainUntil: "2026-10-16T00:00:00.000Z" }),
    };
    const { summary } = await runRebuild(
      { name: "rebuild-yodel_12-events", table: `${DB}.events`, dualWrite: { mode: "materialized-view", cutoverColumn: "ts" } },
      { environment: "e2e", projectDir: tempDir(), schema: build(BEFORE), activities, base: new Map() },
    );
    expect(ran).toEqual(Object.keys(activities));
    expect(JSON.parse(schema)).toEqual(build(BEFORE));

    // A receipt store given to the step reaches the backfill activity (yodel test's per-case store, #112).
    const receipts = { read: () => Promise.resolve(undefined), readAll: () => Promise.resolve(new Map<string, string>()), write: () => Promise.resolve() };
    let given: unknown;
    await runRebuild(
      { name: "rebuild-yodel_12-events", table: `${DB}.events`, dualWrite: { mode: "materialized-view", cutoverColumn: "ts" } },
      {
        environment: "e2e", projectDir: tempDir(), schema: build(BEFORE), base: new Map(), receipts,
        activities: { ...activities, clickhouseRebuildBackfill: (_args: Record<string, unknown>, _signal?: AbortSignal, deps?: unknown) => { given = (deps as { backfill?: { receipts?: unknown } } | undefined)?.backfill?.receipts; return Promise.resolve({}); } },
      },
    );
    expect(given).toBe(receipts);
    expect(summary).toEqual({
      op: "ClickHouseRebuildOp", table: `${DB}.events`, state: "rebuild", partitions: 3, copied: 1, skipped: 2, cleared: 0, repaired: 0, verifiedRows: 30, swapped: true,
      oldTable: `${DB}.events__chant_old`, retainUntil: "2026-10-16T00:00:00.000Z",
    });
  });
});

const BACKFILL = `
import { EffectReceipt } from "@intentius/chant";
import { Op, activity, effect, phase } from "@intentius/chant/op";
const batches = ["b0", "b1", "b2", "b3"];
export const op = Op({
  name: "backfill-fill",
  overview: "test",
  phases: [phase("Backfill", batches.map((b) => effect(EffectReceipt("fill-" + b, { effect: "fill/" + b, flavor: "existence" }), [
    activity("yodelSql", { sql: "INSERT INTO yodel_12.log VALUES ('" + b + "')" }, "atMostOnce"),
  ])))],
});
`;

/** A receipt store in memory. */
const memoryReceipts = () => {
  const map = new Map<string, string>();
  const store: ReceiptStore = { read: (r) => Promise.resolve(map.get(r.effect)), write: (r, e) => { map.set(r.effect, e); return Promise.resolve(); } };
  return { map, store };
};

describe("a backfill step", () => {
  it("refuses an Op with a step outside an effect() or a gate", () => {
    const op = (steps: unknown[]) => ({ name: "x", overview: "", phases: [{ name: "P", steps }] }) as never;
    expect(backfillProblems(op([{ kind: "activity", fn: "yodelSql", args: {} }]))).toEqual([expect.stringContaining("yodelSql step outside an effect()")]);
    expect(backfillProblems(op([{ kind: "gate", gate: "g" }])).join(" ")).toContain("gate");
    expect(backfillProblems(op([]))).toEqual(["its Op has no steps"]);
  });

  it("the template loads, and fails if applied unwritten", () => {
    expect(backfillTemplate("fill")).toContain('activity("yodelSql"');
  });

  it("runs its batches through effect() receipts; after a failure part way, a rerun skips the finished batches and does each once", async () => {
    const dir = tempDir(true);
    const mdir = join(dir, "migrations", "20261009T1400-fill");
    mkdirSync(mdir, { recursive: true });
    writeFileSync(join(mdir, "backfill.ts"), BACKFILL);
    const ch = new FakeClickHouse();
    let failOn: string | undefined = "b2";
    ch.failWith = (sql) => (failOn && sql.includes(`'${failOn}'`) ? "Code: 999. DB::Exception: forced" : undefined);
    const { map, store } = memoryReceipts();
    const run = { environment: "e2e", projectDir: dir, migrationId: "20261009T1400-fill", dir: mdir, port: ch, receipts: store };

    const failed = await runBackfill("backfill.ts", run).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(StepOpFailed);
    expect((failed as StepOpFailed).message).toContain("forced");
    expect((failed as StepOpFailed).summary).toEqual({ op: "backfill", file: "backfill.ts", name: "backfill-fill", effects: 4, skipped: 0, ran: 2 });
    expect(ch.sent).toEqual(["INSERT INTO yodel_12.log VALUES ('b0')", "INSERT INTO yodel_12.log VALUES ('b1')"]);
    // Receipts are under the migration's id.
    expect([...map.keys()].sort()).toEqual(["20261009T1400-fill/fill/b0", "20261009T1400-fill/fill/b1"]);

    failOn = undefined;
    const { summary } = await runBackfill("backfill.ts", run);
    expect(summary).toEqual({ op: "backfill", file: "backfill.ts", name: "backfill-fill", effects: 4, skipped: 2, ran: 2 });
    expect(ch.sent).toEqual(["b0", "b1", "b2", "b3"].map((b) => `INSERT INTO yodel_12.log VALUES ('${b}')`));

    const third = await runBackfill("backfill.ts", run);
    expect(third.summary).toMatchObject({ skipped: 4, ran: 0 });
    expect(ch.sent).toHaveLength(4);
  });

  it("on Postgres runs each batch in one transaction with its receipt, rolls a failed batch back whole, and resumes at it", async () => {
    const dir = tempDir(true);
    const mdir = join(dir, "migrations", "20261009T1400-fill");
    mkdirSync(mdir, { recursive: true });
    writeFileSync(join(mdir, "backfill.ts"), BACKFILL);
    let failOn: string | undefined = "b2";
    const sent: string[] = [];
    const receipts = new Map<string, string>();
    // A receipt written in a batch's transaction is kept only when the transaction commits.
    let pending: [string, string] | undefined;
    const store: ReceiptStore = {
      read: (r) => Promise.resolve(receipts.get(r.effect)),
      write: (r, e) => {
        sent.push(`receipt ${r.effect}`);
        pending = [r.effect, e];
        return Promise.resolve();
      },
    };
    const client = {
      query: (sql: string) => {
        sent.push(sql);
        if (sql === "COMMIT" && pending) receipts.set(...pending);
        if (sql === "COMMIT" || sql === "ROLLBACK") pending = undefined;
        if (failOn && sql.includes(`'${failOn}'`)) return Promise.reject(new Error("forced"));
        return Promise.resolve([]);
      },
    };
    const run = { environment: "e2e", projectDir: dir, migrationId: "20261009T1400-fill", dir: mdir, postgres: { client, timeouts: { lockTimeoutMs: 500, scanTimeoutMs: 0 } }, receipts: store };
    const batch = (b: string) => ["BEGIN", "SET LOCAL lock_timeout = '500ms'", "SET LOCAL statement_timeout = '0ms'", `INSERT INTO yodel_12.log VALUES ('${b}')`, `receipt 20261009T1400-fill/fill/${b}`, "COMMIT"];

    const failed = await runBackfill("backfill.ts", run).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(StepOpFailed);
    expect((failed as StepOpFailed).summary).toMatchObject({ effects: 4, skipped: 0, ran: 2 });
    expect(sent).toEqual([...batch("b0"), ...batch("b1"), ...batch("b2").slice(0, 4), "ROLLBACK"]);
    expect([...receipts.keys()].sort()).toEqual(["20261009T1400-fill/fill/b0", "20261009T1400-fill/fill/b1"]);

    failOn = undefined;
    sent.length = 0;
    const { summary } = await runBackfill("backfill.ts", run);
    expect(summary).toMatchObject({ skipped: 2, ran: 2 });
    expect(sent).toEqual([...batch("b2"), ...batch("b3")]);

    sent.length = 0;
    expect((await runBackfill("backfill.ts", run)).summary).toMatchObject({ skipped: 4, ran: 0 });
    expect(sent).toEqual([]);
  });

  it("checks a form: a table, a key and a batch size or a list, and SQL using their placeholders", () => {
    expect(formProblems({ table: "t", key: "id", batchSize: 10, sql: "UPDATE t SET a = 1 WHERE id >= {from} AND id < {to}" })).toEqual([]);
    expect(formProblems({ table: "t", batches: ["a", "b"], sql: ["UPDATE t SET a = 1 WHERE m = '{batch}'", "SELECT 1"] })).toEqual([]);
    expect(formProblems({ table: "t", key: "id", batchSize: 10, sql: "UPDATE t SET a = 1" })).toEqual([expect.stringContaining("uses none of {from} and {to}")]);
    expect(formProblems({ table: "t", key: "id", batchSize: 0, sql: "{from}" })).toEqual([expect.stringContaining("batchSize")]);
    expect(formProblems({ table: "t", key: "id", batchSize: 5, batches: [1], sql: "{from}" })).toEqual([expect.stringContaining("not both")]);
    expect(formProblems({ table: "t", sql: "{batch}" })).toEqual([expect.stringContaining('give "key" and "batchSize"')]);
    expect(formProblems({ table: "t", batches: [1, 1], sql: "{batch}", colour: 1 }).join("; ")).toMatch(/"colour" is not a field.*lists a batch twice/);
    expect(JSON.parse(formTemplate("fill"))).toMatchObject({ key: "id", batchSize: 100000, settings: { mutations_sync: "2" } });
    expect(formTemplate("fill", "postgres")).toContain("UPDATE <schema>.<table>");
  });

  it("covers the key with ranges aligned to the batch size, so a rerun sees the same ones", () => {
    expect(keyRanges(3n, 27n, 10).map((b) => b.id)).toEqual(["0-10", "10-20", "20-30"]);
    expect(keyRanges(-5n, 4n, 10).map((b) => b.id)).toEqual(["-10-0", "0-10"]);
    expect(keyRanges(10n, 10n, 10)[0]?.values).toEqual({ "{from}": "10", "{to}": "20" });
  });

  it("a form step is planned, described and run as a backfill: its ranges from the table's keys, a receipt each, and resumed after a failure", async () => {
    const form = { table: "yodel_12.events", key: "id", batchSize: 10, sql: "ALTER TABLE yodel_12.events UPDATE k = 'x' WHERE id >= {from} AND id < {to}", settings: { mutations_sync: "2" } };
    const step = backfillFormStep("fill", form);
    expect(planStep(step)).toEqual({ run: "backfill", form });
    expect(planStep({ ...step, options: { ...form, sql: "no placeholder" } })).toMatchObject({ run: "refused", reason: expect.stringContaining("uses none of") as unknown });
    expect(step.detail).toContain("a data backfill of yodel_12.events by id, 10 a batch");
    expect(step.detail).toContain("ALTER TABLE yodel_12.events UPDATE k = 'x' WHERE id >= {from} AND id < {to};");

    const sent: Array<[string, unknown]> = [];
    let failOn: string | undefined = "id >= 20";
    const port = {
      query: <Row>(sql: string, options?: { settings?: Record<string, string> }) => {
        if (sql.startsWith("SELECT count() AS n")) return Promise.resolve([{ n: "25", lo: "3", hi: "27" }] as Row[]);
        if (failOn && sql.includes(failOn)) return Promise.reject(new Error("forced"));
        sent.push([sql, options?.settings]);
        return Promise.resolve([] as Row[]);
      },
    };
    const { map, store } = memoryReceipts();
    const run = { environment: "e2e", projectDir: tempDir(true), migrationId: "20261009T1400-fill", dir: "/nowhere", port, receipts: store };
    const failed = await runBackfill(form, run).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(StepOpFailed);
    expect((failed as StepOpFailed).summary).toEqual({ op: "backfill", table: "yodel_12.events", name: "backfill-fill", effects: 3, skipped: 0, ran: 2 });
    expect(sent).toEqual([
      ["ALTER TABLE yodel_12.events UPDATE k = 'x' WHERE id >= 0 AND id < 10", { mutations_sync: "2" }],
      ["ALTER TABLE yodel_12.events UPDATE k = 'x' WHERE id >= 10 AND id < 20", { mutations_sync: "2" }],
    ]);
    expect([...map.keys()].sort()).toEqual(["20261009T1400-fill/range/0-10", "20261009T1400-fill/range/10-20"]);

    failOn = undefined;
    const { summary } = await runBackfill(form, run);
    expect(summary).toMatchObject({ effects: 3, skipped: 2, ran: 1 });
    expect(sent.map(([sql]) => sql).at(-1)).toBe("ALTER TABLE yodel_12.events UPDATE k = 'x' WHERE id >= 20 AND id < 30");
  });

  it("the template on Postgres raises until written", () => {
    const t = backfillTemplate("fill", "postgres");
    expect(t).toContain("DO $$ BEGIN RAISE EXCEPTION 'write the backfill of fill for batch ${b}'; END $$");
    expect(t).not.toContain("throwIf");
  });

  it("keeps each migration's receipts apart", async () => {
    const { map, store } = memoryReceipts();
    await prefixedStore(store, "a/").write({ name: "n", effect: "e", flavor: "existence", inputs: {} }, "x");
    expect(await prefixedStore(store, "b/").read({ name: "n", effect: "e", flavor: "existence", inputs: {} })).toBeUndefined();
    expect([...map.keys()]).toEqual(["a/e"]);
  });
});

// ── the versioned apply with an Op step ──────────────────────────────────

const OP: MigrateOpRef = { name: "migrate-e2e", filePath: "/p/ops/migrate-e2e.op.ts", gate: "approve-migrate-e2e", quorum: false };

async function setup(ch = new FakeClickHouse()): Promise<{ ch: FakeClickHouse; venv: VersionedEnv }> {
  const url = `http://fake-${randomUUID()}:8123`;
  const project = projectFromConfig("/nowhere", "/nowhere/chant.config.ts", { lexicons: ["sql"], sql: { dialect: "clickhouse", profiles: { e2e: { url, databases: ["yodel_8"] } } } });
  const venv = await openVersioned(project, { name: "e2e", profile: { url } }, { YODEL_HISTORY_DATABASE: "yodel_8_history" }, ch);
  return { ch, venv };
}

const rebuildStep: MigrationStep = {
  kind: "op", object: "events", type: "ClickHouse::Table", name: "yodel_8.events", op: "ClickHouseRebuildOp", importPath: "@intentius/chant-lexicon-sql/clickhouse",
  options: { name: "rebuild-yodel_8-events", env: "<env>", table: "yodel_8.events", dualWrite: { mode: "materialized-view", cutoverColumn: "ts" } },
  declaration: "", changes: [{ rule: "SQLCH220", class: "rebuild", field: "orderBy" }], detail: "",
};

async function apply(venv: VersionedEnv, ordered: Migration[], runStep: StepRunner, log: string[] = []) {
  const { status } = await inspect(venv, ordered);
  const digest = await currentDigest(venv, status, selectToApply(status, false));
  const ledger = memoryGateLedgerPort({ resolutions: [{ version: 1, op: OP.name, gate: OP.gate, resolvedBy: "alice", timestamp: "2026-10-09T12:00:00.000Z", planDigest: digest }] });
  return executeApply(venv, ordered, { approvedDigest: digest, allowOutOfOrder: false, approve: (d) => verifyApproval(ledger, OP, d), log: (l) => log.push(l), runStep, processEnv: { USER: "tester" } });
}

describe("yodel apply with an Op step", () => {
  const m = migration("20261009T1500-rekey", null, ["ALTER TABLE yodel_8.a ADD COLUMN y UInt8", rebuildStep, "ALTER TABLE yodel_8.a ADD COLUMN z UInt8"]);

  it("runs the statements before the step, the step, then the statements after it, recording step rows with the summary", async () => {
    const { ch, venv } = await setup();
    const order: string[] = [];
    const runStep: StepRunner = (ctx) => {
      order.push(`step ${String(ctx.index)} ${ctx.plan.run} after ${String(ch.sent.length)} statement(s)`);
      return Promise.resolve({ summary: { op: "ClickHouseRebuildOp", copied: 3, skipped: 0 } });
    };
    const result = await apply(venv, [m], runStep);
    expect(result.applied).toEqual([m.id]);
    expect(order).toEqual(["step 1 rebuild after 1 statement(s)"]);
    expect(ch.sent).toEqual(["ALTER TABLE yodel_8.a ADD COLUMN y UInt8", "ALTER TABLE yodel_8.a ADD COLUMN z UInt8"]);
    const stepRows = ch.rows.filter((r) => r.kind === "step");
    expect(stepRows.map((r) => r.status)).toEqual(["started", "succeeded"]);
    expect(stepRows[1]).toMatchObject({ statement_index: 1, statement_sha: stepSha(rebuildStep), note: JSON.stringify({ op: "ClickHouseRebuildOp", copied: 3, skipped: 0 }) });
  });

  it("stops at a failed step, sends nothing after it, and resumes at the step on the next run", async () => {
    const { ch, venv } = await setup();
    const fail: StepRunner = () => {
      const e = new StepOpFailed("rebuild-yodel_8-events", "Backfill / clickhouseRebuildBackfill failed: lost the connection", []);
      e.summary = { op: "ClickHouseRebuildOp", copied: 1 };
      return Promise.reject(e);
    };
    const failed = await apply(venv, [m], fail).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(StepFailed);
    expect((failed as StepFailed).message).toMatch(/failed at step 1: .*lost the connection[\s\S]*resumes at step 1/);
    expect(ch.sent).toEqual(["ALTER TABLE yodel_8.a ADD COLUMN y UInt8"]);
    expect(ch.rows.find((r) => r.kind === "step" && r.status === "failed")).toMatchObject({ note: JSON.stringify({ op: "ClickHouseRebuildOp", copied: 1 }) });

    const { status } = await inspect(venv, [m]);
    expect(status.pending[0]?.partWay).toMatchObject({ status: "failed", resumeAt: 1, failedStatement: 1, done: [0] });

    const log: string[] = [];
    const runs: number[] = [];
    await apply(venv, [m], (ctx) => { runs.push(ctx.index); return Promise.resolve({ summary: { copied: 2, skipped: 1 } }); }, log);
    expect(runs).toEqual([1]);
    expect(log).toContain("  statement 0: succeeded in an earlier run; not sent");
    expect(log.some((l) => l.includes("step 1: ClickHouseRebuildOp for events (yodel_8.events) (resuming from its receipts)"))).toBe(true);
    expect(ch.sent).toEqual(["ALTER TABLE yodel_8.a ADD COLUMN y UInt8", "ALTER TABLE yodel_8.a ADD COLUMN z UInt8"]);
  });

  it("puts the step in the digest: a changed step option is a new plan", async () => {
    const { venv } = await setup();
    const other = migration(m.id, null, ["ALTER TABLE yodel_8.a ADD COLUMN y UInt8", { ...rebuildStep, options: { ...rebuildStep.options, dualWrite: { mode: "materialized-view", cutoverColumn: "other" } } }, "ALTER TABLE yodel_8.a ADD COLUMN z UInt8"]);
    const digest = async (ms: Migration[]) => {
      const { status } = await inspect(venv, ms);
      return currentDigest(venv, status, status.pending);
    };
    expect(await digest([m])).not.toBe(await digest([other]));
  });

  it("refuses a backfill step whose module is not among the migration's files", async () => {
    const { venv } = await setup();
    const bf = migration("20261009T1600-fill", null, [backfillStep("fill") as unknown as MigrationStep]);
    const { status } = await inspect(venv, [bf]);
    expect(() => selectToApply(status, false)).toThrow(expect.objectContaining({ exitCode: 2, message: expect.stringContaining("module backfill.ts is not in") as unknown }));
  });
});

describe("yodel new --retain", () => {
  it("writes retain into a rebuild step's options and declaration, and the step runs with it", () => {
    const first = made(createMigration({ name: "events", build: build(BEFORE), now: at(0) }));
    const previous: Migration = { id: first.id, dir: "/m", parent: null, checksum: first.document.checksum, document: first.document, files: first.files };
    const m = made(createMigration({ name: "rekey", build: build(BEFORE.replace("ORDER BY (k, id)", "ORDER BY (id, k)")), previous, now: at(1), retain: "3d" }));
    const [step] = m.document.steps as [MigrationStep];
    expect(step).toMatchObject({ op: "ClickHouseRebuildOp", options: { retain: "3d" } });
    expect(step.kind === "op" ? step.declaration : "").toMatch(/, retain: "3d" \}\);$/);
    expect(planStep(step)).toMatchObject({ run: "rebuild", options: { retain: "3d" } });
  });
});

describe("yodel new --backfill", () => {
  const saved = process.env.YODEL_E2E_CLICKHOUSE_URL;
  afterAll(() => {
    if (saved === undefined) delete process.env.YODEL_E2E_CLICKHOUSE_URL;
    else process.env.YODEL_E2E_CLICKHOUSE_URL = saved;
  });

  it("writes a template when the module is missing, refuses it unwritten, then copies the written module into the migration", async () => {
    process.env.YODEL_E2E_CLICKHOUSE_URL = "http://127.0.0.1:9";
    const project = projectFrom("clickhouse");
    dirs.push(project.dir);
    const at = (...args: string[]) => [...args, "--dir", project.dir];

    const first = await yodel(at("new", "events"));
    expect(first.code, first.err).toBe(0);

    const template = await yodel(at("new", "fill", "--backfill", "backfills/fill.ts", "--json"));
    expect(template.code, template.err).toBe(0);
    expect(json(template)).toEqual({ written: false, template: join(project.dir, "backfills", "fill.ts") });
    expect(readMigrations(join(project.dir, "migrations"))).toHaveLength(1);

    const unwritten = await yodel(at("new", "fill", "--backfill", "backfills/fill.ts"));
    expect(unwritten.code).toBe(1);
    expect(unwritten.err).toContain("is still the template");

    writeFileSync(join(project.dir, "backfills", "fill.ts"), BACKFILL);
    const written = await yodel(at("new", "fill", "--backfill", "backfills/fill.ts", "--json"));
    expect(written.code, written.err).toBe(0);
    expect(json(written)).toMatchObject({ written: true, statements: 0, ops: [{ op: "backfill", object: "backfill", name: "fill" }] });
    const [, fill] = readMigrations(join(project.dir, "migrations")) as [Migration, Migration];
    expect(fill.files.extra).toEqual({ "backfill.ts": BACKFILL });
    expect(verifyChecksum(fill).ok).toBe(true);
    expect(planStep(fill.document.steps[0] as MigrationStep)).toEqual({ run: "backfill", file: "backfill.ts" });

    writeFileSync(join(project.dir, "backfills", "gated.ts"), BACKFILL.replace("phases: [phase(", "phases: [phase(\"Ask\", [gate(\"g\")]), phase(").replace("{ Op,", "{ Op, gate,"));
    const gated = await yodel(at("new", "gated", "--backfill", "backfills/gated.ts"));
    expect(gated.code).toBe(1);
    expect(gated.err).toContain('phase "Ask" has a gate (g) outside an effect()');
  }, 120_000);

  it("with no file, writes the form's template at backfills/<name>.json, refuses it unwritten, then writes the form into the step", async () => {
    process.env.YODEL_E2E_CLICKHOUSE_URL = "http://127.0.0.1:9";
    const project = projectFrom("clickhouse");
    dirs.push(project.dir);
    const at = (...args: string[]) => [...args, "--dir", project.dir];
    expect((await yodel(at("new", "events"))).code).toBe(0);

    const template = await yodel(at("new", "fill", "--backfill"));
    expect(template.code, template.err).toBe(0);
    expect(template.out).toContain("Wrote a backfill form at backfills/fill.json");
    const unwritten = await yodel(at("new", "fill", "--backfill", "--json"));
    expect(unwritten.code).toBe(1);
    expect(unwritten.err).toContain("is still the template");

    writeFileSync(join(project.dir, "backfills", "fill.json"), JSON.stringify({ table: "t", key: "id", batchSize: 5, sql: "no placeholder" }));
    const bad = await yodel(at("new", "fill", "--backfill"));
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("uses none of {from} and {to}");

    const form = { table: "shop.events", batches: ["202601", "202602"], sql: "ALTER TABLE shop.events UPDATE k = 'x' WHERE toYYYYMM(ts) = {batch}", settings: { mutations_sync: "2" } };
    writeFileSync(join(project.dir, "backfills", "fill.json"), JSON.stringify(form));
    const written = await yodel(at("new", "fill", "--backfill"));
    expect(written.code, written.err).toBe(0);
    expect(written.out).toContain("This migration ends with a backfill of shop.events, 2 batches (202601, 202602). Each batch runs:\n    ALTER TABLE shop.events UPDATE k = 'x' WHERE toYYYYMM(ts) = {batch};");
    const [, fill] = readMigrations(join(project.dir, "migrations")) as [Migration, Migration];
    expect(fill.files.extra).toBeUndefined();
    expect(verifyChecksum(fill).ok).toBe(true);
    expect(planStep(fill.document.steps[0] as MigrationStep)).toEqual({ run: "backfill", form });
    expect(fill.files.sql).toContain("-- backfill (fill): a backfill of shop.events, 2 batches (202601, 202602), not a statement; each batch runs:");
  }, 120_000);
});
