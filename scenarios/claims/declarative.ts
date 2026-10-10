import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hold, partDialects, partNames, runParts, type Claim, type Ctx, type PartEntry } from "../lib/claim.js";
import { parse, Project } from "../lib/project.js";
import { declareRoutines, insertedStatus, replaceFunctionByHand, routinesOnServer } from "../lib/routines.js";
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
async function column(ctx: Ctx, { p }: Declarative): Promise<void> {
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

/**
 * Postgres functions, procedures and triggers (#44): a trigger function, a
 * trigger on the existing orders table that runs it, and a procedure are
 * planned with their classes (the trigger as SQLPG283, the lock it takes on
 * a table that exists) and applied behind the gate; the trigger then fires,
 * and the plan is empty.
 * BREAK: the function is replaced by hand after the apply, so the server
 * no longer holds what is declared and the plan is not empty.
 */
async function routines(ctx: Ctx, { p }: Declarative): Promise<void> {
  declareRoutines(p);
  const plan = await p.yodel(["plan", p.env, "--json"]);
  const rules = parse<{ changes: Array<{ object: string; rule: string }> }>(plan).changes.map((c) => `${c.object.split(" ")[0] ?? ""} ${c.rule}`);
  for (const want of ["lowerStatus SQLPG200", "archiveOrders SQLPG200", "ordersLowerStatus SQLPG283"]) {
    hold(rules.includes(want), `yodel plan does not show ${want}: ${rules.join(", ")}`);
  }
  const gated = await p.apply();
  if (gated.ran.code !== 3) throw new Error(`yodel apply did not stop at the gate (exit ${String(gated.ran.code)})`);
  await p.approve(gated.doc.approve);
  const applied = await p.apply();
  hold(applied.ran.code === 0, `the approved routines did not apply (exit ${String(applied.ran.code)})`);
  const on = await routinesOnServer(ctx);
  hold(on.fn && on.proc && on.trigger, `on the server: function ${String(on.fn)}, procedure ${String(on.proc)}, trigger ${String(on.trigger)}`);
  hold((await insertedStatus(ctx)) === "shipped", "the trigger did not lower-case an inserted status");
  if (ctx.broken) await replaceFunctionByHand(ctx);
  const after = await p.yodel(["plan", p.env, "--json"]);
  const left = parse<{ changes: Array<{ object: string }> }>(after).changes.map((c) => c.object);
  hold(after.code === 0 && left.length === 0, `yodel plan after the routines applied is not empty: ${left.join(", ")}`);
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
 * It runs on its own database: the one the src/ parts used is emptied first.
 * BREAK: the ORM's DDL changes again between the approval and the apply,
 * so the approval no longer covers the plan and the column is not added.
 */
async function orm(ctx: Ctx): Promise<void> {
  await ctx.db.reset();
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

/** The project the src/ parts run on: declarative, applied once. */
interface Declarative {
  p: Project;
}

/** The parts, in order: the src/ declarations, a column added and on Postgres the routines (#44), on one project; then an ORM's DDL (#67) on a project of its own. */
const parts: ReadonlyArray<PartEntry<Declarative>> = [
  ["column", column],
  ["routines", routines, ["pg"]],
  ["orm", orm],
];

async function body(ctx: Ctx): Promise<void> {
  await runParts(ctx, { p: await declared(ctx) }, parts);
}

export const declarative: Claim = {
  name: "declarative",
  says: "the declarative path: yodel plan shows the change against the live server and yodel apply makes it behind the plan-bound gate, for src/ declarations (on Postgres, functions, procedures and triggers too) and for an ORM's exported DDL",
  dialects: { ch: body, pg: body },
  parts: partNames(parts),
  partDialects: partDialects(parts),
};
