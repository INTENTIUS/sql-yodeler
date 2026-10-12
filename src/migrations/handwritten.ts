/**
 * Hand-written migrations (#248): `yodel new <name> --sql` writes a
 * migration whose `migration.sql` the person writes, for what the declared
 * schema does not say: data a migration carries (reference rows, a data
 * fix) and statements yodel would not write itself.
 *
 * `migration.json` marks it `"source": "sql"`. `migration.sql` is then the
 * source of its statements: `yodel lint --update-checksum <id>` splits it
 * with the dialect's splitter and records each statement as a step, so the
 * migration goes through the same chain, checksum, plan, approval, apply,
 * history and resume as one yodel wrote.
 *
 * The schema it records, which the next `yodel new` diffs from:
 *
 * - only data statements (INSERT, UPDATE, DELETE, MERGE, COPY, TRUNCATE;
 *   on ClickHouse also `ALTER TABLE ... UPDATE | DELETE`): its parent's
 *   recorded schema, unchanged;
 * - any other statement: the current build of `src/`. The person declares
 *   what the SQL does, and `yodel lint --replay` runs the chain and shows
 *   the SQL gives that schema, so a statement the declarations do not hold
 *   fails the pull request's lint job.
 *
 * Offline either way: recording reads no server.
 */

import type { StatementStep } from "@intentius/chant-lexicon-sql/migration-statements";
import type { BuildOutput } from "../chant/build.js";
import { YodelError, type SqlDialect } from "../project.js";
import { computeChecksum } from "./checksum.js";
import { emptyBuild, migrationId } from "./create.js";
import { MIGRATION_FORMAT, normalizeLineEndings, serializeDocument, type MigrationDocument, type MigrationFiles } from "./document.js";
import type { Migration } from "./directory.js";

/** `migration.json`'s `source` for a hand-written migration. */
export const HAND_WRITTEN = "sql";
/** The rule and class a hand-written statement is recorded with. */
export const HAND_RULE = "SQL";
export const HAND_CLASS = "hand-written";
/** The entity type a hand-written statement names. */
export const HAND_TYPE = "SQL::Statement";

export const isHandWritten = (doc: { source?: unknown } | Record<string, unknown>): boolean => (doc as { source?: unknown }).source === HAND_WRITTEN;

/** The text the empty migration.sql starts with; a migration.sql still holding it has not been written. */
export const HAND_TEMPLATE_MARK = "-- Write this migration's statements below";

/** migration.sql as `yodel new --sql` writes it: a header and no statements. */
export function handTemplate(doc: Pick<MigrationDocument, "id" | "parent">): string {
  return [
    `-- yodel migration ${doc.id}`,
    `-- parent: ${doc.parent ?? "none (the first migration)"}`,
    `-- hand-written: migration.sql is this migration's source.`,
    `${HAND_TEMPLATE_MARK}, each ending with ;`,
    `-- then record them with: yodel lint --update-checksum ${doc.id}`,
    `-- A statement that changes the schema needs the change declared in src/ too;`,
    `-- yodel lint --replay shows the statements give the declared schema.`,
    ``,
  ].join("\n");
}

/** The empty hand-written migration that follows `previous`. */
export function createHandWritten(options: { name: string; dialect: SqlDialect; previous?: Migration | undefined; now?: Date; defaultDatabase?: string; defaultSchema?: string }): { id: string; document: MigrationDocument; files: MigrationFiles } {
  const now = options.now ?? new Date();
  const id = migrationId(options.name, now);
  const schema: BuildOutput = options.previous?.document.schema ?? emptyBuild({ dialect: options.dialect, objects: [] });
  const unsigned: MigrationDocument & { source: string } = {
    format: MIGRATION_FORMAT,
    id,
    parent: options.previous?.id ?? null,
    checksum: "",
    createdAt: `${now.toISOString().slice(0, 19)}Z`,
    dialect: options.dialect,
    ...(options.dialect === "clickhouse" && options.defaultDatabase !== undefined ? { defaultDatabase: options.defaultDatabase } : {}),
    ...(options.dialect === "postgres" && options.defaultSchema !== undefined ? { defaultSchema: options.defaultSchema } : {}),
    source: HAND_WRITTEN,
    refused: false,
    hints: [],
    steps: [],
    schema,
  };
  const sql = handTemplate(unsigned);
  const document = { ...unsigned, checksum: computeChecksum({ sql, json: unsigned }) };
  return { id, document, files: { sql, json: serializeDocument(document) } };
}

/** `text` without the comment lines and blank lines before its first keyword. */
function withoutLeadingComments(text: string): string {
  const lines = text.split("\n");
  while (lines.length > 0 && /^\s*(--.*)?$/.test(lines[0] ?? "")) lines.shift();
  return lines.join("\n").trim();
}

/** The dialect's statement splitter: each statement's text, its leading comments left out. */
export async function splitHandSql(dialect: SqlDialect, sql: string): Promise<string[]> {
  if (dialect === "postgres") {
    const { splitStatements } = await import("@intentius/chant-lexicon-sql/postgres/apply/statements");
    return splitStatements(sql).map((s) => withoutLeadingComments(s.text)).filter((s) => s !== "");
  }
  const { splitStatements } = await import("@intentius/chant-lexicon-sql/clickhouse/import/ir");
  return splitStatements(sql).map(withoutLeadingComments).filter((s) => s !== "");
}

const lead = (sql: string): string => (/^\s*(?:WITH\b[\s\S]*?\)\s*)?([A-Za-z]+)/.exec(sql)?.[1] ?? "").toUpperCase();
const CH_MUTATION = /^\s*ALTER\s+TABLE\s+\S+(?:\s+ON\s+CLUSTER\s+\S+)?\s+(?:UPDATE|DELETE)\b/i;

/** Whether `sql` changes only rows: it leaves the schema as it was. */
export function isDataStatement(dialect: SqlDialect, sql: string): boolean {
  if (["INSERT", "UPDATE", "DELETE", "MERGE", "COPY", "TRUNCATE"].includes(lead(sql))) return true;
  return dialect === "clickhouse" && CH_MUTATION.test(sql);
}

/** Removes every row, or the rows nothing limits: TRUNCATE, and DELETE with no WHERE. */
function removesAllRows(sql: string): boolean {
  const l = lead(sql);
  if (l === "TRUNCATE") return true;
  return l === "DELETE" && !/\bWHERE\b/i.test(sql);
}

/** The first line of `sql`, short enough to name the statement in output. */
const summary = (sql: string): string => {
  const line = (sql.split("\n")[0] ?? "").trim();
  return line.length > 72 ? `${line.slice(0, 69)}...` : line;
};

/** Each statement as the step yodel apply runs. */
export function handSteps(dialect: SqlDialect, statements: readonly string[]): StatementStep[] {
  return statements.map((sql, i) => {
    const pgOutside = dialect === "postgres" && (/\bCONCURRENTLY\b/i.test(sql) || /^\s*ALTER\s+TYPE\b[\s\S]*\bADD\s+VALUE\b/i.test(sql) || lead(sql) === "VACUUM");
    return {
      kind: "statement",
      object: `sql-${String(i)}`,
      type: HAND_TYPE,
      name: summary(sql),
      sql,
      rule: HAND_RULE,
      class: HAND_CLASS,
      transactional: dialect === "postgres" && !pgOutside,
      ...(dialect === "clickhouse" && CH_MUTATION.test(sql) ? { waitsForMutation: true } : {}),
      ...(removesAllRows(sql) ? { destructive: true } : {}),
    };
  });
}

export interface RecordedHandWritten {
  document: MigrationDocument;
  statements: number;
  /** Whether a statement changes the schema, so the recorded schema is the build's. */
  changesSchema: boolean;
}

/**
 * `m` with its statements read from migration.sql and its schema recorded
 * (see the module comment). `build` is the current build, needed only when
 * a statement changes the schema; `parentSchema` is the parent's recorded
 * schema (undefined for the first migration).
 */
export async function recordHandWritten(m: Migration, parentSchema: BuildOutput | undefined, build: () => Promise<BuildOutput>): Promise<RecordedHandWritten> {
  const dialect = m.document.dialect;
  const sql = normalizeLineEndings(m.files.sql);
  if (sql.includes(HAND_TEMPLATE_MARK) && (await splitHandSql(dialect, sql)).length === 0) {
    throw new YodelError(`${m.id}: migration.sql holds no statements yet; write them, each ending with ;, then run yodel lint --update-checksum ${m.id} again`);
  }
  const statements = await splitHandSql(dialect, sql);
  if (statements.length === 0) throw new YodelError(`${m.id}: migration.sql holds no statements; write them, each ending with ;`);
  let cursor = 0;
  for (const s of statements) {
    const at = sql.indexOf(`${s};`, cursor);
    if (at === -1) throw new YodelError(`${m.id}: end each statement in migration.sql with ; (the statement starting "${summary(s)}" has none)`);
    cursor = at + s.length + 1;
  }
  const changesSchema = statements.some((s) => !isDataStatement(dialect, s));
  const schema = changesSchema ? await build() : (parentSchema ?? emptyBuild({ dialect, objects: [] }));
  const document: MigrationDocument = { ...m.document, refused: false, steps: handSteps(dialect, statements), schema };
  return { document, statements: statements.length, changesSchema };
}
