/**
 * Postgres access control in a claim (#45): a role, row-level security on
 * orders, a policy and grants, and access turned on for the claim's
 * environment.
 *
 * The role is named `<schema>__reader`, so the plain and the broken run each
 * have their own, and `Db.reset` drops it with the schema.
 */

import type { Ctx } from "./claim.js";
import type { Project } from "./project.js";

/** The claim's role. */
export const reader = (ctx: Ctx): string => `${ctx.db.name}__reader`;

/**
 * Turns access on (or off) for the claim's environment: in yodel.config.ts
 * (`environments.<env>.access`, what yodel's own plan, new and init read)
 * and in the chant profile (`sql.profiles.<env>.access`), which the
 * declarative path's ApplyOp and chant's drift read, on either dialect.
 */
export function manageAccess(p: Project, on = true): void {
  p.write("yodel.config.ts", `import { defineConfig } from "@intentius/sql-yodeler";\n\nexport default defineConfig({\n  environments: { ${JSON.stringify(p.env)}: { access: ${String(on)} } },\n});\n`);
  const [plain, managed] = p.ctx.dialect === "pg" ? ["lockTimeoutMs: 500,", "lockTimeoutMs: 500,\n        access: true,"] : ["databases: [", "access: true, databases: ["];
  const config = p.read("chant.config.ts");
  if (on && !config.includes(managed)) p.edit("chant.config.ts", plain, managed);
  if (!on && config.includes(managed)) p.edit("chant.config.ts", managed, plain);
}

/** Declares the role, a policy on orders for it and grants on the schema and orders, in src/access.ts; and forces row-level security on orders. */
export function declareAccess(p: Project): void {
  p.edit("src/schema.ts", /\n {2}\)`;\n\nexport const ordersStatus/, "\n  );\n  ALTER TABLE ${db}.orders ENABLE ROW LEVEL SECURITY;\n  ALTER TABLE ${db}.orders FORCE ROW LEVEL SECURITY`;\n\nexport const ordersStatus");
  p.write(
    "src/access.ts",
    `import { grant, policy, role } from "@intentius/chant-lexicon-sql/postgres";
import { db, orders } from "./schema.js";

export const reader = role\`CREATE ROLE ${reader(p.ctx)} NOLOGIN\`;

export const ordersPaid = policy\`
  CREATE POLICY orders_paid ON \${orders} FOR SELECT TO \${reader}
  USING (\${orders.columns.status} = 'paid')\`;

export const useDb = grant\`GRANT USAGE ON SCHEMA \${db} TO \${reader}\`;
export const readOrders = grant\`GRANT SELECT ON \${orders} TO \${reader}\`;
`,
  );
}

/** What the server holds for the role on orders. */
export async function accessOnServer(ctx: Ctx): Promise<{ rls: boolean; forced: boolean; policy: boolean; usage: boolean; select: boolean; insert: boolean }> {
  const n = ctx.db.name;
  const r = reader(ctx);
  const role = (await ctx.db.count(`SELECT count(*) FROM pg_roles WHERE rolname = '${r}'`)) === 1;
  const row = async (sql: string) => (await ctx.db.scalar(sql)) === "true";
  return {
    rls: await row(`SELECT relrowsecurity FROM pg_class WHERE oid = '${n}.orders'::regclass`),
    forced: await row(`SELECT relforcerowsecurity FROM pg_class WHERE oid = '${n}.orders'::regclass`),
    policy: (await ctx.db.count(`SELECT count(*) FROM pg_policies WHERE schemaname = '${n}' AND tablename = 'orders' AND '${r}' = ANY (roles)`)) === 1,
    usage: role && (await row(`SELECT has_schema_privilege('${r}', '${n}', 'USAGE')`)),
    select: role && (await row(`SELECT has_table_privilege('${r}', '${n}.orders', 'SELECT')`)),
    insert: role && (await row(`SELECT has_table_privilege('${r}', '${n}.orders', 'INSERT')`)),
  };
}
