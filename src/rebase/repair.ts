/**
 * `yodel repair` (#15): record an intended edit to an applied migration.
 *
 * Apply and status compare every applied migration's checksum in the
 * history with its files' checksum, recomputed, and refuse on a mismatch
 * (`../versioned/state.ts`). The history's state of a migration is its
 * migration row with the highest `seq` (`../history/rows.ts`), so a repair
 * is one more migration row, appended under the apply lock:
 *
 *   kind = 'migration', statement_index = -1, statement_sha = ''
 *   status = 'succeeded'           it stays applied
 *   checksum = the files' checksum now
 *   parent = the parent its migration.json names now
 *   plan_digest = the digest it was applied under, carried over
 *   note = the reason, as given
 *
 * Nothing is sent to the server but that row; the edit is not run. The
 * first `succeeded` row still says when the migration was applied, so the
 * order of applied migrations is unchanged.
 */

import { YodelError } from "../project.js";
import { isApplied, MIGRATION_ROW, type HistoryRow, type HistoryState, type MigrationRecord, type RunContext } from "../history/index.js";
import { computeChecksum, type Migration } from "../migrations/index.js";

/** Exit code: refused, nothing written (not applied, already matching, or gone from the directory). */
export const REPAIR_REFUSED = 4;

export interface RepairCheck {
  record: MigrationRecord;
  /** The checksum the history records now. */
  oldChecksum: string;
  /** The checksum of the files now, which the repair records. */
  newChecksum: string;
}

/** Whether `m` can be repaired against `state`: applied, and its files hash to something else than the history records. Throws a YodelError naming why not. */
export function checkRepair(m: Migration | undefined, id: string, state: HistoryState, environment: string): RepairCheck {
  const record = state.byId.get(id);
  if (!m) {
    throw new YodelError(
      record
        ? `refused: ${id} is in ${environment}'s history, but the migrations directory no longer has it; restore its directory (repair records an edit to a migration's files, not its removal)`
        : `refused: ${id} is not in the migrations directory`,
      REPAIR_REFUSED,
    );
  }
  if (!record) throw new YodelError(`refused: ${id} has not run in ${environment}: its history has no row for it. Nothing to repair; an edit to a pending migration needs none.`, REPAIR_REFUSED);
  if (!isApplied(record)) {
    throw new YodelError(
      `refused: ${id} is not applied in ${environment}: it ran part way (its latest row is ${record.status}). ` +
        `A migration that failed part way may be edited before it resumes, as long as the statements that succeeded are unchanged; yodel apply resumes it. Repair is for an applied migration.`,
      REPAIR_REFUSED,
    );
  }
  const newChecksum = computeChecksum(m.files);
  if (record.checksum === newChecksum) {
    throw new YodelError(`refused: ${id}'s files already hash to the checksum ${environment}'s history records (${newChecksum}); nothing to repair`, REPAIR_REFUSED);
  }
  return { record, oldChecksum: record.checksum, newChecksum };
}

/** The history row a repair appends. `seq` is one more than the history's highest, taken under the lock. */
export function repairRow(input: { migration: Migration; check: RepairCheck; reason: string; run: RunContext; seq: number }): HistoryRow {
  const reason = input.reason.trim();
  if (reason === "") throw new YodelError("a repair needs a reason: --reason \"<why the files changed>\"");
  return {
    seq: input.seq,
    run_id: input.run.runId,
    kind: "migration",
    migration_id: input.migration.id,
    parent: input.migration.parent ?? "",
    checksum: input.check.newChecksum,
    statement_index: MIGRATION_ROW,
    statement_sha: "",
    status: "succeeded",
    error: "",
    applied_by: input.run.appliedBy,
    plan_digest: input.run.planDigest,
    silences: "[]",
    note: reason,
  };
}
