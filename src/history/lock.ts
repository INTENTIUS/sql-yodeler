/**
 * One apply at a time per environment.
 *
 * ## Keeper: a KeeperMap row
 *
 * The lock is a row in `<history database>.lock`, a `KeeperMap` table, so
 * it lives in Keeper. Inserted with `keeper_map_strict_mode = 1`, an insert
 * of a key that is there already fails ("Node exists") instead of
 * overwriting it: create-if-absent, which is a lock. Every runner, on any
 * host, sees the same row, because every host's `lock` table names the same
 * Keeper path. It was picked over the other routes ClickHouse SQL offers:
 *
 * - an insert into a Replicated table that deduplicates: the losing insert is
 *   dropped silently, inside a time window, so the loser cannot tell it lost
 *   without reading back, and a later insert is not refused at all;
 * - `INSERT INTO system.zookeeper`: no `DELETE`, so a lock could never be
 *   released or expired from SQL.
 *
 * The row names its owner and an expiry. A runner that holds it extends the
 * expiry while it works (a heartbeat every third of the TTL) and deletes the
 * row when done. A runner that finds an expired row deletes that row (by its
 * owner, so it never deletes a newer one) and inserts its own; two runners
 * racing for an expired lock both delete, and only one insert succeeds. A
 * heartbeat that finds the row gone or someone else's stops the apply
 * before its next statement.
 *
 * KeeperMap needs Keeper and the server setting `keeper_map_path_prefix`.
 *
 * ## No Keeper: a local lock file
 *
 * A single node with no Keeper (or no `keeper_map_path_prefix`) gets a lock
 * file under the system temp directory instead, created exclusively, with
 * the same owner and expiry. It serializes applies from one machine only, and
 * the run says so: cross-runner locking needs Keeper. A cluster, a
 * Replicated database or Cloud never fall back: they refuse without the
 * KeeperMap lock.
 *
 * ## Clearing a lock by hand
 *
 * A dead runner's lock expires after its TTL (`YODEL_LOCK_TTL`, seconds,
 * default 900). To clear it sooner, when you know no apply is running:
 *
 *   Keeper: ALTER TABLE <history database>.lock DELETE WHERE name = 'apply'
 *   local:  rm the lock file the refusal names
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YodelError } from "../project.js";
import { serverMessage, type ClickHousePort } from "./client.js";
import { databaseDdl, ident, literal, LOCK_TABLE, lockTableDdl } from "./ddl.js";
import { describeTopology, type HistoryTopology } from "./topology.js";

/** Exit code: another apply holds the lock. */
export const LOCKED = 5;

/** The lock row's key: one apply lock per history database. */
export const LOCK_NAME = "apply";

/** Default lock TTL. */
export const DEFAULT_LOCK_TTL_MS = 15 * 60 * 1000;

export interface Lock {
  /** `advisory`: a Postgres session advisory lock (`./postgres/lock.ts`). */
  kind: "keeper" | "local" | "advisory";
  owner: string;
  /** Where it is: the KeeperMap table, or the lock file. */
  where: string;
  /** Set when the lock is local: why, and that cross-runner locking needs Keeper. */
  notice?: string;
  /** Extends the expiry. Throws a {@link LockLostError} when the lock is no longer this owner's. */
  heartbeat(): Promise<void>;
  /** Deletes the lock, when it is still this owner's. */
  release(): Promise<void>;
}

export class LockHeldError extends YodelError {
  constructor(
    readonly holder: string,
    readonly expiresAt: string,
    readonly where: string,
    readonly clear: string,
  ) {
    super(`another apply holds the lock (${where}): owner ${holder}, until ${expiresAt} UTC. Wait for it, or once you know it is not running, clear it with: ${clear}`, LOCKED);
    this.name = "LockHeldError";
  }
}

export class LockLostError extends YodelError {
  constructor(where: string) {
    super(`the apply lock (${where}) is no longer held by this run (it expired and another run took it); stopped before the next statement`, LOCKED);
    this.name = "LockLostError";
  }
}

export interface LockOptions {
  database: string;
  topology: HistoryTopology;
  /** Who holds it, for the refusal another runner sees. */
  holder: string;
  ttlMs?: number;
  /** Identifies the server, for the local lock file's name. */
  serverKey: string;
  /** Where local lock files go. Default: `<tmpdir>/yodel-locks`. */
  localDir?: string;
}

/** A lock owner: who, plus a random part so two runs by the same user never share one. */
export const lockOwner = (holder: string): string => `${holder}#${String(process.pid)}-${randomUUID().slice(0, 8)}`;

const isNodeExists = (e: unknown) => /Node exists|already exists/i.test(serverMessage(e));
const keeperMapUnavailable = (e: unknown) => /keeper_map_path_prefix|ZooKeeper|Keeper is not|KEEPER_EXCEPTION.*(not configured|connection)|No such engine|UNKNOWN_STORAGE/i.test(serverMessage(e));

const STRICT = { keeper_map_strict_mode: "1", async_insert: "0" };

/** Acquires the environment's apply lock, or throws {@link LockHeldError}. */
export async function acquireLock(port: ClickHousePort, options: LockOptions): Promise<Lock> {
  const ttlMs = options.ttlMs ?? DEFAULT_LOCK_TTL_MS;
  await port.query(databaseDdl(options));
  try {
    await port.query(lockTableDdl(options));
  } catch (e) {
    if (!keeperMapUnavailable(e)) throw e;
    const why = (serverMessage(e).split("\n")[0] ?? "").replace(/^Code: \d+\. DB::Exception: /, "").replace(/\s*\([A-Z_]+\)\s*\(version [^)]*\)\s*$/, "");
    if (options.topology.kind !== "single") {
      throw new YodelError(
        `topology ${describeTopology(options.topology)} needs the Keeper lock (a KeeperMap table), and the server cannot make one: ${why}. ` +
          `Configure Keeper and keeper_map_path_prefix on the server.`,
      );
    }
    return localLock(options, ttlMs, `no KeeperMap on this server (${why}); the lock is a file on this machine, so cross-runner locking needs Keeper (and keeper_map_path_prefix)`);
  }
  return keeperLock(port, options, ttlMs);
}

async function keeperLock(port: ClickHousePort, options: LockOptions, ttlMs: number): Promise<Lock> {
  const table = `${ident(options.database)}.${LOCK_TABLE}`;
  const owner = lockOwner(options.holder);
  const where = `KeeperMap ${options.database}.${LOCK_TABLE}`;
  const clear = `ALTER TABLE ${table} DELETE WHERE name = '${LOCK_NAME}'`;
  const until = `now64(3) + toIntervalMillisecond(${String(ttlMs)})`;
  const read = async () =>
    (await port.query<{ owner: string; until: string; expired: number | string }>(
      // Not aliased as expires_at: an alias shadows the column in ClickHouse, and the comparison would read the string.
      `SELECT owner, toString(expires_at) AS until, expires_at < now64(3) AS expired FROM ${table} WHERE name = ${literal(LOCK_NAME)}`,
    ))[0];

  for (let attempt = 0; ; attempt++) {
    try {
      await port.query(`INSERT INTO ${table} (name, owner, acquired_at, expires_at) SELECT ${literal(LOCK_NAME)}, ${literal(owner)}, now64(3), ${until}`, { settings: STRICT });
      break;
    } catch (e) {
      if (!isNodeExists(e)) throw e;
      const held = await read();
      if (held && Number(held.expired) !== 1) throw new LockHeldError(held.owner, held.until, where, clear);
      if (attempt >= 3) throw new LockHeldError(held?.owner ?? "(unknown)", held?.until ?? "(unknown)", where, clear);
      // Expired (or released between the insert and the read): delete that owner's row, never a newer one, and try again.
      if (held) await port.query(`ALTER TABLE ${table} DELETE WHERE name = ${literal(LOCK_NAME)} AND owner = ${literal(held.owner)}`, { settings: STRICT });
    }
  }

  return {
    kind: "keeper",
    owner,
    where,
    async heartbeat() {
      await port.query(`ALTER TABLE ${table} UPDATE expires_at = ${until} WHERE name = ${literal(LOCK_NAME)} AND owner = ${literal(owner)}`, { settings: STRICT });
      const held = await read();
      if (held?.owner !== owner) throw new LockLostError(where);
    },
    async release() {
      await port.query(`ALTER TABLE ${table} DELETE WHERE name = ${literal(LOCK_NAME)} AND owner = ${literal(owner)}`, { settings: STRICT });
    },
  };
}

interface LockFile {
  owner: string;
  acquiredAt: string;
  expiresAt: string;
}

/** The local lock's file for a server and history database. */
export function localLockPath(options: Pick<LockOptions, "serverKey" | "database" | "localDir">): string {
  const key = createHash("sha256").update(`${options.serverKey}\n${options.database}`).digest("hex").slice(0, 16);
  return join(options.localDir ?? join(tmpdir(), "yodel-locks"), `${options.database}-${key}.lock`);
}

function readLockFile(path: string): LockFile | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LockFile;
  } catch {
    return undefined;
  }
}

function localLock(options: LockOptions, ttlMs: number, notice: string): Lock {
  const path = localLockPath(options);
  mkdirSync(join(path, ".."), { recursive: true });
  const owner = lockOwner(options.holder);
  const where = `local lock file ${path}`;
  const body = (): string => JSON.stringify({ owner, acquiredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + ttlMs).toISOString() } satisfies LockFile);

  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(path, body(), { flag: "wx" });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const held = readLockFile(path);
      const expired = !held || Date.parse(held.expiresAt) < Date.now();
      if (!expired || attempt >= 3) throw new LockHeldError(held?.owner ?? "(unreadable)", held?.expiresAt ?? "(unknown)", where, `rm ${path}`);
      rmSync(path, { force: true });
    }
  }

  return {
    kind: "local",
    owner,
    where,
    notice,
    heartbeat() {
      if (readLockFile(path)?.owner !== owner) return Promise.reject(new LockLostError(where));
      writeFileSync(path, body());
      return Promise.resolve();
    },
    release() {
      if (readLockFile(path)?.owner === owner) rmSync(path, { force: true });
      return Promise.resolve();
    },
  };
}

/**
 * Runs `body` holding the lock: a heartbeat every third of the TTL while it
 * runs, the lock released after, whatever happens. `beat` lets the body
 * extend the lock (and learn it was lost) between statements.
 */
export async function withLock<T>(lock: Lock, ttlMs: number, body: (beat: () => Promise<void>) => Promise<T>): Promise<T> {
  let lost: unknown;
  const timer = setInterval(() => {
    lock.heartbeat().catch((e: unknown) => {
      lost ??= e;
    });
  }, Math.max(1000, Math.floor(ttlMs / 3)));
  timer.unref();
  const beat = async () => {
    if (lost !== undefined) throw lost instanceof Error ? lost : new LockLostError(lock.where);
    await lock.heartbeat();
  };
  try {
    return await body(beat);
  } finally {
    clearInterval(timer);
    await lock.release().catch(() => undefined);
  }
}
