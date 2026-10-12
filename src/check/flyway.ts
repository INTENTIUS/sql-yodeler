/**
 * A Flyway project as `yodel check` reads it (#250): its `flyway.toml` or
 * `flyway.conf`, the locations it names, read recursively, and the
 * placeholders it substitutes.
 *
 * The configuration is the first `flyway.toml`, else `flyway.conf`, found in
 * the directory checked or a directory above it, up to the project's. Its
 * locations are read relative to the file's own directory:
 *
 *   filesystem:<path>   that directory
 *   classpath:<path>    src/main/resources/<path> (and, for code
 *   <path>              migrations, src/main/java/<path> and src/main/kotlin/<path>)
 *
 * With no configuration, or one that names no location, the directory
 * checked is the one location. A Java or Kotlin migration in a location is
 * refused, naming it: its code is not SQL.
 *
 * Placeholders are `${name}` (the prefix and suffix are configurable), from
 * `flyway.placeholders.<name>` (conf) or `[flyway.placeholders]` (toml),
 * plus Flyway's own: `flyway:defaultSchema`, `flyway:user`,
 * `flyway:database`, `flyway:timestamp`, `flyway:filename`,
 * `flyway:workingDirectory`, `flyway:table` and `flyway:environment`. A
 * placeholder with no value is an error naming its file and line, as
 * Flyway's own run would be.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { YodelError } from "../project.js";

export interface FlywayConfig {
  /** The configuration file, absolute; undefined with none. */
  file?: string;
  /** Where file names are relative to: the configuration's directory, else the directory checked. */
  root: string;
  /** The SQL locations, absolute directories. */
  locations: string[];
  /** Directories code migrations (Java, Kotlin) of a classpath location would be in. */
  codeLocations: string[];
  placeholders: Record<string, string>;
  placeholderPrefix: string;
  placeholderSuffix: string;
  placeholderReplacement: boolean;
  sqlMigrationPrefix: string;
  repeatableSqlMigrationPrefix: string;
  baselineMigrationPrefix: string;
  undoSqlMigrationPrefix: string;
  sqlMigrationSeparator: string;
  sqlMigrationSuffixes: string[];
  defaultSchema?: string;
  user?: string;
  database?: string;
  table: string;
  environment?: string;
}

/** The first `flyway.toml`, else `flyway.conf`, in `dir` or a directory above it up to `stopAt`. */
export function findFlywayConfig(dir: string, stopAt?: string): string | undefined {
  const top = stopAt === undefined ? undefined : resolve(stopAt);
  let at = resolve(dir);
  for (;;) {
    for (const name of ["flyway.toml", "flyway.conf"]) {
      const f = join(at, name);
      if (existsSync(f) && statSync(f).isFile()) return f;
    }
    const up = dirname(at);
    if (at === top || up === at || (top !== undefined && !`${at}${sep}`.startsWith(`${top}${sep}`))) return undefined;
    at = up;
  }
}

type Values = Record<string, string | string[] | boolean>;

/** Java-properties `flyway.*` keys, without the `flyway.` prefix. */
export function parseFlywayConf(text: string): Values {
  const out: Values = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i] ?? "";
    while (/\\$/.test(line) && i + 1 < lines.length) line = line.slice(0, -1) + (lines[++i] ?? "").trimStart();
    const t = line.trim();
    if (t === "" || t.startsWith("#") || t.startsWith("!")) continue;
    const m = /^([^=:\s]+)\s*[=:]\s*(.*)$/.exec(t);
    if (!m) continue;
    const key = m[1] ?? "";
    if (!key.startsWith("flyway.")) continue;
    out[key.slice("flyway.".length)] = (m[2] ?? "").trim();
  }
  return out;
}

/** A TOML document, as far as Flyway's configuration uses it: tables, strings, arrays of strings, booleans and numbers. */
export function parseToml(text: string): Record<string, Values> {
  const tables: Record<string, Values> = { "": {} };
  let current = "";
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const t = stripComment(lines[i] ?? "").trim();
    if (t === "") continue;
    const table = /^\[\s*([^\]]+?)\s*\]$/.exec(t);
    if (table) {
      current = (table[1] ?? "").split(".").map((k) => unquote(k.trim())).join(".");
      tables[current] ??= {};
      continue;
    }
    const kv = /^("[^"]*"|'[^']*'|[A-Za-z0-9_.:-]+)\s*=\s*(.*)$/.exec(t);
    if (!kv) continue;
    let raw = kv[2] ?? "";
    // A multi-line array runs to its closing bracket.
    while (raw.trimStart().startsWith("[") && !balanced(raw) && i + 1 < lines.length) raw += ` ${stripComment(lines[++i] ?? "").trim()}`;
    const path = unquote(kv[1] ?? "").split(".");
    const key = path.pop() ?? "";
    const where = [current, ...path].filter(Boolean).join(".");
    tables[where] ??= {};
    tables[where][key] = tomlValue(raw.trim());
  }
  return tables;
}

function stripComment(line: string): string {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#") return line.slice(0, i);
  }
  return line;
}

const balanced = (s: string) => (s.match(/\[/g) ?? []).length <= (s.match(/\]/g) ?? []).length;

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  return s;
}

function tomlValue(raw: string): string | string[] | boolean {
  if (raw === "true" || raw === "false") return raw === "true";
  if (raw.startsWith("[")) {
    const inner = raw.replace(/^\[/, "").replace(/\]\s*$/, "");
    return (inner.match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^,\s]+/g) ?? []).map((v) => unquote(v.trim())).filter((v) => v !== "");
  }
  return unquote(raw);
}

const list = (v: string | string[] | boolean | undefined): string[] | undefined =>
  v === undefined || typeof v === "boolean" ? undefined : Array.isArray(v) ? v : v.split(",").map((s) => s.trim()).filter(Boolean);
const str = (v: string | string[] | boolean | undefined): string | undefined => (typeof v === "string" ? v : Array.isArray(v) ? v.join(",") : undefined);

/** The database name a JDBC URL names: the path after the host. */
function databaseOf(url: string | undefined): string | undefined {
  const m = url === undefined ? null : /^jdbc:[a-z0-9]+:\/\/[^/]+\/([^?;]+)/i.exec(url);
  return m?.[1] ?? undefined;
}

/** The configuration `file` holds, or the defaults with `dir` as the one location when there is none. */
export function readFlywayConfig(file: string | undefined, dir: string): FlywayConfig {
  let values: Values = {};
  let placeholders: Record<string, string> = {};
  if (file !== undefined) {
    const text = readFileSync(file, "utf8");
    if (file.endsWith(".toml")) {
      const t = parseToml(text);
      const flyway = t.flyway ?? {};
      const name = str(flyway.environment) ?? "default";
      const env = t[`environments.${name}`] ?? {};
      values = { ...flyway, ...(t[`environments.${name}.flyway`] ?? {}), ...(env.url !== undefined ? { url: env.url } : {}), ...(env.user !== undefined ? { user: env.user } : {}), ...(env.schemas !== undefined ? { schemas: env.schemas } : {}) };
      if (str(flyway.environment) !== undefined) values.environment = name;
      placeholders = Object.fromEntries(Object.entries({ ...(t["flyway.placeholders"] ?? {}), ...(t[`environments.${name}.flyway.placeholders`] ?? {}) }).map(([k, v]) => [k, str(v) ?? String(v)]));
    } else {
      values = parseFlywayConf(text);
      placeholders = Object.fromEntries(Object.entries(values).flatMap(([k, v]) => (k.startsWith("placeholders.") ? [[k.slice("placeholders.".length), str(v) ?? ""]] : [])));
    }
  }
  const root = file === undefined ? resolve(dir) : dirname(file);
  const named = list(values.locations) ?? [];
  const locations: string[] = [];
  const codeLocations: string[] = [];
  for (const l of named) {
    const m = /^(filesystem|classpath):(.*)$/.exec(l);
    const kind = m?.[1] ?? "classpath";
    const path = (m?.[2] ?? l).replace(/^\/+/, kind === "classpath" ? "" : "/");
    if (kind === "filesystem") locations.push(resolve(root, path));
    else {
      locations.push(join(root, "src", "main", "resources", path));
      codeLocations.push(join(root, "src", "main", "java", path), join(root, "src", "main", "kotlin", path));
    }
  }
  if (locations.length === 0) locations.push(resolve(dir));
  const schemas = list(values.schemas);
  const replacement = values.placeholderReplacement;
  const defaultSchema = str(values.defaultSchema) ?? schemas?.[0];
  const user = str(values.user);
  const database = databaseOf(str(values.url));
  const environment = str(values.environment);
  return {
    ...(file !== undefined ? { file } : {}),
    root,
    locations,
    codeLocations,
    placeholders,
    placeholderPrefix: str(values.placeholderPrefix) ?? "${",
    placeholderSuffix: str(values.placeholderSuffix) ?? "}",
    placeholderReplacement: !(replacement === false || replacement === "false"),
    sqlMigrationPrefix: str(values.sqlMigrationPrefix) ?? "V",
    repeatableSqlMigrationPrefix: str(values.repeatableSqlMigrationPrefix) ?? "R",
    baselineMigrationPrefix: str(values.baselineMigrationPrefix) ?? "B",
    undoSqlMigrationPrefix: str(values.undoSqlMigrationPrefix) ?? "U",
    sqlMigrationSeparator: str(values.sqlMigrationSeparator) ?? "__",
    sqlMigrationSuffixes: list(values.sqlMigrationSuffixes) ?? [".sql"],
    ...(defaultSchema !== undefined ? { defaultSchema } : {}),
    ...(user !== undefined ? { user } : {}),
    ...(database !== undefined ? { database } : {}),
    table: str(values.table) ?? "flyway_schema_history",
    ...(environment !== undefined ? { environment } : {}),
  };
}

/** Every file under `dir`, recursively, absolute, sorted; none when it does not exist. */
export function walk(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** A Flyway SQL callback (`beforeMigrate.sql`, `afterEachMigrate__notify.sql`, ...): run around a migrate, not a migration. */
export const isCallback = (file: string): boolean => /^(before|after)[A-Z][A-Za-z]*(__.*)?\.[A-Za-z]+$/.test(basename(file));

/** The code migrations (Java, Kotlin) in `config`'s locations, relative to its root. */
export function codeMigrations(config: FlywayConfig): string[] {
  const code = /\.(java|kt|class)$/;
  const prefixes = [config.sqlMigrationPrefix, config.repeatableSqlMigrationPrefix, config.baselineMigrationPrefix].filter(Boolean);
  const migration = (f: string) => code.test(f) && prefixes.some((p) => basename(f).startsWith(p)) && basename(f).includes(config.sqlMigrationSeparator);
  return [...new Set([...config.locations, ...config.codeLocations])]
    .flatMap((d) => walk(d))
    .filter(migration)
    .map((f) => relative(config.root, f).split(sep).join("/"));
}

/** The values Flyway gives its own placeholders, for `file`. */
function builtins(config: FlywayConfig, file: string, fallback: { defaultSchema?: string | undefined }): Record<string, string | undefined> {
  return {
    "flyway:defaultSchema": config.defaultSchema ?? fallback.defaultSchema,
    "flyway:user": config.user,
    "flyway:database": config.database,
    "flyway:timestamp": new Date().toISOString().replace("T", " ").replace(/\..*$/, ""),
    "flyway:filename": basename(file),
    "flyway:workingDirectory": process.cwd(),
    "flyway:table": config.table,
    "flyway:environment": config.environment,
  };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `text` with its placeholders replaced, line by line so line numbers hold.
 * A placeholder with no value is an error naming `file` and the line.
 */
export function substitute(text: string, file: string, config: FlywayConfig, fallback: { defaultSchema?: string | undefined } = {}): string {
  if (!config.placeholderReplacement) return text;
  const values: Record<string, string | undefined> = { ...builtins(config, file, fallback), ...config.placeholders };
  const lower = new Map(Object.entries(values).map(([k, v]) => [k.toLowerCase(), v]));
  const pattern = new RegExp(`${escape(config.placeholderPrefix)}([A-Za-z0-9_.:-]+)${escape(config.placeholderSuffix)}`, "g");
  return text
    .split("\n")
    .map((line, i) =>
      line.replace(pattern, (whole, name: string) => {
        const v = values[name] ?? lower.get(name.toLowerCase());
        if (v === undefined) {
          const where = config.file === undefined ? "a flyway.toml or flyway.conf beside the migrations" : relative(process.cwd(), config.file) || config.file;
          throw new YodelError(`${file}:${String(i + 1)}: no value for the placeholder ${whole}; set it in ${where} (flyway.placeholders.${name} in flyway.conf, [flyway.placeholders] in flyway.toml)`);
        }
        return v;
      }),
    )
    .join("\n");
}
