/**
 * A Flyway project as `yodel check` reads it (#250, #4400): its `flyway.toml` or
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

import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import * as layout from "@intentius/chant/workspace/flyway-layout";
import { workingTree, type WorkspaceTree } from "@intentius/chant/workspace/tree";
import { YodelError } from "../project.js";

/*
 * The reading itself is chant's `workspace/flyway-layout`, the one the
 * workspace's Flyway kind uses (#4400). This file keeps yodel's view of it:
 * absolute file system paths in, absolute paths out, and a YodelError where
 * chant throws a FlywayPlaceholderError. The tree is rooted at `/`, so a
 * location outside the project (`filesystem:../shared`) still reads.
 */

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

const fsRoot = (): WorkspaceTree => workingTree(sep);
const toTree = (abs: string): string => resolve(abs).split(sep).filter(Boolean).join("/");
const toAbs = (p: string): string => resolve(sep, ...p.split("/"));

/** chant's configuration for each of ours, to hand back to chant's `substitute`. */
const layouts = new WeakMap<FlywayConfig, layout.FlywayConfig>();

/** The first `flyway.toml`, else `flyway.conf`, in `dir` or a directory above it up to `stopAt`. */
export function findFlywayConfig(dir: string, stopAt?: string): string | undefined {
  const at = resolve(dir);
  const top = stopAt === undefined ? undefined : resolve(stopAt);
  // A tree reads up to its root, so the project's directory is the root when `dir` is inside it.
  const inside = top !== undefined && `${at}${sep}`.startsWith(`${top}${sep}`);
  const base = inside ? top : resolve(sep);
  const found = layout.findFlywayConfig(workingTree(base), toTreeUnder(base, at));
  return found === undefined ? undefined : resolve(base, ...found.split("/"));
}

function toTreeUnder(base: string, abs: string): string {
  return relative(base, abs).split(sep).filter(Boolean).join("/");
}

/** The configuration `file` holds, or the defaults with `dir` as the one location when there is none. */
export function readFlywayConfig(file: string | undefined, dir: string): FlywayConfig {
  const c = layout.readFlywayConfig(fsRoot(), file === undefined ? undefined : toTree(file), toTree(dir));
  // Locations chant leaves out as outside the tree: only an absolute `filesystem:` path is one here, as the tree is the whole disk.
  const absolute = c.outside.flatMap((l) => {
    const m = /^filesystem:(.*)$/.exec(l);
    return m?.[1] !== undefined && isAbsolute(m[1]) ? [resolve(m[1])] : [];
  });
  const locations = [...c.locations.map(toAbs), ...absolute];
  if (locations.length === 0) locations.push(resolve(dir));
  const { file: _f, root, locations: _l, codeLocations, outside: _o, url: _u, dialect: _d, ...rest } = c;
  const mine: FlywayConfig = {
    ...rest,
    ...(file !== undefined ? { file: resolve(file) } : {}),
    root: toAbs(root),
    locations,
    codeLocations: codeLocations.map(toAbs),
  };
  layouts.set(mine, c);
  return mine;
}

/** Every file under `dir`, recursively, absolute, sorted; none when it does not exist. */
export function walk(dir: string): string[] {
  return layout.walk(fsRoot(), toTree(dir)).map(toAbs);
}

/** A Flyway SQL callback (`beforeMigrate.sql`, `afterEachMigrate__notify.sql`, ...): run around a migrate, not a migration. */
export const isCallback = (file: string): boolean => layout.isCallback(basename(file));

/** The code migrations (Java, Kotlin) in `config`'s locations, relative to its root. */
export function codeMigrations(config: FlywayConfig): string[] {
  const c = layouts.get(config);
  if (c === undefined) return [];
  // Ours holds the absolute locations (with any absolute `filesystem:` ones), so the tree-relative copy takes them.
  const shared: layout.FlywayConfig = { ...c, locations: config.locations.map(toTree), codeLocations: config.codeLocations.map(toTree) };
  return layout.codeMigrations(fsRoot(), shared).map((f) => relative(config.root, toAbs(f)).split(sep).join("/"));
}

/**
 * `text` with its placeholders replaced, line by line so line numbers hold.
 * A placeholder with no value is a YodelError naming `file` and the line.
 */
export function substitute(text: string, file: string, config: FlywayConfig, fallback: { defaultSchema?: string | undefined } = {}): string {
  const c = layouts.get(config);
  if (c === undefined) return text;
  try {
    return layout.substitute(text, file, c, fallback);
  } catch (e) {
    if (!(e instanceof layout.FlywayPlaceholderError)) throw e;
    const where = config.file === undefined ? "a flyway.toml or flyway.conf beside the migrations" : relative(process.cwd(), config.file) || config.file;
    throw new YodelError(`${e.file}:${String(e.line)}: no value for the placeholder ${e.placeholder}; set it in ${where} (flyway.placeholders.${e.name} in flyway.conf, [flyway.placeholders] in flyway.toml)`);
  }
}
