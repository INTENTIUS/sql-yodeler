/**
 * A file of DDL, as an ORM prints it (Prisma's `migrate diff --script`,
 * Drizzle's `generate`, Django's `sqlmigrate`, SQLAlchemy's `CreateTable`),
 * read with the sql lexicon's own parsers and written out as declarations:
 * one TypeScript file of `table`, `index`, `view`, ... templates, the same
 * file `chant import` writes. The build then treats them like any other
 * declaration in `src/`.
 *
 * What is read:
 *
 * - Postgres: `CREATE SCHEMA`, `TABLE`, `INDEX`, `VIEW`, `MATERIALIZED VIEW`,
 *   `SEQUENCE`, `TYPE ... AS ENUM`, `DOMAIN`, `EXTENSION` and `COMMENT ON`,
 *   each parsed by the lexicon's Postgres parser. `ALTER TABLE <t> ADD
 *   [CONSTRAINT <c>] FOREIGN KEY | UNIQUE | PRIMARY KEY | CHECK ...`, the
 *   form ORMs print foreign keys in, is folded into `<t>`'s CREATE TABLE as
 *   a table constraint. `BEGIN` and `COMMIT` are skipped.
 * - ClickHouse: `CREATE DATABASE`, `TABLE`, `VIEW` and `MATERIALIZED VIEW`,
 *   as `chant import <file>.sql` reads them.
 *
 * Any other statement is an error naming it: a statement left out would be
 * a schema yodel does not manage, silently.
 *
 * `schema` (a Postgres schema, a ClickHouse database) qualifies the names
 * the DDL leaves unqualified, as an ORM does when the schema comes from its
 * connection: on Postgres an object's own name, an index's table, a foreign
 * key's table and a column type naming an enum or domain the file creates;
 * on ClickHouse an object's own name.
 */

import type { TemplateIR } from "@intentius/chant/import/parser";
import type { Token } from "@intentius/chant-lexicon-sql/core/tokens";
import type { StatementNode, NameNode } from "@intentius/chant-lexicon-sql/postgres/parser";
import { YodelError, type SqlDialect } from "../project.js";

export interface DdlOptions {
  /** Qualifies unqualified names (a Postgres schema, a ClickHouse database). */
  schema?: string | undefined;
  /** Comment lines at the top of the generated file. */
  header?: string | undefined;
  /** Names the DDL in errors. */
  origin: string;
}

/** One object the DDL creates. */
export interface DdlObject {
  /** The export it is declared as. */
  export: string;
  /** Its entity type, `Postgres::Table`. */
  type: string;
  /** `schema.name` (Postgres), `database.name` (ClickHouse). */
  name: string;
}

export interface Declarations {
  /** The TypeScript file's content. */
  content: string;
  objects: DdlObject[];
}

const isTrivia = (t: Token): boolean => t.kind === "ws" || t.kind === "comment";
const isName = (t: Token | undefined): boolean => t !== undefined && (t.kind === "ident" || t.kind === "qident");
const word = (t: Token | undefined, ...words: string[]): boolean => t !== undefined && t.kind === "ident" && words.includes(t.text.toUpperCase());

/** A name as SQL text: bare when it is a plain lower-case identifier, else double-quoted. */
const quoteIdent = (name: string): string => (/^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`);

/** The statements of a file, each as its tokens (trivia kept inside, trimmed at the ends), split on top-level `;`. */
function splitTokens(tokens: readonly Token[]): Token[][] {
  const out: Token[][] = [];
  let current: Token[] = [];
  const flush = () => {
    let from = 0;
    let to = current.length;
    const trivia = (i: number) => {
      const t = current[i];
      return t !== undefined && isTrivia(t);
    };
    while (from < to && trivia(from)) from++;
    while (to > from && trivia(to - 1)) to--;
    if (to > from) out.push(current.slice(from, to));
    current = [];
  };
  for (const t of tokens) {
    if (t.kind === "punct" && t.text === ";") flush();
    else current.push(t);
  }
  flush();
  return out;
}

const text = (tokens: readonly Token[]): string => tokens.map((t) => t.text).join("");
const firstLine = (s: string): string => (s.split("\n")[0] ?? "").slice(0, 100);

/** Turns a file of DDL into declarations. */
export async function ddlToDeclarations(dialect: SqlDialect, ddl: string, options: DdlOptions): Promise<Declarations> {
  const ir = dialect === "postgres" ? await postgresIR(ddl, options) : await clickhouseIR(ddl, options);
  if (ir.resources.length === 0) throw new YodelError(`${options.origin}: the DDL creates no objects`);
  const files =
    dialect === "postgres"
      ? new (await import("@intentius/chant-lexicon-sql/postgres/import/generator")).PostgresGenerator(options.header).generate(ir)
      : new (await import("@intentius/chant-lexicon-sql/clickhouse/import/generator")).ClickHouseGenerator(options.header).generate(ir);
  const [file] = files;
  if (!file || files.length !== 1) throw new YodelError(`${options.origin}: the lexicon's generator wrote ${String(files.length)} files, expected one`);
  return {
    content: file.content,
    objects: ir.resources.map((r) => {
      const p = r.properties as { schema?: string; database?: string; name: string };
      const qualifier = p.schema ?? p.database;
      return { export: r.logicalId, type: r.type, name: qualifier ? `${qualifier}.${p.name}` : p.name };
    }),
  };
}

// ---------- ClickHouse ----------

async function clickhouseIR(ddl: string, options: DdlOptions): Promise<TemplateIR> {
  const { tokenizeText } = await import("@intentius/chant-lexicon-sql/clickhouse/tokens");
  const { parseCreate } = await import("@intentius/chant-lexicon-sql/clickhouse/parser");
  const { describeStatement, objectsToIR } = await import("@intentius/chant-lexicon-sql/clickhouse/import/ir");
  const objects: Array<ReturnType<typeof describeStatement>> = [];
  const problems: string[] = [];
  for (const stmt of splitTokens(tokenizeText(ddl, 0))) {
    let sql = text(stmt);
    if (!/^CREATE\b/i.test(sql)) {
      problems.push(`not a CREATE statement: ${firstLine(sql)}`);
      continue;
    }
    try {
      const tokens = tokenizeText(sql, 0);
      const node = parseCreate(tokens);
      const name = tokens.slice(node.name.from, node.name.to).filter((t) => !isTrivia(t));
      const [only] = name;
      if (options.schema && node.statement !== "database" && only && name.length === 1) {
        const at = tokens.indexOf(only);
        sql = text(tokens.slice(0, at)) + `${quoteIdent(options.schema)}.` + text(tokens.slice(at));
      }
      objects.push(describeStatement(sql));
    } catch (e) {
      problems.push(`does not parse (${e instanceof Error ? e.message : String(e)}): ${firstLine(sql)}`);
    }
  }
  if (problems.length > 0) throw ddlError(options.origin, problems);
  return objectsToIR(objects);
}

// ---------- Postgres ----------

const PG_TYPE: Record<string, string> = {
  schema: "Postgres::Schema",
  table: "Postgres::Table",
  index: "Postgres::Index",
  view: "Postgres::View",
  sequence: "Postgres::Sequence",
  enum: "Postgres::Enum",
  domain: "Postgres::Domain",
  extension: "Postgres::Extension",
};

interface PgObject {
  type: string;
  schema?: string;
  name: string;
  /** The CREATE's tokens, then each COMMENT ON's. */
  statements: Token[][];
  /** Table constraints folded in from ALTER TABLE ... ADD, as SQL text. */
  constraints: string[];
}

function ddlError(origin: string, problems: string[]): YodelError {
  return new YodelError(
    `${origin}: ${String(problems.length)} statement(s) yodel cannot read as declarations:\n${problems.map((p) => `  - ${p}`).join("\n")}\n` +
      `A DDL source holds CREATE statements (and, on Postgres, COMMENT ON and ALTER TABLE ... ADD of a table constraint).`,
  );
}

async function postgresIR(ddl: string, options: DdlOptions): Promise<TemplateIR> {
  const { tokenizeText } = await import("@intentius/chant-lexicon-sql/postgres/tokens");
  const { parseStatements, identValue } = await import("@intentius/chant-lexicon-sql/postgres/parser");
  const { objectsToIR } = await import("@intentius/chant-lexicon-sql/postgres/import/ir");

  const problems: string[] = [];
  const parsed: Array<{ tokens: Token[]; node: StatementNode }> = [];
  const alters: Array<{ table: string[]; constraint: string; sql: string }> = [];
  for (const stmt of splitTokens(tokenizeText(ddl, 0))) {
    const sig = stmt.filter((t) => !isTrivia(t));
    const sql = text(stmt);
    if (sig.length === 1 && word(sig[0], "BEGIN", "COMMIT")) continue;
    if (word(sig[0], "ALTER") && word(sig[1], "TABLE")) {
      const alter = readAlterAdd(stmt, sig, identValue);
      if (alter) alters.push({ ...alter, sql });
      else problems.push(`an ALTER TABLE other than ADD of a table constraint: ${firstLine(sql)}`);
      continue;
    }
    if (!word(sig[0], "CREATE", "COMMENT")) {
      problems.push(`not a CREATE statement: ${firstLine(sql)}`);
      continue;
    }
    try {
      const tokens = tokenizeText(sql, 0);
      const nodes = parseStatements(tokens);
      for (const node of nodes) parsed.push({ tokens, node });
    } catch (e) {
      problems.push(`does not parse (${e instanceof Error ? e.message : String(e)}): ${firstLine(sql)}`);
    }
  }
  if (problems.length > 0) throw ddlError(options.origin, problems);

  const nameOf = (tokens: Token[], n: NameNode): string[] => n.pieces.length > 0 ? n.pieces : tokens.slice(n.span.from, n.span.to).filter((t) => isName(t)).map((t) => identValue(t));
  const qualify = (pieces: readonly string[]): { schema?: string; name: string } => {
    const name = pieces[pieces.length - 1] ?? "";
    const schema = pieces.length >= 2 ? pieces[pieces.length - 2] : options.schema;
    return schema ? { schema, name } : { name };
  };
  const key = (q: { schema?: string; name: string }) => `${q.schema ?? ""}.${q.name}`;

  // The types the file creates, so a column of one is qualified with the rest.
  const fileTypes = new Set<string>();
  for (const { tokens, node } of parsed) {
    if (node.statement === "enum" || node.statement === "domain") {
      const pieces = nameOf(tokens, node.name);
      const [only] = pieces;
      if (only !== undefined && pieces.length === 1) fileTypes.add(only);
    }
  }

  const objects: PgObject[] = [];
  const byName = new Map<string, PgObject>();
  for (const { tokens, node } of parsed) {
    const inserts = new Set<number>();
    /** Qualifies an unqualified name in the statement, when `schema` is set. */
    const mark = (n: NameNode | undefined) => {
      if (!n || !options.schema) return;
      const names = tokens.slice(n.span.from, n.span.to).filter((t) => !isTrivia(t));
      const [only] = names;
      if (only && names.length === 1 && isName(only)) inserts.add(tokens.indexOf(only));
    };
    if (node.statement === "comment") {
      const target = qualify(nameOf(tokens, node.objectType === "COLUMN" ? { ...node.target, pieces: nameOf(tokens, node.target).slice(0, -1) } : node.target));
      const owner = byName.get(key(target));
      if (!owner) {
        problems.push(`COMMENT ON ${node.objectType} for an object the file does not create: ${firstLine(text(tokens))}`);
        continue;
      }
      if (node.objectType !== "COLUMN" || nameOf(tokens, node.target).length < 3) mark(node.target);
      owner.statements.push(rewrite(tokens, inserts, options.schema));
      continue;
    }
    if (node.statement === "policy" || node.statement === "role" || node.statement === "grant" || node.statement === "rowSecurity") {
      problems.push(`access control (a policy, role, grant or row security) is not read from a DDL source: ${firstLine(text(tokens))}`);
      continue;
    }
    if (node.statement === "index") {
      if (!node.name) {
        problems.push(`an index with no name (the declaration needs one): ${firstLine(text(tokens))}`);
        continue;
      }
      mark(node.table);
    } else if (node.statement === "table") {
      for (const c of [...node.columns.flatMap((col) => col.constraints), ...node.constraints]) mark(c.references?.table);
      if (options.schema) {
        for (const col of node.columns) {
          if (!col.type) continue;
          const type = tokens.slice(col.type.from, col.type.to).filter((t) => !isTrivia(t));
          const first = type[0];
          if (first && isName(first) && fileTypes.has(identValue(first)) && !(type[1]?.kind === "punct" && type[1].text === ".")) inserts.add(tokens.indexOf(first));
        }
      }
    } else if (node.statement === "schema" && !node.name) {
      problems.push(`a CREATE SCHEMA with no name: ${firstLine(text(tokens))}`);
      continue;
    }
    // An index takes its table's schema: its own name is never qualified.
    if (node.statement !== "schema" && node.statement !== "extension" && node.statement !== "index") mark(node.name);
    const pieces = node.name ? nameOf(tokens, node.name) : [];
    const q = node.statement === "schema" || node.statement === "extension" ? { name: pieces[pieces.length - 1] ?? "" } : node.statement === "index" ? qualify([...nameOf(tokens, node.table).slice(0, -1), pieces[pieces.length - 1] ?? ""]) : qualify(pieces);
    const type = node.statement === "view" && node.materialized ? "Postgres::MaterializedView" : (PG_TYPE[node.statement] ?? node.statement);
    const object: PgObject = { type, ...q, statements: [rewrite(tokens, inserts, options.schema)], constraints: [] };
    objects.push(object);
    if (node.statement !== "index") byName.set(key(q), object);
  }

  for (const alter of alters) {
    const table = byName.get(key(qualify(alter.table)));
    if (!table || table.type !== "Postgres::Table") {
      problems.push(`ALTER TABLE of a table the file does not create: ${firstLine(alter.sql)}`);
      continue;
    }
    table.constraints.push(await qualifyConstraint(alter.constraint, options.schema));
  }
  if (problems.length > 0) throw ddlError(options.origin, problems);

  return objectsToIR(
    objects.map((o) => {
      const [create = [], ...comments] = o.statements;
      const ddl = [o.constraints.length > 0 ? addConstraints(create, o.constraints) : text(create), ...comments.map((c) => text(c))].join(";\n");
      return { type: o.type as never, ...(o.schema ? { schema: o.schema } : {}), name: o.name, ddl };
    }),
  );
}

/** The statement's tokens with `schema.` inserted before each marked one. */
function rewrite(tokens: readonly Token[], inserts: ReadonlySet<number>, schema: string | undefined): Token[] {
  if (!schema || inserts.size === 0) return [...tokens];
  const out: Token[] = [];
  tokens.forEach((t, i) => {
    if (inserts.has(i)) out.push({ kind: "ident", text: `${quoteIdent(schema)}.`, part: 0, start: 0, end: 0 });
    out.push(t);
  });
  return out;
}

/** `ALTER TABLE [ONLY] [IF EXISTS] <name> ADD <table constraint>`: the table's name pieces and the constraint's text. */
function readAlterAdd(stmt: readonly Token[], sig: readonly Token[], identValue: (t: Token) => string): { table: string[]; constraint: string } | undefined {
  let i = 2;
  if (word(sig[i], "IF") && word(sig[i + 1], "EXISTS")) i += 2;
  if (word(sig[i], "ONLY")) i++;
  const table: string[] = [];
  for (let t = sig[i]; t && isName(t); t = sig[i]) {
    table.push(identValue(t));
    i++;
    const dot = sig[i];
    if (dot?.kind === "punct" && dot.text === ".") i++;
    else break;
  }
  if (table.length === 0 || !word(sig[i], "ADD")) return undefined;
  i++;
  if (!word(sig[i], "CONSTRAINT", "FOREIGN", "UNIQUE", "PRIMARY", "CHECK", "EXCLUDE")) return undefined;
  // One constraint: a comma at depth 0 starts another ALTER action, which is not read.
  let depth = 0;
  for (const t of sig.slice(i)) {
    if (t.kind === "punct" && t.text === "(") depth++;
    else if (t.kind === "punct" && t.text === ")") depth--;
    else if (t.kind === "punct" && t.text === "," && depth === 0) return undefined;
  }
  const start = sig[i];
  return start ? { table, constraint: text(stmt.slice(stmt.indexOf(start))) } : undefined;
}

/** Qualifies the table a folded FOREIGN KEY references, when it is unqualified. */
async function qualifyConstraint(constraint: string, schema: string | undefined): Promise<string> {
  if (!schema) return constraint;
  const { tokenizeText } = await import("@intentius/chant-lexicon-sql/postgres/tokens");
  const tokens = tokenizeText(constraint, 0);
  const sig = tokens.map((t, i) => ({ t, i })).filter((x) => !isTrivia(x.t));
  const inserts = new Set<number>();
  sig.forEach((x, k) => {
    const target = sig[k + 1];
    const dot = sig[k + 2]?.t;
    if (word(x.t, "REFERENCES") && target && isName(target.t) && !(dot?.kind === "punct" && dot.text === ".")) inserts.add(target.i);
  });
  return text(rewrite(tokens, inserts, schema));
}

/** A CREATE TABLE with table constraints added at the end of its column list (the `)` matching the first `(`). */
function addConstraints(create: readonly Token[], constraints: readonly string[]): string {
  let depth = 0;
  const close = create.findIndex((t) => {
    if (t.kind !== "punct") return false;
    if (t.text === "(") depth++;
    else if (t.text === ")") return --depth === 0;
    return false;
  });
  if (close < 0) return text(create);
  const before = text(create.slice(0, close)).replace(/\s+$/, "");
  const indent = /\n([ \t]+)\S[^\n]*$/.exec(before)?.[1] ?? "  ";
  return `${before}${constraints.map((c) => `,\n${indent}${c}`).join("")}\n${text(create.slice(close))}`;
}
