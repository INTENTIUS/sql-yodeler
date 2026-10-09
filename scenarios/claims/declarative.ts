import { hold, type Claim, type Ctx } from "../lib/claim.js";
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
async function body(ctx: Ctx): Promise<void> {
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

export const declarative: Claim = {
  name: "declarative",
  says: "the declarative path: yodel plan shows the change against the live server and yodel apply makes it behind the plan-bound gate",
  dialects: { ch: body, pg: body },
};
