/**
 * The ORM handoff end to end against the emulator's Postgres (#279): a
 * column rename runs as a PostgresMigrationOp step, then an orm-handoff step
 * marks the ORM's own migration applied.
 *
 * - Prisma: `prisma migrate status` reports the migration as applied and
 *   `prisma migrate deploy` runs nothing. Needs the prisma CLI in the project
 *   (the suite installs it with npm into the temporary project) and
 *   DATABASE_URL pointing at the emulator with ?schema=<suite schema>.
 * - Rails: the version is a row in schema_migrations. When `rails` is on the
 *   PATH, `rails db:migrate:status` is also checked; the row is checked either
 *   way, because it is the whole of what Rails reads.
 *
 * Written, not run: the epic's brief is unit tests only. Run it with the
 * emulator up:
 *
 *   YODEL_E2E_POSTGRES_URL=postgres://$(ipconfig getifaddr en0):5432/postgres \
 *   YODEL_E2E_POSTGRES_USER=postgres YODEL_E2E_POSTGRES_PASSWORD=chant \
 *   npx vitest run test/e2e/orm-handoff.test.ts
 *
 * Objects in schema <prefix>_orm_handoff, the history in <prefix>_orm_handoff_history.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runChant } from "../../src/chant/process.js";
import type { BuildOutput, BuiltObject } from "../../src/chant/build.js";
import { createMigration, readMigrations, writeMigration, type Migration } from "../../src/migrations/index.js";
import type { OrmHandoffOptions } from "../../src/steps/index.js";
import { json, yodel } from "../helpers/run.js";
import { postgres, postgresReachable, postgresUrl } from "./emulator.js";
import { e2eProject, suiteName } from "./names.js";

const S = suiteName("orm_handoff");
const HISTORY = `${S}_history`;

const schema: BuiltObject = { export: "app", type: "Postgres::Schema", ddl: `CREATE SCHEMA ${S}`, dependsOn: [] };
const people = (cols: string): BuiltObject => ({ export: "people", type: "Postgres::Table", ddl: `CREATE TABLE ${S}.people (${cols})`, dependsOn: ["app"] });
const build = (cols: string): BuildOutput => ({ dialect: "postgres", objects: [schema, people(cols)] });

const available = (command: string, args: string[]): boolean => {
  try {
    execFileSync(command, args, { stdio: "ignore", timeout: 120_000 });
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(!postgresReachable)("the ORM handoff on postgres", () => {
  let dir = "";
  let dispose = (): void => undefined;
  const saved = process.env.YODEL_HISTORY_DATABASE;
  const migrations = () => join(dir, "migrations");
  const at = (...args: string[]) => [...args, "--dir", dir];

  const approvedApply = async () => {
    const gated = await yodel(at("apply", "e2e", "--json"));
    expect(gated.code, gated.err).toBe(3);
    const command = (json(gated) as { approve?: string }).approve ?? "";
    const ran = await runChant(command.split(" ").slice(1), { cwd: dir });
    expect(ran.code, ran.stderr).toBe(0);
    return yodel(at("apply", "e2e", "--json"));
  };

  /** Makes the first migration (the table with `login`) and applies it; then the rename with the handoff. */
  const rename = (handoff: OrmHandoffOptions, minute: number, to: string): Migration => {
    const made = createMigration({ name: "rename-login", build: build(`id bigint PRIMARY KEY,\n  ${to} text NOT NULL -- previously: ${to === "handle" ? "login" : "handle"}\n`), previous: readMigrations(migrations()).at(-1), now: new Date(Date.UTC(2026, 9, 23, 13, minute)), ormHandoff: handoff });
    if (made.id === undefined) throw new Error("no change for the rename");
    writeMigration(migrations(), made);
    const m = readMigrations(migrations()).find((x) => x.id === made.id);
    if (!m) throw new Error("the migration was not written");
    return m;
  };

  beforeAll(async () => {
    process.env.YODEL_HISTORY_DATABASE = HISTORY;
    await postgres(`DROP SCHEMA IF EXISTS ${S} CASCADE; DROP SCHEMA IF EXISTS ${HISTORY} CASCADE`);
    ({ dir, dispose } = e2eProject("postgres-versioned", S));
    const first = createMigration({ name: "people", build: build("id bigint PRIMARY KEY, login text NOT NULL"), now: new Date(Date.UTC(2026, 9, 23, 12, 0)) });
    if (first.id === undefined) throw new Error("no first migration");
    writeMigration(migrations(), first);
    const applied = await approvedApply();
    expect(applied.code, applied.err).toBe(0);
    await postgres(`INSERT INTO ${S}.people (id, login) SELECT g, 'user' || g FROM generate_series(1, 500) g`);
  });
  afterAll(async () => {
    dispose();
    if (saved === undefined) delete process.env.YODEL_HISTORY_DATABASE;
    else process.env.YODEL_HISTORY_DATABASE = saved;
    await postgres(`DROP SCHEMA IF EXISTS ${S} CASCADE; DROP SCHEMA IF EXISTS ${HISTORY} CASCADE`);
  });

  it("Rails: the rename runs, then schema_migrations holds the version", async () => {
    const version = "20261023130000";
    mkdirSync(join(dir, "db/migrate"), { recursive: true });
    writeFileSync(join(dir, "db/migrate", `${version}_rename_login.rb`), "class RenameLogin < ActiveRecord::Migration[7.1]\n  def change\n    rename_column :people, :login, :handle\n  end\nend\n");
    const m = rename({ orm: "rails", migration: version, dbSchema: S }, 30, "handle");
    expect(m.document.steps.map((s) => (s.kind === "op" ? s.op : s.kind))).toEqual(["PostgresMigrationOp", "orm-handoff"]);

    const applied = await approvedApply();
    expect(applied.code, applied.err).toBe(0);
    expect(applied.err).toMatch(/step 1: orm-handoff: mark rails migration 20261023130000 applied/);
    const cols = await postgres<{ c: string }>(`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = '${S}' AND table_name = 'people' ORDER BY ordinal_position`);
    expect(cols.map((c) => c.c)).toEqual(["id", "handle"]);
    expect(await postgres(`SELECT version FROM ${S}.schema_migrations`)).toEqual([{ version }]);
    const step = (await postgres<{ note: string }>(`SELECT note FROM ${HISTORY}.history WHERE migration_id = '${m.id}' AND kind = 'step' AND statement_index = 1 AND status = 'succeeded'`))[0];
    expect(JSON.parse(step?.note ?? "{}")).toMatchObject({ op: "orm-handoff", orm: "rails", via: "insert" });
  }, 600_000);

  it.skipIf(!available("npx", ["--no-install", "prisma", "--version"]))("Prisma: migrate status reports the migration applied and migrate deploy runs nothing", async () => {
    const name = "20261023140000_rename_login_again";
    const url = new URL(postgresUrl);
    url.username = process.env.YODEL_E2E_POSTGRES_USER ?? "postgres";
    url.password = process.env.YODEL_E2E_POSTGRES_PASSWORD ?? "";
    url.searchParams.set("schema", S);
    const env = { ...process.env, DATABASE_URL: url.toString() };
    mkdirSync(join(dir, "prisma/migrations", name), { recursive: true });
    writeFileSync(join(dir, "prisma/migrations", name, "migration.sql"), `ALTER TABLE "${S}"."people" RENAME COLUMN "handle" TO "nick";\n`);
    writeFileSync(join(dir, "prisma/migrations/migration_lock.toml"), 'provider = "postgresql"\n');
    writeFileSync(join(dir, "prisma/schema.prisma"), 'datasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}\n\nmodel people {\n  id   BigInt @id\n  nick String\n}\n');
    // The Prisma CLI inherits the process environment, as it does when a person runs yodel apply.
    Object.assign(process.env, { DATABASE_URL: env.DATABASE_URL });
    rename({ orm: "prisma", migration: name, dbSchema: S }, 40, "nick");

    const applied = await approvedApply();
    expect(applied.code, applied.err).toBe(0);
    const status = execFileSync("npx", ["--no-install", "prisma", "migrate", "status"], { cwd: dir, env, encoding: "utf8" });
    expect(status).toMatch(/Database schema is up to date|have been applied/);
    const deploy = execFileSync("npx", ["--no-install", "prisma", "migrate", "deploy"], { cwd: dir, env, encoding: "utf8" });
    expect(deploy).toMatch(/No pending migrations to apply/);
    const row = (await postgres<{ checksum: string; finished: boolean }>(`SELECT checksum, finished_at IS NOT NULL AS finished FROM ${S}._prisma_migrations WHERE migration_name = '${name}'`))[0];
    expect(row?.finished).toBe(true);
    expect(row?.checksum).toMatch(/^[0-9a-f]{64}$/);
  }, 600_000);
});
