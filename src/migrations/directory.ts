/**
 * Reading and writing a project's `migrations/` directory.
 *
 * Order is the chain of parent ids, as in Alembic and pgroll: the first
 * migration has `parent: null`, every other names the one it follows, and
 * the list runs from the first to the newest. The ids' timestamps never
 * decide the order. A directory is well formed when the parent links make
 * one unbroken chain:
 *
 * - every directory under `migrations/` is named like an id and holds a
 *   readable `migration.sql` and `migration.json` whose `id` is that name
 *   (plain files there, such as a README, are ignored);
 * - every parent names a migration in the directory;
 * - no two migrations have the same parent, `null` included. Two branches
 *   that each added a migration give one parent two children: a fork. It is
 *   reported naming both, never ordered by timestamp or by name;
 * - every migration is reachable from the first (no cycles).
 *
 * {@link scanMigrations} reports every problem and never throws on one, for
 * `yodel lint`. {@link readMigrations} returns the ordered chain or throws a
 * {@link MigrationDirectoryError} listing the problems, for the verbs that
 * act on the chain (`new`, `apply`, `rebase`).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { YodelError } from "../project.js";
import { verifyChecksum, type ChecksumCheck } from "./checksum.js";
import { MIGRATION_JSON, MIGRATION_SQL, type MigrationDocument, type MigrationFiles } from "./document.js";

/** Where a project keeps its migrations, relative to the project directory. */
export const MIGRATIONS_DIR = "migrations";

/** `<YYYYMMDDTHHMM>-<name>`; a name is lowercase letters and digits, words joined by `-` or `_`. */
export const MIGRATION_ID = /^(\d{8}T\d{4})-([a-z0-9]+(?:[-_][a-z0-9]+)*)$/;
export const MIGRATION_NAME = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

/** One migration as read from disk. */
export interface Migration {
  id: string;
  /** Its directory, absolute. */
  dir: string;
  parent: string | null;
  /** The checksum `migration.json` records (not recomputed; see {@link verifyChecksum}). */
  checksum: string;
  document: MigrationDocument;
  /** The files' text exactly as read. */
  files: MigrationFiles;
}

export type MigrationProblem =
  | { kind: "unreadable"; path: string; message: string }
  | { kind: "id-mismatch"; id: string; recorded: string; message: string }
  | { kind: "missing-parent"; id: string; parent: string; message: string }
  | { kind: "fork"; parent: string | null; children: string[]; message: string }
  | { kind: "unreachable"; ids: string[]; message: string }
  | { kind: "checksum"; id: string; check: ChecksumCheck; message: string };

export interface MigrationScan {
  /** The migrations directory, absolute. */
  dir: string;
  /** Every migration that could be read, sorted by id. */
  migrations: Migration[];
  /** From the first migration to the newest, when there is no structural problem; else `undefined`. */
  ordered: Migration[] | undefined;
  /** Every problem found. Checksum mismatches are listed here but never stop {@link MigrationScan.ordered} being computed. */
  problems: MigrationProblem[];
}

/** A migrations directory that is not one unbroken chain, or (when asked) whose checksums do not match. */
export class MigrationDirectoryError extends YodelError {
  constructor(
    readonly dir: string,
    readonly problems: MigrationProblem[],
  ) {
    super(`${dir}:\n${problems.map((p) => `  ${p.message}`).join("\n")}`);
    this.name = "MigrationDirectoryError";
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function readOne(dir: string, id: string): Migration | MigrationProblem {
  const at = join(dir, id);
  let sql: string;
  let json: string;
  try {
    sql = readFileSync(join(at, MIGRATION_SQL), "utf8");
    json = readFileSync(join(at, MIGRATION_JSON), "utf8");
  } catch (e) {
    return { kind: "unreadable", path: at, message: `${id}: ${e instanceof Error ? e.message : String(e)}` };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch (e) {
    return { kind: "unreadable", path: join(at, MIGRATION_JSON), message: `${id}/${MIGRATION_JSON} is not JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  const bad = (what: string): MigrationProblem => ({ kind: "unreadable", path: join(at, MIGRATION_JSON), message: `${id}/${MIGRATION_JSON}: ${what}` });
  if (!isRecord(doc)) return bad("not an object");
  if (typeof doc.id !== "string") return bad("no id");
  if (doc.parent !== null && typeof doc.parent !== "string") return bad("parent is neither an id nor null");
  if (typeof doc.checksum !== "string") return bad("no checksum");
  if (!Array.isArray(doc.steps)) return bad("no steps");
  if (!isRecord(doc.schema)) return bad("no recorded schema");
  if (doc.id !== id) {
    return { kind: "id-mismatch", id, recorded: doc.id, message: `${id}/${MIGRATION_JSON} records id ${doc.id}; a migration's id is its directory's name` };
  }
  return { id, dir: at, parent: doc.parent, checksum: doc.checksum, document: doc as unknown as MigrationDocument, files: { sql, json } };
}

/** Every migration in `dir` and every problem with the directory. A missing `dir` is an empty directory. */
export function scanMigrations(dir: string): MigrationScan {
  const problems: MigrationProblem[] = [];
  const migrations: Migration[] = [];
  if (!existsSync(dir)) return { dir, migrations, ordered: [], problems };

  for (const entry of readdirSync(dir).sort()) {
    if (entry.startsWith(".")) continue; // a write in progress, editor and OS files
    if (!statSync(join(dir, entry)).isDirectory()) continue;
    if (!MIGRATION_ID.test(entry)) {
      problems.push({ kind: "unreadable", path: join(dir, entry), message: `${entry}: not a migration directory name (expected <YYYYMMDDTHHMM>-<name>)` });
      continue;
    }
    const read = readOne(dir, entry);
    if ("kind" in read) problems.push(read);
    else migrations.push(read);
  }

  const byId = new Map(migrations.map((m) => [m.id, m]));
  const children = new Map<string | null, Migration[]>();
  for (const m of migrations) {
    if (m.parent !== null && !byId.has(m.parent)) {
      problems.push({ kind: "missing-parent", id: m.id, parent: m.parent, message: `${m.id} follows ${m.parent}, which is not in the directory` });
    }
    const list = children.get(m.parent) ?? [];
    list.push(m);
    children.set(m.parent, list);
  }
  for (const [parent, kids] of children) {
    if (kids.length < 2) continue;
    const ids = kids.map((k) => k.id);
    problems.push({
      kind: "fork",
      parent,
      children: ids,
      message:
        parent === null
          ? `fork: ${ids.join(" and ")} are each a first migration (parent null); rebase all but one onto the chain`
          : `fork: ${ids.join(" and ")} both follow ${parent}; rebase one onto the other`,
    });
  }

  let ordered: Migration[] | undefined;
  const structural = problems.length > 0;
  if (!structural) {
    ordered = [];
    for (let next = children.get(null)?.[0]; next; next = children.get(next.id)?.[0]) ordered.push(next);
    if (ordered.length !== migrations.length) {
      const reached = new Set(ordered.map((m) => m.id));
      const ids = migrations.filter((m) => !reached.has(m.id)).map((m) => m.id);
      problems.push({ kind: "unreachable", ids, message: `${ids.join(", ")} cannot be reached from the first migration (their parents form a cycle)` });
      ordered = undefined;
    }
  }

  for (const m of migrations) {
    const check = verifyChecksum(m);
    if (!check.ok) {
      problems.push({ kind: "checksum", id: m.id, check, message: `${m.id}: its files hash to ${check.actual}, but ${MIGRATION_JSON} records ${check.recorded || "no checksum"}` });
    }
  }
  return { dir, migrations, ordered, problems };
}

/**
 * The migrations in `dir`, from the first to the newest. Throws a
 * {@link MigrationDirectoryError} on any structural problem (unreadable,
 * id mismatch, missing parent, fork, cycle), and, with `verify`, on a
 * checksum mismatch too. A missing `dir` has no migrations.
 */
export function readMigrations(dir: string, options: { verify?: boolean } = {}): Migration[] {
  const scan = scanMigrations(dir);
  const fatal = scan.problems.filter((p) => options.verify === true || p.kind !== "checksum");
  if (fatal.length > 0 || !scan.ordered) throw new MigrationDirectoryError(dir, fatal);
  return scan.ordered;
}

/** The newest migration of an ordered list (the end of the chain), or `undefined` for none. */
export const newestMigration = (ordered: readonly Migration[]): Migration | undefined => ordered[ordered.length - 1];

/**
 * Writes a migration's directory, `<dir>/<id>/`, creating `dir` as needed.
 * The files go into a hidden directory first and are renamed into place, so
 * a reader never sees half a migration. An existing `<id>` is an error.
 * Returns the directory written.
 */
export function writeMigration(dir: string, migration: { id: string; files: MigrationFiles }): string {
  const target = join(dir, migration.id);
  if (existsSync(target)) throw new YodelError(`${target} already exists; a migration's directory is never overwritten`);
  mkdirSync(dir, { recursive: true });
  const staging = join(dir, `.${migration.id}.writing`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging);
  try {
    writeFileSync(join(staging, MIGRATION_SQL), migration.files.sql);
    writeFileSync(join(staging, MIGRATION_JSON), migration.files.json);
    renameSync(staging, target);
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    throw e;
  }
  return target;
}
