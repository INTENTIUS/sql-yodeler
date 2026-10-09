/**
 * The Postgres history (#13): `<schema>.history` (default `yodeler.history`),
 * the same rows as ClickHouse's, and the session advisory lock.
 *
 *   pgHistoryDdl(schema)                     CREATE SCHEMA / TABLE
 *   new PostgresHistoryStore(client, {schema}) exists(), ensure(), rows(), state(), append(rows)
 *   acquireAdvisoryLock(conn, {schema, holder}) the apply lock, on a connection of its own
 *   lockKeys(schema)                          the lock's two keys
 */

export * from "./ddl.js";
export * from "./lock.js";
export * from "./store.js";
