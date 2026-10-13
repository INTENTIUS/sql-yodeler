/**
 * The project's `sql-types.d.ts` (chant's `chant sql types`, the row types
 * of the declared tables) kept up with `src/` (#273). `yodel new` runs it
 * after a declaration change, when the project keeps the file, so an edited
 * table does not leave the typed queries a step behind; CI's `chant sql
 * types --check` still catches a file nobody refreshed.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Project } from "../project.js";
import { runChant } from "./process.js";

/** The file `chant sql types` writes, beside the declarations. */
export const SQL_TYPES_FILE = "sql-types.d.ts";

/**
 * Regenerates the project's `sql-types.d.ts` when it has one. `updated` is
 * its path, relative to the project, when the text changed; `warning` says
 * why it could not be written, which never fails the command that asked.
 */
export async function refreshSqlTypes(project: Project): Promise<{ updated?: string; warning?: string }> {
  const path = join(project.dir, project.sourceDir, SQL_TYPES_FILE);
  if (!existsSync(path)) return {};
  const before = readFileSync(path, "utf8");
  const ran = await runChant(["sql", "types", "--output", path], { cwd: project.dir });
  const where = relative(project.dir, path);
  if (ran.code !== 0) return { warning: `chant sql types did not refresh ${where} (exit ${String(ran.code)}): ${(ran.stderr || ran.stdout).trim().split("\n")[0] ?? ""}; run npx chant sql types` };
  return readFileSync(path, "utf8") === before ? {} : { updated: where };
}
