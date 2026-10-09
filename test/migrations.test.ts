import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BuildOutput } from "../src/chant/build.js";
import {
  computeChecksum,
  createMigration,
  emptyBuild,
  MigrationDirectoryError,
  migrationId,
  newestMigration,
  readMigrations,
  scanMigrations,
  serializeDocument,
  verifyChecksum,
  writeMigration,
  type CreatedMigration,
  type MigrationDocument,
} from "../src/migrations/index.js";

const clickhouse = (orderBy = "(kind, ts)", extra = ""): BuildOutput => ({
  dialect: "clickhouse",
  objects: [
    { export: "db", type: "ClickHouse::Database", ddl: "CREATE DATABASE yodel_7 ENGINE = Atomic", dependsOn: [] },
    {
      export: "events",
      type: "ClickHouse::Table",
      ddl: `CREATE TABLE yodel_7.events (id UInt64, kind String, ts DateTime${extra}) ENGINE = MergeTree ORDER BY ${orderBy}`,
      dependsOn: ["db"],
    },
  ],
});

const postgres = (column = "status text NOT NULL"): BuildOutput => ({
  dialect: "postgres",
  postgresMajor: 18,
  objects: [
    { export: "app", type: "Postgres::Schema", ddl: "CREATE SCHEMA yodel_7", dependsOn: [] },
    { export: "orders", type: "Postgres::Table", ddl: `CREATE TABLE yodel_7.orders (\n  id bigint PRIMARY KEY,\n  ${column}\n)`, dependsOn: ["app"] },
  ],
});

const at = (minute: number) => new Date(Date.UTC(2026, 9, 9, 14, minute, 7));

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "yodel-migrations-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const made = (m: ReturnType<typeof createMigration>): CreatedMigration => {
  if (m.id === undefined) throw new Error("expected a migration");
  return m;
};

/** Writes migrations one after another, each following the newest on disk. */
function chain(dir: string, builds: Array<[string, BuildOutput]>): CreatedMigration[] {
  return builds.map(([name, build], i) => {
    const previous = newestMigration(readMigrations(dir));
    const m = made(createMigration({ name, build, previous, now: at(10 + i) }));
    writeMigration(dir, m);
    return m;
  });
}

describe("migration ids", () => {
  it("are a UTC minute and a name", () => {
    expect(migrationId("add-country", new Date("2026-10-09T08:12:59-06:00"))).toBe("20261009T1412-add-country");
    expect(migrationId("add_country2", at(5))).toBe("20261009T1405-add_country2");
  });

  it("refuse a name that is not lowercase words", () => {
    for (const bad of ["Add", "add country", "-x", "x--y", "../x", ""]) expect(() => migrationId(bad, at(0))).toThrow(/migration name/);
  });
});

describe.each([
  ["clickhouse", clickhouse(), clickhouse("(kind, ts)", ", note String DEFAULT ''")],
  ["postgres", postgres(), postgres("status text NOT NULL, note text")],
] as const)("%s migrations", (dialect, first, second) => {
  it("start from an empty schema of the same dialect", () => {
    expect(emptyBuild(first)).toEqual(dialect === "postgres" ? { dialect, objects: [], postgresMajor: 18 } : { dialect, objects: [] });
    const m = made(createMigration({ name: "init", build: first, now: at(12) }));
    expect(m.id).toBe("20261009T1412-init");
    expect(m.document).toMatchObject({ format: 1, id: m.id, parent: null, dialect, refused: false, schema: first, createdAt: "2026-10-09T14:12:07Z" });
    expect(m.document.steps.every((s) => s.kind === "statement" && s.class === "create")).toBe(true);
    expect(m.files.sql).toMatch(/^-- yodel migration 20261009T1412-init\n-- parent: none \(the first migration\)\n\n-- /);
    expect(m.files.sql).toMatch(/: SQL(CH|PG)200 create\nCREATE /);
    expect(verifyChecksum(m.files).ok).toBe(true);
  });

  it("follow the newest one, diffing from its recorded schema", () => {
    const dir = tempDir();
    const [a, b] = chain(dir, [
      ["init", first],
      ["add-note", second],
    ]);
    expect(b?.document.parent).toBe(a?.id);
    expect(b?.document.steps).toHaveLength(1);
    expect(b?.document.steps[0]).toMatchObject({ kind: "statement", object: dialect === "clickhouse" ? "events" : "orders" });
    expect(b?.files.sql).toContain(`-- parent: ${String(a?.id)}`);
    const read = readMigrations(dir);
    expect(read.map((m) => m.id)).toEqual([a?.id, b?.id]);
    expect(read[1]?.document.schema).toEqual(second);
    expect(read.every((m) => verifyChecksum(m).ok)).toBe(true);
  });

  it("report no change when the build matches the recorded schema", () => {
    const dir = tempDir();
    chain(dir, [["init", first]]);
    const none = createMigration({ name: "again", build: first, previous: newestMigration(readMigrations(dir)), now: at(30) });
    expect(none.id).toBeUndefined();
    expect(none.statements.steps).toEqual([]);
  });
});

describe("migration.json", () => {
  it("is written the same way every time: fixed key order, a trailing newline", () => {
    const m = made(createMigration({ name: "init", build: clickhouse(), now: at(12) }));
    expect(Object.keys(JSON.parse(m.files.json) as object)).toEqual([
      "format", "id", "parent", "checksum", "createdAt", "dialect", "defaultDatabase", "refused", "hints", "steps", "schema",
    ]);
    expect(Object.keys(m.document.steps[0] ?? {}).slice(0, 4)).toEqual(["kind", "object", "type", "name"]);
    expect(m.files.json.endsWith("}\n")).toBe(true);
    expect(m.files.json).not.toContain("\r");
    // Shuffled keys serialize to the same bytes.
    const shuffled = Object.fromEntries(Object.entries(m.document).reverse()) as unknown as MigrationDocument;
    expect(serializeDocument(shuffled)).toBe(m.files.json);
    // The same input makes the same files.
    expect(made(createMigration({ name: "init", build: clickhouse(), now: at(12) })).files).toEqual(m.files);
  });
});

describe("checksums", () => {
  const m = made(createMigration({ name: "init", build: postgres(), now: at(12) }));

  it("are normalized for line endings", () => {
    const crlf = { sql: m.files.sql.replace(/\n/g, "\r\n"), json: m.files.json.replace(/\n/g, "\r\n") };
    const cr = { sql: m.files.sql.replace(/\n/g, "\r"), json: m.files.json.replace(/\n/g, "\r") };
    expect(computeChecksum(crlf)).toBe(m.document.checksum);
    expect(computeChecksum(cr)).toBe(m.document.checksum);
    expect(verifyChecksum(crlf).ok).toBe(true);
  });

  it("ignore the checksum field and the JSON's layout, but nothing else", () => {
    expect(computeChecksum({ sql: m.files.sql, json: { ...m.document, checksum: "sha256:0" } })).toBe(m.document.checksum);
    expect(computeChecksum({ sql: m.files.sql, json: JSON.stringify(m.document) })).toBe(m.document.checksum);
    expect(m.document.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    const edits: Array<[string, { sql: string; json: string }]> = [
      ["a statement", { sql: m.files.sql.replace("bigint", "integer"), json: m.files.json }],
      ["a space in the SQL", { sql: `${m.files.sql} `, json: m.files.json }],
      ["the parent", { sql: m.files.sql, json: serializeDocument({ ...m.document, parent: "20261001T0000-other" }) }],
      ["the recorded schema", { sql: m.files.sql, json: serializeDocument({ ...m.document, schema: postgres("status varchar") }) }],
    ];
    for (const [what, files] of edits) expect(verifyChecksum(files).ok, what).toBe(false);
  });

  it("cover only their own migration's files", () => {
    const dir = tempDir();
    const [a, b, c] = chain(dir, [
      ["one", postgres()],
      ["two", postgres("status text NOT NULL, note text")],
      ["three", postgres("status text NOT NULL, note text, region text")],
    ]);
    const before = readMigrations(dir).map((x) => [x.id, x.checksum]);
    // Edit the middle migration's files.
    const mid = join(dir, String(b?.id));
    writeFileSync(join(mid, "migration.sql"), `${readFileSync(join(mid, "migration.sql"), "utf8")}-- edited\n`);
    const scan = scanMigrations(dir);
    expect(scan.problems.map((p) => [p.kind, "id" in p ? p.id : ""])).toEqual([["checksum", b?.id]]);
    for (const x of scan.migrations) {
      if (x.id !== b?.id) expect(verifyChecksum(x).ok, x.id).toBe(true);
    }
    expect(scan.migrations.map((x) => [x.id, x.checksum])).toEqual(before);
    // A checksum mismatch is a problem for verify, not for ordering.
    expect(readMigrations(dir).map((x) => x.id)).toEqual([a?.id, b?.id, c?.id]);
    expect(() => readMigrations(dir, { verify: true })).toThrow(/two: its files hash to sha256:[0-9a-f]+, but migration.json records sha256:/);
  });
});

describe("the directory", () => {
  it("is empty when there is none", () => {
    expect(readMigrations(join(tempDir(), "migrations"))).toEqual([]);
    expect(newestMigration([])).toBeUndefined();
  });

  it("orders by the parent chain, not by the ids", () => {
    const dir = tempDir();
    const first = made(createMigration({ name: "zzz-first", build: clickhouse(), now: at(50) }));
    writeMigration(dir, first);
    const second = made(createMigration({ name: "aaa-second", build: clickhouse("(ts, kind)"), previous: readMigrations(dir)[0], now: at(1) }));
    writeMigration(dir, second);
    expect(readMigrations(dir).map((m) => m.id)).toEqual(["20261009T1450-zzz-first", "20261009T1401-aaa-second"]);
  });

  it("reports two migrations with the same parent, naming both", () => {
    const dir = tempDir();
    const [root] = chain(dir, [["init", clickhouse()]]);
    const previous = newestMigration(readMigrations(dir));
    const left = made(createMigration({ name: "left", build: clickhouse("(kind, ts)", ", a String"), previous, now: at(20) }));
    const right = made(createMigration({ name: "right", build: clickhouse("(kind, ts)", ", b String"), previous, now: at(21) }));
    writeMigration(dir, left);
    writeMigration(dir, right);
    const scan = scanMigrations(dir);
    expect(scan.ordered).toBeUndefined();
    expect(scan.problems).toEqual([
      {
        kind: "fork",
        parent: root?.id,
        children: [left.id, right.id],
        message: `fork: ${left.id} and ${right.id} both follow ${String(root?.id)}; rebase one onto the other`,
      },
    ]);
    let error: unknown;
    try {
      readMigrations(dir);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(MigrationDirectoryError);
    expect((error as Error).message).toContain(`fork: ${left.id} and ${right.id} both follow ${String(root?.id)}`);
  });

  it("reports two first migrations as a fork too", () => {
    const dir = tempDir();
    writeMigration(dir, made(createMigration({ name: "a", build: clickhouse(), now: at(1) })));
    writeMigration(dir, made(createMigration({ name: "b", build: postgres(), now: at(2) })));
    expect(() => readMigrations(dir)).toThrow(/fork: 20261009T1401-a and 20261009T1402-b are each a first migration/);
  });

  it("reports a missing parent, a renamed directory and a stray directory", () => {
    const dir = tempDir();
    const [a, b] = chain(dir, [
      ["one", clickhouse()],
      ["two", clickhouse("(ts, kind)")],
    ]);
    renameSync(join(dir, String(a?.id)), join(dir, "20261009T0000-renamed"));
    mkdirSync(join(dir, "notes"));
    writeFileSync(join(dir, "README.md"), "plain files are ignored\n");
    const kinds = scanMigrations(dir).problems.map((p) => p.kind).sort();
    expect(kinds).toEqual(["id-mismatch", "missing-parent", "unreadable"]);
    expect(() => readMigrations(dir)).toThrow(new RegExp(`${String(b?.id)} follows ${String(a?.id)}, which is not in the directory`));
  });

  it("never overwrites a migration", () => {
    const dir = tempDir();
    const m = made(createMigration({ name: "init", build: clickhouse(), now: at(1) }));
    writeMigration(dir, m);
    expect(() => writeMigration(dir, m)).toThrow(/already exists/);
  });
});

describe("Op steps", () => {
  it("a ClickHouse sort-key change is a ClickHouseRebuildOp step, a comment in the SQL", () => {
    const first = made(createMigration({ name: "init", build: clickhouse(), now: at(1) }));
    const dir = tempDir();
    writeMigration(dir, first);
    const m = made(createMigration({ name: "sort-key", build: clickhouse("(ts, kind)"), previous: readMigrations(dir)[0], now: at(2) }));
    expect(m.document.refused).toBe(true);
    expect(m.document.steps).toEqual([
      expect.objectContaining({ kind: "op", op: "ClickHouseRebuildOp", object: "events", name: "yodel_7.events", importPath: "@intentius/chant-lexicon-sql/clickhouse" }),
    ]);
    expect(m.files.sql).toContain("-- This migration contains an Op step, not only SQL:");
    expect(m.files.sql).toMatch(/^-- events \(yodel_7\.events\): SQLCH220 made by ClickHouseRebuildOp, not a statement:$/m);
    expect(m.files.sql.split("\n").filter((l) => l.trim() !== "" && !l.startsWith("--"))).toEqual([]);
  });

  it("a Postgres column rename is a PostgresMigrationOp step, a comment in the SQL", () => {
    const first = made(createMigration({ name: "init", build: postgres(), now: at(1) }));
    const dir = tempDir();
    writeMigration(dir, first);
    const m = made(createMigration({ name: "rename", build: postgres("state text NOT NULL -- previously: status"), previous: readMigrations(dir)[0], now: at(2) }));
    expect(m.document.refused).toBe(true);
    expect(m.document.steps).toEqual([
      expect.objectContaining({ kind: "op", op: "PostgresMigrationOp", object: "orders", name: "yodel_7.orders", importPath: "@intentius/chant-lexicon-sql/postgres" }),
    ]);
    expect(m.files.sql).toContain("-- This migration contains an Op step, not only SQL:");
    expect(m.files.sql).toMatch(/made by PostgresMigrationOp, not a statement:$/m);
  });
});
