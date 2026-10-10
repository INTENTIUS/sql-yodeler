import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BuildOutput, BuiltObject } from "../src/chant/build.js";
import { createMigration, MIGRATION_JSON, MIGRATION_SQL, newestMigration, readMigrations, scanMigrations, serializeDocument, writeMigration, type CreatedMigration, type Migration, type MigrationDocument } from "../src/migrations/index.js";
import { lintMigrations, lintSettings, LINT_RULES, mapMigrationSql, migrationSilences, silenceableRules, updateChecksum, type Finding, type LintOptions, type ProjectRule } from "../src/lint/index.js";
import { compareHistory } from "../src/versioned/state.js";
import { deriveState, MIGRATION_ROW, type HistoryRow } from "../src/history/index.js";

// ── builds ─────────────────────────────────────────────────────────────

const chDb: BuiltObject = { export: "db", type: "ClickHouse::Database", ddl: "CREATE DATABASE yodel_14 ENGINE = Atomic", dependsOn: [] };
const chEvents = (columns: string, orderBy = "id"): BuiltObject => ({
  export: "events",
  type: "ClickHouse::Table",
  ddl: `CREATE TABLE yodel_14.events (${columns}) ENGINE = MergeTree ORDER BY ${orderBy}`,
  dependsOn: ["db"],
});
const ch = (...objects: BuiltObject[]): BuildOutput => ({ dialect: "clickhouse", objects: [chDb, ...objects] });

const pgSchema: BuiltObject = { export: "app", type: "Postgres::Schema", ddl: "CREATE SCHEMA yodel_14", dependsOn: [] };
const pgCustomers: BuiltObject = { export: "customers", type: "Postgres::Table", ddl: "CREATE TABLE yodel_14.customers (id bigint PRIMARY KEY)", dependsOn: ["app"] };
const pgOrders = (columns: string): BuiltObject => ({ export: "orders", type: "Postgres::Table", ddl: `CREATE TABLE yodel_14.orders (\n  id bigint PRIMARY KEY,\n  ${columns}\n)`, dependsOn: ["app"] });
const pgIndex = (ddl: string): BuiltObject => ({ export: "ix", type: "Postgres::Index", ddl, dependsOn: ["orders"] });
const pg = (...objects: BuiltObject[]): BuildOutput => ({ dialect: "postgres", postgresMajor: 18, objects: [pgSchema, pgCustomers, ...objects] });

// ── a migrations directory ─────────────────────────────────────────────

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "yodel-lint-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const at = (minute: number) => new Date(Date.UTC(2026, 9, 9, 12, minute));

/** Writes one migration per build, each following the newest on disk; returns them. */
function chain(dir: string, builds: Array<[string, BuildOutput]>, start = 0): CreatedMigration[] {
  return builds.map(([name, build], i) => {
    const previous = newestMigration(readMigrations(dir));
    const m = createMigration({ name, build, previous, now: at(start + i) });
    if (m.id === undefined) throw new Error(`no change for ${name}`);
    writeMigration(dir, m);
    return m;
  });
}

const read = (dir: string, id: string): Migration => {
  const m = scanMigrations(dir).migrations.find((x) => x.id === id);
  if (!m) throw new Error(`no ${id}`);
  return m;
};

/** Edits a migration's migration.sql, then records the new checksum as an author would before it is applied. */
function editSql(dir: string, id: string, edit: (sql: string) => string, sign = true): void {
  const path = join(dir, id, MIGRATION_SQL);
  writeFileSync(path, edit(readFileSync(path, "utf8")));
  if (sign) updateChecksum(read(dir, id));
}

/** Rewrites migration.json, keeping its checksum valid. */
function editDocument(dir: string, id: string, edit: (doc: MigrationDocument) => MigrationDocument): void {
  const path = join(dir, id, MIGRATION_JSON);
  writeFileSync(path, serializeDocument(edit(JSON.parse(readFileSync(path, "utf8")) as MigrationDocument)));
  updateChecksum(read(dir, id));
}

/** Puts `line` on its own line just above the line that holds `marker`. */
const above = (marker: string, line: string) => (sql: string) => {
  const at = sql.indexOf(marker);
  if (at === -1) throw new Error(`no ${marker} in\n${sql}`);
  const start = sql.lastIndexOf("\n", at) + 1;
  return `${sql.slice(0, start)}${line}\n${sql.slice(start)}`;
};

const lint = (dir: string, options: LintOptions = {}) => lintMigrations(dir, options);
const rules = (findings: readonly Finding[]) => findings.map((f) => f.rule);
const live = (findings: readonly Finding[]) => findings.filter((f) => f.silenced === undefined);

// ── tests ──────────────────────────────────────────────────────────────

describe("yodel lint: a clean directory", () => {
  it("has no findings for additive ClickHouse migrations", async () => {
    const dir = tempDir();
    chain(dir, [
      ["create", ch(chEvents("id UInt64"))],
      ["add-kind", ch(chEvents("id UInt64, kind String DEFAULT ''"))],
    ]);
    const report = await lint(dir, { dialect: "clickhouse" });
    expect(report.findings).toEqual([]);
    expect(report.errors).toBe(0);
    expect(report.migrations).toHaveLength(2);
  });

  it("has no findings for an empty or missing directory", async () => {
    const report = await lint(join(tempDir(), "migrations"));
    expect(report).toMatchObject({ migrations: [], findings: [], errors: 0 });
  });
});

describe("yodel lint: ordering and integrity", () => {
  it("names both migrations that follow the same parent (a fork)", async () => {
    const dir = tempDir();
    const [first] = chain(dir, [["create", ch(chEvents("id UInt64"))]]);
    // Two branches, each adding a migration on the same parent.
    const a = createMigration({ name: "add-a", build: ch(chEvents("id UInt64, a String DEFAULT ''")), previous: read(dir, first?.id ?? ""), now: at(10) });
    const b = createMigration({ name: "add-b", build: ch(chEvents("id UInt64, b String DEFAULT ''")), previous: read(dir, first?.id ?? ""), now: at(11) });
    if (a.id === undefined || b.id === undefined) throw new Error("expected migrations");
    writeMigration(dir, a);
    writeMigration(dir, b);

    const report = await lint(dir);
    const fork = report.findings.filter((f) => f.rule === "fork");
    expect(fork).toHaveLength(1);
    expect(fork[0]?.level).toBe("error");
    expect(fork[0]?.message).toContain(a.id);
    expect(fork[0]?.message).toContain(b.id);
    expect(fork[0]?.message).toContain(`both follow ${String(first?.id)}`);
    expect(report.errors).toBe(1);
  });

  it("reports a missing parent and a migration of another dialect as directory errors", async () => {
    const dir = tempDir();
    const [m] = chain(dir, [["create", ch(chEvents("id UInt64"))]]);
    editDocument(dir, m?.id ?? "", (doc) => ({ ...doc, parent: "20261001T0000-gone" }));
    const report = await lint(dir, { dialect: "postgres" });
    expect(report.findings.filter((f) => f.rule === "directory").map((f) => f.message)).toEqual([
      expect.stringContaining("follows 20261001T0000-gone, which is not in the directory"),
      expect.stringContaining("is a clickhouse migration, but the project's dialect is postgres"),
    ]);
  });

  it("reports an edited migration whose checksum no longer matches, until the new one is recorded", async () => {
    const dir = tempDir();
    const [m] = chain(dir, [["create", ch(chEvents("id UInt64"))]]);
    const id = m?.id ?? "";
    editSql(dir, id, (sql) => `${sql}-- a note\n`, false);

    const before = await lint(dir);
    expect(rules(before.findings)).toEqual(["checksum"]);
    expect(before.findings[0]).toMatchObject({ level: "error", migration: id });
    expect(before.findings[0]?.message).toContain(`yodel lint --update-checksum ${id}`);
    expect(before.findings[0]?.message).toContain("yodel repair");

    expect(updateChecksum(read(dir, id))?.to).toMatch(/^sha256:/);
    expect(updateChecksum(read(dir, id))).toBeUndefined();
    expect((await lint(dir)).findings).toEqual([]);
  });

  it("with an environment's history: an applied migration edited is an error, a pending one's edit a warning", async () => {
    const dir = tempDir();
    const [one, two] = chain(dir, [
      ["create", ch(chEvents("id UInt64"))],
      ["add-kind", ch(chEvents("id UInt64, kind String DEFAULT ''"))],
    ]);
    const ordered = readMigrations(dir);
    const row = (seq: number, m: CreatedMigration): HistoryRow => ({
      seq,
      run_id: "r",
      kind: "migration",
      migration_id: m.id,
      parent: m.document.parent ?? "",
      checksum: m.document.checksum,
      statement_index: MIGRATION_ROW,
      statement_sha: "",
      status: "succeeded",
      error: "",
      applied_by: "test",
      plan_digest: "",
      silences: "[]",
      note: "",
      recorded_at: "2026-10-09 12:00:00",
    });
    // Only the first is applied in prod.
    const state = deriveState([row(1, one as CreatedMigration)]);
    editSql(dir, one?.id ?? "", (sql) => `${sql}-- edited after it ran\n`, false);
    editSql(dir, two?.id ?? "", (sql) => `${sql}-- edited before it ran\n`, false);

    const history = { environment: "prod", status: compareHistory(readMigrations(dir), state) };
    expect(ordered).toHaveLength(2);
    const report = await lint(dir, { history });
    const checksum = report.findings.filter((f) => f.rule === "checksum");
    expect(checksum.map((f) => [f.migration, f.level])).toEqual([
      [one?.id, "error"],
      [two?.id, "warning"],
    ]);
    expect(checksum[0]?.message).toContain(`prod: ${String(one?.id)} was applied with checksum`);
    expect(checksum[1]?.message).toContain("not applied in prod");
    expect(report.errors).toBe(1);
  });
});

describe("yodel lint: what the lexicon cannot read", () => {
  it("is an error naming the object, in the migration that records it, never skipped", async () => {
    const dir = tempDir();
    const [m, next] = chain(dir, [
      ["create", ch(chEvents("id UInt64"))],
      ["add-kind", ch(chEvents("id UInt64, kind String DEFAULT ''"))],
    ]);
    const collection: BuiltObject = {
      export: "lookup",
      type: "ClickHouse::NamedCollection",
      ddl: "CREATE NAMED COLLECTION lookup AS url = 'http://example.invalid'",
      dependsOn: [],
    };
    // Schemas recorded with an object the lexicon has no parser for (hand-written, or by a newer chant).
    // Both migrations record it; it is reported once, where it first appears.
    for (const id of [m?.id ?? "", next?.id ?? ""]) {
      editDocument(dir, id, (doc) => ({ ...doc, schema: { ...doc.schema, objects: [...doc.schema.objects, collection] } }));
    }

    const report = await lint(dir);
    const unreadable = report.findings.filter((f) => f.rule === "unreadable-object");
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]).toMatchObject({ level: "error", migration: m?.id, object: "lookup" });
    expect(unreadable[0]?.message).toContain("lookup (ClickHouse::NamedCollection)");
    expect(unreadable[0]?.message).toContain("cannot read it");
    expect(report.errors).toBe(1);
  });

  it("is an error for a statement whose rule the classifier does not know, or a step of an unknown kind", async () => {
    const dir = tempDir();
    const [m] = chain(dir, [["create", ch(chEvents("id UInt64"))]]);
    editDocument(dir, m?.id ?? "", (doc) => ({
      ...doc,
      steps: [
        ...doc.steps,
        { kind: "statement", object: "events", type: "ClickHouse::Table", name: "yodel_14.events", sql: "OPTIMIZE TABLE yodel_14.events FINAL", rule: "HANDWRITTEN", class: "metadata", transactional: false },
        { kind: "mystery", object: "events" } as unknown as MigrationDocument["steps"][number],
      ],
    }));
    const report = await lint(dir);
    const unreadable = report.findings.filter((f) => f.rule === "unreadable-object");
    expect(unreadable.map((f) => f.step)).toEqual([2, 3]);
    expect(unreadable[0]?.message).toContain('rule "HANDWRITTEN" is not one of the clickhouse classifier\'s');
    expect(unreadable[1]?.message).toContain('kind "mystery"');
    // The hand-written statement is also not in migration.sql, which apply would not run anyway.
    expect(rules(report.findings)).toContain("migration-sql");
  });

  it("cannot be lowered from an error in yodel.config.ts", () => {
    expect(() => lintSettings({ rules: { "unreadable-object": "warning" } }, LINT_RULES)).toThrow(/always an error/);
    expect(() => lintSettings({ rules: { fork: "off" } }, LINT_RULES)).toThrow(/always an error/);
    expect(() => lintSettings({ rules: { checksum: "off" } }, LINT_RULES)).toThrow(/always an error/);
    expect(() => lintSettings({ rules: { nope: "off" } }, LINT_RULES)).toThrow(/no such rule/);
    expect(() => lintSettings({ rules: { destructive: "loud" } }, LINT_RULES)).toThrow(/expected "error", "warning" or "off"/);
    expect(() => lintSettings({ levels: {} }, LINT_RULES)).toThrow(/unknown setting/);
  });
});

describe("yodel lint: ClickHouse statement rules", () => {
  it("flags a drop as destructive, a type change as a mutation", async () => {
    const dir = tempDir();
    const [, m] = chain(dir, [
      ["create", ch(chEvents("id UInt64, n UInt32, gone String"))],
      ["change", ch(chEvents("id UInt64, n UInt64"))],
    ]);
    const report = await lint(dir);
    expect(report.findings.map((f) => [f.rule, f.step, f.level])).toEqual([
      ["destructive", 0, "error"],
      ["ch-mutation", 1, "error"],
    ]);
    expect(report.findings[0]?.message).toContain("SQLCH202 Drop a column on yodel_14.events");
    expect(report.findings[1]?.message).toContain("SQLCH210 Change a column's type");
    expect(report.findings.every((f) => f.migration === m?.id && f.object === "yodel_14.events")).toBe(true);
  });

  it("flags a sort key change as a rebuild, and the app-mode rebuild apply does not run as a refused step", async () => {
    const dir = tempDir();
    chain(dir, [
      ["create", ch(chEvents("id UInt64, kind String"))],
      ["resort", ch(chEvents("id UInt64, kind String", "(kind, id)"))],
    ]);
    const report = await lint(dir);
    expect(rules(report.findings).sort()).toEqual(["ch-rebuild", "refused-step"]);
    expect(report.findings.find((f) => f.rule === "ch-rebuild")?.message).toContain("SQLCH220 Change the sorting key (orderBy)");
    expect(report.findings.find((f) => f.rule === "refused-step")?.message).toContain("in app mode");
  });

  it("does not run Postgres rules on ClickHouse statements", async () => {
    const dir = tempDir();
    chain(dir, [["create", ch(chEvents("id UInt64"))]]);
    const report = await lint(dir, { settings: lintSettings({ rules: { "pg-lock": "error" } }, LINT_RULES) });
    expect(report.findings).toEqual([]);
  });
});

describe("yodel lint: Postgres statement rules (from the classifier's classes)", () => {
  it("flags a rewrite, a volatile default and a drop; a CHECK is planned NOT VALID, then VALIDATE", async () => {
    const dir = tempDir();
    chain(dir, [
      ["create", pg(pgOrders("n integer, gone text"))],
      ["change", pg(pgOrders("n bigint, ts timestamptz DEFAULT clock_timestamp(), CONSTRAINT positive CHECK (n > 0)"))],
    ]);
    const report = await lint(dir);
    const got = report.findings.map((f) => [f.rule, f.message.match(/SQLPG\d+/)?.[0]]);
    expect(got).toEqual(
      expect.arrayContaining([
        ["pg-rewrite", "SQLPG207"],
        ["pg-rewrite", "SQLPG202"],
        ["destructive", "SQLPG204"],
      ]),
    );
    // chant plans the CHECK as ADD CONSTRAINT ... NOT VALID (SQLPG217), then VALIDATE (SQLPG220): neither blocks writes.
    expect(got.map(([, code]) => code)).not.toContain("SQLPG218");
    expect(report.findings.find((f) => f.message.includes("SQLPG207"))?.message).toContain("blocks reads and writes");
    expect(report.errors).toBe(report.findings.length);
  });

  it("flags an index without CONCURRENTLY on an existing table; a foreign key is planned NOT VALID, then VALIDATE", async () => {
    const dir = tempDir();
    chain(dir, [
      ["create", pg(pgOrders("cid bigint"))],
      ["index", pg(pgOrders("cid bigint"), pgIndex("CREATE INDEX ix ON yodel_14.orders (cid)"))],
      ["fk", pg(pgOrders("cid bigint REFERENCES yodel_14.customers (id)"), pgIndex("CREATE INDEX ix ON yodel_14.orders (cid)"))],
    ]);
    const report = await lint(dir);
    expect(report.findings.map((f) => [f.rule, f.message.match(/SQLPG\d+/)?.[0]])).toEqual([
      ["pg-lock", "SQLPG241"],
    ]);
    expect(report.findings[0]?.message).toContain("without CONCURRENTLY");
  });

  it("passes the safe forms: CONCURRENTLY, NOT VALID, USING INDEX, and an index on a table created with it", async () => {
    const dir = tempDir();
    chain(dir, [
      ["create", pg(pgOrders("cid bigint"), pgIndex("CREATE INDEX ix ON yodel_14.orders (cid)"))],
      ["unique", pg(pgOrders("cid bigint UNIQUE"), pgIndex("CREATE INDEX ix ON yodel_14.orders (cid)"))],
      ["fk", pg(pgOrders("cid bigint UNIQUE, CONSTRAINT fk FOREIGN KEY (cid) REFERENCES yodel_14.customers (id) NOT VALID"), pgIndex("CREATE INDEX ix ON yodel_14.orders (cid)"))],
      ["reindex", pg(pgOrders("cid bigint UNIQUE, CONSTRAINT fk FOREIGN KEY (cid) REFERENCES yodel_14.customers (id) NOT VALID"), pgIndex("CREATE INDEX CONCURRENTLY ix ON yodel_14.orders (cid, id)"))],
    ]);
    const report = await lint(dir);
    expect(report.findings).toEqual([]);
  });
});

describe("yodel lint: Postgres Op steps", () => {
  it("passes a type change across kinds made by PostgresMigrationOp, which apply runs (#13)", async () => {
    const dir = tempDir();
    const [, m] = chain(dir, [
      ["create", pg(pgOrders("code text"))],
      ["retype", pg(pgOrders("code integer"))],
    ]);
    expect(m?.document.steps.map((s) => (s.kind === "op" ? s.op : s.kind))).toEqual(["PostgresMigrationOp"]);
    const report = await lint(dir);
    expect(report.findings).toEqual([]);
  });
});

describe("yodel lint: silences", () => {
  /** A ClickHouse chain whose second migration drops a column (step 0) and changes a type (step 1). */
  function risky(): { dir: string; id: string } {
    const dir = tempDir();
    const [, m] = chain(dir, [
      ["create", ch(chEvents("id UInt64, n UInt32, gone String"))],
      ["change", ch(chEvents("id UInt64, n UInt64"))],
    ]);
    return { dir, id: m?.id ?? "" };
  }

  it("silence one rule for one statement, with the reason kept on the finding", async () => {
    const { dir, id } = risky();
    editSql(dir, id, above("DROP COLUMN `gone`", "-- yodel:allow destructive gone was never written; checked in prod on 2026-10-08"));
    const report = await lint(dir);
    expect(report.findings.map((f) => [f.rule, f.silenced])).toEqual([
      ["destructive", "gone was never written; checked in prod on 2026-10-08"],
      ["ch-mutation", undefined],
    ]);
    expect(report).toMatchObject({ errors: 1, silenced: 1 });

    editSql(dir, id, above("MODIFY COLUMN `n` UInt64", "-- yodel:allow ch-mutation events is 40 MB"));
    const after = await lint(dir);
    expect(live(after.findings)).toEqual([]);
    expect(after).toMatchObject({ errors: 0, silenced: 2 });
    expect(after.silences[id]?.map((s) => [s.step, s.rule])).toEqual([
      [0, "destructive"],
      [1, "ch-mutation"],
    ]);
  });

  it("does not carry a silence over to another statement or another rule", async () => {
    const { dir, id } = risky();
    // Above the type change: it does not silence the drop, and the type change is not destructive.
    editSql(dir, id, above("MODIFY COLUMN `n` UInt64", "-- yodel:allow destructive wrong statement"));
    const report = await lint(dir);
    expect(live(report.findings).map((f) => [f.rule, f.level])).toEqual([
      ["destructive", "error"],
      ["ch-mutation", "error"],
      ["silence", "warning"],
    ]);
    expect(report.findings.find((f) => f.rule === "silence")?.message).toContain("silences nothing");
  });

  it("refuses a silence with no reason, an unknown rule, an integrity rule, or one after the last step", async () => {
    const { dir, id } = risky();
    editSql(dir, id, above("DROP COLUMN `gone`", "-- yodel:allow destructive"));
    editSql(dir, id, above("DROP COLUMN `gone`", "-- yodel:allow dropping-is-fine because"));
    editSql(dir, id, above("DROP COLUMN `gone`", "-- yodel:allow checksum I edited it"));
    editSql(dir, id, (sql) => `${sql}-- yodel:allow ch-mutation trailing\n`);
    const report = await lint(dir);
    const silence = report.findings.filter((f) => f.rule === "silence");
    expect(silence.map((f) => f.level)).toEqual(["error", "error", "error", "error"]);
    expect(silence.map((f) => f.message).join("\n")).toMatch(/needs a reason[\s\S]*dropping-is-fine is not a rule[\s\S]*checksum is not a rule[\s\S]*after the last step/);
    // None of them silenced anything.
    expect(live(report.findings).filter((f) => f.rule === "destructive")).toHaveLength(1);
  });

  it("are what apply records in the history: the step, the rule and the reason, as JSON", () => {
    const { dir, id } = risky();
    editSql(dir, id, above("DROP COLUMN `gone`", "-- yodel:allow destructive gone was never written"));
    editSql(dir, id, above("MODIFY COLUMN `n` UInt64", "--yodel:allow   ch-mutation   small table  "));
    expect(JSON.parse(migrationSilences(read(dir, id)))).toEqual([
      { step: 0, rule: "destructive", reason: "gone was never written" },
      { step: 1, rule: "ch-mutation", reason: "small table" },
    ]);
    // A migration with none records an empty list, as before.
    const first = readMigrations(dir)[0];
    expect(first && migrationSilences(first)).toBe("[]");
  });

  it("silence an Op step: a line above the rebuild's comment", async () => {
    const dir = tempDir();
    const [, m] = chain(dir, [
      ["create", ch(chEvents("id UInt64, kind String"))],
      ["resort", ch(chEvents("id UInt64, kind String", "(kind, id)"))],
    ]);
    const id = m?.id ?? "";
    editSql(dir, id, above("-- events (yodel_14.events): SQLCH220", "-- yodel:allow ch-rebuild events is small; rebuilt in the maintenance window"));
    const report = await lint(dir, { settings: lintSettings({ rules: { "refused-step": "warning" } }, LINT_RULES) });
    expect(report.findings.map((f) => [f.rule, f.level, f.silenced])).toEqual([
      ["ch-rebuild", "error", "events is small; rebuilt in the maintenance window"],
      ["refused-step", "warning", undefined],
    ]);
    expect(report.errors).toBe(0);
  });
});

describe("yodel lint: migration.sql against migration.json", () => {
  it("reports a statement edited in migration.sql only: apply runs migration.json's", async () => {
    const dir = tempDir();
    const [m] = chain(dir, [["create", ch(chEvents("id UInt64"))]]);
    editSql(dir, m?.id ?? "", (sql) => sql.replace("ORDER BY id", "ORDER BY id SETTINGS index_granularity = 1024"));
    const report = await lint(dir);
    expect(rules(report.findings)).toEqual(["migration-sql"]);
    expect(report.findings[0]?.message).toContain("yodel apply runs migration.json's");
  });

  it("maps each silence to the step below it", () => {
    const steps = [
      { kind: "statement", object: "a", type: "T", name: "d.a", sql: "DROP TABLE d.a", rule: "SQLCH250", class: "drop", transactional: false },
      { kind: "manual", object: "v", type: "V", name: "d.v", changes: [], detail: "x" },
      { kind: "statement", object: "b", type: "T", name: "d.b", sql: "DROP TABLE d.b", rule: "SQLCH250", class: "drop", transactional: false },
    ] as const;
    const sql = ["-- header", "-- yodel:allow destructive first", "DROP TABLE d.a;", "", "-- yodel:allow ch-rebuild second", "-- v (d.v): has no statement", "", "-- b (d.b): SQLCH250 drop", "-- yodel:allow destructive third", "DROP TABLE d.b;", ""].join("\n");
    const map = mapMigrationSql(sql, steps as never, new Set(silenceableRules()));
    expect(map.problems).toEqual([]);
    expect(map.silences.map((s) => [s.step, s.rule, s.reason, s.line])).toEqual([
      [0, "destructive", "first", 2],
      [1, "ch-rebuild", "second", 5],
      [2, "destructive", "third", 9],
    ]);
  });
});

describe("yodel lint: levels and project rules", () => {
  it("lowers a statement rule to a warning or turns it off", async () => {
    const dir = tempDir();
    chain(dir, [
      ["create", ch(chEvents("id UInt64, n UInt32, gone String"))],
      ["change", ch(chEvents("id UInt64, n UInt64"))],
    ]);
    const report = await lint(dir, { settings: lintSettings({ rules: { "ch-mutation": "warning", destructive: "off" } }, LINT_RULES) });
    expect(report.findings.map((f) => [f.rule, f.level])).toEqual([["ch-mutation", "warning"]]);
    expect(report).toMatchObject({ errors: 0, warnings: 1 });
  });

  it("runs project rules (the replay check's hook) and reports one that cannot run as an error", async () => {
    const dir = tempDir();
    chain(dir, [["create", ch(chEvents("id UInt64"))]]);
    const seen: string[] = [];
    const replay: ProjectRule = {
      rule: { id: "replay", summary: "test", level: "error", silenceable: false, configurable: true },
      check: (ctx) => {
        seen.push(...ctx.scan.migrations.map((m) => m.id));
        return Promise.resolve([{ rule: "replay", message: "the replayed schema differs" }]);
      },
    };
    const broken: ProjectRule = { rule: { ...replay.rule, id: "broken" }, check: () => Promise.reject(new Error("no emulator")) };
    const report = await lint(dir, { rules: [replay, broken] });
    expect(seen).toHaveLength(1);
    expect(report.findings.map((f) => [f.rule, f.level, f.message])).toEqual([
      ["broken", "error", "broken could not run: no emulator"],
      ["replay", "error", "the replayed schema differs"],
    ]);
    const quiet = await lint(dir, { rules: [replay], settings: lintSettings({ rules: { replay: "warning" } }, { ...LINT_RULES, replay: replay.rule }) });
    expect(quiet).toMatchObject({ errors: 0, warnings: 1 });
  });
});
