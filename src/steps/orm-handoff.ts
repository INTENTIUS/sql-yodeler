/**
 * An `orm-handoff` step (#279): the last step of a migration whose change an
 * ORM also owns. A hard change (a staged rename, a type change) runs as a
 * `PostgresMigrationOp`; the team writes the ORM's own migration for the same
 * change; this step then marks that migration as applied, so the ORM does not
 * run it again.
 *
 * It does what each ORM's own "mark as applied" does, and nothing the ORM
 * would not:
 *
 * - Prisma: `prisma migrate resolve --applied <name>`, the CLI. Yodel runs
 *   the command and does not write `_prisma_migrations` itself. The CLI
 *   (schema-engine's `mark_migration_applied`) refuses a migration that is not
 *   in the migrations directory, refuses one already recorded as finished,
 *   checks the directory's provider lock file, takes the migrations table's
 *   advisory lock, and writes the row with the checksum of `migration.sql`
 *   (SHA-256, hex; `checksum.rs`), which `migrate deploy` and `migrate dev`
 *   compare on every run. A row written by hand has to copy all of that and
 *   follow it when a Prisma release changes it.
 * - Rails: a row in `schema_migrations`, which is all Rails itself writes for
 *   a migration it has run (`SchemaMigration#create_version` inserts the
 *   version string into the `version` column). `rails db:migrate` skips a
 *   migration whose version is in the table (`pending_migrations` rejects the
 *   versions already migrated). Rails runs the app's Ruby to do that, so
 *   yodel inserts the row itself.
 *
 * Before the migration's first statement, apply asks {@link ormHandoffRefusal}
 * whether the handoff can work: the ORM's migration is in the repository and
 * is not recorded as applied. A handoff found out only after the Op ran would
 * leave the change made and the ORM about to make it again.
 */

import { execFile } from "node:child_process";
import { statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { PgClient } from "../history/postgres/index.js";
import type { MigrationStep } from "@intentius/chant-lexicon-sql/migration-statements";
import { ORM_HANDOFF_OP, type OrmHandoffOptions } from "./kinds.js";

const PRISMA_DIR = "prisma/migrations";
const RAILS_DIR = "db/migrate";
const DEFAULT_SCHEMA = "public";
/** Rails' migration file name: the version, the name, an optional scope (`MigrationFilenameRegexp`). */
const RAILS_FILE = /^([0-9]+)_([_a-z0-9]*)\.?([_a-z0-9]*)?\.rb$/;

const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;
const str = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Runs a command to the end: its stdout and stderr, and its exit code (not a throw). */
export type HandoffExec = (command: string, args: string[], cwd: string) => Promise<{ code: number; output: string }>;

export const defaultHandoffExec: HandoffExec = (command, args, cwd) =>
  new Promise((resolve) => {
    execFile(command, args, { cwd, env: process.env, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
      resolve({ code, output: `${stdout}${stderr}`.trim() });
    });
  });

/** The ORM's own name for it, for messages. */
const ormName = (o: OrmHandoffOptions) => (o.orm === "prisma" ? "Prisma" : "Rails");

/** The file in the repository that proves the ORM migration exists, or `undefined`. */
export function ormMigrationFile(options: OrmHandoffOptions, projectDir: string): string | undefined {
  if (options.orm === "prisma") {
    const file = join(projectDir, options.dir ?? PRISMA_DIR, options.migration, "migration.sql");
    return isFile(file) ? file : undefined;
  }
  const dir = join(projectDir, options.dir ?? RAILS_DIR);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  const name = names.find((n) => RAILS_FILE.exec(n)?.[1] === options.migration);
  return name !== undefined && isFile(join(dir, name)) ? join(dir, name) : undefined;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Where the ORM records its migrations, and the query that says whether it recorded this one. */
function recordedQuery(options: OrmHandoffOptions): { table: string; sql: string } {
  const schema = quote(options.dbSchema ?? DEFAULT_SCHEMA);
  if (options.orm === "prisma") {
    // A row with finished_at set is what schema-engine's mark_migration_applied calls applied; a failed or rolled-back row is not.
    return { table: `${schema}._prisma_migrations`, sql: `SELECT 1 AS applied FROM ${schema}._prisma_migrations WHERE migration_name = ${str(options.migration)} AND finished_at IS NOT NULL` };
  }
  const table = `${schema}.${quote(options.table ?? "schema_migrations")}`;
  return { table, sql: `SELECT 1 AS applied FROM ${table} WHERE version = ${str(options.migration)}` };
}

const MISSING_TABLE = /relation "[^"]+" does not exist|schema "[^"]+" does not exist/;

/** Whether the ORM's table already holds the migration. A table that is not there yet holds nothing. */
async function isRecorded(options: OrmHandoffOptions, read: (sql: string) => Promise<Array<Record<string, unknown>>>): Promise<boolean> {
  try {
    return (await read(recordedQuery(options).sql)).length > 0;
  } catch (e) {
    if (MISSING_TABLE.test(e instanceof Error ? e.message : String(e))) return false;
    throw e;
  }
}

/**
 * Why the handoff cannot run, or `undefined` when it can: the ORM's migration
 * is not in the repository, or the ORM already records it as applied. `read`
 * runs a read-only query on the environment's server.
 */
export async function ormHandoffRefusal(options: OrmHandoffOptions, ctx: { projectDir: string; read: (sql: string) => Promise<Array<Record<string, unknown>>> }): Promise<string | undefined> {
  const orm = ormName(options);
  if (ormMigrationFile(options, ctx.projectDir) === undefined) {
    const where = options.orm === "prisma" ? `${options.dir ?? PRISMA_DIR}/${options.migration}/migration.sql` : `${options.dir ?? RAILS_DIR}/${options.migration}_*.rb`;
    return `the ${orm} migration ${options.migration} is not in the repository (looked for ${where}), so there is nothing to mark applied`;
  }
  if (await isRecorded(options, ctx.read)) {
    return `${orm} already records ${options.migration} as applied (${recordedQuery(options).table}), so the Op's change would be made twice or the ORM's migration was run by the ORM; remove the orm-handoff step if the ORM ran it`;
  }
  return undefined;
}

export interface OrmHandoffSummary {
  op: "orm-handoff";
  orm: "prisma" | "rails";
  migration: string;
  /** How it was recorded: the Prisma CLI, or a row yodel inserted. */
  via: "prisma migrate resolve" | "insert";
  table: string;
}

export interface RunOrmHandoffOptions {
  projectDir: string;
  /** The environment's Postgres connection. */
  client: PgClient;
  log?: (line: string) => void;
  exec?: HandoffExec;
}

/** Runs the handoff to the end. Throws when the ORM's migration is missing or already applied, or the ORM's command fails. */
export async function runOrmHandoff(options: OrmHandoffOptions, run: RunOrmHandoffOptions): Promise<{ summary: OrmHandoffSummary }> {
  const read = (sql: string) => run.client.query(sql);
  const why = await ormHandoffRefusal(options, { projectDir: run.projectDir, read });
  if (why) throw new Error(`orm-handoff refused: ${why}`);
  const { table } = recordedQuery(options);
  if (options.orm === "rails") {
    // Rails' own table: `create_table` with a string primary key `version` and no id column.
    await run.client.query(`CREATE TABLE IF NOT EXISTS ${table} ("version" character varying NOT NULL PRIMARY KEY)`);
    await run.client.query(`INSERT INTO ${table} ("version") VALUES ($1)`, [options.migration]);
    run.log?.(`recorded Rails migration ${options.migration} in ${table}`);
    return { summary: { op: "orm-handoff", orm: "rails", migration: options.migration, via: "insert", table } };
  }
  const args = ["--no-install", "prisma", "migrate", "resolve", "--applied", options.migration, ...(options.schema ? ["--schema", options.schema] : []), ...(options.config ? ["--config", options.config] : [])];
  run.log?.(`npx ${args.join(" ")}`);
  const result = await (run.exec ?? defaultHandoffExec)("npx", args, run.projectDir);
  if (result.code !== 0) throw new Error(`prisma migrate resolve --applied ${options.migration} exited ${String(result.code)}: ${result.output.split("\n").slice(-6).join("\n")}`);
  // The CLI reaches the database through the project's own datasource; confirm it is the environment's.
  if (!(await isRecorded(options, read))) {
    throw new Error(`prisma migrate resolve --applied ${options.migration} succeeded, but ${table} on this environment's server has no finished row for it: the project's datasource points at another database or schema (set dbSchema if Prisma uses another schema)`);
  }
  return { summary: { op: "orm-handoff", orm: "prisma", migration: options.migration, via: "prisma migrate resolve", table } };
}

/** The step to put at the end of a migration's `steps` in `migration.json`: the options are in the step, so in the migration's checksum and the plan digest. */
export function ormHandoffStep(migrationName: string, options: OrmHandoffOptions): Extract<MigrationStep, { kind: "op" }> {
  return {
    kind: "op",
    object: "orm-handoff",
    type: "Yodel::OrmHandoff",
    name: migrationName,
    op: ORM_HANDOFF_OP as never,
    importPath: "@intentius/sql-yodeler",
    options: options,
    declaration: JSON.stringify(options, null, 2),
    changes: [],
    detail: `marks the ${ormName(options)} migration ${options.migration} as applied, so ${ormName(options)} does not run it again. yodel apply runs it last, after the Op, under the migration's lock and gate.`,
  };
}
