/**
 * The versioned path (#8): `yodel apply <env>` and `yodel status <env>` for a
 * project with a `migrations/` directory.
 *
 *   hasMigrations(project)                 whether apply takes the versioned path
 *   openVersioned(project, env)            the server, the history, the lock settings
 *   inspect(venv, ordered)                 history state and how the directory compares (no lock)
 *   compareHistory(ordered, state)         the same, pure
 *   selectToApply(status, allowOutOfOrder) the pending migrations, or the refusal
 *   currentDigest(venv, status, toApply)   the plan digest
 *   executeApply(venv, ordered, options)   apply under the lock, after checking the digest
 *   findMigrateOp / runMigrateOp           the approval Op (see ./op.ts)
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "../project.js";
import { MIGRATIONS_DIR } from "../migrations/index.js";
import type { Migration } from "../migrations/index.js";
import { currentDigest, inspect, integrityRefusal, stepRefusal, type VersionedEnv } from "./engine.js";
import type { StatusReport } from "./report.js";

export * from "./approval.js";
export * from "./digest.js";
export * from "./engine.js";
export * from "./op.js";
export * from "./report.js";
export * from "./state.js";

/** The project's migrations directory. */
export const migrationsDir = (project: Project): string => join(project.dir, MIGRATIONS_DIR);

/**
 * Whether `yodel apply` takes the versioned path: the project has a
 * `migrations/` directory holding at least one migration directory. A
 * directory that is there but malformed still takes it, and is refused
 * there, rather than falling back to the declarative path.
 */
export function hasMigrations(project: Project): boolean {
  const dir = migrationsDir(project);
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some((e) => !e.startsWith(".") && statSync(join(dir, e)).isDirectory());
}

/** The status, with the digest apply would ask approval for, or why it would refuse. */
export async function statusReport(venv: VersionedEnv, ordered: readonly Migration[], options: { allowOutOfOrder?: boolean; sync?: boolean } = {}): Promise<StatusReport> {
  const { status } = await inspect(venv, ordered, options.sync === undefined ? {} : { sync: options.sync });
  const refusal = integrityRefusal(status, options.allowOutOfOrder === true) ?? stepRefusal(status.pending);
  const digest = !refusal && status.pending.length > 0 ? await currentDigest(venv, status, status.pending) : undefined;
  return {
    environment: venv.environment,
    location: venv.location,
    status,
    digest,
    refusal: refusal ? { exitCode: refusal.exitCode, message: refusal.message } : undefined,
  };
}
