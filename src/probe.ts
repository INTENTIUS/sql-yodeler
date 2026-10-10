/**
 * The write probe (#50): `yodel config check <env> --write-probe` tries a
 * write with the credentials the job holds and reports whether the server
 * let it. A pull request job runs it before its plan, so a reader that can
 * write (the writer's secrets mapped into the job, a reader granted too
 * much) fails the pull request.
 *
 * The write leaves nothing behind. On Postgres it is a `CREATE TABLE` in
 * the environment's first schema (`CREATE SCHEMA` when that schema is not
 * there yet) inside a transaction that is rolled back. On ClickHouse, which
 * has no transactions, a `Memory` table with a random name in the first
 * database (the database itself when it is not there yet), dropped at once
 * when it was made.
 *
 * Only a refusal for want of privilege counts as "cannot write" (Postgres
 * 42501 and 25006, ClickHouse 164 READONLY and 497 ACCESS_DENIED); any
 * other failure is an error, so a probe that could not tell never passes.
 */

import { randomBytes } from "node:crypto";
import { environmentSettings } from "./config/settings.js";
import { YodelError, type Environment, type Project } from "./project.js";

export interface ProbeResult {
  /** The server let the write through. */
  wrote: boolean;
  /** What was tried, and the server's answer when it refused. */
  detail: string;
}

/** Postgres SQLSTATEs that mean the role may not write. */
const PG_REFUSED = new Set(["42501", "25006"]);
/** ClickHouse error codes that mean the user may not write: READONLY, ACCESS_DENIED. */
const CH_REFUSED = new Set([164, 497]);
const CH_UNKNOWN_DATABASE = 81;

const pgIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;
const chIdent = (s: string) => `\`${s.replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\``;
/** The first line of a server message, without ClickHouse's trailing version. */
const firstLine = (s: string) => (s.trim().split("\n")[0] ?? "").replace(/ \(version .*\)\.?$/, "");

/** Tries a write in `env` with the credentials this process holds. */
export async function writeProbe(project: Project, env: Environment, processEnv: NodeJS.ProcessEnv = process.env): Promise<ProbeResult> {
  return project.dialect === "postgres" ? postgresProbe(project, env, processEnv) : clickhouseProbe(project, env, processEnv);
}

async function postgresProbe(project: Project, env: Environment, processEnv: NodeJS.ProcessEnv): Promise<ProbeResult> {
  const { resolvePostgresTarget, isUnresolvedTarget } = await import("@intentius/chant-lexicon-sql/postgres/live/bind");
  const target = resolvePostgresTarget({ environment: env.name, config: project.config, env: processEnv });
  if (isUnresolvedTarget(target)) throw new YodelError(`${env.name}: ${target.detail}`);
  const { connectPostgres } = await import("@intentius/chant-lexicon-sql/postgres/live/client");
  let client: Awaited<ReturnType<typeof connectPostgres>>;
  try {
    client = await connectPostgres(target.endpoint, { applicationName: "yodel write probe" });
  } catch (e) {
    throw new YodelError(`${env.name}: the write probe could not connect: ${e instanceof Error ? firstLine(e.message) : String(e)}`);
  }
  const schema = target.schemas?.[0] ?? target.defaultSchema;
  try {
    await client.query("BEGIN");
    const there = (await client.query<{ n: number }>("SELECT 1 AS n FROM pg_catalog.pg_namespace WHERE nspname = $1", [schema])).length > 0;
    const sql = there ? `CREATE TABLE ${pgIdent(schema)}.yodel_write_probe (x integer)` : `CREATE SCHEMA ${pgIdent(schema)}`;
    try {
      await client.query(sql);
      return { wrote: true, detail: `${sql} succeeded (rolled back)` };
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      const message = e instanceof Error ? firstLine(e.message) : String(e);
      if (typeof code === "string" && PG_REFUSED.has(code)) return { wrote: false, detail: `${sql}: ${message}` };
      throw new YodelError(`${env.name}: the write probe could not tell whether this job can write: ${sql}: ${message}`);
    }
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
}

async function clickhouseProbe(project: Project, env: Environment, processEnv: NodeJS.ProcessEnv): Promise<ProbeResult> {
  const { resolveClickHouseTarget, isUnresolvedTarget } = await import("@intentius/chant-lexicon-sql/clickhouse/live/bind");
  const target = resolveClickHouseTarget({ environment: env.name, config: project.config, env: processEnv });
  if (isUnresolvedTarget(target)) throw new YodelError(`${env.name}: ${target.detail}`);
  const { clickhouseQuery } = await import("@intentius/chant-lexicon-sql/clickhouse/http");
  const database = target.databases?.[0] ?? environmentSettings(project, env.name, processEnv).historyDatabase;
  const table = `${chIdent(database)}.${chIdent(`yodel_write_probe_${randomBytes(6).toString("hex")}`)}`;
  const attempt = async (sql: string, undo: string): Promise<ProbeResult | number> => {
    try {
      await clickhouseQuery(target.endpoint, sql);
    } catch (e) {
      const text = (e as { serverMessage?: unknown }).serverMessage;
      const message = typeof text === "string" ? text : e instanceof Error ? e.message : String(e);
      const code = Number(/Code: (\d+)/.exec(message)?.[1] ?? NaN);
      if (CH_REFUSED.has(code)) return { wrote: false, detail: `${sql}: ${firstLine(message)}` };
      if (Number.isFinite(code) && !/AUTHENTICATION_FAILED/.test(message)) return code;
      throw new YodelError(`${env.name}: the write probe could not tell whether this job can write: ${sql}: ${firstLine(message)}`);
    }
    await clickhouseQuery(target.endpoint, undo);
    return { wrote: true, detail: `${sql} succeeded (dropped again)` };
  };
  const first = await attempt(`CREATE TABLE ${table} (x UInt8) ENGINE = Memory`, `DROP TABLE IF EXISTS ${table}`);
  if (typeof first !== "number") return first;
  if (first === CH_UNKNOWN_DATABASE) {
    const second = await attempt(`CREATE DATABASE ${chIdent(database)}`, `DROP DATABASE IF EXISTS ${chIdent(database)}`);
    if (typeof second !== "number") return second;
    throw new YodelError(`${env.name}: the write probe could not tell whether this job can write: CREATE DATABASE ${database} failed with code ${String(second)}`);
  }
  throw new YodelError(`${env.name}: the write probe could not tell whether this job can write: CREATE TABLE ${table} failed with code ${String(first)}`);
}
