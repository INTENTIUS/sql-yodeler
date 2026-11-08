/**
 * The `unmigrated` rule (#311): the declared schema in the source directory
 * has a change no migration records, so `yodel new` would write one. It is
 * the finding chant's commit job reads on its check trigger to start
 * `/yodel new` (the sql lexicon's `YODEL_COMMIT_FINDINGS`).
 *
 * It builds the declared schema, offline, and diffs the newest migration's
 * recorded schema against it, as `yodel new` does. It reports nothing when
 * the directory is not one chain (`fork` and `directory` say why, and a
 * rebase comes first), when the project names no source directory, or when
 * the build fails: chant's own build and lint report that, and a finding
 * here would start a `yodel new` that fails the same way. A warning unless
 * `lint.rules.unmigrated` sets another level.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildSchema } from "../chant/build.js";
import { createMigration, newestMigration } from "../migrations/index.js";
import type { Project } from "../project.js";
import type { ProjectRule, RawFinding } from "./check.js";
import { LINT_RULES } from "./rules.js";

/** Whether the project names a directory its schema is declared in. */
const declares = (project: Project): boolean =>
  (project.config as { sourceDir?: unknown }).sourceDir !== undefined ? existsSync(join(project.dir, project.sourceDir)) : existsSync(join(project.dir, "src"));

/** The rule over `project`; `note` gets the reason it did not run, for standard error. */
export function unmigratedRule(project: Project, note: (text: string) => void = () => {}): ProjectRule {
  return {
    rule: LINT_RULES.unmigrated,
    check: async (ctx): Promise<RawFinding[]> => {
      const ordered = ctx.scan.ordered;
      if (!ordered || !declares(project)) return [];
      const newest = newestMigration(ordered);
      let build: Awaited<ReturnType<typeof buildSchema>>;
      try {
        build = await buildSchema(project, { empty: true });
      } catch (e) {
        note(`the declared schema did not build, so it is not compared with the newest migration (rule unmigrated): ${(e instanceof Error ? e.message : String(e)).split("\n")[0] ?? ""}`);
        return [];
      }
      try {
        const made = createMigration({ name: "unmigrated", build: build.output, previous: newest });
        if (made.id === undefined) return [];
        const n = made.statements.steps.length;
        const from = newest ? `${newest.id}'s recorded schema` : "an empty schema";
        return [
          {
            rule: LINT_RULES.unmigrated.id,
            message: `the declared schema in ${project.sourceDir} is ahead of ${from} by ${String(n)} step${n === 1 ? "" : "s"} no migration records; write them with yodel new <name>`,
          },
        ];
      } catch (e) {
        note(`the declared schema could not be compared with the newest migration (rule unmigrated): ${(e instanceof Error ? e.message : String(e)).split("\n")[0] ?? ""}`);
        return [];
      } finally {
        build.dispose();
      }
    },
  };
}
