/**
 * The one thing the history needs from a ClickHouse server: run a statement,
 * get rows back. Over chant's own HTTP client in use; an in-memory fake in
 * the unit tests.
 */

import type { ClickHouseEndpoint } from "@intentius/chant-lexicon-sql/clickhouse/http";
import { YodelError } from "../project.js";

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
    query: async <Row>(sql: string, options: QueryOptions = {}) => {
      try {
        return await clickhouseQuery<Row>(endpoint, sql, options.settings ? { settings: options.settings } : {});
      } catch (e) {
        throw unreachable(endpoint, e) ?? e;
      }
    },
  };
}

/**
 * A server that did not answer at all (refused, no route, a name that does
 * not resolve): fetch throws `TypeError: fetch failed` with the reason in
 * its cause, and neither names the server. One line that does, instead of
 * a stack trace.
 */
export function unreachable(endpoint: ClickHouseEndpoint, e: unknown): YodelError | undefined {
  if (!(e instanceof TypeError) || !/fetch failed/i.test(e.message)) return undefined;
  const cause = (e as { cause?: unknown }).cause;
  const c = cause && typeof cause === "object" ? (cause as { code?: unknown; message?: unknown }) : undefined;
  const why = typeof c?.code === "string" ? c.code : typeof c?.message === "string" ? c.message : e.message;
  return new YodelError(`the ClickHouse server at ${redact(endpoint.url)} did not answer (${why}); is it running, and is that the right URL?`);
}

const redact = (url: string): string => url.replace(/\/\/[^@/]*@/, "//");

/** The server's message for an error from a port, first line. */
export function serverMessage(e: unknown): string {
  if (e && typeof e === "object" && "serverMessage" in e && typeof e.serverMessage === "string") return e.serverMessage.trim();
  return e instanceof Error ? e.message : String(e);
}
