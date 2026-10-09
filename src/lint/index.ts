/**
 * `yodel lint` (#14): rules over a migrations directory, free, for CI.
 *
 *   lintMigrations(dir, options)   every finding, with levels and silences applied
 *   migrationSilences(m)           a migration's `-- yodel:allow` lines, as the history records them
 *   updateChecksum(m)              writes migration.json's checksum to match its files
 *   renderLint / lintJson          the output; lintExitCode the exit code
 *
 * The rules are in `./rules.ts`, how a silence is read in `./silences.ts`.
 */

import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATION_JSON, serializeDocument, verifyChecksum, type Migration } from "../migrations/index.js";
import { silenceableRules } from "./rules.js";
import { mapMigrationSql, silencesJson, type Silence } from "./silences.js";

export * from "./check.js";
export * from "./config.js";
export * from "./report.js";
export * from "./rules.js";
export * from "./silences.js";
export * from "./statements.js";

/** The well-formed `-- yodel:allow` lines of a migration, each with the step it is above. */
export function silencesOf(m: Pick<Migration, "files" | "document">): Silence[] {
  return mapMigrationSql(m.files.sql, m.document.steps, new Set<string>(silenceableRules())).silences;
}

/** {@link silencesOf} as the history's `silences` field holds it: a JSON array of `{ step, rule, reason }`. */
export const migrationSilences = (m: Pick<Migration, "files" | "document">): string => silencesJson(silencesOf(m));

/**
 * Writes `migration.json` again with its `checksum` matching the files, for
 * a migration edited before it was applied anywhere (a silence added, say).
 * Returns the old and new checksum, or `undefined` when they already match.
 */
export function updateChecksum(m: Migration): { from: string; to: string } | undefined {
  const check = verifyChecksum(m);
  if (check.ok) return undefined;
  const path = join(m.dir, MIGRATION_JSON);
  const tmp = join(m.dir, `.${MIGRATION_JSON}.updating`);
  writeFileSync(tmp, serializeDocument({ ...(JSON.parse(m.files.json) as Record<string, unknown>), checksum: check.actual }));
  renameSync(tmp, path);
  return { from: check.recorded, to: check.actual };
}
