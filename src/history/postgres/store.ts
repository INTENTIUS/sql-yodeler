/**
 * Reading and appending the Postgres history table. Nothing here updates or
 * deletes a row.
 *
 * The store works on one connection, the apply's work connection, so a row
 * appended while that connection has a transaction open commits or rolls
 * back with it: that is how a statement and its `succeeded` row commit
 * together (`../../versioned/postgres/executor.ts`).
 */

import { deriveState, type HistoryRow, type HistoryState } from "../rows.js";
import { fromRaw, type HistoryStoreLike } from "../store.js";
import { HISTORY_TABLE } from "../ddl.js";
import { pgHistoryDdl, pgHistoryTable, pgWidenChecks, PG_HISTORY_COLUMNS, PG_WRITTEN_COLUMNS } from "./ddl.js";

/** What the history needs from a Postgres connection: chant's `PostgresClient`. */
export interface PgClient {
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
}

export interface PgHistoryLocation {
  /** The schema the history table lives in. */
  schema: string;
}

/** The history's rows read back, `recorded_at` in the ClickHouse table's form (`YYYY-MM-DD hh:mm:ss.ffffff`, UTC). */
const SELECT = PG_HISTORY_COLUMNS.map(([name]) =>
  name === "recorded_at" ? `pg_catalog.to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS recorded_at` : name === "seq" ? "seq::text AS seq" : name,
).join(", ");

export class PostgresHistoryStore implements HistoryStoreLike {
  constructor(
    readonly client: PgClient,
    readonly location: PgHistoryLocation,
  ) {}

  get table(): string {
    return pgHistoryTable(this.location.schema);
  }

  /** Whether the history table is there. A history that was never made has no rows. */
  async exists(): Promise<boolean> {
    const [row] = await this.client.query<{ present: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'r') AS present",
      [this.location.schema, HISTORY_TABLE],
    );
    return row?.present === true;
  }

  /** Creates the schema and table when they are not there. */
  async ensure(): Promise<void> {
    if (await this.exists()) return;
    for (const sql of pgHistoryDdl(this.location.schema)) await this.client.query(sql);
  }

  /** A table made before `yodel revert` (#55) takes its rows only once its CHECK constraints are widened; this widens them, once. */
  async allowRevert(): Promise<void> {
    const constraints = await this.client.query<{ name: string; def: string }>(
      "SELECT c.conname AS name, pg_catalog.pg_get_constraintdef(c.oid) AS def FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class t ON t.oid = c.conrelid JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = $1 AND t.relname = $2 AND c.contype = 'c'",
      [this.location.schema, HISTORY_TABLE],
    );
    for (const sql of pgWidenChecks(this.location.schema, constraints)) await this.client.query(sql);
  }

  /** Every row, in seq order. Postgres reads are consistent, so the `sync` option the ClickHouse store takes changes nothing here. */
  async rows(): Promise<HistoryRow[]> {
    if (!(await this.exists())) return [];
    const raw = await this.client.query(`SELECT ${SELECT} FROM ${this.table} ORDER BY seq`);
    return raw.map(fromRaw);
  }

  async state(): Promise<HistoryState> {
    return deriveState(await this.rows());
  }

  /** Appends rows, as written; `recorded_at` is the server's. On the store's connection, so inside its open transaction, if any. */
  async append(rows: readonly HistoryRow[]): Promise<void> {
    if (rows.length === 0) return;
    const { sql, params } = insertRows(this.location.schema, rows);
    await this.client.query(sql, params);
  }
}

/** The parameterized `INSERT` of `rows`. */
export function insertRows(schema: string, rows: readonly HistoryRow[]): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const tuples = rows.map((r) => {
    const values = PG_WRITTEN_COLUMNS.map((c) => {
      params.push(c === "seq" ? String(r.seq) : (r as unknown as Record<string, unknown>)[c]);
      return `$${String(params.length)}`;
    });
    return `(${values.join(", ")})`;
  });
  return { sql: `INSERT INTO ${pgHistoryTable(schema)} (${PG_WRITTEN_COLUMNS.join(", ")}) VALUES ${tuples.join(", ")}`, params };
}
