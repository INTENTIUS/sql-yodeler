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
 *
 * Each statement's pre-check (#51, `migrationChecks`) runs with them, the
 * same way: a count of the rows the statement would fail on, which must be
 * 0. A refusal names the statement and the count. A pre-check whose table
 * or column an earlier statement of the same migration makes cannot run
 * before the first statement; it is passed, since no row of it exists yet.
 */

import { YodelError } from "../project.js";
import { EXIT_REFUSED } from "../exit.js";
import { describeExpect, judgeCheck, migrationChecks, type CheckOutcome, type Migration, type RunnableCheck } from "../migrations/index.js";
import type { VersionedDriver } from "./driver.js";
import type { PendingMigration } from "./state.js";

/** Whether `p`'s checks run before it: it has some, and no statement of it has succeeded yet. */
export const checksDue = (p: PendingMigration): boolean => migrationChecks(p.migration.document).length > 0 && (p.partWay?.done.length ?? 0) === 0;

/** The server's refusal of a query over a table or column that does not exist yet. */
const NOT_THERE = /\b(relation|column) "[^"]+"( of relation "[^"]+")? does not exist\b/;

/** Runs each of `m`'s checks and pre-checks; a query the server refuses is a failed check. */
export async function runChecks(driver: VersionedDriver, m: Migration): Promise<CheckOutcome[]> {
  const where = { defaultDatabase: m.document.defaultDatabase, defaultSchema: m.document.defaultSchema };
  const out: CheckOutcome[] = [];
  for (const check of migrationChecks(m.document)) {
    try {
      out.push(judgeCheck(check, await driver.readCheck(check.sql, where)));
    } catch (e) {
      const message = (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "";
      if (check.step && check.step.index > 0 && NOT_THERE.test(message)) {
        out.push({ name: check.name, passed: true, detail: `not run: ${message}, which an earlier statement of ${m.id} makes` });
        continue;
      }
      out.push({ name: check.name, passed: false, detail: `the query failed: ${message}` });
    }
  }
  return out;
}

const firstLine = (sql: string): string => {
  const line = sql.trim().split("\n")[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
};

function failedLine(check: RunnableCheck | undefined, o: CheckOutcome): string {
  if (check?.step) {
    const count = /^\d+$/.test(o.detail) ? `${o.detail} ${check.step.detail}` : `its pre-check ${o.detail}`;
    return `step ${String(check.step.index)}, ${firstLine(check.step.sql)}, would fail: ${count} (pre-check ${o.name}: ${check.sql})`;
  }
  return `check ${o.name} failed: it must ${check ? describeExpect(check).replace(/^returns/, "return") : "pass"}, and returned ${o.detail}`;
}

/** The checks that failed, one line each; a pre-check's names its statement and the count. */
export function failedChecks(m: Migration, outcomes: readonly CheckOutcome[]): string[] {
  const checks = migrationChecks(m.document);
  return outcomes.filter((o) => !o.passed).map((o) => failedLine(checks.find((c) => c.name === o.name), o));
}

/** The refusal when a check of `m` failed, or `undefined`. */
export function checksRefusal(m: Migration, outcomes: readonly CheckOutcome[], when: string): YodelError | undefined {
  const failed = failedChecks(m, outcomes);
  if (failed.length === 0) return undefined;
  return new YodelError(
    `refused: a pre-migration check of ${m.id} failed ${when}. Nothing of ${m.id} was applied:\n${failed.map((f) => `  ${f}`).join("\n")}\n` +
      `Fix the data, then run yodel apply again; if the check is wrong, edit it in migration.json and run yodel lint --update-checksum ${m.id} (the plan digest moves, so the plan is approved again).` +
      (failed.some((f) => f.startsWith("step ")) ? ` A statement's pre-check is chant's count of the rows the statement fails on: fix those rows, or change the declaration.` : ""),
    EXIT_REFUSED,
  );
}
