/**
 * Sending one migration statement to Postgres, the way chant's applier does
 * (`postgres/apply/apply.ts`), with the history row that says it succeeded.
 *
 * ## Timeouts and retries
 *
 * Every statement runs with its own `lock_timeout` (default 5 s, the
 * profile's `lockTimeoutMs`) and `statement_timeout` (the profile's
 * `statementTimeoutMs`, default 60 s, for a catalog change; `scanTimeoutMs`,
 * default none, for one that reads or rewrites rows). A statement blocked
 * behind another session's lock gives up when the lock timeout passes
 * (SQLSTATE 55P03) instead of queueing every later query on the table
 * behind it, and is tried again after a pause that doubles each time (250
 * ms, 500 ms, ...), up to `retries` more times (default 5). Any other error
 * fails it at once.
 *
 * ## Transactions
 *
 * A statement chant marks `transactional` runs in a transaction of its own:
 *
 *     BEGIN; SET LOCAL lock_timeout ...; SET LOCAL statement_timeout ...;
 *     <statement>; INSERT INTO <history> (... 'succeeded' ...); COMMIT
 *
 * so the statement and its `succeeded` row commit together or not at all.
 * A runner killed anywhere in it leaves either both or neither: a statement
 * whose latest row is `started` did not commit, and is sent again safely.
 *
 * A statement that may not run in a transaction block (`CREATE INDEX
 * CONCURRENTLY`, `DROP INDEX CONCURRENTLY`) or that chant keeps out of one
 * (`ALTER TYPE ... ADD VALUE`, whose label cannot be used in the transaction
 * that adds it) runs alone, with `SET` for the session first; its
 * `succeeded` row is written right after it, in a transaction of its own.
 * A runner killed between the two leaves the statement run and its latest
 * row `started`, and the next run sends it again.
 *
 * ## A failed CONCURRENTLY build
 *
 * `CREATE INDEX CONCURRENTLY` that fails (a lock timeout, a duplicate on a
 * unique index, a cancel) leaves the index behind, INVALID: it is in the
 * catalog, is maintained on every write, and is never used, and the next
 * `CREATE INDEX` of that name fails because it exists. So before every
 * attempt, the first, a retry, or a resume in a later run, and after every
 * failure, an INVALID index of that name is dropped (`DROP INDEX
 * CONCURRENTLY IF EXISTS`), and only an INVALID one: a valid index of that
 * name is never touched.
 */

import { YodelError } from "../../project.js";
import type { PgClient } from "../../history/postgres/index.js";
import { pgIdent } from "../../history/postgres/index.js";

/** SQLSTATE lock_not_available: the lock timeout passed. */
export const LOCK_NOT_AVAILABLE = "55P03";

export interface PgTimeouts {
  lockTimeoutMs: number;
  /** For a statement that changes only the catalog. 0 is no limit. */
  statementTimeoutMs: number;
  /** For a statement that reads or rewrites rows. 0 is no limit. */
  scanTimeoutMs: number;
}

export const DEFAULT_PG_TIMEOUTS: PgTimeouts = { lockTimeoutMs: 5_000, statementTimeoutMs: 60_000, scanTimeoutMs: 0 };
export const DEFAULT_LOCK_RETRIES = 5;
export const DEFAULT_RETRY_BASE_MS = 250;

/** The parts of a migration's statement step the executor reads. */
export interface PgStatement {
  sql: string;
  /** chant's class: `rewrite`, `validate` and `concurrently` read or rewrite rows. */
  class: string;
  /** False: outside any transaction. */
  transactional: boolean;
}

export interface PgStatementOptions {
  timeouts: PgTimeouts;
  /** How many more times a statement that hit the lock timeout is tried. */
  retries: number;
  /** The first pause before a retry, in ms; it doubles each time. */
  retryBaseMs?: number;
  /**
   * Writes the `succeeded` row on the client, given the note it carries
   * (the retries it took, the INVALID index it dropped). Called inside the
   * statement's transaction when it has one.
   */
  succeeded: (note: string) => Promise<void>;
  log: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface PgStatementResult {
  attempts: number;
  /** INVALID indexes dropped before or between attempts. */
  droppedInvalid: string[];
  note: string;
}

/** A statement failed; `error` is the server's message. */
export class PgStatementError extends YodelError {
  constructor(
    readonly error: string,
    readonly code: string | undefined,
    readonly attempts: number,
  ) {
    super(error, 1);
    this.name = "PgStatementError";
  }
}

const sqlstate = (e: unknown): string | undefined =>
  e && typeof e === "object" && "code" in e && typeof e.code === "string" ? e.code : undefined;

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const ms = (n: number): string => `'${String(Math.max(0, Math.floor(n)))}ms'`;

/** Whether a statement of `cls` reads or rewrites rows (chant's `scansRows`), so it runs with the scan timeout. */
export const scansRows = (cls: string): boolean => cls === "rewrite" || cls === "validate" || cls === "concurrently";

const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const CONCURRENT_INDEX = new RegExp(String.raw`^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+(?:IF\s+NOT\s+EXISTS\s+)?(${IDENT})\s+ON\s+(?:ONLY\s+)?(?:(${IDENT})\s*\.\s*)?${IDENT}`, "i");

const unquote = (id: string): string => (id.startsWith('"') ? id.slice(1, -1).replace(/""/g, '"') : id.toLowerCase());

/** The index a `CREATE INDEX CONCURRENTLY` builds, `schema.name` quoted, when the statement names its table's schema. */
export function concurrentIndex(sql: string): string | undefined {
  const m = CONCURRENT_INDEX.exec(sql);
  if (!m?.[1] || !m[2]) return undefined;
  return `${pgIdent(unquote(m[2]))}.${pgIdent(unquote(m[1]))}`;
}

/** Drops `index` when it is there and INVALID. Returns whether it dropped it. */
export async function dropInvalidIndex(client: PgClient, index: string, timeouts: PgTimeouts, log: (line: string) => void): Promise<boolean> {
  const [row] = await client.query<{ invalid: boolean }>("SELECT NOT i.indisvalid AS invalid FROM pg_catalog.pg_index i WHERE i.indexrelid = pg_catalog.to_regclass($1)", [index]);
  if (row?.invalid !== true) return false;
  log(`  ${index} is INVALID, left by a CONCURRENTLY build that failed; dropping it before the build`);
  await client.query(`SET lock_timeout = ${ms(timeouts.lockTimeoutMs)}`);
  await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${index}`);
  return true;
}

const defaultSleep = (n: number) => new Promise<void>((r) => setTimeout(r, n));

/** Runs one statement to success or failure; see the module comment. */
export async function runPgStatement(client: PgClient, step: PgStatement, options: PgStatementOptions): Promise<PgStatementResult> {
  const { timeouts, log } = options;
  const sleep = options.sleep ?? defaultSleep;
  const base = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  const statementTimeout = scansRows(step.class) ? timeouts.scanTimeoutMs : timeouts.statementTimeoutMs;
  const index = step.transactional ? undefined : concurrentIndex(step.sql);
  const droppedInvalid: string[] = [];
  const lockWaits: number[] = [];

  const note = (): string => {
    const parts: string[] = [];
    if (lockWaits.length > 0) parts.push(`lock_timeout ${String(timeouts.lockTimeoutMs)}ms hit ${String(lockWaits.length)} time(s); succeeded on attempt ${String(lockWaits.length + 1)}`);
    if (droppedInvalid.length > 0) parts.push(`dropped INVALID index ${droppedInvalid.join(", ")} before building it again`);
    return parts.join("; ");
  };
  const cleanIndex = async () => {
    if (index === undefined) return;
    try {
      if (await dropInvalidIndex(client, index, timeouts, log)) droppedInvalid.push(index);
    } catch (e) {
      log(`  could not drop the INVALID index ${index}: ${messageOf(e)}; the next run tries again`);
    }
  };

  for (let attempt = 1; ; attempt++) {
    try {
      if (step.transactional) {
        await client.query("BEGIN");
        try {
          await client.query(`SET LOCAL lock_timeout = ${ms(timeouts.lockTimeoutMs)}`);
          await client.query(`SET LOCAL statement_timeout = ${ms(statementTimeout)}`);
          await client.query(step.sql);
          await options.succeeded(note());
          await client.query("COMMIT");
        } catch (e) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw e;
        }
      } else {
        await cleanIndex();
        try {
          await client.query(`SET lock_timeout = ${ms(timeouts.lockTimeoutMs)}`);
          await client.query(`SET statement_timeout = ${ms(statementTimeout)}`);
          await client.query(step.sql);
        } catch (e) {
          await cleanIndex();
          throw e;
        } finally {
          await client.query("SET lock_timeout TO DEFAULT").catch(() => undefined);
          await client.query("SET statement_timeout TO DEFAULT").catch(() => undefined);
        }
        await options.succeeded(note());
      }
      return { attempts: attempt, droppedInvalid, note: note() };
    } catch (e) {
      const code = sqlstate(e);
      if (code === LOCK_NOT_AVAILABLE && attempt <= options.retries) {
        lockWaits.push(attempt);
        const wait = base * 2 ** (attempt - 1);
        log(`  lock_timeout ${String(timeouts.lockTimeoutMs)}ms: another session holds a lock this statement needs; trying again in ${String(wait)}ms (${String(attempt)}/${String(options.retries)})`);
        await sleep(wait);
        continue;
      }
      const message = messageOf(e);
      throw new PgStatementError(
        code === LOCK_NOT_AVAILABLE
          ? `${message} (lock_timeout ${String(timeouts.lockTimeoutMs)}ms, tried ${String(attempt)} times: another session kept a lock this statement needs; SQLSTATE 55P03)`
          : message,
        code,
        attempt,
      );
    }
  }
}
