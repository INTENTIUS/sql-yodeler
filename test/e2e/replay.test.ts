/**
 * The replay check (#11) end to end against the emulator: a history replays
 * into a fresh database and every migration's recorded schema matches,
 * a sort-key change included (its ClickHouseRebuildOp step runs), and on
 * Postgres a column rename and a type change (PostgresMigrationOp steps); a history
 * whose recorded schema its statements do not produce fails, naming the
 * first migration that differs and what differs; and a target that is not
 * fresh is refused unless reset.
 *
 * ClickHouse database yodel_11, Postgres schema yodel_11_pg. Gated like the
 * other e2e suites:
 *
 *   YODEL_E2E_CLICKHOUSE_URL=http://$(ipconfig getifaddr en0):8123 \
 *   YODEL_E2E_POSTGRES_URL=postgres://$(ipconfig getifaddr en0):5432/postgres \
 *   YODEL_E2E_POSTGRES_USER=postgres YODEL_E2E_POSTGRES_PASSWORD=chant \
 *   npx vitest run test/e2e/replay.test.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { BuildOutput, BuiltObject } from "../../src/chant/build.js";
import { createMigration, readMigrations, serializeDocument, writeMigration, type CreatedMigration, type MigrationDocument } from "../../src/migrations/index.js";
import { loadProject, resolveEnvironment, YodelError } from "../../src/project.js";
import { NOT_FRESH, renderReplay, replayExitCode, replayFailure, replayHistory, type ReplayResult } from "../../src/replay/index.js";
import { projectFrom } from "../helpers/run.js";
import { clickhouse, clickhouseReachable, postgres, postgresReachable } from "./emulator.js";

const DB = "yodel_11";
const PG = "yodel_11_pg";
const HISTORY = "yodel_11_history";

/** A project copied from `fixture`, with helpers to write its migrations and replay them. */
function project(fixture: string) {
  const { dir, dispose } = projectFrom(fixture);
  const migrations = join(dir, "migrations");
  const next = (name: string, minute: number, schema: BuildOutput): CreatedMigration => {
    const made = createMigration({ name, build: schema, previous: readMigrations(migrations).at(-1), now: new Date(Date.UTC(2026, 9, 9, 11, minute)) });
    if (made.id === undefined) throw new Error(`no change for ${name}`);
    writeMigration(migrations, made);
    return made;
  };
  /** Rewrites a migration's migration.json through `edit`, as a hand edit would. */
  const tamper = (id: string, edit: (doc: MigrationDocument) => MigrationDocument) => {
    const path = join(migrations, id, "migration.json");
    writeFileSync(path, serializeDocument(edit(JSON.parse(readFileSync(path, "utf8")) as MigrationDocument)));
  };
  const lines: string[] = [];
  const replay = async (options: { reset?: boolean; keep?: boolean } = {}): Promise<ReplayResult> => {
    const p = await loadProject(dir);
    return replayHistory(p, resolveEnvironment(p, "emulator"), { ...options, log: (line) => lines.push(line) });
  };
  return { dir, dispose, next, tamper, replay, lines };
}

describe.skipIf(!clickhouseReachable)("the replay check on clickhouse", () => {
  const saved = process.env.YODEL_HISTORY_DATABASE;
  const projects: Array<() => void> = [];
  const count = async (sql: string) => Number((await clickhouse(sql)).trim());

  const events = (orderBy: string, extra = ""): BuiltObject => ({
    export: "events",
    type: "ClickHouse::Table",
    ddl: `CREATE TABLE ${DB}.events (id UInt64, ts DateTime, k String${extra}) ENGINE = MergeTree PARTITION BY toYYYYMM(ts) ORDER BY ${orderBy}`,
    dependsOn: ["db"],
  });
  const users: BuiltObject = { export: "users", type: "ClickHouse::Table", ddl: `CREATE TABLE ${DB}.users (id UInt64, name String) ENGINE = MergeTree ORDER BY id`, dependsOn: ["db"] };
  const build = (...objects: BuiltObject[]): BuildOutput => ({
    dialect: "clickhouse",
    objects: [{ export: "db", type: "ClickHouse::Database", ddl: `CREATE DATABASE ${DB} ENGINE = Atomic`, dependsOn: [] }, ...objects],
  });

  beforeAll(async () => {
    process.env.YODEL_HISTORY_DATABASE = HISTORY;
    await clickhouse(`DROP DATABASE IF EXISTS ${DB} SYNC`);
  });
  afterEach(async () => {
    await clickhouse(`DROP DATABASE IF EXISTS ${DB} SYNC`);
  });
  afterAll(() => {
    for (const d of projects) d();
    if (saved === undefined) delete process.env.YODEL_HISTORY_DATABASE;
    else process.env.YODEL_HISTORY_DATABASE = saved;
  });

  it("replays a history, a sort-key rebuild included, into a fresh database, and every recorded schema matches", async () => {
    const p = project("replay-clickhouse");
    projects.push(p.dispose);
    const one = p.next("events", 0, build(events("(k, id)")));
    const two = p.next("users", 1, build(events("(k, id)", ", country String DEFAULT ''"), users));
    const three = p.next("rekey", 2, build(events("(id, k)", ", country String DEFAULT ''"), users));
    expect(three.document.steps.map((s) => (s.kind === "op" ? s.op : s.kind))).toEqual(["ClickHouseRebuildOp"]);

    const result = await p.replay();
    expect(replayFailure(result)?.message).toBeUndefined();
    expect(result.outcome).toBe("matches");
    expect(replayExitCode(result)).toBe(0);
    expect(result.scope).toEqual([DB]);
    expect(result.matched.map((m) => m.id)).toEqual([one.id, two.id, three.id]);
    expect(result.matched[2]?.ran).toEqual(["step 0: ClickHouseRebuildOp for events (yodel_11.events) (swapped)"]);
    expect(renderReplay(result)).toContain("Every migration replays to its recorded schema.");
    // The replay's database is emptied at the end.
    expect(await count(`SELECT count() FROM system.databases WHERE name = '${DB}'`)).toBe(0);
  }, 600_000);

  it("fails a history whose recorded schema its statements do not produce, naming the first migration that differs", async () => {
    const p = project("replay-clickhouse");
    projects.push(p.dispose);
    const one = p.next("events", 0, build(events("(k, id)")));
    const two = p.next("country", 1, build(events("(k, id)", ", country String DEFAULT ''")));
    const three = p.next("users", 2, build(events("(k, id)", ", country String DEFAULT ''"), users));
    // A hand edit: two's recorded schema now says LowCardinality, which its statement does not make.
    p.tamper(two.id, (doc) => ({
      ...doc,
      schema: build(events("(k, id)", ", country LowCardinality(String) DEFAULT ''")),
    }));

    const result = await p.replay({ keep: true });
    expect(result.outcome).toBe("differs");
    expect(replayExitCode(result)).toBe(1);
    expect(result.matched.map((m) => m.id)).toEqual([one.id]);
    const failure = replayFailure(result);
    expect(failure?.migration).toBe(two.id);
    expect(failure?.message).toContain(`${two.id}: replaying the history through it does not give the schema it records (migrations/${two.id}/migration.json); 1 difference:`);
    expect(failure?.message).toMatch(/events \(yodel_11\.events\): columns\.country\.type: replay has String, migration\.json records LowCardinality ?\( ?String ?\) \(SQLCH\d+\)$/m);
    expect(failure?.message).not.toContain(three.id);
    // kept: the database is as the replay left it, after two.
    expect(await count(`SELECT count() FROM system.columns WHERE database = '${DB}' AND table = 'events' AND name = 'country' AND type = 'String'`)).toBe(1);
    expect(await count(`EXISTS TABLE ${DB}.users`)).toBe(0);
  }, 120_000);

  it("fails a statement that does not apply to a fresh database, naming the migration and the statement", async () => {
    const p = project("replay-clickhouse");
    projects.push(p.dispose);
    p.next("events", 0, build(events("(k, id)")));
    const two = p.next("country", 1, build(events("(k, id)", ", country String DEFAULT ''")));
    p.tamper(two.id, (doc) => ({ ...doc, steps: doc.steps.map((s) => (s.kind === "statement" ? { ...s, sql: s.sql.replace("ADD COLUMN country", "ADD COLUMN k") } : s)) }));
    const result = await p.replay();
    expect(result).toMatchObject({ outcome: "failed", migration: two.id, step: 0 });
    expect(replayFailure(result)?.message).toMatch(new RegExp(`^${two.id}: statement 0 failed in the replay: .*already exists`));
    expect(await count(`SELECT count() FROM system.databases WHERE name = '${DB}'`)).toBe(0);
  }, 120_000);

  it("refuses a target that already holds the history's database, then replays into it with reset", async () => {
    const p = project("replay-clickhouse");
    projects.push(p.dispose);
    p.next("events", 0, build(events("(k, id)")));
    await clickhouse(`CREATE DATABASE ${DB}`);
    await clickhouse(`CREATE TABLE ${DB}.stray (x UInt8) ENGINE = MergeTree ORDER BY x`);
    const refused = await p.replay().catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(YodelError);
    expect((refused as YodelError).exitCode).toBe(NOT_FRESH);
    expect((refused as YodelError).message).toContain(`already holds ${DB}`);
    expect(await count(`EXISTS TABLE ${DB}.stray`)).toBe(1);

    const reset = await p.replay({ reset: true });
    expect(reset).toMatchObject({ outcome: "matches", reset: true });
  }, 120_000);
});

describe.skipIf(!postgresReachable)("the replay check on postgres", () => {
  const projects: Array<() => void> = [];
  const schemaExists = async () => (await postgres<{ n: string }>(`SELECT count(*) AS n FROM pg_namespace WHERE nspname = '${PG}'`))[0]?.n === "1";

  const orders = (columns: string): BuiltObject => ({ export: "orders", type: "Postgres::Table", ddl: `CREATE TABLE ${PG}.orders (\n  id bigint PRIMARY KEY,\n  ${columns}\n)`, dependsOn: ["app"] });
  const index: BuiltObject = { export: "ordersStatus", type: "Postgres::Index", ddl: `CREATE INDEX orders_status_idx ON ${PG}.orders (status)`, dependsOn: ["orders"] };
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
    for (const d of projects) d();
  });

  it("replays a history into a fresh schema, and every recorded schema matches", async () => {
    const p = project("replay-postgres");
    projects.push(p.dispose);
    const one = p.next("orders", 0, build(orders("status text NOT NULL")));
    const two = p.next("note", 1, build(orders("status text NOT NULL,\n  note text DEFAULT 'none'"), index));
    const result = await p.replay();
    expect(replayFailure(result)?.message).toBeUndefined();
    expect(result).toMatchObject({ outcome: "matches", scope: [PG] });
    expect(result.matched.map((m) => m.id)).toEqual([one.id, two.id]);
    expect(await schemaExists()).toBe(false);
  }, 120_000);

  it("replays a column rename and a type change across kinds as PostgresMigrationOp steps, and every recorded schema matches", async () => {
    const p = project("replay-postgres");
    projects.push(p.dispose);
    const one = p.next("people", 0, build(orders("login text NOT NULL,\n  score text NOT NULL")));
    const two = p.next("rename-login", 1, build(orders("handle text NOT NULL -- previously: login\n  ,score text NOT NULL")));
    const three = p.next("score-int", 2, build(orders("handle text NOT NULL,\n  score integer NOT NULL")));
    expect(two.document.steps.map((s) => (s.kind === "op" ? s.op : s.kind))).toEqual(["PostgresMigrationOp"]);
    expect(three.document.steps.map((s) => (s.kind === "op" ? s.op : s.kind))).toEqual(["PostgresMigrationOp"]);

    const result = await p.replay();
    expect(replayFailure(result)?.message).toBeUndefined();
    expect(result.outcome).toBe("matches");
    expect(result.matched.map((m) => m.id)).toEqual([one.id, two.id, three.id]);
    expect(result.matched[1]?.ran).toEqual(["step 0: PostgresMigrationOp for orders (yodel_11_pg.orders) (switched, old column dropped)"]);
    expect(result.matched[2]?.ran).toEqual(["step 0: PostgresMigrationOp for orders (yodel_11_pg.orders) (switched, old column dropped)"]);
    expect(await schemaExists()).toBe(false);
  }, 600_000);

  it("fails a history whose recorded schema its statements do not produce, naming the first migration that differs", async () => {
    const p = project("replay-postgres");
    projects.push(p.dispose);
    const one = p.next("orders", 0, build(orders("status text NOT NULL")));
    const two = p.next("note", 1, build(orders("status text NOT NULL,\n  note text")));
    p.next("index", 2, build(orders("status text NOT NULL,\n  note text"), index));
    p.tamper(two.id, (doc) => ({ ...doc, schema: build(orders("status text NOT NULL,\n  note varchar(200)")) }));

    const result = await p.replay();
    expect(result.outcome).toBe("differs");
    expect(result.matched.map((m) => m.id)).toEqual([one.id]);
    const failure = replayFailure(result);
    expect(failure?.migration).toBe(two.id);
    expect(failure?.message).toMatch(/orders \(yodel_11_pg\.orders\): columns\.note\.type: replay has text, migration\.json records (character varying|varchar)\(200\)/);
    expect(await schemaExists()).toBe(false);
  }, 120_000);
});
