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
 * - Drizzle: a row in `drizzle.__drizzle_migrations`, which is all drizzle's
 *   own `migrate()` writes for a migration it has run. drizzle-kit has no
 *   "mark as applied" command, and `migrate()` runs the SQL, so yodel inserts
 *   the row itself. From drizzle-orm 0.45.4 (npm tarball, `package/`; the
 *   same files in `src/` of github.com/drizzle-team/drizzle-orm at the 0.45.4
 *   tag):
 *   - `pg-core/dialect.ts`, `PgDialect.migrate()` (`pg-core/dialect.js` in the
 *     tarball): with `migrationsSchema` (default `drizzle`) and
 *     `migrationsTable` (default `__drizzle_migrations`) it runs
 *     `CREATE SCHEMA IF NOT EXISTS`, then
 *     `CREATE TABLE IF NOT EXISTS <schema>.<table> (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
 *     then `select id, hash, created_at ... order by created_at desc limit 1`.
 *     It runs a migration only when there is no such row or
 *     `Number(last.created_at) < migration.folderMillis`, and after running
 *     it inserts `("hash", "created_at") values (hash, folderMillis)`. The hash
 *     is never compared: only the newest `created_at` decides.
 *   - `migrator.ts` (`migrator.js`), `readMigrationFiles()`: reads
 *     `<migrationsFolder>/meta/_journal.json`; for each entry of `entries`
 *     reads `<migrationsFolder>/<entry.tag>.sql` and sets
 *     `folderMillis = entry.when` (the journal's epoch milliseconds, written
 *     by drizzle-kit when it generated the migration) and
 *     `hash = sha256(<the file's text>)` in hex.
 *   So the row for a journal entry is (sha256 hex of `<tag>.sql`, `when`),
 *   and `migrate()` skips every journal entry whose `when` is at or below the
 *   newest `created_at`. That is also why the handoff has to be the newest
 *   drizzle migration (or every earlier one already applied): recording it
 *   makes `migrate()` skip any earlier entry that is not recorded.
 *
 * Before the migration's first statement, apply asks {@link ormHandoffRefusal}
 * whether the handoff can work: the ORM's migration is in the repository and
 * is not recorded as applied. A handoff found out only after the Op ran would
 * leave the change made and the ORM about to make it again.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PgClient } from "../history/postgres/index.js";
import type { MigrationStep } from "@intentius/chant-lexicon-sql/migration-statements";
import { ORM_HANDOFF_OP, type OrmHandoffOptions } from "./kinds.js";

const PRISMA_DIR = "prisma/migrations";
const DRIZZLE_DIR = "drizzle";
const DRIZZLE_SCHEMA = "drizzle";
const DRIZZLE_TABLE = "__drizzle_migrations";
const DEFAULT_SCHEMA = "public";

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
const ormName = (o: OrmHandoffOptions) => (o.orm === "prisma" ? "Prisma" : "Drizzle");

/** A drizzle migration as `readMigrationFiles()` sees it: its `.sql` file, the journal's `when` and the file's hash. */
export interface DrizzleMigration {
  file: string;
  /** `entries[].when` of `meta/_journal.json`: what drizzle stores as `created_at`. */
  when: number;
  /** SHA-256, hex, of the `.sql` file's text: what drizzle stores as `hash`. */
  hash: string;
}

/** The journal entry for `options.migration` (its `tag`) and its `.sql` file, or `undefined` when either is not in the repository. */
export function drizzleMigration(options: Extract<OrmHandoffOptions, { orm: "drizzle" }>, projectDir: string): DrizzleMigration | undefined {
  const dir = join(projectDir, options.dir ?? DRIZZLE_DIR);
  try {
    const journal = JSON.parse(readFileSync(join(dir, "meta", "_journal.json"), "utf8")) as { entries?: Array<{ tag?: unknown; when?: unknown }> };
    const entry = journal.entries?.find((e) => e.tag === options.migration);
    const file = join(dir, `${options.migration}.sql`);
    if (entry === undefined || typeof entry.when !== "number" || !Number.isSafeInteger(entry.when) || !isFile(file)) return undefined;
    return { file, when: entry.when, hash: createHash("sha256").update(readFileSync(file, "utf8")).digest("hex") };
  } catch {
    return undefined;
  }
}

/** The file in the repository that proves the ORM migration exists, or `undefined`. */
export function ormMigrationFile(options: OrmHandoffOptions, projectDir: string): string | undefined {
  if (options.orm === "prisma") {
    const file = join(projectDir, options.dir ?? PRISMA_DIR, options.migration, "migration.sql");
    return isFile(file) ? file : undefined;
  }
  return drizzleMigration(options, projectDir)?.file;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Where the ORM records its migrations, and the query that says whether it recorded this one. */
function recordedQuery(options: OrmHandoffOptions, projectDir: string): { table: string; sql: string } {
  if (options.orm === "prisma") {
    const schema = quote(options.dbSchema ?? DEFAULT_SCHEMA);
    // A row with finished_at set is what schema-engine's mark_migration_applied calls applied; a failed or rolled-back row is not.
    return { table: `${schema}._prisma_migrations`, sql: `SELECT 1 AS applied FROM ${schema}._prisma_migrations WHERE migration_name = ${str(options.migration)} AND finished_at IS NOT NULL` };
  }
  const table = `${quote(options.dbSchema ?? DRIZZLE_SCHEMA)}.${quote(options.table ?? DRIZZLE_TABLE)}`;
  const found = drizzleMigration(options, projectDir);
  if (found === undefined) throw new Error(`the Drizzle migration ${options.migration} is not in the repository`);
  // migrate() skips a journal entry when the newest created_at is not below its `when`.
  return { table, sql: `SELECT 1 AS applied FROM ${table} WHERE created_at >= ${String(found.when)} LIMIT 1` };
}

const MISSING_TABLE = /relation "[^"]+" does not exist|schema "[^"]+" does not exist/;

/** Whether the ORM's table already holds the migration. A table that is not there yet holds nothing. */
async function isRecorded(options: OrmHandoffOptions, projectDir: string, read: (sql: string) => Promise<Array<Record<string, unknown>>>): Promise<boolean> {
  try {
    return (await read(recordedQuery(options, projectDir).sql)).length > 0;
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
    const where = options.orm === "prisma" ? `${options.dir ?? PRISMA_DIR}/${options.migration}/migration.sql` : `${options.dir ?? DRIZZLE_DIR}/meta/_journal.json for an entry with tag ${options.migration}, and ${options.dir ?? DRIZZLE_DIR}/${options.migration}.sql`;
    return `the ${orm} migration ${options.migration} is not in the repository (looked for ${where}), so there is nothing to mark applied`;
  }
  if (await isRecorded(options, ctx.projectDir, ctx.read)) {
    const where = options.orm === "drizzle" ? `${recordedQuery(options, ctx.projectDir).table} has a created_at at or after the journal's when for it` : recordedQuery(options, ctx.projectDir).table;
    return `${orm} already records ${options.migration} as applied (${where}), so the Op's change would be made twice or the ORM's migration was run by the ORM; remove the orm-handoff step if the ORM ran it`;
  }
  return undefined;
}

export interface OrmHandoffSummary {
  op: "orm-handoff";
  orm: "prisma" | "drizzle";
  migration: string;
  /** How it was recorded: the Prisma CLI, or a row yodel inserted (Drizzle). */
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
  const { table } = recordedQuery(options, run.projectDir);
  if (options.orm === "drizzle") {
    const found = drizzleMigration(options, run.projectDir);
    if (found === undefined) throw new Error(`orm-handoff refused: the Drizzle migration ${options.migration} is not in the repository`);
    // What PgDialect.migrate() creates and writes (see the top of this file).
    await run.client.query(`CREATE SCHEMA IF NOT EXISTS ${quote(options.dbSchema ?? DRIZZLE_SCHEMA)}`);
    await run.client.query(`CREATE TABLE IF NOT EXISTS ${table} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
    await run.client.query(`INSERT INTO ${table} ("hash", "created_at") VALUES ($1, $2)`, [found.hash, found.when]);
    run.log?.(`recorded Drizzle migration ${options.migration} in ${table}`);
    return { summary: { op: "orm-handoff", orm: "drizzle", migration: options.migration, via: "insert", table } };
  }
  const args = ["--no-install", "prisma", "migrate", "resolve", "--applied", options.migration, ...(options.schema ? ["--schema", options.schema] : []), ...(options.config ? ["--config", options.config] : [])];
  run.log?.(`npx ${args.join(" ")}`);
  const result = await (run.exec ?? defaultHandoffExec)("npx", args, run.projectDir);
  if (result.code !== 0) throw new Error(`prisma migrate resolve --applied ${options.migration} exited ${String(result.code)}: ${result.output.split("\n").slice(-6).join("\n")}`);
  // The CLI reaches the database through the project's own datasource; confirm it is the environment's.
  if (!(await isRecorded(options, run.projectDir, read))) {
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
