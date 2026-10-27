/**
 * `yodel lint --replay <env>` (#11) against the emulator: a clean history
 * passes, a hand-edited recorded schema fails naming the migration (exit 1),
 * and a target that already holds the history's database or schema is
 * refused with exit 1 unless --reset. ClickHouse database <prefix>_lint_replay,
 * Postgres schema <prefix>_lint_replay_pg, through the replay e2e fixtures (profile `emulator`).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { BuildOutput, BuiltObject } from "../../src/chant/build.js";
import { createMigration, readMigrations, scanMigrations, serializeDocument, writeMigration, type CreatedMigration, type MigrationDocument } from "../../src/migrations/index.js";
import { updateChecksum } from "../../src/lint/index.js";
import { json, yodel } from "../helpers/run.js";
import { e2eProject, suiteName } from "./names.js";
import { clickhouse, clickhouseReachable, postgres, postgresReachable } from "./emulator.js";

const DB = suiteName("lint_replay");
const PG = `${DB}_pg`;

interface LintDoc {
  status: string;
  errors: number;
  findings: Array<{ rule: string; level: string; migration?: string; message: string }>;
  replay?: { outcome: string; ok: boolean; matched: Array<{ id: string }> };
}

function project(fixture: string) {
  const { dir, dispose } = e2eProject(fixture, DB);
  const migrations = join(dir, "migrations");
  const next = (name: string, minute: number, schema: BuildOutput): CreatedMigration => {
    const made = createMigration({ name, build: schema, previous: readMigrations(migrations).at(-1), now: new Date(Date.UTC(2026, 9, 9, 15, minute)) });
    if (made.id === undefined) throw new Error(`no change for ${name}`);
    writeMigration(migrations, made);
    return made;
  };
  /** A hand edit of migration.json's recorded schema, its checksum recorded again, so only the replay can catch it. */
  const tamperSchema = (id: string, schema: BuildOutput) => {
    const path = join(migrations, id, "migration.json");
    writeFileSync(path, serializeDocument({ ...(JSON.parse(readFileSync(path, "utf8")) as MigrationDocument), schema }));
    const m = scanMigrations(migrations).migrations.find((x) => x.id === id);
    if (m) updateChecksum(m);
  };
  const lint = (...args: string[]) => yodel(["lint", "--replay", "emulator", ...args, "--json", "--dir", dir]);
  return { dispose, next, tamperSchema, lint };
}

describe.skipIf(!clickhouseReachable)("yodel lint --replay on clickhouse", () => {
  const disposers: Array<() => void> = [];
  const events = (extra = ""): BuiltObject => ({ export: "events", type: "ClickHouse::Table", ddl: `CREATE TABLE ${DB}.events (id UInt64, k String${extra}) ENGINE = MergeTree ORDER BY (k, id)`, dependsOn: ["db"] });
  const build = (...objects: BuiltObject[]): BuildOutput => ({ dialect: "clickhouse", objects: [{ export: "db", type: "ClickHouse::Database", ddl: `CREATE DATABASE ${DB} ENGINE = Atomic`, dependsOn: [] }, ...objects] });

  beforeAll(async () => {
    await clickhouse(`DROP DATABASE IF EXISTS ${DB} SYNC`);
  });
  afterEach(async () => {
    await clickhouse(`DROP DATABASE IF EXISTS ${DB} SYNC`);
  });
  afterAll(() => {
    for (const d of disposers) d();
  });

  it("passes a clean history, and fails a hand-edited recorded schema naming the migration", async () => {
    const p = project("replay-clickhouse");
    disposers.push(p.dispose);
    const one = p.next("events", 0, build(events()));
    const two = p.next("country", 1, build(events(", country String DEFAULT ''")));

    const clean = await p.lint();
    expect(clean.code, clean.out + clean.err).toBe(0);
    const ok = json(clean) as LintDoc;
    expect(ok.replay).toMatchObject({ outcome: "matches", ok: true });
    expect(ok.replay?.matched.map((m) => m.id)).toEqual([one.id, two.id]);

    p.tamperSchema(two.id, build(events(", country LowCardinality(String) DEFAULT ''")));
    const bad = await p.lint();
    expect(bad.code).toBe(1);
    const doc = json(bad) as LintDoc;
    expect(doc.findings.map((f) => [f.rule, f.level, f.migration])).toEqual([["replay", "error", two.id]]);
    expect(doc.findings[0]?.message).toContain(`${two.id}: replaying the history through it does not give the schema it records`);
    expect(doc.replay?.outcome).toBe("differs");
  }, 300_000);

  it("refuses a target that is not fresh with exit 1, and replays into it with --reset", async () => {
    const p = project("replay-clickhouse");
    disposers.push(p.dispose);
    p.next("events", 0, build(events()));
    await clickhouse(`CREATE DATABASE ${DB}`);
    const refused = await p.lint();
    expect(refused.code).toBe(1);
    expect(refused.err).toContain(`already holds ${DB}`);
    const reset = await p.lint("--reset");
    expect(reset.code, reset.err).toBe(0);
  }, 300_000);
});

describe.skipIf(!postgresReachable)("yodel lint --replay on postgres", () => {
  const disposers: Array<() => void> = [];
  const orders = (columns: string): BuiltObject => ({ export: "orders", type: "Postgres::Table", ddl: `CREATE TABLE ${PG}.orders (\n  id bigint PRIMARY KEY,\n  ${columns}\n)`, dependsOn: ["app"] });
  const build = (...objects: BuiltObject[]): BuildOutput => ({
    dialect: "postgres",
    postgresMajor: 18,
    objects: [{ export: "app", type: "Postgres::Schema", ddl: `CREATE SCHEMA ${PG}`, dependsOn: [] }, ...objects],
  });

  beforeAll(async () => {
    await postgres(`DROP SCHEMA IF EXISTS ${PG} CASCADE`);
  });
  afterEach(async () => {
    await postgres(`DROP SCHEMA IF EXISTS ${PG} CASCADE`);
  });
  afterAll(() => {
    for (const d of disposers) d();
  });

  it("passes a clean history, and fails a hand-edited recorded schema naming the migration", async () => {
    const p = project("replay-postgres");
    disposers.push(p.dispose);
    p.next("orders", 0, build(orders("status text NOT NULL")));
    const two = p.next("note", 1, build(orders("status text NOT NULL,\n  note text")));

    const clean = await p.lint();
    expect(clean.code, clean.out + clean.err).toBe(0);
    expect((json(clean) as LintDoc).replay?.outcome).toBe("matches");

    p.tamperSchema(two.id, build(orders("status text NOT NULL,\n  note varchar(200)")));
    const bad = await p.lint();
    expect(bad.code).toBe(1);
    const doc = json(bad) as LintDoc;
    expect(doc.findings.map((f) => [f.rule, f.migration])).toEqual([["replay", two.id]]);
    expect(doc.findings[0]?.message).toMatch(/columns\.note\.type: replay has text, migration\.json records (character varying|varchar)\(200\)/);
  }, 300_000);
});
