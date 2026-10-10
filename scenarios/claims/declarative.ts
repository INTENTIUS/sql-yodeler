import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hold, Violation, type Claim, type Ctx } from "../lib/claim.js";
import { parse, Project } from "../lib/project.js";
import { addColumn, mainTable } from "../lib/schema.js";

/** A declarative project (no migrations/) applied once behind its ApplyOp's gate. */
export async function declared(ctx: Ctx): Promise<Project> {
  const p = await Project.create(ctx, { ops: "declarative" });
  // Setup for the claims built on it: a step that goes wrong here is an error, never a catch.
  const first = await p.apply();
  if (first.ran.code !== 3 || first.doc.status !== "gated") throw new Error(`yodel apply did not stop at the ApplyOp's gate (exit ${String(first.ran.code)})`);
  if (await ctx.db.tableExists(mainTable(ctx))) throw new Error("the table exists before the approval");
  await p.approve(first.doc.approve);
  const applied = await p.apply();
  if (applied.ran.code !== 0 || !(await ctx.db.tableExists(mainTable(ctx)))) throw new Error(`the approved plan did not apply (exit ${String(applied.ran.code)})`);
  return p;
}

/**
 * The declarative path: yodel plan shows the change from the live server
 * to the declared schema, yodel apply makes it behind the ApplyOp's
 * plan-bound gate, and the plan is then empty.
 * BREAK: the source changes again between the approval and the apply, so
 * the approval no longer covers the plan and the column is not added.
 */
async function declaredPart(ctx: Ctx): Promise<void> {
  const p = await declared(ctx);
  addColumn(p, "note");
  const plan = await p.yodel(["plan", p.env, "--json"]);
  const planned = parse<{ changes: unknown[] }>(plan);
  hold(plan.code === 0 && planned.changes.length === 1, `yodel plan shows ${String(planned.changes.length)} changes for one added column`);
  const gated = await p.apply();
  if (gated.ran.code !== 3) throw new Error(`yodel apply did not stop at the gate (exit ${String(gated.ran.code)})`);
  await p.approve(gated.doc.approve);
  if (ctx.broken) addColumn(p, "extra");
  await p.apply();
  hold(await ctx.db.columnExists(mainTable(ctx), "note"), "the approved column is not on the server");
  const after = await p.yodel(["plan", p.env, "--json"]);
  hold(after.code === 0 && parse<{ changes: unknown[] }>(after).changes.length === 0, "yodel plan after the apply is not empty");
}

/** The ORM's DDL, scenarios/fixtures/<dialect>/orm/schema.sql: customers and invoices. */
const ormDdl = (ctx: Ctx): string => readFileSync(fileURLToPath(new URL(`../fixtures/${ctx.dialect === "ch" ? "clickhouse" : "postgres"}/orm/schema.sql`, import.meta.url)), "utf8");

/** A column added to the ORM's customers model, as the ORM would print it. */
function addOrmColumn(p: Project, column: string): void {
  const ch = p.ctx.dialect === "ch";
  // After the created_at column, the last of customers' columns.
  const at = ch ? "    created_at DateTime DEFAULT now()" : `    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,`;
  p.edit("db/orm.sql", at, ch ? `${at},\n    ${column} String DEFAULT ''` : `${at}\n    "${column}" TEXT,`);
}

/**
 * An ORM-exported schema (#67): the project's yodel.config.ts declares a DDL
 * source, a command printing the DDL an ORM would (the fixture's
 * orm/schema.sql; no ORM is installed). yodel reads it into declarations
 * beside src/, so the first apply creates the ORM's tables behind the gate,
 * a model change (a column added to customers) is one change in yodel plan
 * and is applied once approved, and the plan is then empty.
 * BREAK: the ORM's DDL changes again between the approval and the apply,
 * so the approval no longer covers the plan and the column is not added.
 */
async function ormPart(ctx: Ctx): Promise<void> {
  const p = await Project.create(ctx, { ops: "declarative", name: "orm" });
  p.write("db/orm.sql", ormDdl(ctx));
  p.write(
    "yodel.config.ts",
    `import { defineConfig } from "@intentius/sql-yodeler";\n\nexport default defineConfig({\n  sources: { orm: { command: "cat db/orm.sql", schema: "${ctx.db.name}" } },\n});\n`,
  );
  await p.commit("an ORM's schema as a DDL source");
  const first = await p.apply();
  if (first.ran.code !== 3) throw new Error(`yodel apply did not stop at the ApplyOp's gate (exit ${String(first.ran.code)}): ${first.ran.err.slice(-600)}`);
  await p.commit("the ORM's declarations");
  await p.approve(first.doc.approve);
  const created = await p.apply();
  if (created.ran.code !== 0 || !(await ctx.db.tableExists("invoices"))) throw new Error(`the ORM's tables were not created (exit ${String(created.ran.code)})`);

  addOrmColumn(p, "phone");
  const plan = await p.yodel(["plan", p.env, "--json"]);
  const planned = parse<{ changes: Array<{ object: string }> }>(plan);
  hold(plan.code === 0 && planned.changes.length === 1 && planned.changes.every((c) => c.object.includes("customers")), `yodel plan shows ${JSON.stringify(planned.changes)} for one column added to the ORM's customers model`);
  const gated = await p.apply();
  if (gated.ran.code !== 3) throw new Error(`yodel apply did not stop at the gate (exit ${String(gated.ran.code)})`);
  await p.approve(gated.doc.approve);
  if (ctx.broken) addOrmColumn(p, "fax");
  await p.apply();
  hold(await ctx.db.columnExists("customers", "phone"), "the approved column of the ORM's model is not on the server");
  const after = await p.yodel(["plan", p.env, "--json"]);
  hold(after.code === 0 && parse<{ changes: unknown[] }>(after).changes.length === 0, `yodel plan after the apply is not empty: ${after.out.slice(0, 600)}`);
}

/**
 * Each part on its own database (emptied between them). Under BREAK each
 * breaks its own property, and the run is caught only when both catch it.
 */
async function body(ctx: Ctx): Promise<void> {
  const caught: string[] = [];
  const parts: Array<[string, () => Promise<void>]> = [
    ["declared", () => declaredPart(ctx)],
    ["orm", () => ormPart(ctx)],
  ];
  for (const [name, part] of parts) {
    await ctx.db.reset();
    try {
      await part();
    } catch (e) {
      if (!(ctx.broken && e instanceof Violation)) throw e;
      ctx.log(`${name} caught: ${e.message}`);
      caught.push(e.message);
    }
  }
  if (ctx.broken && caught.length === parts.length) throw new Violation(caught.join("; "));
  if (ctx.broken) ctx.log(`only ${String(caught.length)} of the ${String(parts.length)} parts caught their break`);
}

export const declarative: Claim = {
  name: "declarative",
  says: "the declarative path: yodel plan shows the change against the live server and yodel apply makes it behind the plan-bound gate, for src/ declarations and for an ORM's exported DDL",
  dialects: { ch: body, pg: body },
};
