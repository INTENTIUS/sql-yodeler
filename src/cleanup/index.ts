/**
 * What steps leave behind on purpose, and dropping it once its retention
 * date has passed (`yodel cleanup <env>`).
 *
 * Two kinds of object are kept after a step succeeds, each until a date
 * written in its own comment (chant's trailer, `role=old retain-until=...`):
 *
 * - a ClickHouse rebuild's old table, `<table>__chant_old`, kept after the
 *   swap (`rebuild=<db.table>` in its trailer);
 * - a Postgres column migration's old column, kept after the switch when
 *   the step set `retain` (`migration=<schema.table.column>`), with, for a
 *   rename, the trigger and function that keep it written.
 *
 * {@link findRetained} lists them in the environment's databases (or
 * schemas) with the server's clock; one whose date has passed is due. The
 * due ones, by their identity on the server (a table's UUID, a column's
 * table oid and attribute number) and their dates, are what the
 * {@link cleanupDigest} covers, so an approval of it covers exactly them.
 * {@link dropRetained} drops them; nothing is ever dropped before its date.
 */

import type { Topology } from "@intentius/chant-lexicon-sql/clickhouse/topology";
import type { ClickHousePort } from "../history/index.js";
import type { PgClient } from "../history/postgres/index.js";
import { renderForEnvironment } from "../topology/render.js";
import { YodelError } from "../project.js";
import type { VersionedEnv } from "../versioned/engine.js";

/** Something a step kept, and until when. */
export interface Retained {
  kind: "table" | "column";
  /** `db.table__chant_old`, or `schema.table.column`. */
  name: string;
  /** The rebuild (`db.table`) or column migration (`schema.table.column`) it was kept by. */
  of: string;
  /** When it may be dropped (ISO 8601), as its comment says; undefined when its comment has no date, and then it is never due. */
  retainUntil?: string;
  /** The date has passed, by the server's clock. */
  due: boolean;
  /** What identifies it on the server: the table's UUID, or the column's table oid and attribute number. */
  identity: string;
  /** Postgres: the dual-write trigger and its function still there, dropped with the column. */
  trigger?: { name: string; fn: string };
  /** Postgres: the stack and environment in the column's marker, which address the migration's receipts. */
  marker?: { stack?: string; env?: string };
}

/** Where to look, and how to reach it. */
export type RetainedServer =
  | { dialect: "clickhouse"; port: ClickHousePort; databases: readonly string[] | undefined; topology?: Topology | undefined }
  | { dialect: "postgres"; client: PgClient; schemas: readonly string[] | undefined; lockTimeoutMs: number };

/** The server a cleanup reads and drops on: the environment's, as its versioned apply reaches it. */
export function retainedServer(venv: VersionedEnv): RetainedServer {
  if (venv.dialect === "clickhouse") {
    if (!venv.port) throw new YodelError(`${venv.environment} has no ClickHouse server to read`);
    return { dialect: "clickhouse", port: venv.port, databases: venv.scope.databases, topology: venv.topology };
  }
  const ctx = venv.driver.stepContext();
  if (!ctx.postgres) throw new YodelError(`${venv.environment} has no Postgres connection to read`);
  return { dialect: "postgres", client: ctx.postgres.client, schemas: venv.scope.databases, lockTimeoutMs: ctx.lockTimeoutMs ?? ctx.postgres.timeouts.lockTimeoutMs };
}

/**
 * The line `yodel plan` adds when steps kept something: each object and
 * its date, and that `yodel cleanup <env>` drops it after that date.
 * Undefined when nothing is kept, or the server could not be read for it.
 */
export async function retainedNote(venv: VersionedEnv): Promise<string | undefined> {
  try {
    const { retained } = await findRetained(retainedServer(venv));
    if (retained.length === 0) return undefined;
    const due = retained.filter((r) => r.due).length;
    return (
      `Kept by earlier steps, until their retention date: ${retained.map((r) => `${r.name} (${r.retainUntil === undefined ? "no date" : `until ${r.retainUntil}${r.due ? ", due" : ""}`})`).join("; ")}. ` +
      (due > 0 ? `yodel cleanup ${venv.environment} drops the ${String(due)} due, behind an approval; nothing is dropped before its date.` : `yodel cleanup ${venv.environment} drops each after its date, behind an approval.`)
    );
  } catch {
    return undefined;
  }
}

const SYSTEM_DATABASES = ["system", "INFORMATION_SCHEMA", "information_schema"];
const SYSTEM_SCHEMAS = ["pg_catalog", "information_schema", "pg_toast"];

const sqlString = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
const pgIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;
const chIdent = (s: string) => `\`${s.replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\``;

async function trailer(comment: string | null | undefined): Promise<Map<string, string> | undefined> {
  const { readTrailerPairs } = await import("@intentius/chant-lexicon-sql/core/ownership");
  return readTrailerPairs(comment ?? undefined);
}

const due = (retainUntil: string | undefined, now: number) => retainUntil !== undefined && Number.isFinite(Date.parse(retainUntil)) && now >= Date.parse(retainUntil);

/** Every object a step kept in the server's databases (or schemas), with whether it is due, oldest date first. */
export async function findRetained(server: RetainedServer): Promise<{ now: string; retained: Retained[] }> {
  const found = server.dialect === "clickhouse" ? await clickhouseRetained(server) : await postgresRetained(server);
  const key = (r: Retained) => r.retainUntil ?? "9999";
  found.retained.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.name < b.name ? -1 : 1));
  return found;
}

async function clickhouseRetained(server: Extract<RetainedServer, { dialect: "clickhouse" }>): Promise<{ now: string; retained: Retained[] }> {
  const [clock] = await server.port.query<{ now: string | number }>("SELECT toUnixTimestamp64Milli(now64(3)) AS now");
  const now = Number(clock?.now ?? Date.now());
  const where = server.databases && server.databases.length > 0 ? `database IN (${server.databases.map(sqlString).join(", ")})` : `database NOT IN (${SYSTEM_DATABASES.map(sqlString).join(", ")})`;
  const rows = await server.port.query<{ database: string; name: string; uuid: string; comment: string }>(
    `SELECT database, name, toString(uuid) AS uuid, comment FROM system.tables WHERE ${where} AND endsWith(name, '__chant_old') ORDER BY database, name`,
  );
  const retained: Retained[] = [];
  for (const r of rows) {
    const pairs = await trailer(r.comment);
    const of = pairs?.get("rebuild");
    if (!of || pairs?.get("role") !== "old") continue;
    const retainUntil = pairs.get("retain-until");
    retained.push({ kind: "table", name: `${r.database}.${r.name}`, of, ...(retainUntil ? { retainUntil } : {}), due: due(retainUntil, now), identity: r.uuid });
  }
  return { now: new Date(now).toISOString(), retained };
}

async function postgresRetained(server: Extract<RetainedServer, { dialect: "postgres" }>): Promise<{ now: string; retained: Retained[] }> {
  const { migrationNames } = await import("@intentius/chant-lexicon-sql/postgres/migrate/names");
  const [clock] = await server.client.query<{ now: string }>("SELECT (extract(epoch FROM pg_catalog.clock_timestamp()) * 1000)::bigint::text AS now");
  const now = Number(clock?.now ?? Date.now());
  const inScope = server.schemas && server.schemas.length > 0;
  const rows = await server.client.query<{ schema: string; table: string; oid: string; column: string; attnum: string; comment: string }>(
    `SELECT n.nspname AS schema, c.relname AS table, c.oid::text AS oid, a.attname AS column, a.attnum::text AS attnum, pg_catalog.col_description(a.attrelid, a.attnum) AS comment
       FROM pg_catalog.pg_attribute a
       JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p')
        AND ${inScope ? "n.nspname = ANY($1::text[])" : "NOT (n.nspname = ANY($1::text[]))"}
        AND pg_catalog.col_description(a.attrelid, a.attnum) LIKE '%role=old%'
      ORDER BY 1, 2, 4`,
    [inScope ? server.schemas : SYSTEM_SCHEMAS],
  );
  const retained: Retained[] = [];
  for (const r of rows) {
    const pairs = await trailer(r.comment);
    const of = pairs?.get("migration");
    if (!of || pairs?.get("role") !== "old") continue;
    const retainUntil = pairs.get("retain-until");
    // The trigger and function are named after the declared column, the key's last part.
    const column = of.slice(of.lastIndexOf(".") + 1);
    const n = migrationNames(r.schema, r.table, column, "rename", r.column);
    const [trig] = await server.client.query<{ comment: string | null }>("SELECT pg_catalog.obj_description(t.oid, 'pg_trigger') AS comment FROM pg_catalog.pg_trigger t WHERE t.tgrelid = $1::oid AND t.tgname = $2", [r.oid, n.trigger]);
    const [fn] = await server.client.query<{ comment: string | null }>(
      "SELECT pg_catalog.obj_description(p.oid, 'pg_proc') AS comment FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = $1 AND p.proname = $2 AND p.pronargs = 0",
      [r.schema, n.fn],
    );
    const ours = async (comment: string | null | undefined) => (await trailer(comment))?.get("migration") === of;
    const trigger = trig && fn && (await ours(trig.comment)) && (await ours(fn.comment)) ? { name: n.trigger, fn: n.fn } : undefined;
    const { readMarker } = await import("@intentius/chant-lexicon-sql/core/ownership");
    const m = readMarker(r.comment);
    const marker = { ...(m?.stack ? { stack: m.stack } : {}), ...(m?.env ? { env: m.env } : {}) };
    retained.push({
      kind: "column",
      name: `${r.schema}.${r.table}.${r.column}`,
      of,
      ...(retainUntil ? { retainUntil } : {}),
      due: due(retainUntil, now),
      identity: `${r.oid}:${r.attnum}`,
      ...(trigger ? { trigger } : {}),
      marker,
    });
  }
  return { now: new Date(now).toISOString(), retained };
}

/** The digest an approval of a cleanup binds: the environment and every due object, by its identity and date. */
export async function cleanupDigest(environment: string, retained: readonly Retained[]): Promise<string> {
  const { computePlanDigest } = await import("@intentius/chant/op");
  const drop = retained.filter((r) => r.due).map((r) => ({ kind: r.kind, name: r.name, of: r.of, identity: r.identity, retainUntil: r.retainUntil ?? null, trigger: r.trigger ?? null }));
  return computePlanDigest("yodel-cleanup", { environment, drop });
}

/** The statements that drop one due object. */
export function dropStatements(r: Retained, topology?: Topology): string[] {
  if (r.kind === "table") {
    const at = r.name.indexOf(".");
    const sql = `DROP TABLE ${chIdent(r.name.slice(0, at))}.${chIdent(r.name.slice(at + 1))} SYNC`;
    return [topology ? renderForEnvironment(sql, topology) : sql];
  }
  const [schema, table, column] = splitColumn(r.name);
  const qualified = `${pgIdent(schema)}.${pgIdent(table)}`;
  return [
    ...(r.trigger ? [`DROP TRIGGER ${pgIdent(r.trigger.name)} ON ${qualified}`, `DROP FUNCTION ${pgIdent(schema)}.${pgIdent(r.trigger.fn)}()`] : []),
    `ALTER TABLE ${qualified} DROP COLUMN ${pgIdent(column)}`,
  ];
}

/** `schema.table.column`, split at its first two dots (names with dots of their own are not chant's migrations' keys). */
function splitColumn(name: string): [string, string, string] {
  const a = name.indexOf(".");
  const b = name.indexOf(".", a + 1);
  return [name.slice(0, a), name.slice(a + 1, b), name.slice(b + 1)];
}

/**
 * Drops each due object: a ClickHouse table with `DROP TABLE ... SYNC`; a
 * Postgres column (and a rename's trigger and function) in one transaction
 * under the lock timeout, then the column migration's receipts. Objects
 * not due are skipped. Returns the names dropped.
 */
export async function dropRetained(server: RetainedServer, retained: readonly Retained[], log: (line: string) => void): Promise<string[]> {
  const dropped: string[] = [];
  for (const r of retained.filter((x) => x.due)) {
    if (server.dialect === "clickhouse") {
      for (const sql of dropStatements(r, server.topology)) {
        log(sql);
        await server.port.query(sql, { settings: { distributed_ddl_output_mode: "throw_only_active" } });
      }
    } else {
      const { client } = server;
      await client.query("BEGIN");
      try {
        await client.query(`SET LOCAL lock_timeout = '${String(Math.max(0, Math.floor(server.lockTimeoutMs)))}ms'`);
        for (const sql of dropStatements(r)) {
          log(sql);
          await client.query(sql);
        }
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw e;
      }
      await forgetReceipts(client, r);
    }
    dropped.push(r.name);
  }
  return dropped;
}

/** A column migration's backfill receipts, in its table's schema: gone with the column, as the Op's own contract does, so a later migration of the same column starts afresh. */
async function forgetReceipts(client: PgClient, r: Retained): Promise<void> {
  const { postgresReceiptStore } = await import("@intentius/chant-lexicon-sql/postgres/migrate/receipts");
  const { batchPrefix } = await import("@intentius/chant-lexicon-sql/postgres/migrate/steps");
  const [schema] = splitColumn(r.name);
  const identity = r.marker ?? {};
  const store = postgresReceiptStore({ query: <T>(sql: string, params?: readonly unknown[]) => client.query<T>(sql, params) } as never, schema, identity);
  await store.forget(batchPrefix(identity, r.of));
}

/** One line for each retained object: what it is, until when, and whether cleanup drops it now. */
export function describeRetained(r: Retained): string {
  const what = r.kind === "table" ? `${r.name} (the old table of the rebuild of ${r.of})` : `${r.name} (the old column of ${r.of}${r.trigger ? `, with its trigger ${r.trigger.name}` : ""})`;
  if (r.retainUntil === undefined) return `${what}: no retention date in its comment, never dropped by yodel cleanup`;
  return r.due ? `${what}: kept until ${r.retainUntil}, due` : `${what}: kept until ${r.retainUntil}`;
}
