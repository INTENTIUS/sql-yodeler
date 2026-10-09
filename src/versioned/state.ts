/**
 * The migrations directory against the history: what is applied, pending,
 * out of order, part way, or changed since it ran. Pure.
 *
 * ## Order, and "out of order"
 *
 * The order is the chain `readMigrations` returns: parent links from the
 * first migration to the newest, never the ids' timestamps. A pending
 * migration is out of order when the chain puts it before a migration the
 * history records applied: it was merged (or rebased into place) after a
 * migration that follows it had already run here. It is reported, refused
 * unless the run passes `--allow-out-of-order`, and never skipped: with the
 * flag it runs, in chain order with the other pending ones.
 *
 * ## Checksums
 *
 * Every applied migration's checksum in the history is compared with its
 * files' checksum, recomputed, on every run; a mismatch refuses (`yodel
 * repair`, #15, records an intended edit). A migration the history records
 * applied that is gone from the directory refuses the same way. A
 * migration that failed part way may be edited before it resumes (to fix
 * the statement that failed), as long as every statement that already
 * succeeded is unchanged: those are compared statement by statement.
 */

import type { MigrationStep } from "@intentius/chant-lexicon-sql/migration-statements";
import { computeChecksum, type Migration } from "../migrations/index.js";
import { isApplied, statementDone, statementSha, type HistoryState, type MigrationRecord } from "../history/index.js";

export interface AppliedMigration {
  id: string;
  checksum: string;
  appliedBy: string;
  recordedAt: string;
  planDigest: string;
  /** Its position in the chain; `undefined` when the directory no longer has it. */
  index: number | undefined;
}

export interface PartWay {
  /** The latest migration row's status: `failed` (a statement failed) or `started` (the runner stopped). */
  status: "failed" | "started";
  /** The index (in `steps`) of the first statement that has not succeeded: where it resumes. */
  resumeAt: number;
  /** The statement that failed, when one did. */
  failedStatement: number | undefined;
  error: string;
  /** The indexes of the statements that succeeded and are never sent again. */
  done: number[];
  /** Its files changed since it ran part way (only statements not yet run). */
  edited: boolean;
}

export interface PendingMigration {
  id: string;
  /** Its position in the chain. */
  index: number;
  /** The checksum of its files, recomputed. */
  checksum: string;
  /** Before a migration the history records applied. */
  outOfOrder: boolean;
  partWay: PartWay | undefined;
  /** Its Op and manual steps, which `apply` does not run (#12). */
  refusedSteps: Array<{ index: number; step: Exclude<MigrationStep, { kind: "statement" }> }>;
  migration: Migration;
}

export type Mismatch =
  | { kind: "applied"; id: string; recorded: string; actual: string; message: string }
  | { kind: "part-way"; id: string; statement: number; message: string }
  | { kind: "missing"; id: string; recorded: string; message: string };

export interface VersionedStatus {
  /** In chain order; then any the directory no longer has, in the order they were applied. */
  applied: AppliedMigration[];
  /** In chain order. */
  pending: PendingMigration[];
  mismatches: Mismatch[];
}

export const outOfOrder = (s: VersionedStatus): PendingMigration[] => s.pending.filter((p) => p.outOfOrder);
export const partWay = (s: VersionedStatus): PendingMigration[] => s.pending.filter((p) => p.partWay !== undefined);

const REPAIR = "if the edit is intended, record it with yodel repair <id> --reason ... (#15)";

function partWayOf(m: Migration, rec: MigrationRecord, actual: string): { partWay: PartWay; mismatch?: Mismatch } {
  const done: number[] = [];
  let resumeAt = m.document.steps.length;
  let mismatch: Mismatch | undefined;
  m.document.steps.forEach((step, i) => {
    if (statementDone(rec, i)) {
      done.push(i);
      const sha = step.kind === "statement" ? statementSha(step.sql) : "";
      if (!mismatch && rec.statements.get(i)?.sha !== sha) {
        mismatch = {
          kind: "part-way",
          id: m.id,
          statement: i,
          message: `${m.id} ran part way, and statement ${String(i)}, which succeeded, has changed in its files since; ${REPAIR}`,
        };
      }
    } else if (resumeAt === m.document.steps.length) {
      resumeAt = i;
    }
  });
  const failed = [...rec.statements.values()].filter((s) => s.status === "failed").sort((a, b) => b.seq - a.seq)[0];
  return {
    partWay: {
      status: rec.status === "failed" ? "failed" : "started",
      resumeAt,
      failedStatement: failed && !statementDone(rec, failed.index) ? failed.index : undefined,
      error: rec.error || failed?.error || "",
      done,
      edited: rec.checksum !== actual,
    },
    ...(mismatch ? { mismatch } : {}),
  };
}

/** Compares the chain with the history. */
export function compareHistory(ordered: readonly Migration[], state: HistoryState): VersionedStatus {
  const position = new Map(ordered.map((m, i) => [m.id, i]));
  const mismatches: Mismatch[] = [];
  const applied: AppliedMigration[] = [];
  let lastApplied = -1;

  for (const [i, m] of ordered.entries()) {
    const rec = state.byId.get(m.id);
    if (!rec || !isApplied(rec)) continue;
    lastApplied = i;
    const actual = computeChecksum(m.files);
    applied.push({ id: m.id, checksum: rec.checksum, appliedBy: rec.appliedBy, recordedAt: rec.recordedAt, planDigest: rec.planDigest, index: i });
    if (rec.checksum !== actual) {
      mismatches.push({
        kind: "applied",
        id: m.id,
        recorded: rec.checksum,
        actual,
        message: `${m.id} was applied with checksum ${rec.checksum}, but its files now hash to ${actual}; ${REPAIR}`,
      });
    }
  }
  const gone = state.migrations.filter((r) => isApplied(r) && !position.has(r.id)).sort((a, b) => (a.appliedSeq ?? 0) - (b.appliedSeq ?? 0));
  for (const r of gone) {
    applied.push({ id: r.id, checksum: r.checksum, appliedBy: r.appliedBy, recordedAt: r.recordedAt, planDigest: r.planDigest, index: undefined });
    mismatches.push({
      kind: "missing",
      id: r.id,
      recorded: r.checksum,
      message: `${r.id} is recorded applied, but the migrations directory no longer has it; restore it, or ${REPAIR}`,
    });
  }

  const pending: PendingMigration[] = [];
  for (const [i, m] of ordered.entries()) {
    const rec = state.byId.get(m.id);
    if (isApplied(rec)) continue;
    const actual = computeChecksum(m.files);
    let pw: PartWay | undefined;
    if (rec) {
      const r = partWayOf(m, rec, actual);
      pw = r.partWay;
      if (r.mismatch) mismatches.push(r.mismatch);
    }
    pending.push({
      id: m.id,
      index: i,
      checksum: actual,
      outOfOrder: i < lastApplied,
      partWay: pw,
      refusedSteps: m.document.steps.flatMap((step, index) => (step.kind === "statement" ? [] : [{ index, step }])),
      migration: m,
    });
  }
  return { applied, pending, mismatches };
}
