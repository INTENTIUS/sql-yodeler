/**
 * An in-memory Postgres for the Postgres history's unit tests: it answers
 * what the history store, the advisory lock and the executor send, keeps a
 * transaction's history rows until COMMIT (and drops them on ROLLBACK), and
 * records every other statement as "sent", failing the ones a test asks it
 * to. The catalog reader's queries get no rows. One {@link FakePgServer} is
 * shared by every connection to it, so two connections can contend for the
 * advisory lock.
 */

import type { PgLockConnection } from "../../src/history/postgres/index.js";

export class FakePgError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export interface Failure {
  message: string;
  code?: string;
}

export class FakePgServer {
  /** The history table's rows, committed. */
  rows: Record<string, unknown>[] = [];
  historyExists = false;
  /** Statements sent on any connection that are not the history's, the lock's or session settings. */
  sent: string[] = [];
  /** Every query, on every connection, in order. */
  log: string[] = [];
  /** Advisory locks held, by key, with the holding connection's pid. */
  locks = new Map<string, number>();
  /** Indexes in the catalog that are INVALID. */
  invalidIndexes = new Set<string>();
  /** A statement that fails while this returns a failure. */
  failWith: (sql: string) => Failure | undefined = () => undefined;
  private pids = 100;
  private clock = 0;
  connections: FakePgConnection[] = [];

  connect = (): Promise<FakePgConnection> => {
    const c = new FakePgConnection(this, this.pids++);
    this.connections.push(c);
    return Promise.resolve(c);
  };

  stamp(): string {
    this.clock++;
    return `2026-10-09 12:00:00.${String(this.clock).padStart(6, "0")}`;
  }
}

const HISTORY_COLUMNS = ["seq", "run_id", "kind", "migration_id", "parent", "checksum", "statement_index", "statement_sha", "status", "error", "applied_by", "plan_digest", "silences", "note"];

export class FakePgConnection implements PgLockConnection {
  ended = false;
  private tx: Record<string, unknown>[] | undefined;
  private app = "";

  constructor(
    readonly server: FakePgServer,
    readonly pid: number,
  ) {}

  query<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    try {
      return Promise.resolve(this.answer(sql, params) as T[]);
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }

  end(): Promise<void> {
    this.ended = true;
    for (const [k, pid] of this.server.locks) if (pid === this.pid) this.server.locks.delete(k);
    return Promise.resolve();
  }

  private answer(sql: string, params: readonly unknown[]): unknown[] {
    if (this.ended) throw new FakePgError("Connection terminated");
    const s = this.server;
    s.log.push(sql);
    if (sql === "BEGIN") {
      this.tx = [];
      return [];
    }
    if (sql === "COMMIT") {
      for (const r of this.tx ?? []) s.rows.push({ ...r, recorded_at: s.stamp() });
      this.tx = undefined;
      return [];
    }
    if (sql === "ROLLBACK") {
      this.tx = undefined;
      return [];
    }
    if (/^SET (LOCAL )?(lock_timeout|statement_timeout)\b/.test(sql)) return [];
    if (sql.includes("set_config('application_name'")) {
      this.app = String(params[0]);
      return [];
    }
    if (sql.includes("pg_try_advisory_lock")) {
      const key = `${String(params[0])}/${String(params[1])}`;
      const held = s.locks.get(key);
      if (held !== undefined && held !== this.pid) return [{ ok: false }];
      s.locks.set(key, this.pid);
      return [{ ok: true }];
    }
    if (sql.includes("pg_advisory_unlock")) {
      const key = `${String(params[0])}/${String(params[1])}`;
      if (s.locks.get(key) === this.pid) s.locks.delete(key);
      return [{ pg_advisory_unlock: true }];
    }
    if (sql.includes("FROM pg_catalog.pg_locks l LEFT JOIN pg_catalog.pg_stat_activity")) {
      const key = `${String(params[0])}/${String(params[1])}`;
      const pid = s.locks.get(key);
      const holder = s.connections.find((c) => c.pid === pid);
      return pid === undefined ? [] : [{ pid, app: holder?.app ?? "", since: "2026-10-09 11:59:00" }];
    }
    if (sql.includes("FROM pg_catalog.pg_locks WHERE locktype = 'advisory'")) {
      const key = `${String(params[0])}/${String(params[1])}`;
      return [{ n: s.locks.get(key) === this.pid ? 1 : 0 }];
    }
    if (sql.includes("FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n")) return [{ present: s.historyExists }];
    if (sql === "SHOW server_version") return [{ server_version: "18.6 (Fake)" }];
    if (sql.startsWith("CREATE SCHEMA IF NOT EXISTS") || sql.startsWith("COMMENT ON TABLE")) return [];
    if (/^CREATE TABLE IF NOT EXISTS \S+\."history"/.test(sql)) {
      s.historyExists = true;
      return [];
    }
    if (/^INSERT INTO \S+\."history"/.test(sql)) {
      const n = HISTORY_COLUMNS.length;
      const rows: Record<string, unknown>[] = [];
      for (let i = 0; i < params.length; i += n) rows.push(Object.fromEntries(HISTORY_COLUMNS.map((c, j) => [c, params[i + j]])));
      if (this.tx) this.tx.push(...rows);
      else for (const r of rows) s.rows.push({ ...r, recorded_at: s.stamp() });
      return [];
    }
    if (/^SELECT .* FROM \S+\."history" ORDER BY seq$/.test(sql)) return [...s.rows].sort((a, b) => Number(a.seq) - Number(b.seq));
    if (sql.includes("FROM pg_catalog.pg_index i WHERE i.indexrelid")) return s.invalidIndexes.has(String(params[0])) ? [{ invalid: true }] : [];
    if (sql.startsWith("DROP INDEX CONCURRENTLY IF EXISTS")) {
      s.invalidIndexes.delete(sql.slice("DROP INDEX CONCURRENTLY IF EXISTS ".length));
      s.sent.push(sql);
      return [];
    }
    if (/^\s*(SELECT|WITH)\b/i.test(sql)) return []; // the catalog reader's queries
    const failure = s.failWith(sql);
    if (failure) throw new FakePgError(failure.message, failure.code);
    s.sent.push(sql);
    return [];
  }
}
