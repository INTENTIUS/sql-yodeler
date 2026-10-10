/**
 * Tenant sets (#56): one environment over many databases (ClickHouse) or
 * schemas (Postgres) with the same migrations.
 *
 * `yodel.config.ts` `environments.<env>.tenants` lists them (names, a file,
 * or a read-only query on the environment's server). Each tenant is a
 * target of its own, `<env>/<tenant>`: its profile is the environment's on
 * the tenant's database or schema (`resolveEnvironment`), its history is
 * `<history database>_<tenant>` (`environmentSettings`), and every
 * statement and check is sent with the template's name replaced by the
 * tenant's ({@link tenantDriver}). The apply pipeline renders the
 * environment's wave with a run per tenant, one gate over all of them.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { TenantSet } from "../config/define.js";
import { resolveEnvironment, YodelError, type Environment, type Project, type TenantOf } from "../project.js";
import type { VersionedDriver } from "../versioned/driver.js";
import { renameIdentifier, splitTarget, TENANT_NAME, tenantTarget } from "./target.js";

export * from "./target.js";

/** `env`'s tenant set in yodel.config.ts, if it has one. */
export const tenantSetOf = (project: Pick<Project, "yodel">, env: string): TenantSet | undefined => project.yodel?.config.environments?.[env]?.tenants;

function checked(names: readonly string[], where: string): string[] {
  const bad = names.filter((n) => !TENANT_NAME.test(n));
  if (bad.length > 0) throw new YodelError(`${where} lists ${bad.map((b) => JSON.stringify(b)).join(", ")}, which ${bad.length === 1 ? "is not a tenant name" : "are not tenant names"} (letters, digits and _, not starting with a digit)`);
  return [...new Set(names)];
}

/** Reads a tenant file: a JSON array of names, or one name per line (`#` starts a comment). */
export function readTenantFile(path: string): string[] {
  if (!existsSync(path)) throw new YodelError(`the tenant file ${path} does not exist`);
  const text = readFileSync(path, "utf8");
  if (text.trimStart().startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new YodelError(`${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!Array.isArray(parsed) || !parsed.every((t) => typeof t === "string")) throw new YodelError(`${path}: expected a JSON array of tenant names`);
    return checked(parsed, path);
  }
  return checked(text.split("\n").map((l) => l.replace(/#.*/, "").trim()).filter(Boolean), path);
}

/**
 * The tenants of `env`, in the order the set gives them; undefined when it
 * has no set. A query runs read-only on the environment's server, with its
 * profile, and its rows' first column are the names.
 */
export async function listTenants(project: Project, env: string): Promise<string[] | undefined> {
  const set = tenantSetOf(project, env);
  if (set === undefined) return undefined;
  if (Array.isArray(set)) return [...set];
  if ("file" in set) return readTenantFile(resolve(project.dir, set.file));
  const { openVersioned, closeVersioned } = await import("../versioned/engine.js");
  const venv = await openVersioned(project, resolveEnvironment(project, env));
  try {
    let rows: Array<Record<string, unknown>>;
    try {
      rows = await venv.driver.readCheck(set.query, {});
    } catch (e) {
      throw new YodelError(`${env}'s tenant query failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return checked(rows.map((r) => { const v = Object.values(r)[0]; return typeof v === "string" ? v : JSON.stringify(v ?? ""); }), `${env}'s tenant query`);
  } finally {
    await closeVersioned(venv);
  }
}

/** Throws unless `env`'s tenant set names the tenant `env` is. */
export async function checkTenant(project: Project, env: Environment): Promise<void> {
  if (!env.tenant) return;
  const set = tenantSetOf(project, env.tenant.env);
  if (Array.isArray(set)) return; // resolveEnvironment checked it.
  const names = (await listTenants(project, env.tenant.env)) ?? [];
  if (!names.includes(env.tenant.name)) {
    throw new YodelError(`no tenant "${env.tenant.name}" in ${env.tenant.env}'s tenant set (${set && "file" in set ? set.file : "its query"} lists ${names.length > 0 ? names.join(", ") : "none"})`);
  }
}

/**
 * The targets `names` stand for: an environment with a tenant set is each
 * of its tenants, `<env>/<tenant>`; any other name is itself.
 */
export async function expandTargets(project: Project, names: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const name of names) {
    const tenants = splitTarget(name).tenant === undefined ? await listTenants(project, name) : undefined;
    if (tenants) out.push(...tenants.map((t) => tenantTarget(name, t)));
    else out.push(name);
  }
  return out;
}

/**
 * A tenant's driver: the environment's, with the template's name replaced
 * by the tenant's in every statement and check it sends. An Op step (a
 * rebuild, a backfill) gets the tenant in its context, and its runner
 * renames what the step names (`../steps/index.ts`).
 */
export function tenantDriver(driver: VersionedDriver, tenant: TenantOf): VersionedDriver {
  const rename = (sql: string) => renameIdentifier(sql, tenant.template, tenant.name);
  const where = (w: { defaultDatabase?: string | undefined; defaultSchema?: string | undefined }) => ({
    ...(w.defaultDatabase !== undefined ? { defaultDatabase: rename(w.defaultDatabase) } : {}),
    ...(w.defaultSchema !== undefined ? { defaultSchema: rename(w.defaultSchema) } : {}),
  });
  return {
    ...driver,
    readCheck: (sql, w) => driver.readCheck(rename(sql), where(w)),
    runStatement: (step, run) => driver.runStatement({ ...step, sql: rename(step.sql) }, run),
    stepContext: () => ({ ...driver.stepContext(), tenant }),
  };
}
