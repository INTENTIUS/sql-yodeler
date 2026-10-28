/**
 * The baseline: the first migration of an adopted database, holding the
 * schema the database already had, recorded applied without running it.
 *
 * ## How the history records it
 *
 * One migration row, `status = 'succeeded'`, `note` starting `baseline`
 * ({@link BASELINE_NOTE}), the migration's checksum, `parent = ''`, and no
 * statement rows: none of its statements was sent, since the objects they
 * create are the ones it was read from. `plan_digest` is empty, as nothing
 * was approved.
 *
 * The rest of yodel needs nothing new to read it. `deriveState` makes the
 * migration's state its latest migration row, `succeeded`, so `isApplied`
 * holds; `compareHistory` lists it applied, checks its checksum like any
 * other's, and never puts it among the pending, so `yodel apply` never sends
 * its statements; and statement rows are only read for a migration that is
 * part way. A status other than `succeeded` (say `adopted`) would read as
 * part way, and apply would run it, so the status stays `succeeded` and the
 * note is what says it was adopted.
 */

import { randomUUID } from "node:crypto";
import { YodelError, yodelRefusal } from "../project.js";
import type { Migration } from "../migrations/index.js";
import { appliedBy, MIGRATION_ROW, withLock, type HistoryRow } from "../history/index.js";
import { type VersionedEnv } from "../versioned/index.js";

/** The baseline migration's name: its id is `<YYYYMMDDTHHMM>-baseline`. */
export const BASELINE_NAME = "baseline";

/** The start of a baseline row's `note`. */
export const BASELINE_NOTE = "baseline";

/** The note a baseline row carries. */
export const baselineNote = (environment: string): string =>
  `${BASELINE_NOTE}: adopted from the live database by yodel init --from ${environment}; its statements were not run`;

/** Whether a history row records a baseline. */
export const isBaselineRow = (row: Pick<HistoryRow, "kind" | "note">): boolean =>
  row.kind === "migration" && (row.note === BASELINE_NOTE || row.note.startsWith(`${BASELINE_NOTE}:`));

/** The one row that records `m` applied as a baseline. */
export function baselineRow(m: Pick<Migration, "id" | "parent" | "checksum">, input: { seq: number; runId: string; appliedBy: string; environment: string; skipped?: readonly string[] }): HistoryRow {
  if (m.parent !== null) throw new YodelError(`${m.id} follows ${m.parent}; only a first migration can be a baseline`);
  return {
    seq: input.seq,
    run_id: input.runId,
    kind: "migration",
    migration_id: m.id,
    parent: "",
    checksum: m.checksum,
    statement_index: MIGRATION_ROW,
    statement_sha: "",
    status: "succeeded",
    error: "",
    applied_by: input.appliedBy,
    plan_digest: "",
    silences: "[]",
    note: input.skipped?.length ? `${baselineNote(input.environment)}; not adopted, of kinds yodel cannot declare: ${input.skipped.join(", ")}` : baselineNote(input.environment),
  };
}

/** Why the history cannot take a baseline, or `undefined`: a baseline is the first thing a history records. */
export function historyRefusal(state: { migrations: readonly { id: string }[] }, location: string): YodelError | undefined {
  if (state.migrations.length === 0) return undefined;
  const ids = state.migrations.map((m) => m.id);
  return yodelRefusal(
    `refused: the history (${location}) already records ${ids.length === 1 ? "a migration" : `${String(ids.length)} migrations`} (${ids.slice(0, 3).join(", ")}${ids.length > 3 ? ", ..." : ""}); ` +
      `this environment is already under versioned migrations, so there is nothing to adopt. Nothing was written.`,
  );
}

/** Reads the history without the lock, for a refusal before anything is written. */
export async function checkHistoryEmpty(venv: VersionedEnv): Promise<void> {
  const refusal = historyRefusal(await venv.store.state(), `${venv.location.database}.history`);
  if (refusal) throw refusal;
}

/**
 * Records `m` applied as the baseline, under the apply lock: makes the
 * history when it is not there, checks again that it records nothing, and
 * appends the one row.
 */
export async function recordBaseline(venv: VersionedEnv, m: Migration, processEnv: NodeJS.ProcessEnv = process.env, skipped: readonly string[] = []): Promise<{ row: HistoryRow; lock: { kind: string; where: string; notice?: string } }> {
  const by = appliedBy(processEnv);
  const lock = await venv.driver.acquireLock(by);
  return withLock(lock, venv.lockTtlMs, async () => {
    await venv.store.ensure();
    const state = await venv.store.state();
    const refusal = historyRefusal(state, `${venv.location.database}.history`);
    if (refusal) throw refusal;
    const row = baselineRow(m, { seq: state.maxSeq + 1, runId: randomUUID(), appliedBy: by, environment: venv.environment, skipped });
    await venv.store.append([row]);
    return { row, lock: { kind: lock.kind, where: lock.where, ...(lock.notice ? { notice: lock.notice } : {}) } };
  });
}
