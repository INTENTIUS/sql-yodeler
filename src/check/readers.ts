/**
 * Another tool's migrations directory (#1): golang-migrate, goose, Flyway or
 * dbmate, read in the order that tool applies it, the up direction only.
 *
 *   golang-migrate  `<version>_<title>.up.sql`; the `.down.sql` files are not read
 *   goose           `<version>_<name>.sql`, the `-- +goose Up` section; a
 *                   `-- +goose StatementBegin` ... `StatementEnd` block is one
 *                   statement. A Go migration (`.go`) is refused: its code is not SQL
 *   flyway          the locations its flyway.toml or flyway.conf names, read
 *                   recursively (the directory checked when there is none):
 *                   `V<version>__<description>.sql` by version, starting from
 *                   the newest `B<version>__` baseline when there is one,
 *                   then the repeatable `R__<description>.sql` files by
 *                   description, with placeholders substituted. Undo (`U`)
 *                   files and callbacks (`beforeMigrate.sql`, ...) are not
 *                   read; a Java or Kotlin migration is refused (flyway.ts)
 *   dbmate          `<version>_<name>.sql`, the `-- migrate:up` section
 *
 * Pure but for reading the files: no server, no git.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { YodelError } from "../project.js";
import { codeMigrations, findFlywayConfig, isCallback, readFlywayConfig, substitute, walk } from "./flyway.js";

export const TOOLS = ["golang-migrate", "goose", "flyway", "dbmate"] as const;
export type Tool = (typeof TOOLS)[number];

/** One statement of a migration's up section, and the line of the file it starts on. */
export interface ForeignStatement {
  sql: string;
  line: number;
}

/** A `-- yodel:allow <rule> <reason>` line in the file. */
export interface ForeignAllow {
  rule: string;
  reason: string;
  line: number;
}

/** One migration of the other tool, as that tool applies it. */
export interface ForeignMigration {
  /** The file, relative to the directory, with `/`. */
  file: string;
  /** The version the tool orders by; the description for a Flyway repeatable. */
  version: string;
  /** The name after the version. */
  name: string;
  /** A Flyway repeatable migration (`R__`): applied after the versioned ones, again whenever it changes. */
  repeatable?: true;
  /** A Flyway baseline migration (`B__`): a fresh database starts from it, in place of the versioned files up to its version. */
  baseline?: true;
  /** The up section's statements, in order. */
  statements: ForeignStatement[];
  allows: ForeignAllow[];
}

const GOLANG_MIGRATE = /^(\d+)_(.+)\.up\.sql$/;
const GOLANG_MIGRATE_ANY = /^\d+_.+\.(up|down)\.sql$/;
const NUMBERED = /^(\d+)_(.+)\.sql$/;
const FLYWAY_ANY = /^[VURB]\d*(?:[._]\d+)*__.+\.sql$/;
const GOOSE_UP = /^--\s*\+goose\s+Up\b/i;
const GOOSE_DOWN = /^--\s*\+goose\s+Down\b/i;
const GOOSE_BEGIN = /^--\s*\+goose\s+StatementBegin\b/i;
const GOOSE_END = /^--\s*\+goose\s+StatementEnd\b/i;
const DBMATE_UP = /^--\s*migrate:up\b/i;
const DBMATE_DOWN = /^--\s*migrate:down\b/i;
const ALLOW = /^\s*--\s*yodel:allow\s+(\S+)(?:\s+(.*))?$/;

/** The files of `dir`, top level only, sorted. */
function files(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new YodelError(`${dir} is not a directory`);
  return readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile()).sort();
}

/**
 * Which tool's directory `dir` is, from its file names (a flyway.toml or
 * flyway.conf in it or above it, up to `stopAt`, makes it Flyway's);
 * undefined when none fits.
 */
export function detectTool(dir: string, stopAt?: string): Tool | undefined {
  const names = files(dir);
  const sql = names.filter((f) => f.endsWith(".sql"));
  if (sql.length > 0 && sql.every((f) => GOLANG_MIGRATE_ANY.test(f))) return "golang-migrate";
  if (findFlywayConfig(dir, stopAt) !== undefined) return "flyway";
  // Flyway reads its locations recursively, and its callbacks sit beside the migrations.
  const nested = walk(dir).filter((f) => f.endsWith(".sql") && !isCallback(f));
  if (nested.length > 0 && nested.every((f) => FLYWAY_ANY.test(f.split(sep).pop() ?? ""))) return "flyway";
  const numbered = names.filter((f) => NUMBERED.test(f) || f.endsWith(".go"));
  if (numbered.length === 0) return undefined;
  const text = sql.filter((f) => NUMBERED.test(f)).map((f) => readFileSync(join(dir, f), "utf8"));
  if (names.some((f) => /^\d+_.+\.go$/.test(f)) || text.some((t) => /^--\s*\+goose\s+Up\b/im.test(t))) return "goose";
  if (text.some((t) => /^--\s*migrate:up\b/im.test(t))) return "dbmate";
  return undefined;
}

/** A version's numeric parts, for Flyway's ordering (1.10 after 1.9). */
const parts = (v: string): bigint[] => v.split(/[._]/).map((p) => BigInt(p));

function compareVersions(a: string, b: string): number {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i] ?? 0n;
    const q = y[i] ?? 0n;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

/** A section of lines, each with its 1-based number. */
type Lines = Array<{ text: string; line: number }>;

/** The statements of `lines`, split at top-level semicolons by `split`, each with the line it starts on. */
function statementsOf(lines: Lines, split: (sql: string) => string[]): ForeignStatement[] {
  if (lines.length === 0) return [];
  const first = lines[0]?.line ?? 1;
  const text = lines.map((l) => l.text).join("\n");
  const out: ForeignStatement[] = [];
  let from = 0;
  for (const s of split(text)) {
    // Its start: the statement's own text, found after the one before it.
    const at = text.indexOf(s.slice(0, Math.min(s.length, 40)), from);
    const start = at >= 0 ? at : from;
    const lead = text.slice(0, start).split("\n").length - 1;
    out.push({ sql: s, line: first + lead + leadingComments(s) });
    if (at >= 0) from = at + s.length;
  }
  return out;
}

/** How many whole comment lines a statement starts with, so its line is the statement's own. */
function leadingComments(sql: string): number {
  let n = 0;
  for (const l of sql.split("\n")) {
    if (/^\s*(--.*)?$/.test(l)) n++;
    else break;
  }
  return n;
}

function allowsOf(lines: Lines): ForeignAllow[] {
  return lines.flatMap((l) => {
    const m = ALLOW.exec(l.text);
    return m ? [{ rule: m[1] ?? "", reason: (m[2] ?? "").trim(), line: l.line }] : [];
  });
}

const numbered = (text: string): Lines => text.split(/\r?\n/).map((t, i) => ({ text: t, line: i + 1 }));

/** goose: the Up section; a StatementBegin/End block kept whole. */
function gooseUp(text: string, file: string, split: (sql: string) => string[]): { statements: ForeignStatement[]; up: Lines } {
  const lines = numbered(text);
  const start = lines.findIndex((l) => GOOSE_UP.test(l.text.trim()));
  if (start < 0) throw new YodelError(`${file}: no -- +goose Up line, so goose would run nothing from it`);
  const end = lines.findIndex((l, i) => i > start && GOOSE_DOWN.test(l.text.trim()));
  const up = lines.slice(start + 1, end < 0 ? undefined : end);
  const out: ForeignStatement[] = [];
  let plain: Lines = [];
  let block: Lines | undefined;
  for (const l of up) {
    if (GOOSE_BEGIN.test(l.text.trim())) {
      out.push(...statementsOf(plain, split));
      plain = [];
      block = [];
      continue;
    }
    if (GOOSE_END.test(l.text.trim())) {
      if (block === undefined) throw new YodelError(`${file}:${String(l.line)}: -- +goose StatementEnd with no StatementBegin before it`);
      const sql = block.map((b) => b.text).join("\n").trim().replace(/;\s*$/, "");
      const at = block.find((b) => b.text.trim() !== "" && !b.text.trim().startsWith("--"));
      if (sql !== "") out.push({ sql, line: at?.line ?? block[0]?.line ?? l.line });
      block = undefined;
      continue;
    }
    if (block !== undefined) block.push(l);
    else plain.push(l);
  }
  if (block !== undefined) throw new YodelError(`${file}: -- +goose StatementBegin with no StatementEnd after it`);
  out.push(...statementsOf(plain, split));
  return { statements: out, up };
}

/** dbmate: the `-- migrate:up` section. */
function dbmateUp(text: string, file: string): Lines {
  const lines = numbered(text);
  const start = lines.findIndex((l) => DBMATE_UP.test(l.text.trim()));
  if (start < 0) throw new YodelError(`${file}: no -- migrate:up line, so dbmate would run nothing from it`);
  const end = lines.findIndex((l, i) => i > start && DBMATE_DOWN.test(l.text.trim()));
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

export interface ReadOptions {
  /** The project's directory: a flyway.toml or flyway.conf is looked for up to it. */
  stopAt?: string;
  /** What Flyway's own placeholders fall back to: the replay scope's default schema. */
  defaults?: { defaultSchema?: string | undefined };
}

/** The migrations a tool applies, and the directory their `file` names are relative to. */
export interface ForeignDir {
  root: string;
  /** The Flyway configuration read, when there was one. */
  config?: string;
  migrations: ForeignMigration[];
}

/**
 * The migrations in `dir`, in the order `tool` applies them. `split`
 * splits SQL into statements at top-level semicolons (the dialect's).
 */
export function readForeign(dir: string, tool: Tool, split: (sql: string) => string[], options: ReadOptions = {}): ForeignMigration[] {
  return readForeignDir(dir, tool, split, options).migrations;
}

/** {@link readForeign}, with the directory the file names are relative to: a Flyway configuration's, when one is read. */
export function readForeignDir(dir: string, tool: Tool, split: (sql: string) => string[], options: ReadOptions = {}): ForeignDir {
  if (tool === "flyway") return readFlyway(dir, split, options);
  const names = files(dir);
  const read = (f: string) => readFileSync(join(dir, f), "utf8");
  const byVersion = (out: ForeignMigration[]): ForeignDir => ({ root: dir, migrations: out.sort((a, b) => compareVersions(a.version, b.version)) });
  switch (tool) {
    case "golang-migrate":
      return byVersion(
        names.flatMap((f) => {
          const m = GOLANG_MIGRATE.exec(f);
          if (!m) return [];
          const lines = numbered(read(f));
          return [{ file: f, version: m[1] ?? "", name: m[2] ?? "", statements: statementsOf(lines, split), allows: allowsOf(lines) }];
        }),
      );
    case "goose": {
      const go = names.filter((f) => /^\d+_.+\.go$/.test(f));
      if (go.length > 0) throw new YodelError(`${go.join(", ")}: a Go migration is code, which yodel check cannot read; only goose's SQL migrations are checked`);
      return byVersion(
        names.flatMap((f) => {
          const m = NUMBERED.exec(f);
          if (!m) return [];
          const { statements, up } = gooseUp(read(f), f, split);
          return [{ file: f, version: m[1] ?? "", name: m[2] ?? "", statements, allows: allowsOf(up) }];
        }),
      );
    }
    case "dbmate":
      return byVersion(
        names.flatMap((f) => {
          const m = NUMBERED.exec(f);
          if (!m) return [];
          const up = dbmateUp(read(f), f);
          return [{ file: f, version: m[1] ?? "", name: m[2] ?? "", statements: statementsOf(up, split), allows: allowsOf(up) }];
        }),
      );
  }
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Flyway: see the module comment, and flyway.ts for the configuration. */
function readFlyway(dir: string, split: (sql: string) => string[], options: ReadOptions): ForeignDir {
  const file = findFlywayConfig(dir, options.stopAt);
  const config = readFlywayConfig(file, dir);
  const code = codeMigrations(config);
  if (code.length > 0) throw new YodelError(`${code.join(", ")}: a Java or Kotlin migration is code, which yodel check cannot read or replay; only Flyway's SQL migrations are checked`);
  if (!config.locations.some((l) => existsSync(l))) {
    throw new YodelError(`${config.locations.map((l) => relative(process.cwd(), l) || l).join(", ")}: no such directory${file !== undefined ? ` (the locations ${file} names)` : ""}`);
  }
  const suffix = `(?:${config.sqlMigrationSuffixes.map(esc).join("|")})`;
  const sepr = esc(config.sqlMigrationSeparator);
  const V = new RegExp(`^${esc(config.sqlMigrationPrefix)}(\\d+(?:[._]\\d+)*)${sepr}(.+?)${suffix}$`);
  const B = new RegExp(`^${esc(config.baselineMigrationPrefix)}(\\d+(?:[._]\\d+)*)${sepr}(.+?)${suffix}$`);
  const R = new RegExp(`^${esc(config.repeatableSqlMigrationPrefix)}${sepr}(.+?)${suffix}$`);
  const versioned: ForeignMigration[] = [];
  const baselines: ForeignMigration[] = [];
  const repeatable: ForeignMigration[] = [];
  const seen = new Map<string, string>();
  for (const abs of [...new Set(config.locations.flatMap((l) => walk(l)))]) {
    const name = abs.split(sep).pop() ?? "";
    if (isCallback(name)) continue;
    const v = V.exec(name);
    const b = v ? null : B.exec(name);
    const r = v || b ? null : R.exec(name);
    if (!v && !b && !r) continue;
    const rel = relative(config.root, abs).split(sep).join("/");
    const lines = numbered(substitute(readFileSync(abs, "utf8"), rel, config, options.defaults));
    const m = { file: rel, statements: statementsOf(lines, split), allows: allowsOf(lines) };
    if (r) {
      repeatable.push({ ...m, version: r[1] ?? "", name: r[1] ?? "", repeatable: true });
      continue;
    }
    const hit = v ?? b;
    const version = hit?.[1] ?? "";
    // 1 and 1.0 are one version to Flyway: trailing zero parts do not count.
    const p = parts(version);
    while (p.length > 1 && p.at(-1) === 0n) p.pop();
    const key = `${b ? "B" : "V"}${p.join(".")}`;
    const before = seen.get(key);
    if (before !== undefined) throw new YodelError(`${before} and ${rel}: two ${b ? "baseline" : "versioned"} migrations of version ${version}, which Flyway refuses too`);
    seen.set(key, rel);
    if (b) baselines.push({ ...m, version, name: hit?.[2] ?? "", baseline: true });
    else versioned.push({ ...m, version, name: hit?.[2] ?? "" });
  }
  versioned.sort((a, b) => compareVersions(a.version, b.version));
  repeatable.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  // A fresh database starts from the newest baseline, then the versioned files after it.
  const baseline = baselines.sort((a, b) => compareVersions(a.version, b.version)).at(-1);
  const after = baseline === undefined ? versioned : versioned.filter((m) => compareVersions(m.version, baseline.version) > 0);
  return { root: config.root, ...(file !== undefined ? { config: file } : {}), migrations: [...(baseline ? [baseline] : []), ...after, ...repeatable] };
}
