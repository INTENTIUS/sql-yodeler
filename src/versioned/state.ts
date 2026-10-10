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
 *
 * ## Checkpoints (#63)
 *
 * A checkpoint creates its parent's recorded schema from nothing. An
 * environment whose history is empty starts at the newest checkpoint: the
 * migrations before it are skipped, never run there. An environment whose
 * history records a checkpoint started there, and skips the migrations
 * before it the same way. Any other checkpoint is skipped: the environment
 * ran (or started past) the migrations it stands for. A skipped migration
 * is neither applied nor pending, so it is never out of order either.
 */

import type { MigrationStep } from "@intentius/chant-lexicon-sql/migration-statements";
import { computeChecksum, isCheckpoint, type Migration } from "../migrations/index.js";
import { isApplied, isReverted, statementDone, type HistoryState, type MigrationRecord, type Repair } from "../history/index.js";
import { planStep, stepSha } from "../steps/index.js";

export interface AppliedMigration {
  id: string;
  checksum: string;
  appliedBy: string;
  /** When it was applied; a later repair does not change it. */
  recordedAt: string;
  planDigest: string;
  /** Its position in the chain; `undefined` when the directory no longer has it. */
  index: number | undefined;
  /** `yodel repair` records since it was applied, oldest first. */
  repairs?: Repair[] | undefined;
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
  /** It was applied, then `yodel revert` (#55) undid it: who reverted it and when. Applied again, every statement runs again. */
  reverted?: { by: string; at: string };
  /** Its Op steps `apply` runs: a ClickHouse rebuild, a backfill (#12). */
  opSteps: Array<{ index: number; step: Exclude<MigrationStep, { kind: "statement" }> }>;
  /** Its steps `apply` does not run (a manual step, an Op it does not run), each with why. Any of them refuses the run. */
  refusedSteps: Array<{ index: number; step: Exclude<MigrationStep, { kind: "statement" }>; reason: string }>;
  migration: Migration;
}

export type Mismatch =
  | { kind: "applied"; id: string; recorded: string; actual: string; message: string }
  | { kind: "part-way"; id: string; statement: number; message: string }
  | { kind: "missing"; id: string; recorded: string; message: string };

/** A migration this environment never runs, because of a checkpoint (#63). */
export interface SkippedMigration {
  id: string;
  /** `covered`: it comes before the checkpoint the environment starts from. `checkpoint`: a checkpoint the environment does not start from. */
  reason: "covered" | "checkpoint";
  /** `covered`: the checkpoint the environment starts from. */
  checkpoint?: string;
}

export interface VersionedStatus {
  /** In chain order; then any the directory no longer has, in the order they were applied. */
  applied: AppliedMigration[];
  /** In chain order. */
  pending: PendingMigration[];
  mismatches: Mismatch[];
  /** In chain order: the migrations a checkpoint leaves out here. Absent when there are none. */
  skipped?: SkippedMigration[];
}

export const outOfOrder = (s: VersionedStatus): PendingMigration[] => s.pending.filter((p) => p.outOfOrder);
export const partWay = (s: VersionedStatus): PendingMigration[] => s.pending.filter((p) => p.partWay !== undefined);

/** How to record an intended edit of migration `id`. */
const repair = (id: string) => `if the edit is intended, record it with yodel repair ${id} --reason ... <env>`;

function partWayOf(m: Migration, rec: MigrationRecord, actual: string): { partWay: PartWay; mismatch?: Mismatch } {
  const done: number[] = [];
  let resumeAt = m.document.steps.length;
  let mismatch: Mismatch | undefined;
  m.document.steps.forEach((step, i) => {
    if (statementDone(rec, i)) {
      done.push(i);
      const sha = stepSha(step, m.files);
      if (!mismatch && rec.statements.get(i)?.sha !== sha) {
        mismatch = {
          kind: "part-way",
          id: m.id,
          statement: i,
          message: `${m.id} ran part way, and statement ${String(i)}, which succeeded, has changed in its files since; ${repair(m.id)}`,
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

/** Why a step apply runs on one dialect is refused in a migration of the other, or `undefined`. */
function dialectRefusal(run: string, dialect: string): string | undefined {
  if (run === "rebuild" && dialect !== "clickhouse") return `a ClickHouseRebuildOp step in a ${dialect} migration`;
  if (run === "pgMigration" && dialect !== "postgres") return `a PostgresMigrationOp step in a ${dialect} migration`;
  return undefined;
}

/** A migration's Op steps, split into the ones apply runs and the ones it refuses. A backfill step whose module is not among the migration's files is refused. */
export function classifySteps(m: Migration): Pick<PendingMigration, "opSteps" | "refusedSteps"> {
  const opSteps: PendingMigration["opSteps"] = [];
  const refusedSteps: PendingMigration["refusedSteps"] = [];
  m.document.steps.forEach((step, index) => {
    if (step.kind === "statement") return;
    const plan = planStep(step);
    const wrongDialect = dialectRefusal(plan.run, m.document.dialect);
    if (plan.run === "refused") refusedSteps.push({ index, step, reason: plan.reason });
    else if (wrongDialect) refusedSteps.push({ index, step, reason: wrongDialect });
    else if (plan.run === "backfill" && m.files.extra?.[plan.file] === undefined) {
      refusedSteps.push({ index, step, reason: `a backfill step whose module ${plan.file} is not in ${m.id}'s directory` });
    } else opSteps.push({ index, step });
  });
  return { opSteps, refusedSteps };
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
    applied.push({ id: m.id, checksum: rec.checksum, appliedBy: rec.appliedBy, recordedAt: rec.recordedAt, planDigest: rec.planDigest, index: i, ...(rec.repairs.length > 0 ? { repairs: rec.repairs } : {}) });
    if (rec.checksum !== actual) {
      mismatches.push({
        kind: "applied",
        id: m.id,
        recorded: rec.checksum,
        actual,
        message: `${m.id} was applied with checksum ${rec.checksum}, but its files now hash to ${actual}; ${repair(m.id)}`,
      });
    }
  }
  const gone = state.migrations.filter((r) => isApplied(r) && !position.has(r.id)).sort((a, b) => (a.appliedSeq ?? 0) - (b.appliedSeq ?? 0));
  for (const r of gone) {
    applied.push({ id: r.id, checksum: r.checksum, appliedBy: r.appliedBy, recordedAt: r.recordedAt, planDigest: r.planDigest, index: undefined, ...(r.repairs.length > 0 ? { repairs: r.repairs } : {}) });
    mismatches.push({
      kind: "missing",
      id: r.id,
      recorded: r.checksum,
      message: `${r.id} is recorded applied, but the migrations directory no longer has it; restore it, or ${repair(r.id)}`,
    });
  }

  // The checkpoint this environment starts from: the newest one its history records, or, for an empty history, the newest one in the chain.
  let start = -1;
  for (const [i, m] of ordered.entries()) if (isCheckpoint(m) && state.byId.has(m.id)) start = i;
  if (start < 0 && state.migrations.length === 0) for (const [i, m] of ordered.entries()) if (isCheckpoint(m)) start = i;
  const startId = start < 0 ? undefined : ordered[start]?.id;
  const skipped: SkippedMigration[] = [];

  const pending: PendingMigration[] = [];
  for (const [i, m] of ordered.entries()) {
    const rec = state.byId.get(m.id);
    if (isApplied(rec)) continue;
    if (!rec && i < start) {
      skipped.push({ id: m.id, reason: "covered", ...(startId ? { checkpoint: startId } : {}) });
      continue;
    }
    if (!rec && i !== start && isCheckpoint(m)) {
      skipped.push({ id: m.id, reason: "checkpoint" });
      continue;
    }
    const actual = computeChecksum(m.files);
    let pw: PartWay | undefined;
    if (rec && isReverted(rec)) {
      pending.push({ id: m.id, index: i, checksum: actual, outOfOrder: i < lastApplied, partWay: undefined, reverted: { by: rec.appliedBy, at: rec.recordedAt }, ...classifySteps(m), migration: m });
      continue;
    }
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
      ...classifySteps(m),
      migration: m,
    });
  }
  return { applied, pending, mismatches, ...(skipped.length > 0 ? { skipped } : {}) };
}
