/**
 * Hand-written migrations (#248): `yodel new --sql`, the statements read
 * from migration.sql into migration.json, the schema each records, lint on
 * them, and a rebase that moves one.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BuildOutput, BuiltObject } from "../src/chant/build.js";
import {
  createHandWritten,
  createMigration,
  handSteps,
  HAND_TEMPLATE_MARK,
  isDataStatement,
  MIGRATION_JSON,
  MIGRATION_SQL,
  newestMigration,
  readMigrations,
  recordHandWritten,
  scanMigrations,
  serializeDocument,
  splitHandSql,
  verifyChecksum,
  writeMigration,
  type Migration,
} from "../src/migrations/index.js";
import { lintMigrations, updateChecksum } from "../src/lint/index.js";
import { planRebase } from "../src/rebase/index.js";

const pgSchema: BuiltObject = { export: "app", type: "Postgres::Schema", ddl: "CREATE SCHEMA yodel_248", dependsOn: [] };
const pgKinds = (columns = "id bigint PRIMARY KEY, name text NOT NULL"): BuiltObject => ({ export: "kinds", type: "Postgres::Table", ddl: `CREATE TABLE yodel_248.kinds (${columns})`, dependsOn: ["app"] });
const pg = (...objects: BuiltObject[]): BuildOutput => ({ dialect: "postgres", postgresMajor: 18, objects: [pgSchema, ...objects] });

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "yodel-248-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const at = (minute: number) => new Date(Date.UTC(2026, 9, 12, 12, minute));
const read = (dir: string, id: string): Migration => {
  const m = scanMigrations(dir).migrations.find((x) => x.id === id);
  if (!m) throw new Error(`no ${id}`);
  return m;
};

/** A first migration that creates the kinds table, then an empty hand-written one after it. */
function setup(): { dir: string; first: Migration; hand: Migration } {
  const dir = tempDir();
  const made = createMigration({ name: "create", build: pg(pgKinds()), now: at(0) });
  if (made.id === undefined) throw new Error("no change");
  writeMigration(dir, made);
  const previous = newestMigration(readMigrations(dir));
  const hand = createHandWritten({ name: "seed-kinds", dialect: "postgres", previous, now: at(1), defaultSchema: "public" });
  writeMigration(dir, hand);
  return { dir, first: read(dir, made.id), hand: read(dir, hand.id) };
}

/** Writes migration.sql's statements under its header and records them, as `yodel lint --update-checksum` does. */
async function fill(dir: string, id: string, statements: string, build: BuildOutput = pg(pgKinds())): Promise<Migration> {
  const path = join(dir, id, MIGRATION_SQL);
  writeFileSync(path, `${readFileSync(path, "utf8")}\n${statements}\n`);
  const m = read(dir, id);
  const parent = m.document.parent === null ? undefined : read(dir, m.document.parent);
  const recorded = await recordHandWritten(m, parent?.document.schema, () => Promise.resolve(build));
  const doc = { ...(JSON.parse(m.files.json) as Record<string, unknown>), ...recorded.document };
  writeFileSync(join(dir, id, MIGRATION_JSON), serializeDocument(doc));
  updateChecksum(read(dir, id));
  return read(dir, id);
}

describe("yodel new --sql", () => {
  it("writes an empty hand-written migration after the newest, its parent's schema recorded", () => {
    const { first, hand } = setup();
    expect(hand.document.source).toBe("sql");
    expect(hand.document.parent).toBe(first.id);
    expect(hand.document.steps).toEqual([]);
    expect(hand.document.schema).toEqual(first.document.schema);
    expect(hand.files.sql).toContain(HAND_TEMPLATE_MARK);
    expect(hand.files.sql).toContain(`yodel lint --update-checksum ${hand.id}`);
    expect(verifyChecksum(hand).ok).toBe(true);
  });

  it("is a migration-sql finding until its statements are recorded", async () => {
    const { dir, hand } = setup();
    const report = await lintMigrations(dir, { dialect: "postgres" });
    expect(report.findings.find((f) => f.migration === hand.id)?.rule).toBe("migration-sql");
  });
});

describe("recording the statements", () => {
  it("reads each statement from migration.sql; data only keeps the parent's schema", async () => {
    const { dir, first, hand } = setup();
    const m = await fill(dir, hand.id, "INSERT INTO yodel_248.kinds (id, name) VALUES (1, 'a;b'), (2, 'c');\nUPDATE yodel_248.kinds SET name = upper(name) WHERE id = 2;");
    expect(m.document.steps.map((s) => (s.kind === "statement" ? s.sql : s.kind))).toEqual([
      "INSERT INTO yodel_248.kinds (id, name) VALUES (1, 'a;b'), (2, 'c')",
      "UPDATE yodel_248.kinds SET name = upper(name) WHERE id = 2",
    ]);
    expect(m.document.schema).toEqual(first.document.schema);
    expect(verifyChecksum(m).ok).toBe(true);
    const report = await lintMigrations(dir, { dialect: "postgres" });
    expect(report.findings.filter((f) => f.migration === hand.id && f.level === "error")).toEqual([]);
  });

  it("records the current build when a statement changes the schema, and lint classifies that change", async () => {
    const { dir, hand } = setup();
    const after = pg(pgKinds("id bigint PRIMARY KEY, name text NOT NULL, retired boolean"));
    const m = await fill(dir, hand.id, "ALTER TABLE yodel_248.kinds ADD COLUMN retired boolean;\nUPDATE yodel_248.kinds SET retired = false;", after);
    expect(m.document.schema).toEqual(after);
    // Dropping the column again by hand is destructive, found from the schema change.
    const next = createHandWritten({ name: "drop-retired", dialect: "postgres", previous: m, now: at(2), defaultSchema: "public" });
    writeMigration(dir, next);
    await fill(dir, next.id, "ALTER TABLE yodel_248.kinds DROP COLUMN retired;", pg(pgKinds()));
    const report = await lintMigrations(dir, { dialect: "postgres" });
    expect(report.findings.some((f) => f.migration === next.id && f.rule === "destructive" && f.silenced === undefined)).toBe(true);
  });

  it("flags a statement that removes every row, and a yodel:allow line silences it", async () => {
    const { dir, hand } = setup();
    await fill(dir, hand.id, "-- yodel:allow destructive the reference rows are reloaded below\nTRUNCATE yodel_248.kinds;\nINSERT INTO yodel_248.kinds (id, name) VALUES (1, 'a');");
    const report = await lintMigrations(dir, { dialect: "postgres" });
    const found = report.findings.find((f) => f.migration === hand.id && f.rule === "destructive");
    expect(found?.silenced).toBe("the reference rows are reloaded below");
  });

  it("refuses migration.sql with no statements, or a statement with no ;", async () => {
    const { hand } = setup();
    await expect(recordHandWritten(hand, undefined, () => Promise.resolve(pg()))).rejects.toThrow(/holds no statements/);
    const unterminated = { ...hand, files: { ...hand.files, sql: `${hand.files.sql}\nINSERT INTO yodel_248.kinds (id, name) VALUES (1, 'a')\n` } };
    await expect(recordHandWritten(unterminated, undefined, () => Promise.resolve(pg()))).rejects.toThrow(/end each statement/);
  });
});

describe("the steps", () => {
  it("splits on the dialect's rules and leaves leading comments out", async () => {
    expect(await splitHandSql("postgres", "-- a comment\nCREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1; $$;\nSELECT 2;")).toEqual(["CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1; $$", "SELECT 2"]);
  });

  it("knows data statements, transactions and mutations", () => {
    expect(isDataStatement("postgres", "INSERT INTO t VALUES (1)")).toBe(true);
    expect(isDataStatement("postgres", "ALTER TABLE t ADD COLUMN c int")).toBe(false);
    expect(isDataStatement("clickhouse", "ALTER TABLE d.t UPDATE c = 1 WHERE 1")).toBe(true);
    const [concurrently] = handSteps("postgres", ["CREATE INDEX CONCURRENTLY i ON t (c)"]);
    expect(concurrently?.transactional).toBe(false);
    const [mutation] = handSteps("clickhouse", ["ALTER TABLE d.t DELETE WHERE c = 1"]);
    expect(mutation?.waitsForMutation).toBe(true);
    const [deleteAll] = handSteps("postgres", ["DELETE FROM t"]);
    expect(deleteAll?.destructive).toBe(true);
    const [deleteSome] = handSteps("postgres", ["DELETE FROM t WHERE id = 1"]);
    expect(deleteSome?.destructive).toBeUndefined();
  });
});

describe("rebase", () => {
  it("moves a hand-written migration with its statements as written", async () => {
    const { dir, first, hand } = setup();
    await fill(dir, hand.id, "INSERT INTO yodel_248.kinds (id, name) VALUES (1, 'a');");
    // Theirs: another migration on the same parent, merged first.
    const theirs = createMigration({ name: "add-label", build: pg(pgKinds("id bigint PRIMARY KEY, name text NOT NULL, label text")), previous: first, now: at(0) });
    if (theirs.id === undefined) throw new Error("no change");
    writeMigration(dir, theirs);
    const plan = planRebase(scanMigrations(dir).migrations, { id: hand.id });
    if (plan.moved === undefined) throw new Error("nothing to rebase");
    const moved = plan.rewritten[0];
    expect(moved?.parent).toBe(theirs.id);
    expect(moved?.document.steps).toEqual(read(dir, hand.id).document.steps);
    expect(moved?.files.sql).toContain(`-- parent: ${theirs.id}`);
    expect(moved?.files.sql).toContain("INSERT INTO yodel_248.kinds (id, name) VALUES (1, 'a');");
  });
});
