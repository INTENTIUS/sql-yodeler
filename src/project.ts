/**
 * A SQL Yodeler project: the directory that holds `chant.config.ts`, its
 * dialect, and the server each environment names in `sql.profiles.<env>`.
 *
 * Every verb starts here: `loadProject()` finds and evaluates the config,
 * `resolveEnvironment()` picks one profile. Calling chant is in `./chant/`.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { SqlConfig, SqlProfile } from "@intentius/chant-lexicon-sql/config";
import type { SqlDialect } from "@intentius/chant-lexicon-sql/dialects";
import type { YodelConfig } from "./config/define.js";

export type { SqlDialect, SqlProfile };

/** An error a verb reports as one line on stderr, with the exit code it ends with. */
export class YodelError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "YodelError";
  }
}

/** The parts of a loaded `chant.config.ts` yodel reads. */
export interface ProjectConfig {
  lexicons?: string[];
  sourceDir?: string;
  sql?: SqlConfig;
  [key: string]: unknown;
}

export interface Project {
  /** The absolute directory holding `chant.config.ts`. */
  dir: string;
  configPath: string;
  /** The config as chant loaded and validated it. */
  config: ProjectConfig;
  /** `sql.dialect`, `clickhouse` when the config names none (chant's default). */
  dialect: SqlDialect;
  /** Where the declared schema lives, relative to `dir`: `sourceDir`, else `src` when it exists, else `.`. */
  sourceDir: string;
  /** `yodel.config.ts`, checked, when the project has one (`./config/`). */
  yodel?: { path: string; config: YodelConfig } | undefined;
}

export interface Environment {
  name: string;
  /** `sql.profiles.<name>`. */
  profile: SqlProfile;
}

/** The nearest directory at or above `start` that holds `chant.config.ts`. */
export function findProjectDir(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "chant.config.ts"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * The dialect a config declares. A list is refused: yodel manages one
 * database per project, and one chant build holds one dialect.
 */
export function projectDialect(config: ProjectConfig, configPath: string): SqlDialect {
  const dialect = config.sql?.dialect;
  if (dialect === undefined) return "clickhouse";
  if (Array.isArray(dialect)) {
    if (dialect.length === 1 && dialect[0]) return dialect[0];
    throw new YodelError(`${configPath}: sql.dialect lists ${dialect.join(", ")}; a yodel project is one database, so name one dialect`);
  }
  return dialect;
}

/** Builds a {@link Project} from a config already loaded. Pure, for tests and callers that load the config themselves. */
export function projectFromConfig(dir: string, configPath: string, config: ProjectConfig, yodel?: Project["yodel"]): Project {
  if (!(config.lexicons ?? []).includes("sql")) {
    throw new YodelError(`${configPath}: lexicons does not include "sql"; add lexicons: ["sql"] and import "@intentius/chant-lexicon-sql"`);
  }
  const sourceDir = config.sourceDir ?? (existsSync(join(dir, "src")) ? "src" : ".");
  return { dir, configPath, config, dialect: projectDialect(config, configPath), sourceDir, ...(yodel ? { yodel } : {}) };
}

/**
 * Finds the project at or above `start` (default: the working directory) and
 * loads its `chant.config.ts` through chant's own loader, so it is validated
 * the same way `chant build` validates it, and its `yodel.config.ts` when
 * there is one.
 */
export async function loadProject(start: string = process.cwd()): Promise<Project> {
  const dir = findProjectDir(start);
  if (!dir) throw new YodelError(`no chant.config.ts in ${resolve(start)} or any directory above it`);
  const { loadChantConfig } = await import("@intentius/chant/config");
  let loaded: Awaited<ReturnType<typeof loadChantConfig>>;
  try {
    loaded = await loadChantConfig(dir);
  } catch (e) {
    throw new YodelError(e instanceof Error ? e.message : String(e));
  }
  const config = loaded.config as ProjectConfig;
  const { loadYodelConfig } = await import("./config/load.js");
  const yodel = await loadYodelConfig(dir, Object.keys(config.sql?.profiles ?? {}));
  return projectFromConfig(dir, loaded.configPath ?? join(dir, "chant.config.ts"), config, yodel);
}

/** `sql.profiles.<name>`, or an error naming the environments the project declares. */
export function resolveEnvironment(project: Project, name: string): Environment {
  const profiles = project.config.sql?.profiles ?? {};
  const profile = profiles[name];
  if (!profile) {
    const declared = Object.keys(profiles);
    throw new YodelError(
      `no environment "${name}": ${project.configPath} declares no sql.profiles.${name}` +
        (declared.length > 0 ? ` (declared: ${declared.join(", ")})` : " (it declares no sql.profiles)"),
    );
  }
  const postgres = /^postgres(ql)?:\/\//.test(profile.url);
  if (postgres !== (project.dialect === "postgres")) {
    throw new YodelError(
      `sql.profiles.${name}.url is a ${postgres ? "Postgres" : "ClickHouse"} server, but the project's dialect is ${project.dialect}`,
    );
  }
  return { name, profile };
}
