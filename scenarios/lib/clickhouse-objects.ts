/**
 * ClickHouse dictionaries, SQL functions and access control in a claim
 * (#46): the declarations the declarative claim adds to the fixture, what
 * the declarative claim's adopt part makes by hand, and what the server is asked about them.
 *
 * Every object that belongs to no database (a function, a user, a role) is
 * named `<database>__<name>`, so the plain and the broken run each have
 * their own and `Db.reset` drops them with the database, with the row
 * policies on its tables.
 */

import type { Ctx } from "./claim.js";
import type { Project } from "./project.js";

/** The claim's names: its role, its user, its function, its dictionary. */
export const chNames = (ctx: Ctx) => ({
  reader: `${ctx.db.name}__reader`,
  svc: `${ctx.db.name}__svc`,
  fn: `${ctx.db.name}__scale`,
  dict: "daily_n",
});

/** src/dictionary.ts: a dictionary over daily, keyed by day, with the lifetime given. */
export function declareDictionary(p: Project, lifetime: number): void {
  p.write(
    "src/dictionary.ts",
    `import { dictionary } from "@intentius/chant-lexicon-sql/clickhouse";
import { db } from "./schema.js";

export const dailyN = dictionary\`
  CREATE DICTIONARY \${db}.${chNames(p.ctx).dict} (day Date, n UInt64 DEFAULT 0)
  PRIMARY KEY day
  SOURCE(CLICKHOUSE(TABLE 'daily' DB '${p.ctx.db.name}'))
  LAYOUT(COMPLEX_KEY_HASHED())
  LIFETIME(${String(lifetime)})\`;
`,
  );
}

/** The dictionary's lifetime on the server (its LIFETIME MAX), or "" when there is none. */
export async function dictionaryLifetime(ctx: Ctx): Promise<string> {
  const create = await ctx.db.scalar(`SELECT create_table_query FROM system.tables WHERE database = '${ctx.db.name}' AND name = '${chNames(ctx).dict}'`);
  return /LIFETIME\(MIN \d+ MAX (\d+)\)/.exec(create)?.[1] ?? "";
}

/** Replaces the dictionary by hand, out of band, with another lifetime. */
export async function replaceDictionaryByHand(ctx: Ctx): Promise<void> {
  const n = ctx.db.name;
  await ctx.db.exec(`CREATE OR REPLACE DICTIONARY ${n}.${chNames(ctx).dict} (day Date, n UInt64 DEFAULT 0) PRIMARY KEY day SOURCE(CLICKHOUSE(TABLE 'daily' DB '${n}')) LAYOUT(COMPLEX_KEY_HASHED()) LIFETIME(900)`);
}

/** src/function.ts: a lambda UDF, `(x, k) -> <body>`. */
export function declareFunction(p: Project, body: string): void {
  p.write(
    "src/function.ts",
    `import { func } from "@intentius/chant-lexicon-sql/clickhouse";

export const scale = func\`CREATE FUNCTION ${chNames(p.ctx).fn} AS (x, k) -> ${body}\`;
`,
  );
}

/** What the function gives for (2, 3), or "" when the server has no such function. */
export async function scaled(ctx: Ctx): Promise<string> {
  const { fn } = chNames(ctx);
  if ((await ctx.db.count(`SELECT count() FROM system.functions WHERE name = '${fn}' AND origin = 'SQLUserDefined'`)) !== 1) return "";
  return ctx.db.scalar(`SELECT ${fn}(2, 3)`);
}

/**
 * src/access.ts: a role, a user it is granted to (created by chant: it
 * declares `NOT IDENTIFIED`, a method that holds no secret), a row policy on
 * events for the role, and the role's SELECT on events.
 */
export function declareChAccess(p: Project): void {
  const { reader, svc } = chNames(p.ctx);
  p.write(
    "src/access.ts",
    `import { grant, policy, role, user } from "@intentius/chant-lexicon-sql/clickhouse";
import { events } from "./schema.js";

export const reader = role\`CREATE ROLE ${reader}\`;

export const svc = user\`CREATE USER ${svc} NOT IDENTIFIED\`;

export const clicksOnly = policy\`CREATE ROW POLICY clicks ON \${events} FOR SELECT USING kind = 'click' TO \${reader}\`;

export const readEvents = grant\`GRANT SELECT ON \${events} TO \${reader}\`;
export const svcReads = grant\`GRANT \${reader} TO \${svc}\`;
`,
  );
}

/** What the server holds of the claim's access control. */
export async function chAccessOnServer(ctx: Ctx): Promise<{ role: boolean; user: boolean; policy: boolean; select: boolean; insert: boolean; granted: boolean }> {
  const { reader, svc } = chNames(ctx);
  const role = (await ctx.db.count(`SELECT count() FROM system.roles WHERE name = '${reader}'`)) === 1;
  const user = (await ctx.db.count(`SELECT count() FROM system.users WHERE name = '${svc}'`)) === 1;
  const has = async (type: string) => role && (await ctx.db.count(`SELECT count() FROM system.grants WHERE role_name = '${reader}' AND access_type = '${type}' AND database = '${ctx.db.name}' AND table = 'events'`)) === 1;
  return {
    role,
    user,
    policy: (await ctx.db.count(`SELECT count() FROM system.row_policies WHERE short_name = 'clicks' AND database = '${ctx.db.name}' AND table = 'events' AND has(apply_to_list, '${reader}')`)) === 1,
    select: await has("SELECT"),
    insert: await has("INSERT"),
    granted: user && (await ctx.db.count(`SELECT count() FROM system.role_grants WHERE user_name = '${svc}' AND granted_role_name = '${reader}'`)) === 1,
  };
}
