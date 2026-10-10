/**
 * Each command's `--json` output validates against its schema in schemas/
 * (#58). Commands that read no server run here, from fixture projects; the
 * ones that need a server are checked through the functions that build their
 * JSON, fed typed inputs. Under BREAK=1 each output loses a field its schema
 * requires before it is checked, and every check fails.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpStep, ManualStep, StatementStep } from "@intentius/chant-lexicon-sql/migration-statements";
import type { BuildOutput, BuiltObject } from "../src/chant/build.js";
import { driftFingerprint, driftFromLifecycle } from "../src/chant/drift.js";
import { planJson, type Plan } from "../src/chant/plan.js";
import { applyJson, type DeclarativeOutcome, type VersionedOutcome } from "../src/commands/apply.js";
import { driftJson } from "../src/commands/drift.js";
import { initJson } from "../src/commands/init.js";
import { repairJson } from "../src/commands/repair.js";
import type { Adopted } from "../src/init/adopt.js";
import type { LintReport } from "../src/lint/check.js";
import { lintJson } from "../src/lint/report.js";
import { createMigration, scanMigrations, writeMigration, type CreatedMigration, type Migration } from "../src/migrations/index.js";
import type { VersionedPlan } from "../src/pr/model.js";
import { planJsonVersioned } from "../src/pr/render.js";
import { replayJson, type ReplayResult } from "../src/replay/index.js";
import { COMMAND_SCHEMAS, SCHEMA_BASE, SCHEMA_NAMES, readSchema, schemaId, schemasDir, type SchemaName } from "../src/schemas.js";
import type { RuleResult } from "../src/versioned/policy.js";
import { statusJson, type StatusReport } from "../src/versioned/report.js";
import { compareHistory } from "../src/versioned/state.js";
import { deriveState } from "../src/history/index.js";
import { json, projectFrom, repoRoot, yodel } from "./helpers/run.js";

const broken = !!process.env.BREAK && process.env.BREAK !== "0";

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
for (const name of SCHEMA_NAMES) ajv.addSchema(readSchema(name));

/** BREAK=1: drop the first field of the document (of each item, for a list); every schema requires it. */
function breakDoc(doc: unknown): unknown {
  const drop = (o: unknown) => Object.fromEntries(Object.entries(o as Record<string, unknown>).slice(1));
  return Array.isArray(doc) ? doc.map(drop) : drop(doc);
}

/** The schema's errors for `doc`, empty when it validates. */
function problems(ref: string, doc: unknown): string[] {
  const validate = ajv.getSchema(ref);
  if (!validate) throw new Error(`no schema ${ref}`);
  const checked = broken ? breakDoc(doc) : doc;
  return validate(checked) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""} ${JSON.stringify(e.params)}`);
}

const expectValid = (name: SchemaName, doc: unknown) => {
  expect(problems(schemaId(name), doc), JSON.stringify(doc, null, 2)).toEqual([]);
};

describe("the schemas", () => {
  it("are every file in schemas/, each with its versioned $id and a description", () => {
    expect(readdirSync(schemasDir).sort()).toEqual(SCHEMA_NAMES.map((n) => `${n}.schema.json`).sort());
    for (const name of SCHEMA_NAMES) {
      const s = readSchema(name);
      expect(s.$id).toBe(`${SCHEMA_BASE}${name}.schema.json`);
      expect(SCHEMA_BASE).toMatch(/\/schemas\/v1\/$/);
      expect(s.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(s.description).toMatch(/^Version 1\./);
    }
  });

  it("ship in the package", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { files: string[] };
    expect(pkg.files).toContain("schemas");
  });

  it("name a schema for every command that takes --json", async () => {
    const withJson: string[] = [];
    for (const c of (await import("../src/commands/index.js")).commands) {
      const help = await yodel([c.name, "--help"]);
      if (/^\s+--json\b/m.test(help.out)) withJson.push(c.name);
    }
    expect(withJson.sort()).toEqual(Object.keys(COMMAND_SCHEMAS).filter((k) => !k.includes(" ")).sort());
  });
});

// ---------- inputs ----------

const server = { dialect: "clickhouse" as const, address: "ch:8123", version: "25.3.2.39" };
const statement: StatementStep = { kind: "statement", object: "yodel_58.events", type: "ClickHouse::Table", name: "yodel_58.events", sql: "ALTER TABLE yodel_58.events ADD COLUMN note String", rule: "SQLCH201", class: "online", transactional: false };
const change = { rule: "SQLCH301", class: "rebuild", field: "orderBy", before: "id", after: "(ts, id)" };
const opStep: OpStep = { kind: "op", object: "yodel_58.events", type: "ClickHouse::Table", name: "yodel_58.events", op: "ClickHouseRebuildOp", importPath: "@intentius/chant-lexicon-sql", options: {}, declaration: "new ClickHouseRebuildOp({})", changes: [change], detail: "rebuild events with the new sort key" };
const manualStep: ManualStep = { kind: "manual", object: "yodel_58.events", type: "ClickHouse::Table", name: "yodel_58.events", changes: [{ ...change, destructive: true }], detail: "drop the old column by hand" };
const migration = {} as Migration;

const statusReport = (dialect: "clickhouse" | "postgres"): StatusReport => ({
  environment: "dev",
  server: dialect === "clickhouse" ? server : { dialect, address: "pg:5432/db", version: "18.6" },
  dialect,
  location: { database: "yodeler", topology: { kind: "single" } },
  topology: "single (default)",
  status: {
    applied: [
      { id: "20261010T0900-init", checksum: "sha256:a", appliedBy: "ci@host", recordedAt: "2026-10-10 09:00:00.000000", planDigest: "sha256:d", index: 0, repairs: [{ checksum: "sha256:b", by: "bob@laptop", at: "2026-10-10 10:00:00.000000", reason: "reformatted", seq: 9 }] },
      { id: "20261010T0901-gone", checksum: "sha256:c", appliedBy: "ci@host", recordedAt: "2026-10-10 09:01:00.000000", planDigest: "sha256:d", index: undefined },
    ],
    pending: [
      {
        id: "20261010T0910-rebuild",
        index: 1,
        checksum: "sha256:e",
        outOfOrder: true,
        partWay: { status: "failed", resumeAt: 1, failedStatement: 1, error: "timeout", done: [0], edited: false },
        opSteps: [{ index: 2, step: opStep }],
        refusedSteps: [{ index: 3, step: manualStep, reason: "a manual step" }],
        migration,
      },
      { id: "20261010T0920-note", index: 2, checksum: "sha256:f", outOfOrder: false, partWay: { status: "started", resumeAt: 0, failedStatement: undefined, error: "", done: [], edited: true }, opSteps: [], refusedSteps: [], migration },
    ],
    mismatches: [
      { kind: "applied", id: "20261010T0900-init", recorded: "sha256:a", actual: "sha256:x", message: "changed" },
      { kind: "part-way", id: "20261010T0910-rebuild", statement: 0, message: "changed" },
      { kind: "missing", id: "20261010T0901-gone", recorded: "sha256:c", message: "gone" },
    ],
  },
  digest: "sha256:d",
  refusal: { exitCode: 4, message: "a checksum mismatch" },
});

const chDiff = { changes: [{ object: "events (yodel_58.events)", field: "orderBy", before: "id", after: "(ts, id)", rule: "SQLCH301", class: "rebuild" }], rebuilds: [], hints: ["a drop and an add look like a rename"] };
const declarative = (dialect: "clickhouse" | "postgres"): Plan =>
  dialect === "clickhouse"
    ? ({ environment: "dev", dialect, diff: chDiff, refused: [] } as unknown as Plan)
    : ({ environment: "dev", dialect, diff: { changes: [{ object: "orders (shop.orders)", field: "columns.amount.type", rule: "SQLPG310", class: "rewrite", destructive: true }], refused: [], hints: [] }, refused: [] } as unknown as Plan);

const policy: RuleResult[] = [
  { id: "no-drops", description: "no destructive step in prod", outcome: "overridden", reasons: ["step 0 of 20261010T0910-rebuild is destructive"], override: { rule: "no-drops", by: "alice", at: "2026-10-10T09:00:00Z", reason: "the column was never read", digest: "sha256:d" } },
  { id: "online-only", outcome: "allowed", reasons: [] },
];

const versionedPlan = (approval: VersionedPlan["approval"]): VersionedPlan => ({
  environment: "prod",
  dialect: "clickhouse",
  server,
  history: "yodeler.history (single (default))",
  appliedCount: 3,
  pending: [
    {
      id: "20261010T0910-rebuild",
      outOfOrder: false,
      resumeAt: 1,
      checks: [{ name: "no-nulls", sql: "SELECT count() FROM t WHERE x IS NULL", expect: { max: 0 } }, { name: "empty", sql: "SELECT 1 WHERE 0", expect: "empty" }],
      steps: [
        { index: 0, step: { ...statement, sql: "CREATE USER u IDENTIFIED BY PASSWORD 'hunter2'", destructive: true }, done: true },
        { index: 1, step: opStep, done: false },
        { index: 2, step: manualStep, done: false, refused: "a manual step" },
      ],
    },
  ],
  problems: ["20261010T0905-x is out of order"],
  digest: "sha256:d",
  approval,
  sinceLast: { approved: "sha256:old", now: "sha256:d", confirmed: true, changes: [{ part: "pending", message: "a migration was added" }] },
  notes: ["the history is read from the reader's credentials"],
  policy,
});

// ---------- the commands ----------

describe("each command's --json output validates against its schema", () => {
  const EMULATOR_ENV = ["YODEL_E2E_CLICKHOUSE_URL", "YODEL_E2E_POSTGRES_URL"];
  const saved = Object.fromEntries(EMULATOR_ENV.map((k) => [k, process.env[k]]));
  beforeAll(() => {
    // Nothing here reads a server; a profile that reached for one would fail.
    process.env.YODEL_E2E_CLICKHOUSE_URL = "http://127.0.0.1:9";
    process.env.YODEL_E2E_POSTGRES_URL = "postgres://127.0.0.1:9/postgres";
  });
  afterAll(() => {
    for (const k of EMULATOR_ENV) {
      const v = saved[k];
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    }
  });

  it("status, on both dialects", () => {
    expectValid("status", statusJson(statusReport("clickhouse")));
    expectValid("status", statusJson(statusReport("postgres")));
    expectValid("status", statusJson({ environment: "dev", location: { database: "yodeler", topology: { kind: "single" } }, status: { applied: [], pending: [], mismatches: [] } }));
  });

  it("plan, declarative on both dialects and versioned", () => {
    expectValid("plan", { ...planJson(declarative("clickhouse")), server });
    expectValid("plan", planJson(declarative("postgres")));
    expectValid(
      "plan",
      planJsonVersioned(
        versionedPlan({
          kind: "op",
          op: "migrate-prod",
          gate: "approve",
          command: "chant approve migrate-prod approve --plan sha256:d",
          latest: { digest: "sha256:old", by: "alice", at: "2026-10-10T09:00:00Z", holds: false, sameDigest: false, askedAgain: { at: "2026-10-10T09:30:00Z", digest: "sha256:old" }, moved: { approved: "sha256:old", now: "sha256:d", confirmed: false, changes: [{ part: "live", message: "the live schema moved" }] } },
        }),
      ),
    );
    expectValid("plan", planJsonVersioned(versionedPlan({ kind: "no-op", message: "no migrations Op for prod\n\ndeclare one" })));
    const wave = { wave: 2, gate: "on-destructive" as const, base: "a".repeat(40), baseSource: "HEAD^1", destructiveSteps: [{ migration: "m1", step: 0, what: "drop", why: "destructive" }], waits: true, planDigest: "sha256:w", digest: "sha256:s", approve: "chant approve yodel-apply yodel-apply-wave-2 --plan sha256:s", promotions: [{ env: "staging", from: "yodel.config.ts", migrations: [{ id: "m1", checksum: "c", ran: "applied with another checksum" as const, recorded: "c0" }] }], blocked: true };
    expectValid("plan", planJsonVersioned({ ...versionedPlan({ kind: "no-op", message: "no migrations Op for prod" }), wave }));
    expectValid("plan", planJsonVersioned({ environment: "dev", dialect: "postgres", appliedCount: 0, pending: [], problems: [], refusal: { exitCode: 4, message: "a fork" }, notes: [] }));
  });

  it("apply: versioned (each outcome), --execute and declarative", () => {
    // Through applyJson, which yodel apply prints with.
    const report = statusReport("clickhouse");
    const outcomes: VersionedOutcome[] = [
      { status: "planned" },
      { status: "unchanged" },
      { status: "refused" },
      { status: "refused", preChecks: { migration: "20261010T0910-rebuild", checks: [{ name: "no-nulls", passed: false, detail: "3 rows" }] } },
      { status: "refused", refusal: { exitCode: 4, message: "refused: prod applies only migrations staging applied first" } },
      { status: "denied", policy: [{ id: "online-only", outcome: "denied", reasons: ["a rebuild is not online"] }] },
      { status: "stood-down", stoodDown: "standing down: main on origin is at b, newer than this run's a" },
      { status: "stood-down", stoodDown: "standing down", op: "migrate-dev" },
      { status: "gated", op: "migrate-dev", gate: "approve", moved: { approved: "sha256:old", by: "alice", at: "2026-10-10T09:00:00Z", confirmed: true, changes: [], askedAgain: { at: "2026-10-10T09:30:00Z", digest: "sha256:old" } }, approve: "chant approve migrate-dev approve --plan sha256:d", gatePlanDigest: "sha256:d" },
      { status: "failed", op: "migrate-dev", exitCode: 5, chantExitCode: 1 },
      { status: "applied", op: "migrate-dev", appliedNow: ["20261010T0910-rebuild"] },
    ];
    for (const outcome of outcomes) expectValid("apply", applyJson({ mode: "versioned", report, outcome }));
    const lock = { kind: "keeper" as const, where: "/yodel/locks/dev" };
    expectValid("apply", applyJson({ mode: "execute", environment: "dev", planDigest: "sha256:d", result: { applied: ["a"], skipped: [{ id: "a", statement: 0 }], lock } }));
    expectValid("apply", applyJson({ mode: "execute", environment: "dev", planDigest: "sha256:d", result: { applied: ["a"], skipped: [], lock: { ...lock, notice: "local lock", waited: { ms: 5000, heldBy: "ci@other", where: "/yodel/locks/dev" } } } }));
    expectValid("apply", applyJson({ mode: "execute", environment: "dev", planDigest: "sha256:d", result: { applied: [], skipped: [], lock: { kind: "local", where: "(not taken: this run stood down)" }, stoodDown: "standing down" } }));
    // --wave-apply, and the plan file --wave-plan writes (src/waves/).
    expectValid("apply", applyJson({ mode: "execute", environment: "dev", planDigest: "sha256:d", wavePlanDigest: "sha256:w", result: { applied: ["a"], skipped: [], lock: { kind: "advisory", where: "Postgres advisory lock" } } }));
    expectValid("apply", applyJson({ mode: "wave-plan", plan: { planDigest: "sha256:w", destructive: true, empty: false, environment: "prod", migrations: "sha256:d", gate: "on-destructive", base: "a".repeat(40), pending: ["m1"], destructiveSteps: [{ migration: "m1", step: 0, what: "drop", why: "destructive" }], requires: [{ env: "staging", applied: [{ id: "m1", checksum: "c" }] }] } }));
    const plan = planJson(declarative("clickhouse"));
    const declared: DeclarativeOutcome[] = [
      { status: "refused", plan },
      { status: "unchanged", plan },
      { status: "gated", gate: "approve", approve: "chant approve apply-dev approve --plan sha256:d", planDigest: "sha256:d", plan },
      { status: "failed", exitCode: 1, plan },
      { status: "incomplete", plan, remaining: plan },
      { status: "applied", plan },
    ];
    for (const outcome of declared) {
      expectValid("apply", applyJson({ mode: "declarative", environment: "dev", dialect: "clickhouse", server, op: "apply-dev", outcome }));
    }
    expectValid("apply", applyJson({ mode: "declarative", environment: "dev", dialect: "postgres", op: "apply-dev", outcome: { status: "applied", plan: planJson(declarative("postgres")) } }));
  });

  it("lint, on a fork and with silences, and with each replay outcome", async () => {
    const { dir, dispose } = projectFrom("lint-clickhouse");
    try {
      const migrations = join(dir, "migrations");
      const db: BuiltObject = { export: "db", type: "ClickHouse::Database", ddl: "CREATE DATABASE yodel_58 ENGINE = Atomic", dependsOn: [] };
      const events = (columns: string): BuildOutput => ({ dialect: "clickhouse", objects: [db, { export: "events", type: "ClickHouse::Table", ddl: `CREATE TABLE yodel_58.events (${columns}) ENGINE = MergeTree ORDER BY id`, dependsOn: ["db"] }] });
      const add = (name: string, build: BuildOutput, minute: number, parent?: CreatedMigration): CreatedMigration => {
        const previous = parent ? scanMigrations(migrations).migrations.find((m) => m.id === parent.id) : undefined;
        const m = createMigration({ name, build, previous, now: new Date(Date.UTC(2026, 9, 10, 9, minute)) });
        if (m.id === undefined) throw new Error(`no change for ${name}`);
        writeMigration(migrations, m);
        return m;
      };
      const first = add("create", events("id UInt64, old String"), 0);
      const dropped = add("drop-old", events("id UInt64"), 1, first);
      const sql = join(migrations, dropped.id, "migration.sql");
      writeFileSync(sql, readFileSync(sql, "utf8").replace(/^(ALTER TABLE)/m, "-- yodel:allow destructive the column was never read\n$1"));
      const clean = await yodel(["lint", "--json", "--dir", dir, "--update-checksum", dropped.id]);
      expect(json(clean)).toMatchObject({ silenced: 1, silences: { [dropped.id]: [{ rule: "destructive" }] } });
      expectValid("lint", json(clean));
      add("fork", events("id UInt64, old String, b String DEFAULT ''"), 2, first);
      const fork = await yodel(["lint", "--json", "--dir", dir]);
      expect(fork.code).toBe(3);
      expectValid("lint", json(fork));

      const rules = await yodel(["lint", "--rules", "--json", "--dir", dir]);
      expectValid("lint-rules", json(rules));
    } finally {
      dispose();
    }

    const report: LintReport = { dir: "/p/migrations", dialect: "postgres", environment: "dev", migrations: ["a"], findings: [{ rule: "replay", level: "error", message: "differs", migration: "a", step: 0, object: "shop.orders", line: 3 }], silences: {}, errors: 1, warnings: 0, silenced: 0 };
    const base = { dialect: "postgres" as const, where: "pg:5432/yodel_replay", scope: ["shop"], reset: true, kept: false, total: 2 };
    const one = { id: "a", statements: 2, ran: ["step 1: backfill"], skipped: ["step 2: manual (a person runs it)"] };
    const results: ReplayResult[] = [
      { ...base, matched: [one], outcome: "matches" },
      { ...base, matched: [], outcome: "differs", migration: one, changes: [{ object: "shop.orders", field: "columns.amount.type", before: "integer", after: "bigint", rule: "SQLPG310", class: "rewrite" }] },
      { ...base, matched: [one], outcome: "failed", migration: "b", step: 1, error: "relation does not exist" },
      { ...base, matched: [one], outcome: "unreplayable", migration: "b", step: 0, reason: "an Op step" },
    ];
    for (const r of results) expectValid("lint", { ...lintJson(report), replay: replayJson(r) });
  }, 60_000);

  it("drift", () => {
    // Through driftJson, which yodel drift prints with.
    const doc = {
      environment: "dev",
      lexicons: {
        sql: {
          resources: { missing: ["ordersStatus"], unobserved: [{ name: "audit", reason: "no credentials" }] },
          deep: { drifted: [{ name: "events", type: "ClickHouse::Table", changes: [{ path: "ttl", kind: "changed", declared: "ts + INTERVAL 90 DAY", live: "ts + toIntervalDay(30)" }] }], unobserved: [] },
        },
      },
    };
    const result = driftFromLifecycle("dev", doc);
    result.columns = { events: ["id", "ts"] };
    result.lockWait = "waited 5s (lockTimeoutMs) for a lock on shop.orders";
    result.against = { source: "history", migration: "20261010T0900-init" };
    const parts = { dialect: "clickhouse" as const, server, drifted: true, fingerprint: driftFingerprint(result) };
    const issue = { number: 7, title: "drift on dev", body: "", state: "open" as const, url: "https://forge/o/r/issues/7" };
    for (const action of [undefined, { action: "none" as const }, { action: "opened" as const, issue }, { action: "left" as const, why: "the drift could not be read" }, { action: "left" as const, why: "x", issue }]) {
      expectValid("drift", driftJson(result, { ...parts, issue: action }));
    }
    expectValid("drift", driftJson(result, { ...parts, issueError: "403 from the forge" }));
    const clean = { ...driftFromLifecycle("dev", { lexicons: { sql: {} } }), against: { source: "src" as const } };
    expectValid("drift", driftJson(clean, { dialect: "postgres", drifted: false, fingerprint: driftFingerprint(clean) }));
  });

  it("init", () => {
    const adopted = {
      environment: "dev",
      dialect: "postgres",
      objects: ["table shop.orders"],
      schemaFiles: ["src/schema.ts"],
      migrationPath: "migrations/20261010T0900-baseline",
      baseline: { id: "20261010T0900-baseline", checksum: "sha256:a", statements: 3 },
      recorded: { database: "yodeler", row: { seq: 1, note: "baseline", applied_by: "alice@laptop" }, lock: { kind: "advisory", where: "pg" } },
      warnings: [],
    } as unknown as Adopted;
    expectValid("init", initJson(adopted));
  });

  it("new: written, unchanged, a backfill template and a kept --replace", async () => {
    const { dir, dispose } = projectFrom("clickhouse");
    try {
      const first = await yodel(["new", "init", "--json", "--dir", dir]);
      expect(first.code, first.err).toBe(0);
      expectValid("new", json(first));
      const again = await yodel(["new", "again", "--json", "--dir", dir]);
      expectValid("new", json(again));
    } finally {
      dispose();
    }
    expectValid("new", { written: false, template: "/p/backfills/fill.ts" });
    expectValid("new", { written: false, replaced: null, kept: "20261010T0900-init" });
  }, 60_000);

  it("rebase: nothing to do, and a fork moved", async () => {
    const { dir, dispose } = projectFrom("clickhouse-versioned");
    try {
      const nothing = await yodel(["rebase", "--json", "--dir", dir]);
      expect(nothing.code, nothing.err).toBe(0);
      expectValid("rebase", json(nothing));

      const migrations = join(dir, "migrations");
      const db: BuiltObject = { export: "db", type: "ClickHouse::Database", ddl: "CREATE DATABASE yodel_58 ENGINE = Atomic", dependsOn: [] };
      const table = (name: string): BuiltObject => ({ export: name, type: "ClickHouse::Table", ddl: `CREATE TABLE yodel_58.${name} (id UInt64) ENGINE = MergeTree ORDER BY id`, dependsOn: ["db"] });
      const add = (name: string, objects: BuiltObject[], minute: number, previous?: Migration) => {
        const made = createMigration({ name, build: { dialect: "clickhouse", objects: [db, ...objects] }, previous, now: new Date(Date.UTC(2026, 9, 10, 10, minute)) });
        if (made.id === undefined) throw new Error(`no change for ${name}`);
        writeMigration(migrations, made);
        return scanMigrations(migrations).migrations.find((m) => m.id === made.id) as Migration;
      };
      const tip = scanMigrations(migrations).ordered?.at(-1);
      const one = add("one", [table("a")], 0, tip);
      add("add-b", [table("a"), table("b")], 10, one);
      add("add-c", [table("a"), table("c")], 20, one);
      const moved = await yodel(["rebase", "--json", "--dir", dir]);
      expect(moved.code, moved.err).toBe(0);
      expectValid("rebase", json(moved));
    } finally {
      dispose();
    }
  }, 60_000);

  it("checkpoint: the checkpoint written, and the status of a fresh environment that starts at it", async () => {
    const { dir, dispose } = projectFrom("clickhouse-versioned");
    try {
      const migrations = join(dir, "migrations");
      const db: BuiltObject = { export: "db", type: "ClickHouse::Database", ddl: "CREATE DATABASE yodel_63 ENGINE = Atomic", dependsOn: [] };
      const made = createMigration({ name: "one", build: { dialect: "clickhouse", objects: [db] }, now: new Date(Date.UTC(2026, 9, 10, 10, 0)) });
      if (made.id === undefined) throw new Error("no change");
      writeMigration(migrations, made);
      const ran = await yodel(["checkpoint", "base", "--json", "--dir", dir]);
      expect(ran.code, ran.err).toBe(0);
      expectValid("checkpoint", json(ran));
      const status = compareHistory(scanMigrations(migrations).ordered ?? [], deriveState([]));
      expect(status.skipped).toEqual([{ id: made.id, reason: "covered", checkpoint: (json(ran) as { id: string }).id }]);
      expectValid("status", statusJson({ ...statusReport("clickhouse"), status }));
    } finally {
      dispose();
    }
  }, 60_000);

  it("repair", () => {
    expectValid("repair", repairJson({ id: "20261010T0900-init", environment: "prod", oldChecksum: "sha256:a", newChecksum: "sha256:b", reason: "a server upgrade reformatted it", seq: 12, runId: "r-1", migrationJsonUpdated: true }));
  });
});
