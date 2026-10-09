/**
 * The Postgres history's DDL: `<schema>.history` in a schema of its own
 * (default `yodeler`, the environment's history database setting), the same
 * columns as the ClickHouse table (`../ddl.ts`), so a row reads the same in
 * both and `deriveState` adds them up the same way.
 *
 * `seq` is the primary key: two runs can never write the same one (a run
 * takes it under the advisory lock, one more than the highest), and the key
 * says so if one ever tried. Rows are only ever inserted.
 */

import { HISTORY_TABLE } from "../ddl.js";

/** A Postgres identifier, double-quoted. */
export const pgIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** A Postgres string literal (standard_conforming_strings, the default since 9.1). */
export const pgLiteral = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/** The history table's columns, in the order {@link HISTORY_COLUMNS} (ClickHouse) has them. */
export const PG_HISTORY_COLUMNS: readonly (readonly [name: string, type: string])[] = [
  ["seq", "bigint NOT NULL PRIMARY KEY"],
  ["run_id", "text NOT NULL"],
  ["kind", "text NOT NULL CHECK (kind IN ('migration', 'statement', 'step'))"],
  ["migration_id", "text NOT NULL"],
  ["parent", "text NOT NULL DEFAULT ''"],
  ["checksum", "text NOT NULL DEFAULT ''"],
  ["statement_index", "integer NOT NULL"],
  ["statement_sha", "text NOT NULL DEFAULT ''"],
  ["status", "text NOT NULL CHECK (status IN ('started', 'succeeded', 'failed'))"],
  ["error", "text NOT NULL DEFAULT ''"],
  ["applied_by", "text NOT NULL DEFAULT ''"],
  ["plan_digest", "text NOT NULL DEFAULT ''"],
  ["silences", "text NOT NULL DEFAULT '[]'"],
  ["note", "text NOT NULL DEFAULT ''"],
  ["recorded_at", "timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()"],
];

/** The columns a row write names: all but `recorded_at`, which is the server's. */
export const PG_WRITTEN_COLUMNS = PG_HISTORY_COLUMNS.map(([name]) => name).filter((n) => n !== "recorded_at");

/** `<schema>.history`, quoted. */
export const pgHistoryTable = (schema: string): string => `${pgIdent(schema)}.${pgIdent(HISTORY_TABLE)}`;

/** Every statement that makes the history ready, in order: the schema, the table, its comment. */
export function pgHistoryDdl(schema: string): string[] {
  const columns = PG_HISTORY_COLUMNS.map(([name, type]) => `  ${name} ${type}`).join(",\n");
  return [
    `CREATE SCHEMA IF NOT EXISTS ${pgIdent(schema)}`,
    `CREATE TABLE IF NOT EXISTS ${pgHistoryTable(schema)} (\n${columns}\n)`,
    `COMMENT ON TABLE ${pgHistoryTable(schema)} IS 'yodel migration history: append-only, one row per migration, statement and step event'`,
  ];
}
