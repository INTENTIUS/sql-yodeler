/**
 * History rows and the state they add up to. Pure: rows in, state out.
 *
 * Rows are only ever appended. The state of a migration is its migration
 * row with the highest `seq`; the state of one of its statements is that
 * statement's row with the highest `seq`. A migration whose latest row is
 * `succeeded` is applied. One whose latest row is `failed` (a statement
 * failed) or `started` (the runner died) is part way: it resumes at the
 * first statement whose latest row is not `succeeded`.
 */

import { createHash } from "node:crypto";

export type HistoryStatus = "started" | "succeeded" | "failed";
export type HistoryKind = "migration" | "statement";

/** The statement index of a migration's own rows. */
export const MIGRATION_ROW = -1;

/** One row of the history table, as written and as read back. */
export interface HistoryRow {
  seq: number;
  /** The apply run that wrote it. */
  run_id: string;
  kind: HistoryKind;
  migration_id: string;
  /** The migration's parent id, `""` for the first. */
  parent: string;
  /** The migration's checksum when the row was written. */
  checksum: string;
  /** {@link MIGRATION_ROW} on a migration row; else the statement's index in the migration's `steps`. */
  statement_index: number;
  /** `sha256:<hex>` of the statement's SQL; `""` on a migration row. */
  statement_sha: string;
  status: HistoryStatus;
  /** The server's message, on a `failed` row. */
  error: string;
  /** Who ran it: the CI actor or the user, and the host. */
  applied_by: string;
  /** The plan digest the run was approved under. */
  plan_digest: string;
  /** The silences (`-- yodel:allow <RULE> <reason>`) in force, as JSON text; `"[]"` when none. */
  silences: string;
  /** Free text, e.g. a repair's reason (#15). */
  note: string;
  /** The server's time, `YYYY-MM-DD hh:mm:ss.ffffff` UTC; absent on a row not yet written. */
  recorded_at?: string;
}

/** The hash a statement row records of the SQL it sent. */
export const statementSha = (sql: string): string => `sha256:${createHash("sha256").update(sql, "utf8").digest("hex")}`;

export interface StatementRecord {
  index: number;
  status: HistoryStatus;
  sha: string;
  error: string;
  seq: number;
}

/** What the history says about one migration. */
export interface MigrationRecord {
  id: string;
  parent: string | null;
  /** The checksum on its latest migration row. */
  checksum: string;
  status: HistoryStatus;
  error: string;
  appliedBy: string;
  planDigest: string;
  recordedAt: string;
  /** The seq of its latest migration row. */
  seq: number;
  /** The seq of the first row that recorded it `succeeded`; orders applied migrations by when they were applied. */
  appliedSeq: number | undefined;
  /** Each statement's latest row, by index. */
  statements: Map<number, StatementRecord>;
}

export interface HistoryState {
  /** Every migration the history names, in the order each was first recorded. */
  migrations: MigrationRecord[];
  byId: Map<string, MigrationRecord>;
  /** The highest seq in the history, 0 when it is empty. */
  maxSeq: number;
}

/** The state the rows add up to. Rows may come in any order. */
export function deriveState(rows: readonly HistoryRow[]): HistoryState {
  const sorted = [...rows].sort((a, b) => a.seq - b.seq);
  const byId = new Map<string, MigrationRecord>();
  const order: MigrationRecord[] = [];
  let maxSeq = 0;
  for (const r of sorted) {
    maxSeq = Math.max(maxSeq, r.seq);
    let m = byId.get(r.migration_id);
    if (!m) {
      m = {
        id: r.migration_id,
        parent: r.parent === "" ? null : r.parent,
        checksum: r.checksum,
        status: "started",
        error: "",
        appliedBy: r.applied_by,
        planDigest: r.plan_digest,
        recordedAt: r.recorded_at ?? "",
        seq: r.seq,
        appliedSeq: undefined,
        statements: new Map(),
      };
      byId.set(r.migration_id, m);
      order.push(m);
    }
    if (r.kind === "migration") {
      m.parent = r.parent === "" ? null : r.parent;
      m.checksum = r.checksum;
      m.status = r.status;
      m.error = r.error;
      m.appliedBy = r.applied_by;
      m.planDigest = r.plan_digest;
      m.recordedAt = r.recorded_at ?? "";
      m.seq = r.seq;
      if (r.status === "succeeded" && m.appliedSeq === undefined) m.appliedSeq = r.seq;
    } else {
      m.statements.set(r.statement_index, { index: r.statement_index, status: r.status, sha: r.statement_sha, error: r.error, seq: r.seq });
    }
  }
  return { migrations: order, byId, maxSeq };
}

/** Whether the history records the migration applied. */
export const isApplied = (m: MigrationRecord | undefined): boolean => m?.status === "succeeded";

/** Whether the statement at `index` has already run: its latest row is `succeeded`. Such a statement is never sent again. */
export const statementDone = (m: MigrationRecord | undefined, index: number): boolean => m?.statements.get(index)?.status === "succeeded";
