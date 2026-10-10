/**
 * `yodel docs` (#62): the declared schema as a static reference, from the
 * sql lexicon's build output (or a migration's recorded schema), with no
 * server read and nothing to run in the browser.
 *
 * - {@link schemaHtml}: one self-contained HTML page (inline CSS, no
 *   scripts): every object with its columns, keys, relations, ClickHouse
 *   engine and sort key, comments, DDL, and the migrations that changed it.
 * - {@link erdMermaid}: a Mermaid `erDiagram` of the tables and views and
 *   how they relate: Postgres foreign keys, what a view or materialized view
 *   reads, the table a materialized view writes to, and the local table a
 *   ClickHouse `Distributed` table serves.
 *
 * Both are deterministic: the same input gives the same bytes, so the
 * output can be committed and compared.
 */

import { HAT_CSS, HAT_ICON, HAT_IMG } from "../brand.js";
import type { BuildOutput, BuiltObject } from "../chant/build.js";
import type { MigrationStep } from "../migrations/index.js";

/** A migration as far as the reference needs it: its id and its steps. */
export interface DocsMigration {
  id: string;
  steps: readonly MigrationStep[];
}

export interface DocsInput {
  /** The page's title, e.g. the project's name. */
  title: string;
  output: BuildOutput;
  /** Where the schema came from, said under the title: "the declared schema (chant build)", "migration <id>". */
  source: string;
  /** The migrations directory's chain, oldest first, for each object's history. */
  migrations?: readonly DocsMigration[];
}

interface Column {
  name: string;
  type?: string;
  notNull?: boolean;
  default?: unknown;
  generated?: unknown;
  comment?: string;
  codec?: string;
  ttl?: string;
}

interface ForeignKey {
  name?: string;
  columns: string[];
  references?: string;
  refTable?: string;
  refColumns?: string[];
  onDelete?: string;
  onUpdate?: string;
}

/** One relation between two objects, by export name. */
export interface Relation {
  from: string;
  to: string;
  kind: "foreign key" | "reads" | "writes to" | "distributes";
  label: string;
  /** Foreign keys only: the referencing columns may be null. */
  optional?: boolean;
}

type Obj = BuiltObject & Record<string, unknown>;

const RELATIONS = new Set(["Table", "View", "MaterializedView", "Dictionary"]);

/** "ClickHouse::Table" to "Table". */
const kindOf = (o: Obj): string => (o.type ?? "").split("::").pop() ?? "";
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const sqlName = (o: Obj): string => str(o.sqlName) ?? str(o.name) ?? o.export;
const columnsOf = (o: Obj): Column[] => (Array.isArray(o.columns) ? (o.columns as Column[]) : []);
const foreignKeysOf = (o: Obj): ForeignKey[] => (Array.isArray(o.foreignKeys) ? (o.foreignKeys as ForeignKey[]) : []);

/** The objects in apply order (then any the order leaves out, by export name). */
function ordered(output: BuildOutput): Obj[] {
  const objects = output.objects as Obj[];
  const byExport = new Map(objects.map((o) => [o.export, o]));
  const order = strs(output.applyOrder);
  const seen = new Set<string>();
  const out: Obj[] = [];
  for (const name of order) {
    const o = byExport.get(name);
    if (o && !seen.has(name)) {
      out.push(o);
      seen.add(name);
    }
  }
  for (const o of [...objects].sort((a, b) => a.export.localeCompare(b.export))) if (!seen.has(o.export)) out.push(o);
  return out;
}

/** The tables, views, materialized views and dictionaries: what the ERD draws. */
const relationsOf = (output: BuildOutput): Obj[] => ordered(output).filter((o) => RELATIONS.has(kindOf(o)));

/** The identifiers in a key expression such as `(kind, id)` or `tuple()`. */
const identifiers = (expr: string | undefined): Set<string> => new Set((expr ?? "").match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);

/** Every relation between the objects the ERD draws, in a stable order. */
export function relations(output: BuildOutput): Relation[] {
  const objects = relationsOf(output);
  const byExport = new Map(objects.map((o) => [o.export, o]));
  const bySqlName = new Map(objects.map((o) => [sqlName(o), o]));
  const out: Relation[] = [];
  for (const o of objects) {
    for (const fk of foreignKeysOf(o)) {
      const target = (fk.references !== undefined ? byExport.get(fk.references) : undefined) ?? (fk.refTable !== undefined ? bySqlName.get(fk.refTable) : undefined);
      if (!target) continue;
      const columns = columnsOf(o);
      const optional = fk.columns.some((c) => columns.find((col) => col.name === c)?.notNull !== true);
      const cols = `${fk.columns.join(", ")} to ${(fk.refColumns ?? []).join(", ") || "its primary key"}`;
      out.push({ from: o.export, to: target.export, kind: "foreign key", label: fk.name ? `${fk.name}: ${cols}` : cols, optional });
    }
    const to = str(o.to);
    if (to !== undefined && byExport.has(to)) out.push({ from: o.export, to, kind: "writes to", label: "writes to" });
    for (const r of strs(o.reads)) if (byExport.has(r)) out.push({ from: o.export, to: r, kind: "reads", label: "reads" });
    const engine = o.engine as { name?: string; args?: unknown[] } | undefined;
    if (engine?.name === "Distributed") {
      const [, db, table] = (engine.args ?? []).map((a) => (typeof a === "string" ? a.replace(/^'|'$/g, "") : ""));
      const target = db !== undefined && table !== undefined ? bySqlName.get(`${db}.${table}`) : undefined;
      if (target) out.push({ from: o.export, to: target.export, kind: "distributes", label: "distributes to" });
    }
  }
  return out;
}

/** A Mermaid entity id: the SQL name with every other character as `_`. */
function entityIds(objects: Obj[]): Map<string, string> {
  const ids = new Map<string, string>();
  const used = new Set<string>();
  for (const o of objects) {
    const base = sqlName(o).replace(/[^A-Za-z0-9_]/g, "_");
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}_${String(n)}`;
    used.add(id);
    ids.set(o.export, id);
  }
  return ids;
}

/** Mermaid takes a type as one word: the type with spaces and commas as `_`. */
const mermaidType = (type: string | undefined): string => (type ?? "unknown").replace(/,\s*/g, "_").replace(/[^A-Za-z0-9_()[\]-]/g, "_");
const mermaidText = (text: string): string => text.replace(/"/g, "'").replace(/\s+/g, " ").trim();

/** The columns the object's keys name: PK, FK, UK, for the ERD's key column. */
function columnKeys(o: Obj): Map<string, string[]> {
  const keys = new Map<string, string[]>();
  const add = (column: string, key: string) => {
    const list = keys.get(column) ?? [];
    if (!list.includes(key)) list.push(key);
    keys.set(column, list);
  };
  const pk = o.primaryKey;
  if (pk && typeof pk === "object" && "columns" in pk) for (const c of strs((pk).columns)) add(c, "PK");
  // ClickHouse: the primary key, or the sort key when it has none, is what the sparse index is built on.
  if (typeof pk === "string" || (pk === undefined && typeof o.orderBy === "string")) {
    const names = new Set(columnsOf(o).map((c) => c.name));
    for (const id of identifiers(str(pk) ?? str(o.orderBy))) if (names.has(id)) add(id, "PK");
  }
  for (const fk of foreignKeysOf(o)) for (const c of fk.columns) add(c, "FK");
  if (Array.isArray(o.uniques)) for (const u of o.uniques as Array<{ columns?: unknown }>) for (const c of strs(u.columns)) add(c, "UK");
  return keys;
}

/** The Mermaid `erDiagram`: one entity per table or view, one line per relation. */
export function erdMermaid(output: BuildOutput): string {
  const objects = relationsOf(output);
  const ids = entityIds(objects);
  const lines = ["erDiagram"];
  for (const o of objects) {
    const keys = columnKeys(o);
    const entity = `  ${ids.get(o.export) ?? o.export}["${sqlName(o)}"]`;
    const columns = columnsOf(o);
    // A view's columns come from its query and have no declared type: the entity alone.
    if (columns.length === 0) {
      lines.push(entity);
      continue;
    }
    lines.push(`${entity} {`);
    for (const c of columns) {
      const k = keys.get(c.name);
      const comment = c.comment ? ` "${mermaidText(c.comment)}"` : "";
      lines.push(`    ${mermaidType(c.type)} ${c.name}${k ? ` ${k.join(", ")}` : ""}${comment}`);
    }
    lines.push("  }");
  }
  for (const r of relations(output)) {
    const from = ids.get(r.from) ?? r.from;
    const to = ids.get(r.to) ?? r.to;
    // A foreign key: many rows to one (or none, when its columns may be null). The rest are not keys, so dotted.
    const shape = r.kind === "foreign key" ? (r.optional ? "}o--o|" : "}o--||") : "}o..||";
    lines.push(`  ${from} ${shape} ${to} : "${mermaidText(r.label)}"`);
  }
  return `${lines.join("\n")}\n`;
}

/** The ERD as Markdown, which GitHub, GitLab and Forgejo render. */
export function erdMarkdown(input: DocsInput): string {
  return `# ${input.title}: entity relationships\n\nFrom ${input.source}. Written by \`yodel docs\`; index.html next to this file has every object's columns, keys, engine and history.\n\n\`\`\`mermaid\n${erdMermaid(input.output)}\`\`\`\n`;
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const code = (s: string): string => `<code>${esc(s)}</code>`;
const anchor = (o: Obj): string => `o-${o.export.replace(/[^A-Za-z0-9_-]/g, "-")}`;

/** A column's default, generated expression or codec, as one line. */
function columnDetail(c: Column): string {
  const parts: string[] = [];
  const d = c.default;
  if (typeof d === "string") parts.push(`DEFAULT ${d}`);
  else if (d && typeof d === "object") {
    const { kind, expr } = d as { kind?: string; expr?: string };
    parts.push(`${kind ?? "DEFAULT"} ${expr ?? ""}`.trim());
  }
  const g = c.generated;
  if (g && typeof g === "object") {
    const { kind, always, expr } = g as { kind?: string; always?: boolean; expr?: string };
    parts.push(kind === "identity" ? `GENERATED ${always ? "ALWAYS" : "BY DEFAULT"} AS IDENTITY` : `GENERATED ALWAYS AS (${expr ?? ""})`);
  }
  if (c.codec) parts.push(`CODEC(${c.codec})`);
  if (c.ttl) parts.push(`TTL ${c.ttl}`);
  return parts.join(", ");
}

/** A view's columns: each output of its query and the expression it comes from. */
function lineageTable(o: Obj): string {
  const lineage = Array.isArray(o.lineage) ? (o.lineage as Array<{ output?: string; expr?: string }>) : [];
  if (lineage.length === 0) return "";
  const rows = lineage.map((l) => `<tr><td>${code(l.output ?? "")}</td><td>${code(l.expr ?? "")}</td></tr>`);
  return `<table><thead><tr><th>Column</th><th>Expression</th></tr></thead><tbody>\n${rows.join("\n")}\n</tbody></table>`;
}

function columnsTable(o: Obj): string {
  const columns = columnsOf(o);
  if (columns.length === 0) return lineageTable(o);
  const keys = columnKeys(o);
  const postgres = o.type?.startsWith("Postgres::") === true;
  const rows = columns.map((c) => {
    const nullable = postgres ? (c.notNull === true ? "no" : "yes") : /^Nullable\(/.test(c.type ?? "") ? "yes" : "no";
    return `<tr><td>${code(c.name)}</td><td>${code(c.type ?? "")}</td><td>${nullable}</td><td>${esc((keys.get(c.name) ?? []).join(", "))}</td><td>${esc(columnDetail(c))}</td><td>${esc(c.comment ?? "")}</td></tr>`;
  });
  return `<table><thead><tr><th>Column</th><th>Type</th><th>Null</th><th>Key</th><th>Default</th><th>Comment</th></tr></thead><tbody>\n${rows.join("\n")}\n</tbody></table>`;
}

/** The facts under an object's name: engine, sort key and the rest, as a definition list. */
function facts(o: Obj, byExport: Map<string, Obj>): string {
  const items: Array<[string, string]> = [];
  const engine = o.engine as { name?: string; args?: unknown[] } | undefined;
  if (engine?.name) items.push(["Engine", code(`${engine.name}${engine.args?.length ? `(${engine.args.map(String).join(", ")})` : ""}`)]);
  for (const [key, label] of [
    ["orderBy", "ORDER BY"],
    ["primaryKey", "PRIMARY KEY"],
    ["partitionBy", "PARTITION BY"],
    ["sampleBy", "SAMPLE BY"],
    ["ttl", "TTL"],
  ] as const) {
    const v = str(o[key]);
    if (v !== undefined) items.push([label, code(v)]);
  }
  const pk = o.primaryKey;
  if (pk && typeof pk === "object" && "columns" in pk) {
    const { name, columns } = pk as { name?: string; columns: unknown };
    items.push(["Primary key", `${code(`(${strs(columns).join(", ")})`)}${name ? ` ${esc(name)}` : ""}`]);
  }
  if (Array.isArray(o.uniques)) for (const u of o.uniques as Array<{ name?: string; columns?: unknown }>) items.push(["Unique", `${code(`(${strs(u.columns).join(", ")})`)}${u.name ? ` ${esc(u.name)}` : ""}`]);
  if (Array.isArray(o.checks)) for (const c of o.checks as Array<{ name?: string; expr?: string }>) items.push(["Check", `${code(c.expr ?? "")}${c.name ? ` ${esc(c.name)}` : ""}`]);
  for (const fk of foreignKeysOf(o)) {
    const target = (fk.references !== undefined ? byExport.get(fk.references) : undefined);
    const ref = target ? `<a href="#${anchor(target)}">${esc(sqlName(target))}</a>` : esc(fk.refTable ?? fk.references ?? "");
    const actions = [fk.onDelete ? `ON DELETE ${fk.onDelete}` : "", fk.onUpdate ? `ON UPDATE ${fk.onUpdate}` : ""].filter(Boolean).join(" ");
    items.push(["Foreign key", `${code(`(${fk.columns.join(", ")})`)} references ${ref} ${code(`(${(fk.refColumns ?? []).join(", ")})`)}${actions ? ` ${esc(actions)}` : ""}${fk.name ? ` ${esc(fk.name)}` : ""}`]);
  }
  if (Array.isArray(o.indexes)) for (const i of o.indexes as Array<{ name?: string; expr?: string; type?: string }>) items.push(["Skip index", code(`${i.name ?? ""} ${i.expr ?? ""} TYPE ${i.type ?? ""}`.trim())]);
  if (Array.isArray(o.projections)) for (const p of o.projections as Array<{ name?: string }>) items.push(["Projection", code(p.name ?? "")]);
  const table = str(o.table);
  if (kindOf(o) === "Index" && table !== undefined) {
    const t = byExport.get(table);
    const elements = Array.isArray(o.elements) ? (o.elements as Array<{ expr?: string }>).map((e) => e.expr ?? "") : [];
    items.push(["On", `${t ? `<a href="#${anchor(t)}">${esc(sqlName(t))}</a>` : esc(str(o.tableName) ?? table)} ${code(`(${elements.join(", ")})`)}${str(o.method) ? ` using ${esc(str(o.method) ?? "")}` : ""}`]);
  }
  const select = str(o.select) ?? str(o.query);
  if (select !== undefined) items.push(["Query", `<pre>${esc(select)}</pre>`]);
  if (items.length === 0) return "";
  return `<dl>\n${items.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("\n")}\n</dl>`;
}

function relationList(o: Obj, all: Relation[], byExport: Map<string, Obj>): string {
  const link = (exportName: string) => {
    const t = byExport.get(exportName);
    return t ? `<a href="#${anchor(t)}">${esc(sqlName(t))}</a>` : esc(exportName);
  };
  const out = all.filter((r) => r.from === o.export).map((r) => `<li>${esc(r.kind === "foreign key" ? `foreign key ${r.label}:` : r.label)} ${link(r.to)}</li>`);
  const inbound = all.filter((r) => r.to === o.export).map((r) => {
    const verb = r.kind === "foreign key" ? `referenced by (${r.label})` : r.kind === "reads" ? "read by" : r.kind === "writes to" ? "written by" : "distributed by";
    return `<li>${esc(verb)} ${link(r.from)}</li>`;
  });
  const items = [...out, ...inbound];
  return items.length ? `<h4>Relations</h4>\n<ul>\n${items.join("\n")}\n</ul>` : "";
}

/** What one migration step did to an object, as one line. */
function stepLine(step: MigrationStep): string {
  const s = step as unknown as Record<string, unknown>;
  if (s.kind === "statement") return `${str(s.rule) ?? ""} ${str(s.class) ?? ""}: ${str(s.sql) ?? ""}`.trim();
  if (s.kind === "op") {
    const changes = Array.isArray(s.changes) ? (s.changes as Array<{ rule?: string; field?: string }>).map((c) => `${c.rule ?? ""} ${c.field ?? ""}`.trim()).join("; ") : "";
    return `${str(s.op) ?? "Op"} step${changes ? ` (${changes})` : ""}`;
  }
  return `${typeof s.kind === "string" ? s.kind : "manual"} step${str(s.detail) ? `: ${str(s.detail) ?? ""}` : ""}`;
}

function history(o: Obj, migrations: readonly DocsMigration[] | undefined): string {
  if (!migrations) return "";
  const rows: string[] = [];
  for (const m of migrations) {
    for (const step of m.steps) {
      const s = step as unknown as Record<string, unknown>;
      if (s.name === sqlName(o) || (s.name === undefined && s.object === o.export)) rows.push(`<tr><td>${code(m.id)}</td><td>${code(stepLine(step))}</td></tr>`);
    }
  }
  if (rows.length === 0) return "";
  return `<h4>History</h4>\n<table><thead><tr><th>Migration</th><th>Step</th></tr></thead><tbody>\n${rows.join("\n")}\n</tbody></table>`;
}

const STYLE = `:root{color-scheme:light dark;--fg:#1d1f23;--muted:#5d6470;--bg:#fff;--line:#d8dce3;--code:#f3f5f8;--link:#1f5fbf}
@media (prefers-color-scheme:dark){:root{--fg:#e6e8eb;--muted:#a3a9b3;--bg:#16181c;--line:#353a42;--code:#22262c;--link:#7fb0ff}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:1.6rem;margin:0 0 4px}h2{margin-top:2.2rem;border-bottom:1px solid var(--line);padding-bottom:4px}
h3{margin:2rem 0 .3rem}h4{margin:1rem 0 .3rem;font-size:.95rem}
.muted,.kind{color:var(--muted)}.kind{font-weight:400;font-size:.85rem;margin-left:.5rem}
a{color:var(--link)}code,pre{font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code);border-radius:4px}
code{padding:1px 4px}pre{padding:8px 10px;overflow-x:auto;white-space:pre}
table{border-collapse:collapse;width:100%;margin:.4rem 0;display:block;overflow-x:auto}
th,td{border:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top}th{font-weight:600}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 12px;margin:.5rem 0}dt{color:var(--muted)}dd{margin:0}dd pre{margin:0}
ul.toc{columns:2 260px;padding-left:1.2rem}details{margin:.5rem 0}summary{cursor:pointer;color:var(--muted)}`;

/** The self-contained HTML reference. */
export function schemaHtml(input: DocsInput): string {
  const objects = ordered(input.output);
  const byExport = new Map(objects.map((o) => [o.export, o]));
  const all = relations(input.output);
  const sections = objects.map((o) => {
    const comment = str(o.comment);
    return [
      `<section id="${anchor(o)}">`,
      `<h3>${esc(sqlName(o))}<span class="kind">${esc(o.type ?? "")}, export ${esc(o.export)}</span></h3>`,
      comment ? `<p>${esc(comment)}</p>` : "",
      facts(o, byExport),
      columnsTable(o),
      relationList(o, all, byExport),
      history(o, input.migrations),
      `<details><summary>DDL</summary><pre>${esc(o.ddl)}</pre></details>`,
      "</section>",
    ].filter(Boolean).join("\n");
  });
  const toc = objects.map((o) => `<li><a href="#${anchor(o)}">${esc(sqlName(o))}</a> <span class="muted">${esc(kindOf(o))}</span></li>`);
  const dialect = input.output.dialect === "clickhouse" ? "ClickHouse" : "Postgres";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(input.title)}: schema</title>
${HAT_ICON}
<style>
${STYLE}
${HAT_CSS}
</style>
</head>
<body>
<main>
<h1 class="brand">${HAT_IMG}${esc(input.title)}</h1>
<p class="muted">${esc(dialect)}, ${String(objects.length)} objects, from ${esc(input.source)}. Written by <code>yodel docs</code>.</p>
<h2>Objects</h2>
<ul class="toc">
${toc.join("\n")}
</ul>
<h2>Entity relationships</h2>
<p class="muted">Mermaid source; erd.md next to this file renders it on GitHub, GitLab and Forgejo.</p>
<pre>${esc(erdMermaid(input.output))}</pre>
<h2>Reference</h2>
${sections.join("\n")}
</main>
</body>
</html>
`;
}
