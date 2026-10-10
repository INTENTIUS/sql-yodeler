/**
 * The emulator, asked directly: a claim checks what yodel did by querying
 * the server, never by trusting yodel's output.
 *
 *   YODEL_CLAIMS_CLICKHOUSE_URL       default http://localhost:8123
 *   YODEL_CLAIMS_POSTGRES_URL         default postgres://localhost:5432/postgres
 *   YODEL_CLAIMS_POSTGRES_USER        default postgres
 *   YODEL_CLAIMS_POSTGRES_PASSWORD    default chant (the emulator's)
 *
 *   YODEL_CLAIMS_DB_PREFIX            default yodel_34
 *
 * Each claim writes only to its own ClickHouse database or Postgres schema,
 * <prefix>_<claim>, and its history, <prefix>_<claim>_history. Two people
 * running the same claim on one server at once give each run its own
 * prefix (yodel_<issue>), so their databases do not collide.
 */

import pg from "pg";
import type { Dialect } from "./claim.js";

export const endpoints = {
  clickhouse: process.env.YODEL_CLAIMS_CLICKHOUSE_URL ?? "http://localhost:8123",
  postgres: process.env.YODEL_CLAIMS_POSTGRES_URL ?? "postgres://localhost:5432/postgres",
  postgresUser: process.env.YODEL_CLAIMS_POSTGRES_USER ?? "postgres",
  postgresPassword: process.env.YODEL_CLAIMS_POSTGRES_PASSWORD ?? "chant",
};

/** The variables a scratch project's chant.config.ts reads, with their defaults filled in. */
export function endpointEnv(): Record<string, string> {
  return {
    YODEL_CLAIMS_CLICKHOUSE_URL: endpoints.clickhouse,
    YODEL_CLAIMS_POSTGRES_URL: endpoints.postgres,
    YODEL_CLAIMS_POSTGRES_USER: endpoints.postgresUser,
    YODEL_CLAIMS_POSTGRES_PASSWORD: endpoints.postgresPassword,
  };
}

/** One statement on a ClickHouse server over HTTP; the response text. */
export async function clickhouseAt(url: string, sql: string): Promise<string> {
  const res = await fetch(`${url.replace(/\/+$/, "")}/`, { method: "POST", body: sql, signal: AbortSignal.timeout(120_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickHouse (${url}): ${text.trim()}\n  in: ${sql}`);
  return text;
}

/** Statements on the Postgres emulator; the last result's rows. */
export async function postgresQuery<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const url = new URL(endpoints.postgres);
  const client = new pg.Client({
    host: url.hostname,
    port: Number(url.port || 5432),
    database: url.pathname.replace(/^\//, "") || "postgres",
    user: endpoints.postgresUser,
    password: endpoints.postgresPassword,
    connectionTimeoutMillis: 15_000,
    statement_timeout: 120_000,
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

/** A claim's database (ClickHouse) or schema (Postgres), and the questions claims ask of it. */
export interface Db {
  dialect: Dialect;
  /** <prefix>_<claim>. */
  name: string;
  /** <prefix>_<claim>_history: the history database or schema. */
  history: string;
  /** Runs SQL as the emulator's admin. */
  exec(sql: string): Promise<void>;
  /** The first column of the first row, as text ("" when there is none). */
  scalar(sql: string): Promise<string>;
  /** A number from {@link scalar}. */
  count(sql: string): Promise<number>;
  tableExists(table: string): Promise<boolean>;
  columnExists(table: string, column: string): Promise<boolean>;
  /** Drops the database / schema and its history. */
  reset(): Promise<void>;
}

/** The start of every claim database's name: YODEL_CLAIMS_DB_PREFIX, default yodel_34. */
export const dbPrefix = process.env.YODEL_CLAIMS_DB_PREFIX ?? "yodel_34";
if (!/^[a-z][a-z0-9_]*$/.test(dbPrefix)) throw new Error(`YODEL_CLAIMS_DB_PREFIX=${dbPrefix} is not a lower-case identifier`);

export function dbFor(dialect: Dialect, claim: string): Db {
  const name = `${dbPrefix}_${claim.replace(/-/g, "_")}`;
  const history = `${name}_history`;
  if (dialect === "ch") {
    const q = (sql: string) => clickhouseAt(endpoints.clickhouse, sql);
    const scalar = async (sql: string) => (await q(sql)).split("\n")[0]?.split("\t")[0]?.trim() ?? "";
    return {
      dialect,
      name,
      history,
      exec: async (sql) => {
        await q(sql);
      },
      scalar,
      count: async (sql) => Number(await scalar(sql)),
      tableExists: async (table) => (await scalar(`EXISTS TABLE ${name}.${table}`)) === "1",
      columnExists: async (table, column) =>
        Number(await scalar(`SELECT count() FROM system.columns WHERE database = '${name}' AND table = '${table}' AND name = '${column}'`)) === 1,
      reset: async () => {
        await q(`DROP DATABASE IF EXISTS ${name} SYNC`);
        await q(`DROP DATABASE IF EXISTS ${history} SYNC`);
      },
    };
  }
  const scalar = async (sql: string) => {
    const rows = await postgresQuery(sql);
    const first = rows[0];
    if (!first) return "";
    const v = Object.values(first)[0];
    if (v === null || v === undefined) return "";
    return typeof v === "string" || typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" ? String(v) : JSON.stringify(v);
  };
  return {
    dialect,
    name,
    history,
    exec: async (sql) => {
      await postgresQuery(sql);
    },
    scalar,
    count: async (sql) => Number(await scalar(sql)),
    tableExists: async (table) => (await scalar(`SELECT to_regclass('${name}.${table}')::text`)) !== "",
    columnExists: async (table, column) =>
      Number(await scalar(`SELECT count(*) FROM information_schema.columns WHERE table_schema = '${name}' AND table_name = '${table}' AND column_name = '${column}'`)) === 1,
    reset: async () => {
      await postgresQuery(`DROP SCHEMA IF EXISTS ${name} CASCADE; DROP SCHEMA IF EXISTS ${history} CASCADE`);
      // A claim's roles (#45) are named <name>__<role>; roles outlive the schema, so they go with it here.
      await postgresQuery(
        `DO $$ DECLARE r text; BEGIN FOR r IN SELECT rolname FROM pg_roles WHERE rolname LIKE '${name}\\_\\_%' LOOP EXECUTE format('DROP ROLE %I', r); END LOOP; END $$`,
      );
    },
  };
}

/** A Postgres session of its own, for holding a lock while yodel runs. */
export async function postgresSession(): Promise<pg.Client> {
  const url = new URL(endpoints.postgres);
  const client = new pg.Client({
    host: url.hostname,
    port: Number(url.port || 5432),
    database: url.pathname.replace(/^\//, "") || "postgres",
    user: endpoints.postgresUser,
    password: endpoints.postgresPassword,
    connectionTimeoutMillis: 15_000,
  });
  await client.connect();
  return client;
}
