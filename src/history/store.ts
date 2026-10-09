/**
 * Reading and appending the history table. Nothing here updates or deletes
 * a row.
 */

import { hostname, userInfo } from "node:os";
import { randomUUID } from "node:crypto";
import type { ClickHousePort } from "./client.js";
import { HISTORY_COLUMNS, HISTORY_TABLE, historyDdl, ident, literal } from "./ddl.js";
import { replicates, type HistoryTopology } from "./topology.js";
import { deriveState, type HistoryRow, type HistoryState } from "./rows.js";

export interface HistoryLocation {
  database: string;
  topology: HistoryTopology;
}

/** Settings every history write carries: synchronous, and never deduplicated away on a Replicated engine. */
const WRITE_SETTINGS = { async_insert: "0", insert_deduplicate: "0" };

/** Who is applying: the CI actor or the user, at this host. */
export function appliedBy(env: NodeJS.ProcessEnv = process.env): string {
  let user = env.GITHUB_ACTOR ?? env.GITLAB_USER_LOGIN ?? env.USER;
  if (!user) {
    try {
      user = userInfo().username;
    } catch {
      user = "unknown";
    }
  }
  return `${user}@${hostname()}`;
}

const columnNames = HISTORY_COLUMNS.map(([name]) => name);

type RawRow = Record<string, unknown>;

function fromRaw(r: RawRow): HistoryRow {
  const s = (k: string): string => {
    const v = r[k];
    return typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "";
  };
  return {
    seq: Number(r.seq),
    run_id: s("run_id"),
    kind: s("kind") === "statement" || s("kind") === "step" ? (s("kind") as "statement" | "step") : "migration",
    migration_id: s("migration_id"),
    parent: s("parent"),
    checksum: s("checksum"),
    statement_index: Number(r.statement_index),
    statement_sha: s("statement_sha"),
    status: (["started", "succeeded", "failed"].includes(s("status")) ? s("status") : "started") as HistoryRow["status"],
    error: s("error"),
    applied_by: s("applied_by"),
    plan_digest: s("plan_digest"),
    silences: s("silences") || "[]",
    note: s("note"),
    recorded_at: s("recorded_at"),
  };
}

export class HistoryStore {
  constructor(
    readonly port: ClickHousePort,
    readonly location: HistoryLocation,
  ) {}

  get table(): string {
    return `${ident(this.location.database)}.${HISTORY_TABLE}`;
  }

  /** Whether the history table is there. A history that was never made has no rows. */
  async exists(): Promise<boolean> {
    const rows = await this.port.query<{ n: string | number }>(
      `SELECT count() AS n FROM system.tables WHERE database = ${literal(this.location.database)} AND name = ${literal(HISTORY_TABLE)}`,
    );
    return Number(rows[0]?.n ?? 0) > 0;
  }

  /** Creates the database and table when they are not there. */
  async ensure(): Promise<void> {
    for (const sql of historyDdl(this.location)) await this.port.query(sql);
  }

  /**
   * Every row. On a cluster or a Replicated database the replica first
   * catches up with the others (`SYSTEM SYNC REPLICA`), so a run reads what
   * a run on another host wrote; on Cloud the read is sequentially
   * consistent. `sync: false` skips that, for a status read that need not
   * wait.
   */
  async rows(options: { sync?: boolean } = {}): Promise<HistoryRow[]> {
    if (!(await this.exists())) return [];
    const { topology } = this.location;
    if (options.sync !== false && replicates(topology)) await this.port.query(`SYSTEM SYNC REPLICA ${this.table}`);
    const settings = topology.kind === "cloud" && options.sync !== false ? { settings: { select_sequential_consistency: "1" } } : {};
    const select = columnNames.map((c) => (c === "recorded_at" ? "toString(recorded_at) AS recorded_at" : c)).join(", ");
    const raw = await this.port.query<RawRow>(`SELECT ${select} FROM ${this.table} ORDER BY seq`, settings);
    return raw.map(fromRaw);
  }

  async state(options: { sync?: boolean } = {}): Promise<HistoryState> {
    return deriveState(await this.rows(options));
  }

  /** Appends rows, as written; `recorded_at` is the server's. */
  async append(rows: readonly HistoryRow[]): Promise<void> {
    if (rows.length === 0) return;
    const body = rows
      .map((r) => JSON.stringify({ ...r, recorded_at: undefined }))
      .join("\n");
    await this.port.query(`INSERT INTO ${this.table} FORMAT JSONEachRow\n${body}`, { settings: WRITE_SETTINGS });
  }
}

/** The fields a run sets on every row it writes. */
export interface RunContext {
  runId: string;
  appliedBy: string;
  planDigest: string;
}

export const newRunContext = (planDigest: string, env: NodeJS.ProcessEnv = process.env): RunContext => ({
  runId: randomUUID(),
  appliedBy: appliedBy(env),
  planDigest,
});

/**
 * Writes one run's rows, each with the next `seq`. Made under the lock from
 * the history's highest seq, so seqs never collide across runs.
 */
export class HistoryRecorder {
  private next: number;

  constructor(
    readonly store: HistoryStore,
    readonly run: RunContext,
    maxSeq: number,
  ) {
    this.next = maxSeq + 1;
  }

  async record(row: Omit<HistoryRow, "seq" | "run_id" | "applied_by" | "plan_digest" | "recorded_at" | "error" | "note" | "silences"> & Partial<Pick<HistoryRow, "error" | "note" | "silences">>): Promise<HistoryRow> {
    const full: HistoryRow = {
      error: "",
      note: "",
      silences: "[]",
      ...row,
      seq: this.next++,
      run_id: this.run.runId,
      applied_by: this.run.appliedBy,
      plan_digest: this.run.planDigest,
    };
    await this.store.append([full]);
    return full;
  }
}
