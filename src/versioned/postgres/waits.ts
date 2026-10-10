/**
 * Reads of the live schema that another session's lock can block (#18): the
 * fingerprint the plan digest covers, read before every apply and plan.
 * chant's catalog reader calls `pg_get_viewdef()` and friends, which wait
 * for a table's ACCESS SHARE lock, so a session holding ACCESS EXCLUSIVE on
 * a declared table (a long `ALTER TABLE`, a `LOCK TABLE`) would hold the read
 * up for as long as it holds the lock, with nothing printed.
 *
 * So the read runs under the profile's `lockTimeoutMs`, and when that passes
 * (SQLSTATE 55P03) yodel says which lock it waited on and who holds it, and
 * tries again with the same pauses and count as a statement (250 ms, then
 * doubling, YODEL_LOCK_RETRIES more times). When the lock is still held after
 * the last try, the read fails with the same description.
 */

import { YodelError } from "../../project.js";
import type { PgClient } from "../../history/postgres/index.js";
import { DEFAULT_RETRY_BASE_MS, LOCK_NOT_AVAILABLE } from "./executor.js";

/** A session's ACCESS EXCLUSIVE lock on a relation, held or queued for. */
export interface LockHolder {
  schema: string;
  name: string;
  pid: number;
  granted: boolean;
  application: string;
}

const sqlstate = (e: unknown): string | undefined =>
  e && typeof e === "object" && "code" in e && typeof e.code === "string" ? e.code : undefined;

/** The ACCESS EXCLUSIVE locks other sessions hold (or wait for) on relations in `schemas` (every schema but the server's own when undefined). */
export async function lockHolders(client: PgClient, schemas: readonly string[] | undefined): Promise<LockHolder[]> {
  const rows = await client.query<{ schema: string; name: string; pid: number | string; granted: boolean; application: string | null }>(
    `SELECT n.nspname AS schema, c.relname AS name, l.pid, l.granted, a.application_name AS application
       FROM pg_catalog.pg_locks l
       JOIN pg_catalog.pg_class c ON c.oid = l.relation
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_catalog.pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'relation' AND l.mode = 'AccessExclusiveLock' AND l.pid <> pg_catalog.pg_backend_pid()
        AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%'
        AND ($1::text[] IS NULL OR n.nspname = ANY ($1::text[]))
      ORDER BY l.granted DESC, n.nspname, c.relname, l.pid
      LIMIT 5`,
    [schemas ? [...schemas] : null],
  );
  return rows.map((r) => ({ schema: r.schema, name: r.name, pid: Number(r.pid), granted: r.granted, application: r.application ?? "" }));
}

/** `a lock on shop.orders (held by pid 123, psql)`, or `a lock held by another session` when none could be named. */
export function describeHolders(holders: readonly LockHolder[]): string {
  if (holders.length === 0) return "a lock another session holds on an object in scope";
  const one = (h: LockHolder) => `${h.schema}.${h.name} (${h.granted ? "held" : "queued for"} by pid ${String(h.pid)}${h.application ? `, ${h.application}` : ""})`;
  return `a lock on ${holders.map(one).join(", ")}`;
}

export interface LockedReadOptions {
  lockTimeoutMs: number;
  retries: number;
  /** The schemas to look for the lock in. */
  schemas: readonly string[] | undefined;
  /** What is being read, for the messages: `the live schema`. */
  what: string;
  log: (line: string) => void;
  retryBaseMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const sleeper = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const seconds = (ms: number) => (ms < 1000 ? `${String(ms)}ms` : `${String(Math.round(ms / 100) / 10)}s`);

/** Runs `read` on `client` with `lock_timeout` set, retrying (and saying why) when another session's lock holds it up. */
export async function readUnderLockTimeout<T>(client: PgClient, read: () => Promise<T>, o: LockedReadOptions): Promise<T> {
  const sleep = o.sleep ?? sleeper;
  const base = o.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  const [prev] = await client.query<{ lock_timeout: string }>("SELECT pg_catalog.current_setting('lock_timeout') AS lock_timeout");
  await client.query("SELECT pg_catalog.set_config('lock_timeout', $1, false)", [`${String(Math.max(0, Math.floor(o.lockTimeoutMs)))}ms`]);
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        return await read();
      } catch (e) {
        if (sqlstate(e) !== LOCK_NOT_AVAILABLE) throw e;
        const holders = await lockHolders(client, o.schemas).catch(() => []);
        const waited = `reading ${o.what} waited ${seconds(o.lockTimeoutMs)} for ${describeHolders(holders)}`;
        if (attempt >= o.retries) {
          const pid = holders.find((h) => h.granted)?.pid;
          throw new YodelError(
            `${waited}, ${String(attempt + 1)} time(s); nothing was changed. Try again once it is released${pid !== undefined ? `, or end that session with: SELECT pg_terminate_backend(${String(pid)})` : ""}`,
          );
        }
        const pause = base * 2 ** attempt;
        o.log(`${waited}; trying again in ${seconds(pause)} (${String(attempt + 1)} of ${String(o.retries)})`);
        await sleep(pause);
      }
    }
  } finally {
    await client.query("SELECT pg_catalog.set_config('lock_timeout', $1, false)", [prev?.lock_timeout ?? "0"]).catch(() => undefined);
  }
}

/** The `PGOPTIONS` a chant child reads Postgres under, so a read blocked by a lock gives up after `lockTimeoutMs` (node-postgres passes it to the server). */
export function lockTimeoutOptions(lockTimeoutMs: number, existing: string | undefined): string {
  return [existing?.trim(), `-c lock_timeout=${String(Math.max(0, Math.floor(lockTimeoutMs)))}`].filter(Boolean).join(" ");
}

/** Whether a read failed because the lock timeout passed. */
export const isLockTimeout = (text: string | undefined): boolean => text !== undefined && /lock timeout/i.test(text);

export { seconds as describeMs };
