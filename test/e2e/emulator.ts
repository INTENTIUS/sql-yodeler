/**
 * Reaching `chant emulator up --lexicon sql` from the e2e tests.
 *
 * Gated by environment variables so CI, which has no emulator, skips them:
 *
 *   YODEL_E2E_CLICKHOUSE_URL=http://<host>:8123
 *   YODEL_E2E_POSTGRES_URL=postgres://<host>:5432/postgres
 *   YODEL_E2E_POSTGRES_USER=postgres YODEL_E2E_POSTGRES_PASSWORD=chant
 *
 * A local Postgres often holds 127.0.0.1:5432, so use the machine's LAN
 * address (`ipconfig getifaddr en0`) rather than localhost. A suite whose
 * variable is set but whose server does not answer skips too, saying why.
 * Every database and schema a suite writes is named from YODEL_E2E_PREFIX
 * (default yodel_e2e) and the suite, <prefix>_<suite>; see ./names.ts. Set
 * it to keep a run apart from others on the same emulator:
 *
 *   YODEL_E2E_PREFIX=yodel_54
 */

import pg from "pg";

export const clickhouseUrl = process.env.YODEL_E2E_CLICKHOUSE_URL ?? "";
export const postgresUrl = process.env.YODEL_E2E_POSTGRES_URL ?? "";

/** Runs one statement on the ClickHouse emulator over HTTP. */
export async function clickhouse(sql: string): Promise<string> {
  const res = await fetch(`${clickhouseUrl.replace(/\/+$/, "")}/`, { method: "POST", body: sql });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickHouse: ${text}`);
  return text;
}

/** Runs statements on the Postgres emulator and returns the last result's rows. */
export async function postgres<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  // Not connectionString: pg lets the URL's (absent) password override the one passed beside it.
  const url = new URL(postgresUrl);
  const client = new pg.Client({
    host: url.hostname,
    port: Number(url.port || 5432),
    database: url.pathname.replace(/^\//, "") || "postgres",
    user: process.env.YODEL_E2E_POSTGRES_USER ?? "postgres",
    password: process.env.YODEL_E2E_POSTGRES_PASSWORD ?? "",
  });
  await client.connect();
  try {
    const result = (await client.query(sql)) as unknown as pg.QueryResult | pg.QueryResult[];
    const last = Array.isArray(result) ? result[result.length - 1] : result;
    return (last?.rows ?? []) as T[];
  } finally {
    await client.end();
  }
}

async function answers(probe: () => Promise<unknown>, what: string): Promise<boolean> {
  try {
    await probe();
    return true;
  } catch (e) {
    console.warn(`skipping the ${what} e2e tests: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

export const clickhouseReachable = clickhouseUrl ? await answers(() => clickhouse("SELECT 1"), "ClickHouse") : false;
export const postgresReachable = postgresUrl ? await answers(() => postgres("SELECT 1"), "Postgres") : false;
