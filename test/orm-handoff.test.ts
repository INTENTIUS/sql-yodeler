import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { MigrationStep } from "@intentius/chant-lexicon-sql/migration-statements";
import { projectFromConfig } from "../src/project.js";
import { classifySteps, closeVersioned, currentDigest, executeApply, inspect, openVersioned, selectToApply, type VersionedEnv } from "../src/versioned/index.js";
import {
  asOrmHandoff,
  describeStep,
  ormHandoffOptions,
  ormHandoffRefusal,
  ormHandoffStep,
  planStep,
  runOrmHandoff,
  stepSha,
  type HandoffExec,
  type OrmHandoffOptions,
  type StepRunner,
} from "../src/steps/index.js";
import { FakePgServer } from "./helpers/fake-postgres.js";
import { migration } from "./helpers/fake-clickhouse.js";
import { createMigration, type Migration } from "../src/migrations/index.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A project directory holding a Prisma migration and a Rails one. */
function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "yodel-handoff-"));
  dirs.push(d);
  mkdirSync(join(d, "prisma/migrations/20261009120000_rename_login"), { recursive: true });
  writeFileSync(join(d, "prisma/migrations/20261009120000_rename_login/migration.sql"), 'ALTER TABLE "users" RENAME COLUMN "login" TO "handle";\n');
  mkdirSync(join(d, "db/migrate"), { recursive: true });
  writeFileSync(join(d, "db/migrate/20261009120000_rename_login.rb"), "class RenameLogin < ActiveRecord::Migration[7.1]; end\n");
  return d;
}

const PRISMA: OrmHandoffOptions = { orm: "prisma", migration: "20261009120000_rename_login", dbSchema: "app" };
const RAILS: OrmHandoffOptions = { orm: "rails", migration: "20261009120000", dbSchema: "app" };

/** A stand-in for the server: the ORM's table holds `recorded` and every query is kept. */
function fakeServer(recorded: Array<Record<string, unknown>> = [], missingTable = false) {
  const queries: Array<{ sql: string; params?: readonly unknown[] | undefined }> = [];
  const client = {
    query<T>(sql: string, params?: readonly unknown[]): Promise<T[]> {
      queries.push({ sql, params });
      if (sql.startsWith("SELECT")) {
        if (missingTable) return Promise.reject(new Error(`relation "app._prisma_migrations" does not exist`));
        return Promise.resolve(recorded as T[]);
      }
      return Promise.resolve([]);
    },
  };
  return { client, queries };
}

describe("the orm-handoff step's options", () => {
  const step = (options: unknown): MigrationStep => ({ ...ormHandoffStep("m", PRISMA), options: options as Record<string, unknown> });
  it("plans a Prisma or Rails handoff", () => {
    expect(planStep(ormHandoffStep("m", PRISMA))).toEqual({ run: "ormHandoff", options: PRISMA });
    expect(planStep(ormHandoffStep("m", RAILS))).toEqual({ run: "ormHandoff", options: RAILS });
    expect(describeStep(ormHandoffStep("m", RAILS))).toBe("orm-handoff: mark rails migration 20261009120000 applied");
    expect(asOrmHandoff(ormHandoffStep("m", RAILS))).toBeDefined();
  });
  it("refuses an ORM it does not know, a bad name, a path outside the project and a stray option", () => {
    const why = (o: unknown) => {
      const p = planStep(step(o));
      return p.run === "refused" ? p.reason : p.run;
    };
    expect(why({ orm: "django", migration: "0001" })).toMatch(/options.orm is "django"; yodel hands off to prisma and rails/);
    expect(why({ orm: "prisma", migration: "../x" })).toMatch(/names a Prisma migration directory/);
    expect(why({ orm: "rails", migration: "rename_login" })).toMatch(/Rails migration version/);
    expect(why({ orm: "prisma", migration: "a", dir: "../outside" })).toMatch(/options.dir is a path inside the project/);
    expect(why({ orm: "rails", migration: "1", table: 'x"; DROP' })).toMatch(/options.table is an unquoted SQL name/);
    expect(why({ orm: "rails", migration: "1", schema: "x" })).toMatch(/"schema" is not an option of a rails handoff/);
    expect(ormHandoffOptions(null)).toEqual({ problem: "its options are an object" });
  });
});

describe("refusing a handoff that cannot work", () => {
  it("refuses when the ORM migration is not in the repository", async () => {
    const projectDir = repo();
    const read = () => Promise.resolve([]);
    const prisma = await ormHandoffRefusal({ ...PRISMA, migration: "20270101000000_gone" }, { projectDir, read });
    expect(prisma).toMatch(/Prisma migration 20270101000000_gone is not in the repository \(looked for prisma\/migrations\/20270101000000_gone\/migration.sql\)/);
    const rails = await ormHandoffRefusal({ ...RAILS, migration: "20270101000000" }, { projectDir, read });
    expect(rails).toMatch(/Rails migration 20270101000000 is not in the repository \(looked for db\/migrate\/20270101000000_\*.rb\)/);
    // A directory without migration.sql is not a migration.
    mkdirSync(join(projectDir, "prisma/migrations/20270202000000_empty"));
    expect(await ormHandoffRefusal({ ...PRISMA, migration: "20270202000000_empty" }, { projectDir, read })).toMatch(/not in the repository/);
  });

  it("refuses when the ORM already records the migration as applied", async () => {
    const projectDir = repo();
    const read = (sql: string) => Promise.resolve(sql.includes("_prisma_migrations") || sql.includes("schema_migrations") ? [{ applied: 1 }] : []);
    expect(await ormHandoffRefusal(PRISMA, { projectDir, read })).toMatch(/Prisma already records 20261009120000_rename_login as applied \("app"._prisma_migrations\)/);
    expect(await ormHandoffRefusal(RAILS, { projectDir, read })).toMatch(/Rails already records 20261009120000 as applied \("app"."schema_migrations"\)/);
  });

  it("counts a Prisma row as applied only when it is finished, and an ORM table that is not there as empty", async () => {
    const projectDir = repo();
    const seen: string[] = [];
    const read = (sql: string) => {
      seen.push(sql);
      return Promise.resolve([]);
    };
    expect(await ormHandoffRefusal(PRISMA, { projectDir, read })).toBeUndefined();
    expect(seen[0]).toBe(`SELECT 1 AS applied FROM "app"._prisma_migrations WHERE migration_name = '20261009120000_rename_login' AND finished_at IS NOT NULL`);
    const none = () => Promise.reject(new Error('relation "app.schema_migrations" does not exist'));
    expect(await ormHandoffRefusal(RAILS, { projectDir, read: none })).toBeUndefined();
    const broken = () => Promise.reject(new Error("permission denied for table x"));
    await expect(ormHandoffRefusal(RAILS, { projectDir, read: broken })).rejects.toThrow(/permission denied/);
  });
});

describe("running the handoff", () => {
  it("Rails: creates the table when it is not there and inserts the version", async () => {
    const projectDir = repo();
    const { client, queries } = fakeServer();
    const { summary } = await runOrmHandoff(RAILS, { projectDir, client });
    expect(summary).toEqual({ op: "orm-handoff", orm: "rails", migration: "20261009120000", via: "insert", table: '"app"."schema_migrations"' });
    expect(queries.slice(1).map((q) => q.sql)).toEqual([
      `CREATE TABLE IF NOT EXISTS "app"."schema_migrations" ("version" character varying NOT NULL PRIMARY KEY)`,
      `INSERT INTO "app"."schema_migrations" ("version") VALUES ($1)`,
    ]);
    expect(queries[2]?.params).toEqual(["20261009120000"]);
  });

  it("Rails: writes nothing when the migration is missing or recorded", async () => {
    const projectDir = repo();
    const recorded = fakeServer([{ applied: 1 }]);
    await expect(runOrmHandoff(RAILS, { projectDir, client: recorded.client })).rejects.toThrow(/already records/);
    expect(recorded.queries.filter((q) => !q.sql.startsWith("SELECT"))).toEqual([]);
    const missing = fakeServer();
    await expect(runOrmHandoff({ ...RAILS, migration: "99" }, { projectDir, client: missing.client })).rejects.toThrow(/not in the repository/);
    expect(missing.queries).toEqual([]);
  });

  it("Prisma: runs prisma migrate resolve --applied in the project and checks the row", async () => {
    const projectDir = repo();
    const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
    const server = fakeServer();
    // The CLI writes the row; the next read finds it.
    const exec: HandoffExec = (command, args, cwd) => {
      calls.push({ command, args, cwd });
      server.client.query = <T>(sql: string) => Promise.resolve((sql.startsWith("SELECT") ? [{ applied: 1 }] : []) as T[]);
      return Promise.resolve({ code: 0, output: "Migration 20261009120000_rename_login marked as applied." });
    };
    const { summary } = await runOrmHandoff({ ...PRISMA, schema: "prisma/schema.prisma" }, { projectDir, client: server.client, exec });
    expect(calls).toEqual([{ command: "npx", args: ["--no-install", "prisma", "migrate", "resolve", "--applied", "20261009120000_rename_login", "--schema", "prisma/schema.prisma"], cwd: projectDir }]);
    expect(summary).toMatchObject({ orm: "prisma", via: "prisma migrate resolve", table: '"app"._prisma_migrations' });
  });

  it("Prisma: does not run the CLI for a missing or recorded migration, and fails on its exit or on another database", async () => {
    const projectDir = repo();
    const never: HandoffExec = () => Promise.reject(new Error("the CLI must not run"));
    await expect(runOrmHandoff({ ...PRISMA, migration: "20270101000000_gone" }, { projectDir, client: fakeServer().client, exec: never })).rejects.toThrow(/not in the repository/);
    await expect(runOrmHandoff(PRISMA, { projectDir, client: fakeServer([{ applied: 1 }]).client, exec: never })).rejects.toThrow(/already records/);
    const failing: HandoffExec = () => Promise.resolve({ code: 1, output: "P3008 The migration is already recorded as applied" });
    await expect(runOrmHandoff(PRISMA, { projectDir, client: fakeServer().client, exec: failing })).rejects.toThrow(/exited 1: P3008/);
    const ok: HandoffExec = () => Promise.resolve({ code: 0, output: "" });
    await expect(runOrmHandoff(PRISMA, { projectDir, client: fakeServer().client, exec: ok })).rejects.toThrow(/no finished row for it/);
  });
});

describe("the step in a migration", () => {
  const SCHEMA = "yodel_279_history";
  const handoff = ormHandoffStep("rename-login", { orm: "prisma", migration: "20261009120000_rename_login", dbSchema: "yodel_279" });
  const stmt = (sql: string): MigrationStep => ({ kind: "statement", object: "users", type: "Postgres::Table", name: "yodel_279.users", sql, rule: "SQLPG200", class: "create", transactional: true });
  const pgMigration = (id: string, steps: MigrationStep[], dialect: "postgres" | "clickhouse" = "postgres"): Migration => {
    const m = migration(id, null, steps);
    return { ...m, document: { ...m.document, dialect } };
  };

  const setup = async (projectDir: string, recorded: boolean) => {
    const server = new FakePgServer();
    const project = projectFromConfig(projectDir, join(projectDir, "chant.config.ts"), { lexicons: ["sql"], sql: { dialect: "postgres", profiles: { e2e: { url: "postgres://pg:5432/db", schemas: ["yodel_279"] } } } });
    const venv = await openVersioned(project, { name: "e2e", profile: { url: "postgres://pg:5432/db" } }, { YODEL_HISTORY_DATABASE: SCHEMA }, undefined, () => server.connect());
    venv.driver.liveFingerprint = () => Promise.resolve("sha256:fake");
    const asked: string[] = [];
    venv.driver.readCheck = (sql) => {
      asked.push(sql);
      return Promise.resolve(recorded ? [{ applied: 1 }] : []);
    };
    return { server, venv, asked };
  };
  const apply = async (venv: VersionedEnv, ordered: Migration[], runStep: StepRunner) => {
    const { status } = await inspect(venv, ordered);
    const digest = await currentDigest(venv, status, selectToApply(status, false));
    return executeApply(venv, ordered, { approvedDigest: digest, allowOutOfOrder: false, approve: () => Promise.resolve(), log: () => undefined, runStep, processEnv: { USER: "tester" } });
  };

  it("hashes into the history like any step, and changes with its options", async () => {
    const m = pgMigration("20261009T1000-rename", [stmt("CREATE TABLE yodel_279.users (id bigint)"), handoff]);
    const { server, venv } = await setup(repo(), false);
    const ran: number[] = [];
    await apply(venv, [m], (ctx) => {
      ran.push(ctx.index);
      return Promise.resolve({ summary: { op: "orm-handoff", orm: "prisma" } });
    });
    expect(ran).toEqual([1]);
    expect(server.sent).toEqual(["CREATE TABLE yodel_279.users (id bigint)"]);
    const rows = server.rows.filter((r) => r.kind === "step");
    expect(rows.map((r) => r.status)).toEqual(["started", "succeeded"]);
    expect(rows[1]).toMatchObject({ statement_index: 1, statement_sha: stepSha(handoff), note: JSON.stringify({ op: "orm-handoff", orm: "prisma" }) });
    expect(stepSha(handoff)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(stepSha(handoff)).toBe(stepSha(ormHandoffStep("rename-login", { orm: "prisma", migration: "20261009120000_rename_login", dbSchema: "yodel_279" })));
    expect(stepSha(handoff)).not.toBe(stepSha(ormHandoffStep("rename-login", { orm: "prisma", migration: "20261010000000_other", dbSchema: "yodel_279" })));
    await closeVersioned(venv);
  });

  it("refuses the migration before its first statement when the ORM migration is missing", async () => {
    const m = pgMigration("20261009T1000-rename", [stmt("CREATE TABLE yodel_279.users (id bigint)"), ormHandoffStep("rename-login", { orm: "prisma", migration: "20270101000000_gone", dbSchema: "yodel_279" })]);
    const { server, venv } = await setup(repo(), false);
    const runStep: StepRunner = () => Promise.reject(new Error("no step may run"));
    await expect(apply(venv, [m], runStep)).rejects.toMatchObject({ exitCode: 4, message: expect.stringContaining("Nothing of 20261009T1000-rename was applied") as unknown });
    expect(server.sent).toEqual([]);
    await closeVersioned(venv);
  });

  it("refuses the migration before its first statement when the ORM already records it", async () => {
    const m = pgMigration("20261009T1000-rename", [stmt("CREATE TABLE yodel_279.users (id bigint)"), handoff]);
    const { server, venv, asked } = await setup(repo(), true);
    await expect(apply(venv, [m], () => Promise.reject(new Error("no step may run")))).rejects.toThrow(/Prisma already records 20261009120000_rename_login as applied/);
    expect(asked[0]).toContain(`"yodel_279"._prisma_migrations`);
    expect(server.sent).toEqual([]);
    await closeVersioned(venv);
  });

  it("is refused when it is not the migration's last step or the migration is not Postgres", () => {
    const early = pgMigration("20261009T1000-rename", [handoff, stmt("CREATE TABLE yodel_279.users (id bigint)")]);
    expect(classifySteps(early).refusedSteps[0]?.reason).toMatch(/not 20261009T1000-rename's last/);
    const last = pgMigration("20261009T1001-rename", [stmt("CREATE TABLE yodel_279.users (id bigint)"), handoff]);
    expect(classifySteps(last)).toMatchObject({ opSteps: [{ index: 1 }], refusedSteps: [] });
    const ch = pgMigration("20261009T1002-rename", [handoff], "clickhouse");
    expect(classifySteps(ch).refusedSteps[0]?.reason).toBe("an orm-handoff step in a clickhouse migration");
  });
});

describe("yodel's migration writer", () => {
  it("ends a migration with the handoff, in its checksum", () => {
    const build = { dialect: "postgres" as const, objects: [{ export: "app", type: "Postgres::Schema", ddl: "CREATE SCHEMA app", dependsOn: [] }] };
    const now = new Date(Date.UTC(2026, 9, 23, 12, 0));
    const made = createMigration({ name: "first", build, now, ormHandoff: PRISMA });
    const plain = createMigration({ name: "first", build, now });
    if (made.id === undefined || plain.id === undefined) throw new Error("expected migrations");
    expect(made.document.steps.at(-1)).toMatchObject({ kind: "op", op: "orm-handoff", options: PRISMA });
    expect(made.document.refused).toBe(true);
    expect(made.document.checksum).not.toBe(plain.document.checksum);
    expect(made.files.sql).toContain("orm-handoff");
  });
});
