/**
 * Silences: a line in `migration.sql`, above the statement it is for,
 *
 *     -- yodel:allow <rule> <reason>
 *
 * silences that statement rule for that one step. The reason is required
 * and is recorded, with the rule and the step, in every history row the
 * migration writes when it applies (the `silences` column), so the history
 * says who accepted what and why. Because `migration.sql` is in the
 * migration's checksum, a silence is part of what an approval covers.
 *
 * Which step a line is "above": `migration.sql` holds each step in the
 * order `migration.json` lists them, a statement as its SQL followed by
 * `;`, an Op or manual step as a comment starting `-- <object> (<name>):`
 * (`renderStatements`). Each step is found in that order; a silence belongs
 * to the first step found after it. A statement `migration.sql` does not
 * hold as `migration.json` records it is reported (`migration-sql`): apply
 * runs `migration.json`'s, so an edit to the SQL alone changes nothing.
 */

import type { MigrationStep } from "@intentius/chant-lexicon-sql/migration-statements";
import { normalizeLineEndings } from "../migrations/document.js";

/** One `-- yodel:allow` line, read. */
export interface Silence {
  /** The step it is above, an index into `migration.json`'s `steps`. */
  step: number;
  rule: string;
  reason: string;
  /** Its line in migration.sql, from 1. */
  line: number;
}

/** What was wrong with a migration.sql. */
export interface SqlProblem {
  rule: "migration-sql" | "silence";
  message: string;
  step?: number;
  line?: number;
}

export interface SqlMap {
  silences: Silence[];
  problems: SqlProblem[];
}

const DIRECTIVE = /yodel:\s*allow\b/i;
const SILENCE = /^\s*--\s*yodel:allow(?:\s+(\S+))?(?:\s+(.*?))?\s*$/;

/** The text that marks a step in migration.sql. */
function anchorOf(step: MigrationStep): string {
  return step.kind === "statement" ? `${step.sql};` : `-- ${step.object} (${step.name}):`;
}

const describe = (step: MigrationStep, i: number) => `step ${String(i)} (${step.kind === "statement" ? `${step.rule} ${step.class}` : step.kind}, ${step.name})`;

/**
 * Reads the silences in `sql` and assigns each to its step. `known` is the
 * set of rule ids a silence may name. Problems: a silence that is
 * malformed, names an unknown rule or one that cannot be silenced, has no
 * reason, or follows the last step; a step migration.sql does not hold.
 */
export function mapMigrationSql(sql: string, steps: readonly MigrationStep[], silenceable: ReadonlySet<string>): SqlMap {
  const text = normalizeLineEndings(sql);
  const lineAt = (offset: number) => text.slice(0, offset).split("\n").length;
  const out: SqlMap = { silences: [], problems: [] };

  const readRegion = (from: number, to: number, step: number | undefined) => {
    const region = text.slice(from, to);
    let offset = from;
    for (const raw of region.split("\n")) {
      const line = lineAt(offset);
      offset += raw.length + 1;
      if (!DIRECTIVE.test(raw) || !raw.trimStart().startsWith("--")) continue;
      const m = SILENCE.exec(raw);
      const rule = m?.[1];
      const reason = m?.[2]?.trim() ?? "";
      if (!m || rule === undefined) {
        out.problems.push({ rule: "silence", line, message: `migration.sql line ${String(line)}: expected -- yodel:allow <rule> <reason>` });
        continue;
      }
      if (!silenceable.has(rule)) {
        out.problems.push({ rule: "silence", line, message: `migration.sql line ${String(line)}: ${rule} is not a rule a statement can silence (${[...silenceable].join(", ")})` });
        continue;
      }
      if (reason === "") {
        out.problems.push({ rule: "silence", line, message: `migration.sql line ${String(line)}: silencing ${rule} needs a reason: -- yodel:allow ${rule} <why this is safe>` });
        continue;
      }
      if (step === undefined) {
        out.problems.push({ rule: "silence", line, message: `migration.sql line ${String(line)}: yodel:allow ${rule} comes after the last step, so it silences nothing; put it above the statement` });
        continue;
      }
      out.silences.push({ step, rule, reason, line });
    }
  };

  let cursor = 0;
  steps.forEach((step, i) => {
    const anchor = anchorOf(step);
    const at = text.indexOf(anchor, cursor);
    if (at === -1) {
      if (step.kind === "statement") {
        out.problems.push({
          rule: "migration-sql",
          step: i,
          message: `${describe(step, i)}: migration.sql does not hold its statement as migration.json records it (${step.sql.split("\n")[0] ?? ""}); yodel apply runs migration.json's`,
        });
      }
      // An Op or manual step's comment is for people; a missing one moves nothing.
      return;
    }
    readRegion(cursor, at, i);
    cursor = at + anchor.length;
  });
  readRegion(cursor, text.length, undefined);
  return out;
}

/** The silences as the history's `silences` field holds them: JSON, `[{"step":0,"rule":"...","reason":"..."}]`. */
export const silencesJson = (silences: readonly Silence[]): string => JSON.stringify(silences.map((s) => ({ step: s.step, rule: s.rule, reason: s.reason })));
