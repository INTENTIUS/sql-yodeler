/**
 * One apply at a time per environment, on Postgres: a session advisory lock.
 *
 * `pg_try_advisory_lock(<yodel>, <history schema>)` on a connection of its
 * own, opened for the lock and held for the whole apply. The two keys are
 * fixed: the first is yodel's ({@link LOCK_CLASS}), the second a hash of the
 * history schema's name ({@link lockKeys}), so every runner of the same
 * environment asks for the same lock, and two environments with their own
 * history schemas in one database do not share one. A session lock is
 * Postgres's own: it is released when the session ends, however it ends
 * (the runner exits, crashes, or its connection drops), so it needs no
 * expiry, and a dead runner never leaves one behind.
 *
 * The statements run on another connection (the work connection), so the
 * lock's connection is never inside a transaction a statement rolls back.
 *
 * A runner that finds the lock taken refuses with exit 5, as on ClickHouse,
 * naming the session that holds it (its pid, its `application_name`, which
 * says who, and since when). The heartbeat checks that the lock's session
 * still holds it; a dropped connection stops the apply before its next
 * statement.
 *
 * Clearing it by hand, when you know the holder is stuck: end that session,
 * `SELECT pg_terminate_backend(<pid>)`.
 */

import { createHash } from "node:crypto";
import { lockOwner, LockHeldError, LockLostError, type Lock } from "../lock.js";
import type { PgClient } from "./store.js";

/** The first key of every yodel lock: "YODL" as an int4. */
export const LOCK_CLASS = 0x594f444c;

/** The lock's two int4 keys for a history schema. Both non-negative, so `pg_locks.objid` (an oid) reads them back as they are. */
export function lockKeys(schema: string): [number, number] {
  const digest = createHash("sha256").update(`yodel apply lock\n${schema}`, "utf8").digest();
  return [LOCK_CLASS, digest.readUInt32BE(0) & 0x7fffffff];
}

/** A connection the lock holds for itself. */
export interface PgLockConnection extends PgClient {
  end(): Promise<void>;
}

export interface PgLockOptions {
  /** The history schema: the lock's second key. */
  schema: string;
  /** Who holds it, for the refusal another runner sees. */
  holder: string;
}

/** `application_name` is 63 bytes at most; the lock's says it is yodel's and whose. */
const applicationName = (owner: string): string => `yodel apply ${owner}`.slice(0, 63);

/**
 * Takes the advisory lock on `conn`, a connection opened for it, or throws
 * {@link LockHeldError} (exit 5). On a refusal the connection is closed.
 * The lock is released with the returned {@link Lock}'s `release`, which
 * also closes the connection.
 */
export async function acquireAdvisoryLock(conn: PgLockConnection, options: PgLockOptions): Promise<Lock> {
  const [k1, k2] = lockKeys(options.schema);
  const owner = lockOwner(options.holder);
  const where = `Postgres advisory lock (${String(k1)}, ${String(k2)}) for history schema ${options.schema}`;
  try {
    await conn.query("SELECT pg_catalog.set_config('application_name', $1, false)", [applicationName(owner)]);
    const [row] = await conn.query<{ ok: boolean }>("SELECT pg_catalog.pg_try_advisory_lock($1::int4, $2::int4) AS ok", [k1, k2]);
    if (row?.ok !== true) {
      const [held] = await conn.query<{ pid: number; app: string | null; since: string | null }>(
        `SELECT l.pid, a.application_name AS app, pg_catalog.to_char(a.backend_start AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS since
           FROM pg_catalog.pg_locks l LEFT JOIN pg_catalog.pg_stat_activity a ON a.pid = l.pid
          WHERE l.locktype = 'advisory' AND l.granted AND l.classid = $1::oid AND l.objid = $2::oid AND l.objsubid = 2
          LIMIT 1`,
        [k1, k2],
      );
      const who = held ? `${held.app || "(no application_name)"}, pid ${String(held.pid)}` : "(another session)";
      throw new LockHeldError(who, held?.since ?? "(unknown)", where, held ? `SELECT pg_terminate_backend(${String(held.pid)})` : "end the session that holds it");
    }
  } catch (e) {
    await conn.end().catch(() => undefined);
    throw e;
  }

  let released = false;
  return {
    kind: "advisory",
    owner,
    where,
    async heartbeat() {
      if (released) throw new LockLostError(where);
      let holds: boolean;
      try {
        const [row] = await conn.query<{ n: number | string }>(
          "SELECT count(*) AS n FROM pg_catalog.pg_locks WHERE locktype = 'advisory' AND granted AND pid = pg_catalog.pg_backend_pid() AND classid = $1::oid AND objid = $2::oid AND objsubid = 2",
          [k1, k2],
        );
        holds = Number(row?.n ?? 0) > 0;
      } catch {
        holds = false;
      }
      if (!holds) throw new LockLostError(where);
    },
    async release() {
      if (released) return;
      released = true;
      try {
        await conn.query("SELECT pg_catalog.pg_advisory_unlock($1::int4, $2::int4)", [k1, k2]);
      } finally {
        await conn.end().catch(() => undefined);
      }
    },
  };
}
