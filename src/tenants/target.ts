/**
 * Tenant targets (#56), the parts every module can import: a tenant of
 * environment `prod` is the target `prod/<tenant>`, and its migrations are
 * the environment's with the template database or schema renamed.
 */

/** Between an environment and a tenant in a target's name. */
export const TENANT_SEPARATOR = "/";

/** A tenant's name: a database or schema name, and part of a target's name and of a file's. */
export const TENANT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `prod/acme` is environment `prod`, tenant `acme`; `prod` is `prod` alone. */
export function splitTarget(name: string): { env: string; tenant?: string } {
  const i = name.indexOf(TENANT_SEPARATOR);
  return i < 0 ? { env: name } : { env: name.slice(0, i), tenant: name.slice(i + 1) };
}

/** The environment a target belongs to: `prod` for `prod/acme` and for `prod`. */
export const baseEnvironment = (name: string): string => splitTarget(name).env;

export const tenantTarget = (env: string, tenant: string): string => `${env}${TENANT_SEPARATOR}${tenant}`;

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `sql` with every identifier `from` replaced by `to`: the name standing
 * alone, bare or quoted (`from.orders`, `"from"`, `` `from` ``), never a
 * longer name that contains it (`from_archive`).
 */
export function renameIdentifier(sql: string, from: string, to: string): string {
  if (from === to) return sql;
  return sql.replace(new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(from)}(?![A-Za-z0-9_$])`, "g"), to);
}
