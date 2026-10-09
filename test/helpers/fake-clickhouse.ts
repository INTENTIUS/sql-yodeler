/**
 * An in-memory ClickHouse for the history's unit tests: it answers the
 * queries the history, the lock and the digest send, and records every
 * other statement as "sent", failing the ones a test asks it to.
 */

import type { ClickHousePort } from "../../src/history/index.js";
import { computeChecksum, serializeDocument, type Migration, type MigrationDocument } from "../../src/migrations/index.js";
import type { MigrationStep } from "@intentius/chant-lexicon-sql/migration-statements";

export class ServerError extends Error {
  constructor(readonly serverMessage: string) {
    super(serverMessage);
  }
}

export interface FakeTable {
  database: string;
  name: string;
  engine: string;
  create: string;
}

export class FakeClickHouse implements ClickHousePort {
  rows: Record<string, unknown>[] = [];
  historyExists = false;
  /** Statements sent that are not the history's or the lock's own. */
  sent: string[] = [];
  databases = [{ name: "yodel_8", engine: "Atomic" }];
  tables: FakeTable[] = [];
  /** A statement that fails while this returns a message. */
  failWith: (sql: string) => string | undefined = () => undefined;
  private clock = 0;

  query<Row = Record<string, unknown>>(sql: string): Promise<Row[]> {
    return Promise.resolve(this.answer(sql) as Row[]);
  }

  private answer(sql: string): unknown[] {
    if (sql.startsWith("CREATE DATABASE IF NOT EXISTS")) return [];
    if (/^CREATE TABLE IF NOT EXISTS \S+\.lock\b/.test(sql)) throw new ServerError("Code: 36. DB::Exception: KeeperMap is disabled because 'keeper_map_path_prefix' config is not defined. (BAD_ARGUMENTS)");
    if (/^CREATE TABLE IF NOT EXISTS \S+\.history\b/.test(sql)) {
      this.historyExists = true;
      return [];
    }
    if (sql.startsWith("SELECT count() AS n FROM system.tables")) return [{ n: this.historyExists ? 1 : 0 }];
    if (/^INSERT INTO \S+\.history FORMAT JSONEachRow\n/.test(sql)) {
      for (const line of sql.split("\n").slice(1)) {
        this.clock++;
        this.rows.push({ ...(JSON.parse(line) as Record<string, unknown>), recorded_at: `2026-10-09 12:00:00.${String(this.clock).padStart(6, "0")}` });
      }
      return [];
    }
    if (/^SELECT seq, .* FROM \S+\.history ORDER BY seq$/.test(sql)) return [...this.rows].sort((a, b) => Number(a.seq) - Number(b.seq));
    if (sql.startsWith("SELECT name, engine FROM system.databases")) return this.databases;
    if (sql.startsWith("SELECT database, name, engine, create_table_query AS create FROM system.tables")) {
      const inList = /database IN \(([^)]*)\)/.exec(sql)?.[1] ?? "";
      const names = [...inList.matchAll(/'([^']*)'/g)].map((m) => m[1]);
      return this.tables.filter((t) => names.includes(t.database));
    }
    const failure = this.failWith(sql);
    if (failure) throw new ServerError(failure);
    this.sent.push(sql);
    return [];
  }
}

const step = (sql: string, i: number): MigrationStep => ({
  kind: "statement",
  object: `t${String(i)}`,
  type: "ClickHouse::Table",
  name: `yodel_8.t${String(i)}`,
  sql,
  rule: "SQLCH100",
  class: "metadata",
  transactional: false,
});

/** A migration with these statements (or steps), as read from disk. */
export function migration(id: string, parent: string | null, statements: Array<string | MigrationStep>): Migration {
  const steps = statements.map((s, i) => (typeof s === "string" ? step(s, i) : s));
  const unsigned: MigrationDocument = {
    format: 1,
    id,
    parent,
    checksum: "",
    dialect: "clickhouse",
    refused: steps.some((s) => s.kind !== "statement"),
    hints: [],
    steps,
    schema: { dialect: "clickhouse", objects: [] },
  };
  const sql = `-- yodel migration ${id}\n\n${steps.map((s) => (s.kind === "statement" ? `${s.sql};` : `-- ${s.kind}`)).join("\n")}\n`;
  const document = { ...unsigned, checksum: computeChecksum({ sql, json: unsigned }) };
  return { id, dir: `/migrations/${id}`, parent, checksum: document.checksum, document, files: { sql, json: serializeDocument(document) } };
}

/** The same migration with its statements changed and its checksum recomputed: an edit after it ran. */
export function edited(m: Migration, statements: string[]): Migration {
  return migration(m.id, m.parent, statements);
}
