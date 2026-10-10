/**
 * `yodel init --from <env>`: adopt a live database in one go.
 *
 *  1. Refuse, before anything is written, when the project already declares
 *     a schema (unless `force`), already has migrations, or the
 *     environment's history already records any; and when the environment
 *     names no `databases` (ClickHouse) or `schemas` (Postgres), or names
 *     the history's own.
 *  2. Read the live database with chant's import (`chant import --from`'s
 *     library functions) and write the declarations into the source
 *     directory.
 *  3. Build them and plan the build against the same database. The plan
 *     must be empty: the declarations are the database. If it is not, the
 *     import does not round-trip, and everything written is taken back.
 *  4. Write the baseline migration: the first migration (parent `null`),
 *     whose statements create everything, from an empty schema to the build.
 *  5. Record it applied in the history without running it (`./baseline.ts`),
 *     on ClickHouse in `<history database>.history`, on Postgres in
 *     `<history schema>.history` (#13), under the apply lock.
 *
 * Any failure in 2 to 5 takes back every file written. The live database
 * is only read; the one write to the server is the history row, and the
 * history database (schema) and table when they were not there.
 */

import { join, relative } from "node:path";
import { loadProject, YodelError, type Environment, type Project } from "../project.js";
import { buildSchema } from "../chant/build.js";
import { planEnvironment, renderPlan, type Plan } from "../chant/plan.js";
import { createMigration, MIGRATIONS_DIR, writeMigration, type Migration } from "../migrations/index.js";
import { environmentSettings } from "../config/settings.js";
import { closeVersioned, hasMigrations, openVersioned, REFUSED, type VersionedEnv } from "../versioned/index.js";
import type { HistoryRow } from "../history/index.js";
import { BASELINE_NAME, checkHistoryEmpty, recordBaseline } from "./baseline.js";
import { declarationFiles, Journal } from "./files.js";
import { describeImported, importLive } from "./live.js";

export interface AdoptOptions {
  /** Overwrite declaration files the source directory already has. */
  force?: boolean;
  /** The baseline migration's name. Default {@link BASELINE_NAME}. */
  name?: string;
  now?: Date;
  processEnv?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

export interface Adopted {
  environment: string;
  dialect: Project["dialect"];
  /** The objects read, as `<kind> <name>`. */
  objects: string[];
  /** The declaration files written, relative to the project. */
  schemaFiles: string[];
  /** The baseline migration's directory, relative to the project. */
  migrationPath: string;
  baseline: { id: string; checksum: string; statements: number };
  /** The baseline's history row, recorded applied; init records it on both dialects. */
  recorded: { database: string; row: HistoryRow; lock: { kind: string; where: string; notice?: string } };
  warnings: string[];
}

/** Where the declarations go: `sourceDir` when the config names one, else `src`. */
export const schemaDir = (project: Project): string => join(project.dir, project.config.sourceDir ?? "src");

/** The refusals that need no server: a schema already declared, migrations already there, a ClickHouse scope that would take in the history. */
export function preflight(project: Project, env: Environment, options: { force?: boolean; processEnv?: NodeJS.ProcessEnv } = {}): void {
  if (hasMigrations(project)) {
    throw new YodelError(
      `refused: ${join(project.dir, MIGRATIONS_DIR)} already holds migrations; init writes the first one (the baseline), so it adopts a database only in a project with none. Nothing was written.`,
      REFUSED,
    );
  }
  const dir = schemaDir(project);
  const existing = declarationFiles(dir);
  if (existing.length > 0 && !options.force) {
    throw new YodelError(
      `refused: ${relative(project.dir, dir) || "."} already declares a schema (${existing.slice(0, 3).join(", ")}${existing.length > 3 ? ", ..." : ""}); ` +
        `init writes the declarations from the live database there. Pass --force to overwrite (files the import does not write are kept, and are built with it). Nothing was written.`,
      REFUSED,
    );
  }
  const { historyDatabase } = environmentSettings(project, env.name, options.processEnv);
  const [key, what] = project.dialect === "postgres" ? (["schemas", "schema"] as const) : (["databases", "database"] as const);
  const scope = project.dialect === "postgres" ? env.profile.schemas : env.profile.databases;
  if (!scope || scope.length === 0) {
    throw new YodelError(
      `refused: sql.profiles.${env.name} names no ${key}, so the import would read every ${what} on the server, the history's (${historyDatabase}) included. ` +
        `List the ${key} this project owns in sql.profiles.${env.name}.${key}. Nothing was written.`,
      REFUSED,
    );
  }
  if (scope.includes(historyDatabase)) {
    throw new YodelError(
      `refused: sql.profiles.${env.name}.${key} includes ${historyDatabase}, the history's ${what} (yodel.config.ts environments.${env.name}.history.database, else YODEL_HISTORY_DATABASE); the history is yodel's, never part of the declared schema. Nothing was written.`,
      REFUSED,
    );
  }
}

/**
 * Whether a plan has nothing to do: no change to a declared object, and no
 * undeclared object it would drop, but for the objects the import left out
 * as another tool's (`leftOut`), which an ApplyOp never drops since they
 * carry no chant marker.
 */
const planIsEmpty = (plan: Plan, leftOut: readonly string[] = []): boolean =>
  plan.diff.changes.every((c) => leftOut.includes(c.object)) && plan.refused.length === 0;

/** Adopts `env`'s live database into the project; see the module comment. */
export async function adopt(project: Project, env: Environment, options: AdoptOptions = {}): Promise<Adopted> {
  const processEnv = options.processEnv ?? process.env;
  const log = options.log ?? (() => undefined);
  preflight(project, env, { ...(options.force !== undefined ? { force: options.force } : {}), processEnv });

  const venv: VersionedEnv = await openVersioned(project, env, processEnv);
  try {
    await checkHistoryEmpty(venv);
    return await adoptWith(project, env, venv, options, processEnv, log);
  } finally {
    await closeVersioned(venv);
  }
}

async function adoptWith(project: Project, env: Environment, venv: VersionedEnv, options: AdoptOptions, processEnv: NodeJS.ProcessEnv, log: (line: string) => void): Promise<Adopted> {
  const live = await importLive(project, env, processEnv);
  if (live.ir.resources.length === 0) {
    throw new YodelError(`refused: ${env.name} holds no objects in its scope (sql.profiles.${env.name}); there is nothing to adopt. Declare a schema and run yodel new instead. Nothing was written.`, REFUSED);
  }
  const objects = [...describeImported(live.ir), ...(live.access ?? [])];
  log(`read ${String(objects.length)} object(s) from ${env.name}`);

  const journal = new Journal();
  try {
    const dir = schemaDir(project);
    journal.mkdir(dir);
    const schemaFiles: string[] = [];
    for (const f of live.files) {
      const path = join(dir, f.path);
      journal.write(path, f.content);
      schemaFiles.push(relative(project.dir, path));
    }
    log(`wrote ${schemaFiles.join(", ")}`);

    // The source directory may have been made just now; load the project again so it is built from there.
    const adopted = await loadProject(project.dir);
    const build = await buildSchema(adopted, { env: processEnv });
    let made: ReturnType<typeof createMigration>;
    try {
      const plan = await planEnvironment(adopted, env, build, { env: processEnv });
      if (!planIsEmpty(plan, live.leftOut)) {
        throw new YodelError(
          `the declarations chant's import wrote do not plan clean against ${env.name}, so they are not yet the database; nothing was kept. ` +
            `This is an object chant cannot round-trip; please report it with the plan:\n${await renderPlan(plan, `Plan for ${env.name} after import`)}`,
        );
      }
      log(`planned against ${env.name}: no change`);
      made = createMigration({ name: options.name ?? BASELINE_NAME, build: build.output, ...(options.now ? { now: options.now } : {}) });
    } finally {
      build.dispose();
    }
    if (made.id === undefined) throw new YodelError("the build declares nothing, so there is no baseline to write");

    const migrations = join(project.dir, MIGRATIONS_DIR);
    journal.mkdir(migrations);
    const path = writeMigration(migrations, made);
    journal.created(path);
    const migration: Migration = { id: made.id, dir: path, parent: null, checksum: made.document.checksum, document: made.document, files: made.files };
    const statements = made.statements.steps.length;
    log(`wrote ${relative(project.dir, path)} (${String(statements)} statement${statements === 1 ? "" : "s"})`);

    const base = {
      environment: env.name,
      dialect: project.dialect,
      objects,
      schemaFiles,
      migrationPath: relative(project.dir, path),
      baseline: { id: made.id, checksum: made.document.checksum, statements },
      warnings: live.warnings,
    };
    const { row, lock } = await recordBaseline(venv, migration, processEnv);
    if (lock.notice) log(`lock: ${lock.notice}`);
    log(`recorded ${made.id} applied in ${venv.location.database}.history as a baseline; none of its statements was run`);
    return { ...base, recorded: { database: venv.location.database, row, lock } };
  } catch (e) {
    journal.undo();
    throw e;
  }
}
