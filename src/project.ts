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
import { splitTarget, TENANT_NAME } from "./tenants/target.js";

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
  /**
   * `sql.profiles.<env>.access` as chant.config.ts says it, before
   * yodel.config.ts's `environments.<env>.access` is put in {@link config}'s
   * profile. Only the environments whose profile sets it.
   */
  profileAccess?: Record<string, boolean>;
}

export interface Environment {
  name: string;
  /** `sql.profiles.<name>`; a tenant's is its environment's, on the tenant's database or schema. */
  profile: SqlProfile;
  /** A tenant of a tenant set (#56): `name` is `<env>/<tenant>`. */
  tenant?: TenantOf;
}

/** Which tenant an {@link Environment} is. */
export interface TenantOf {
  /** The environment whose tenant set names it. */
  env: string;
  name: string;
  /** The database (ClickHouse) or schema (Postgres) the environment's profile names, which the migrations are written against. */
  template: string;
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
  const { config: withAccess, profileAccess } = accessInProfiles(config, yodel?.config);
  return { dir, configPath, config: withAccess, dialect: projectDialect(config, configPath), sourceDir, ...(yodel ? { yodel } : {}), profileAccess };
}

/**
 * `config` with each profile's `access` set to yodel.config.ts's
 * `environments.<env>.access` where it sets one, so the chant functions yodel
 * calls in process (the plan, the import, the server reads) manage access as
 * yodel.config.ts says. Pure.
 */
export function accessInProfiles(config: ProjectConfig, yodel: YodelConfig | undefined): { config: ProjectConfig; profileAccess: Record<string, boolean> } {
  const profiles = config.sql?.profiles ?? {};
  const profileAccess: Record<string, boolean> = {};
  for (const [name, profile] of Object.entries(profiles)) {
    const access = (profile as { access?: unknown }).access;
    if (typeof access === "boolean") profileAccess[name] = access;
  }
  const own = Object.entries(yodel?.environments ?? {}).filter(([name, e]) => e.access !== undefined && profiles[name] !== undefined);
  if (own.length === 0) return { config, profileAccess };
  const next = { ...profiles };
  for (const [name, e] of own) next[name] = { ...profiles[name], access: e.access } as (typeof profiles)[string];
  return { config: { ...config, sql: { ...config.sql, profiles: next } }, profileAccess };
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

/**
 * `sql.profiles.<name>`, or an error naming the environments the project
 * declares. A tenant, `<env>/<tenant>`, is `<env>`'s profile on the
 * tenant's database or schema; it is added to the loaded config's
 * `sql.profiles` under its own name, so chant binds it like any profile.
 * Whether a tenant set given by a file or a query names it is checked when
 * its server is opened (`openVersioned`).
 */
export function resolveEnvironment(project: Project, name: string): Environment {
  const { env: base, tenant } = splitTarget(name);
  if (tenant !== undefined) return resolveTenant(project, base, tenant);
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

function resolveTenant(project: Project, base: string, tenant: string): Environment {
  const env = resolveEnvironment(project, base);
  const set = project.yodel?.config.environments?.[base]?.tenants;
  if (!set) throw new YodelError(`no environment "${base}/${tenant}": ${base} has no tenant set (yodel.config.ts environments.${base}.tenants)`);
  if (!TENANT_NAME.test(tenant)) throw new YodelError(`"${tenant}" is not a tenant name (letters, digits and _, not starting with a digit)`);
  if (Array.isArray(set) && !set.includes(tenant)) throw new YodelError(`no tenant "${tenant}" in ${base}'s tenant set (${set.join(", ")})`);
  const key = project.dialect === "postgres" ? "schemas" : "databases";
  const named = (env.profile as unknown as Record<string, unknown>)[key];
  const template = Array.isArray(named) && named.length === 1 && typeof named[0] === "string" ? named[0] : undefined;
  if (!template) {
    throw new YodelError(
      `${base} has a tenant set, so sql.profiles.${base}.${key} must name exactly one ${project.dialect === "postgres" ? "schema" : "database"}: the template its tenants are made from, which the migrations are written against`,
    );
  }
  const name = `${base}/${tenant}`;
  const profile: SqlProfile = { ...env.profile, [key]: [tenant] };
  const sql = (project.config.sql ??= {} as SqlConfig);
  sql.profiles = { ...(sql.profiles ?? {}), [name]: profile };
  return { name, profile, tenant: { env: base, name: tenant, template } };
}
