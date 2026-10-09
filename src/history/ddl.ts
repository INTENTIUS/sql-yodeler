/**
 * The history's DDL, per topology. Written out here rather than rendered by
 * chant's topology renderer, so the history does not wait on a chant release
 * and the four forms are plain to read and test:
 *
 * | topology   | database                                   | history table                                   |
 * |------------|--------------------------------------------|-------------------------------------------------|
 * | single     | `CREATE DATABASE`                          | `MergeTree`                                     |
 * | cluster    | `CREATE DATABASE ... ON CLUSTER c`         | `ReplicatedMergeTree('<path>', '<replica>')` `ON CLUSTER c` |
 * | replicated | `ENGINE = Replicated(...)`, `ON CLUSTER` when the topology names one | `ReplicatedMergeTree` with no arguments (the database supplies them) |
 * | cloud      | `CREATE DATABASE`                          | `MergeTree` (Cloud makes it `SharedMergeTree`)  |
 *
 * The lock table is a `KeeperMap` (see `./lock.ts`); on a cluster it is
 * created `ON CLUSTER`, every host's table naming the same Keeper path, so
 * there is one lock for the cluster.
 */

import { defaultReplicaPath, DEFAULT_HISTORY_REPLICA_NAME, type HistoryTopology } from "./topology.js";

/** The database the history lives in when the environment names none. */
export const DEFAULT_HISTORY_DATABASE = "yodeler";
export const HISTORY_TABLE = "history";
export const LOCK_TABLE = "lock";

/** A ClickHouse identifier, back-quoted. */
export const ident = (name: string): string => `\`${name.replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\``;

/** A ClickHouse string literal. */
export const literal = (value: string): string => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

const onCluster = (t: HistoryTopology): string => (t.kind === "cluster" ? ` ON CLUSTER ${ident(t.cluster)}` : "");

/**
 * The history table's columns. One row per event, never updated or deleted:
 *
 * - a migration row (`kind = 'migration'`, `statement_index = -1`) when a
 *   migration starts, succeeds or fails;
 * - a statement row (`kind = 'statement'`, `statement_index` its index in
 *   the migration's `steps`) when a statement starts, succeeds or fails;
 * - a step row (`kind = 'step'`, the same) when an Op step (a rebuild, a
 *   backfill) starts, succeeds or fails, its `note` the step's summary as
 *   JSON (the receipts it skipped and the work it ran).
 *
 * The state of a migration or a statement is its row with the highest
 * `seq`. `seq` is taken under the lock, one more than the highest in the
 * table, so it orders rows across runs without trusting anyone's clock;
 * `recorded_at` is the server's time, for people.
 */
export const HISTORY_COLUMNS: readonly (readonly [name: string, type: string])[] = [
  ["seq", "UInt64"],
  ["run_id", "String"],
  ["kind", "LowCardinality(String)"],
  ["migration_id", "String"],
  ["parent", "String"],
  ["checksum", "String"],
  ["statement_index", "Int32"],
  ["statement_sha", "String"],
  ["status", "LowCardinality(String)"],
  ["error", "String"],
  ["applied_by", "String"],
  ["plan_digest", "String"],
  ["silences", "String DEFAULT '[]'"],
  ["note", "String"],
  ["recorded_at", "DateTime64(6, 'UTC') DEFAULT now64(6)"],
];

export interface HistoryDdlOptions {
  database: string;
  topology: HistoryTopology;
}

/** `CREATE DATABASE IF NOT EXISTS` for the history's database. */
export function databaseDdl({ database, topology }: HistoryDdlOptions): string {
  if (topology.kind === "replicated") {
    const cluster = topology.cluster ? ` ON CLUSTER ${ident(topology.cluster)}` : "";
    return `CREATE DATABASE IF NOT EXISTS ${ident(database)}${cluster} ENGINE = Replicated(${literal(`/clickhouse/databases/${database}`)}, '{shard}', '{replica}')`;
  }
  return `CREATE DATABASE IF NOT EXISTS ${ident(database)}${onCluster(topology)}`;
}

/** The history table's engine clause for a topology. */
export function historyEngine({ database, topology }: HistoryDdlOptions): string {
  switch (topology.kind) {
    case "cluster": {
      const path = topology.replicaPath ?? defaultReplicaPath(database, HISTORY_TABLE);
      const replica = topology.replicaName ?? DEFAULT_HISTORY_REPLICA_NAME;
      return `ReplicatedMergeTree(${literal(path)}, ${literal(replica)})`;
    }
    case "replicated":
      return "ReplicatedMergeTree";
    case "single":
    case "cloud":
      return "MergeTree";
  }
}

/** `CREATE TABLE IF NOT EXISTS <database>.history`. */
export function historyTableDdl(options: HistoryDdlOptions): string {
  const columns = HISTORY_COLUMNS.map(([name, type]) => `  ${name} ${type}`).join(",\n");
  return (
    `CREATE TABLE IF NOT EXISTS ${ident(options.database)}.${HISTORY_TABLE}${onCluster(options.topology)}\n(\n${columns}\n)\n` +
    `ENGINE = ${historyEngine(options)}\nORDER BY (migration_id, statement_index, seq)\n` +
    `COMMENT 'yodel migration history: append-only, one row per migration and per statement event'`
  );
}

/** The Keeper path of an environment's lock, under the server's `keeper_map_path_prefix`. */
export const lockKeeperPath = (database: string): string => `/yodeler/${database}/lock`;

/** `CREATE TABLE IF NOT EXISTS <database>.lock`, a KeeperMap. */
export function lockTableDdl(options: HistoryDdlOptions): string {
  return (
    `CREATE TABLE IF NOT EXISTS ${ident(options.database)}.${LOCK_TABLE}${onCluster(options.topology)}\n` +
    `(\n  name String,\n  owner String,\n  acquired_at DateTime64(3, 'UTC'),\n  expires_at DateTime64(3, 'UTC')\n)\n` +
    `ENGINE = KeeperMap(${literal(lockKeeperPath(options.database))})\nPRIMARY KEY name`
  );
}

/** Every statement that makes the history ready, in order: the database, then the table. */
export const historyDdl = (options: HistoryDdlOptions): string[] => [databaseDdl(options), historyTableDdl(options)];
