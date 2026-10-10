/**
 * Pre-migration checks (#52), run against an environment.
 *
 * A migration's `checks` (`../migrations/checks.ts`) are read-only queries.
 * `yodel apply <env>` runs the first pending migration's before it runs the
 * migrations Op, so a run that would be refused stops before anyone is
 * asked to approve it; the Op's Apply step runs every migration's again
 * under the lock, just before that migration's first statement, where the
 * data is what the statements will meet. A check that fails, or whose query
 * the server refuses, refuses the run with exit 4: nothing of that
 * migration is sent. Under the lock the history records the outcome: the
 * migration's `started` row carries the checks that passed in its `note`,
 * and a refusal is a `failed` migration row naming the check.
 *
 * A migration resuming part way (a statement of it already succeeded) does
 * not run its checks again: they held before its first statement.
 */

import { YodelError } from "../project.js";
import { EXIT_REFUSED } from "../exit.js";
import { describeExpect, judgeCheck, type CheckOutcome, type Migration } from "../migrations/index.js";
import type { VersionedDriver } from "./driver.js";
import type { PendingMigration } from "./state.js";

/** Whether `p`'s checks run before it: it has some, and no statement of it has succeeded yet. */
export const checksDue = (p: PendingMigration): boolean => (p.migration.document.checks?.length ?? 0) > 0 && (p.partWay?.done.length ?? 0) === 0;

/** Runs each of `m`'s checks; a query the server refuses is a failed check. */
export async function runChecks(driver: VersionedDriver, m: Migration): Promise<CheckOutcome[]> {
  const where = { defaultDatabase: m.document.defaultDatabase, defaultSchema: m.document.defaultSchema };
  const out: CheckOutcome[] = [];
  for (const check of m.document.checks ?? []) {
    try {
      out.push(judgeCheck(check, await driver.readCheck(check.sql, where)));
    } catch (e) {
      out.push({ name: check.name, passed: false, detail: `the query failed: ${(e instanceof Error ? e.message : String(e)).split("\n")[0] ?? ""}` });
    }
  }
  return out;
}

/** The checks that failed, one line each. */
export function failedChecks(m: Migration, outcomes: readonly CheckOutcome[]): string[] {
  return outcomes
    .filter((o) => !o.passed)
    .map((o) => {
      const check = m.document.checks?.find((c) => c.name === o.name);
      return `check ${o.name} failed: it must ${check ? describeExpect(check).replace(/^returns/, "return") : "pass"}, and returned ${o.detail}`;
    });
}

/** The refusal when a check of `m` failed, or `undefined`. */
export function checksRefusal(m: Migration, outcomes: readonly CheckOutcome[], when: string): YodelError | undefined {
  const failed = failedChecks(m, outcomes);
  if (failed.length === 0) return undefined;
  return new YodelError(
    `refused: a pre-migration check of ${m.id} failed ${when}. Nothing of ${m.id} was applied:\n${failed.map((f) => `  ${f}`).join("\n")}\n` +
      `Fix the data, then run yodel apply again; if the check is wrong, edit it in migration.json and run yodel lint --update-checksum ${m.id} (the plan digest moves, so the plan is approved again).`,
    EXIT_REFUSED,
  );
}
