/**
 * Postgres functions, procedures and triggers in the claims fixture (#44):
 * the declarations the declarative and new claims add, and what the server
 * is asked about them.
 */

import type { Ctx } from "./claim.js";
import type { Project } from "./project.js";

/**
 * src/routines.ts: a trigger function that lower-cases orders.status, the
 * trigger on orders (a table that already exists) that runs it, and a
 * procedure. `byName`: the trigger names the function in its text instead
 * of through its declaration, and the function is not declared (a function
 * dropped while a trigger still uses it). `keep`: the procedure takes a
 * second parameter.
 */
export function routinesSource(options: { byName?: boolean; keep?: boolean } = {}): string {
  const fn = options.byName
    ? ""
    : `
export const lowerStatus = func\`
  CREATE FUNCTION \${db}.orders_lower_status() RETURNS trigger LANGUAGE plpgsql
  AS $$ BEGIN NEW.status := lower(NEW.status); RETURN NEW; END $$\`;
`;
  const runs = options.byName ? "yodel_34_claim.orders_lower_status()" : "${lowerStatus}()";
  return `import { ${options.byName ? "" : "func, "}procedure, trigger } from "@intentius/chant-lexicon-sql/postgres";
import { db, orders } from "./schema.js";
${fn}
export const ordersLowerStatus = trigger\`
  CREATE TRIGGER orders_lower_status BEFORE INSERT OR UPDATE ON \${orders}
  FOR EACH ROW EXECUTE FUNCTION ${runs}\`;

export const archiveOrders = procedure\`
  CREATE PROCEDURE \${db}.archive_orders(before_id bigint${options.keep ? ", keep int" : ""}) LANGUAGE sql
  AS $$ DELETE FROM \${orders} WHERE id < before_id $$\`;
`;
}

/** Writes src/routines.ts, with the claim's schema in place of the fixture's. */
export function declareRoutines(p: Project, options: Parameters<typeof routinesSource>[0] = {}): void {
  p.write("src/routines.ts", routinesSource(options).replaceAll("yodel_34_claim", p.ctx.db.name));
}

/** Whether the server has the function, the procedure and the trigger on orders. */
export async function routinesOnServer(ctx: Ctx): Promise<{ fn: boolean; proc: boolean; trigger: boolean }> {
  const n = ctx.db.name;
  const proc = async (name: string, kind: string) => (await ctx.db.count(`SELECT count(*) FROM pg_proc WHERE pronamespace = '${n}'::regnamespace AND proname = '${name}' AND prokind = '${kind}'`)) === 1;
  return {
    fn: await proc("orders_lower_status", "f"),
    proc: await proc("archive_orders", "p"),
    trigger: (await ctx.db.count(`SELECT count(*) FROM pg_trigger WHERE tgrelid = '${n}.orders'::regclass AND tgname = 'orders_lower_status' AND NOT tgisinternal`)) === 1,
  };
}

/** Inserts an order with an upper-case status and reads back what was stored: the trigger, when it runs, lower-cases it. */
export async function insertedStatus(ctx: Ctx): Promise<string> {
  return ctx.db.scalar(`INSERT INTO ${ctx.db.name}.orders (status, amount) VALUES ('SHIPPED', 1) RETURNING status`);
}

/** Replaces the function's body by hand, out of band: it no longer changes the status. */
export async function replaceFunctionByHand(ctx: Ctx): Promise<void> {
  await ctx.db.exec(`CREATE OR REPLACE FUNCTION ${ctx.db.name}.orders_lower_status() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`);
}
