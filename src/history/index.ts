/**
 * The migration history (#8): an append-only ClickHouse table in the
 * database the environment names (default `yodeler`), and the apply lock.
 *
 *   historyDdl({ database, topology })     CREATE DATABASE / TABLE for single, cluster, replicated, cloud
 *   lockTableDdl({ database, topology })   the KeeperMap lock table
 *   new HistoryStore(port, location)       exists(), ensure(), rows(), state(), append(rows)
 *   new HistoryRecorder(store, run, maxSeq) record(row): appends with the next seq
 *   deriveState(rows)                      the latest row per migration and per statement
 *   isApplied(record), statementDone(record, i)
 *   acquireLock(port, options), withLock(lock, ttl, body)
 *   parseHistoryTopology("cluster:main")
 *
 * Rows are never updated or deleted; a state is always the row with the
 * highest seq for its key. #10 (`init --from` records a baseline), #12 (Op
 * steps record their receipts' progress), #13 (the Postgres twin), #15
 * (`repair` appends a migration row with the new checksum and a `note`) and
 * #16 (the digest) build on this.
 */

export * from "./client.js";
export * from "./ddl.js";
export * from "./lock.js";
export * from "./rows.js";
export * from "./store.js";
export * from "./topology.js";
