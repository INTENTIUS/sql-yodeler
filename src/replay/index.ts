/**
 * The replay check (#11): the migration history, replayed into the
 * dialect's emulator, must produce each migration's recorded schema.
 *
 *   replayHistory(project, env, options)   read migrations/, replay them into env's server, compare after each
 *   replayMigrations(ordered, driver)      the same over any driver (pure of dialect)
 *   replayExitCode / replayFailure         0, 1 or 2; the first failing migration and why
 *   renderReplay / replayJson              the result for people and for tools
 *
 * `yodel lint --replay <env>` and the CI template run it against the
 * emulator (`chant emulator up --lexicon sql`), bound by the environment's
 * `sql.profiles.<env>`.
 */

import type { Environment, Project } from "../project.js";
import { readMigrations } from "../migrations/index.js";
import { migrationsDir } from "../versioned/index.js";
import type { StepRunner } from "../steps/index.js";
import type { ClickHousePort } from "../history/index.js";
import { clickhouseReplay } from "./clickhouse.js";
import { postgresReplay } from "./postgres.js";
import { refuseShared, sharedProfiles } from "./shared.js";
import { replayMigrations, type ReplayDriver, type ReplayOptions, type ReplayResult } from "./replay.js";

export * from "./replay.js";
export * from "./report.js";
export * from "./shared.js";
export { clickhouseDatabases, clickhouseReplay } from "./clickhouse.js";
export { postgresReplay, postgresSchemas } from "./postgres.js";

export interface ReplayHistoryOptions extends ReplayOptions {
  processEnv?: NodeJS.ProcessEnv;
  /** ClickHouse: the server, in place of an HTTP port to the bound endpoint. */
  port?: ClickHousePort;
  /** Runs a ClickHouseRebuildOp or PostgresMigrationOp step. Default: chant's local executor, as apply runs it. */
  runStep?: StepRunner;
  /** Other profiles on the same server whose databases or schemas the replay may empty (`--reset-shared`). */
  resetShared?: readonly string[];
}

/** The dialect's driver for `env`. */
export async function openReplay(project: Project, env: Environment, ordered: Parameters<typeof replayMigrations>[0], options: ReplayHistoryOptions = {}): Promise<ReplayDriver> {
  if (project.dialect === "postgres") {
    return postgresReplay(project, env, ordered, {
      ...(options.processEnv ? { processEnv: options.processEnv } : {}),
      ...(options.runStep ? { runStep: options.runStep } : {}),
      ...(options.log ? { log: options.log } : {}),
    });
  }
  return clickhouseReplay(project, env, ordered, {
    ...(options.processEnv ? { processEnv: options.processEnv } : {}),
    ...(options.port ? { port: options.port } : {}),
    ...(options.runStep ? { runStep: options.runStep } : {}),
    ...(options.log ? { log: options.log } : {}),
  });
}

/**
 * Replays the project's migrations (well formed, or a `MigrationDirectoryError`)
 * into `env`'s server and compares each with its recorded schema. Checksums
 * are not this check's: `yodel lint` checks them.
 */
export async function replayHistory(project: Project, env: Environment, options: ReplayHistoryOptions = {}): Promise<ReplayResult> {
  const ordered = readMigrations(migrationsDir(project));
  const driver = await openReplay(project, env, ordered, options);
  try {
    refuseShared(env, await sharedProfiles(project, env, driver.scope, options.processEnv), options.resetShared ?? [], project.dialect);
    return await replayMigrations(ordered, driver, options);
  } finally {
    await driver.close();
  }
}
