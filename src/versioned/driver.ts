/**
 * What the versioned apply needs from a dialect: its lock, the live-schema
 * fingerprint the plan digest covers, and how one statement is sent and
 * recorded. The engine (`./engine.ts`) is the same for both dialects: it
 * reads the history, compares it with the directory, checks the digest and
 * the approval, and walks the statements and Op steps in order, recording
 * each one's start and failure; the driver does the dialect's part.
 *
 *   ClickHouse  ./clickhouse.ts   the Keeper (or local) lock, system.tables, a statement then its row
 *   Postgres    ./postgres/       the session advisory lock, chant's catalog reader, a statement and its row in one transaction
 */

import type { SqlDialect } from "../project.js";
import type { StatementStep } from "@intentius/chant-lexicon-sql/migration-statements";
import type { Lock } from "../history/index.js";
import type { StepContext } from "../steps/index.js";

export interface StatementRun {
  /**
   * Writes the statement's `succeeded` row, with `note` (the retries it
   * took, an INVALID index it dropped; `""` when there is nothing to say).
   * The driver calls it where the row commits with the statement when the
   * dialect can: inside the statement's transaction on Postgres.
   */
  succeeded: (note: string) => Promise<unknown>;
  log: (line: string) => void;
}

/** One dialect's part of the versioned apply. A failed statement throws with the server's message, which the history's failed row records. */
export interface VersionedDriver {
  dialect: SqlDialect;
  /** The `note` a statement's rows carry: what ClickHouse rendered it for (#9); none on Postgres. */
  rowNote?: string;
  /** Takes the environment's apply lock, or throws a `LockHeldError` (exit 5). */
  acquireLock(holder: string): Promise<Lock>;
  /** A fingerprint of the live schema in the environment's scope, the history left out. */
  liveFingerprint(): Promise<string>;
  /**
   * Runs a pre-migration check's query (#52) read-only and returns its rows:
   * ClickHouse with `readonly = 2` and the migration's default database,
   * Postgres in a `READ ONLY` transaction with `search_path` set to the
   * migration's default schema, rolled back.
   */
  readCheck(sql: string, where: { defaultDatabase?: string | undefined; defaultSchema?: string | undefined }): Promise<Array<Record<string, unknown>>>;
  /** Sends one statement and writes its `succeeded` row through `run`; throws with the server's message when it fails. */
  runStatement(step: StatementStep, run: StatementRun): Promise<void>;
  /** What an Op step's runner gets from the dialect: the ClickHouse port and endpoint; the Postgres lock timeout, and the connection, timeouts and receipts schema a backfill uses. */
  stepContext(): Pick<StepContext, "port" | "endpoint" | "lockTimeoutMs" | "postgres">;
  /** Closes what the driver opened (a Postgres connection). Safe to call twice. */
  close(): Promise<void>;
}
