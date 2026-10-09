/**
 * The one thing the history needs from a ClickHouse server: run a statement,
 * get rows back. Over chant's own HTTP client in use; an in-memory fake in
 * the unit tests.
 */

import type { ClickHouseEndpoint } from "@intentius/chant-lexicon-sql/clickhouse/http";

export interface QueryOptions {
  /** Server settings for this query alone. `database` sets the default database. */
  settings?: Record<string, string>;
}

export interface ClickHousePort {
  query<Row = Record<string, unknown>>(sql: string, options?: QueryOptions): Promise<Row[]>;
}

/** A port over chant's ClickHouse HTTP client. */
export async function httpPort(endpoint: ClickHouseEndpoint): Promise<ClickHousePort> {
  const { clickhouseQuery } = await import("@intentius/chant-lexicon-sql/clickhouse/http");
  return {
    query: <Row>(sql: string, options: QueryOptions = {}) =>
      clickhouseQuery<Row>(endpoint, sql, options.settings ? { settings: options.settings } : {}),
  };
}

/** The server's message for an error from a port, first line. */
export function serverMessage(e: unknown): string {
  if (e && typeof e === "object" && "serverMessage" in e && typeof e.serverMessage === "string") return e.serverMessage.trim();
  return e instanceof Error ? e.message : String(e);
}
