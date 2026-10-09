import { hold, type Claim, type Ctx } from "../lib/claim.js";
import { Project } from "../lib/project.js";
import { mainTable, needsVersioned } from "../lib/schema.js";

/**
 * A pending migration applies only behind the migrations Op's gate: yodel
 * apply stops at the gate with the server untouched, `chant approve` with
 * the command it printed lets the next yodel apply run, and every history
 * row carries the digest that was approved.
 * BREAK: the approval is skipped, so the second apply stops at the gate too.
 */
async function body(ctx: Ctx): Promise<void> {
  const p = await Project.create(ctx);
  const id = await p.newMigration("create");
  hold(id !== undefined, "yodel new wrote no migration for the fixture's schema");
  await p.commit("the first migration");
  await needsVersioned(p);
  const table = mainTable(ctx);

  const gated = await p.apply();
  hold(gated.ran.code === 3 && gated.doc.status === "gated", `yodel apply did not stop at the gate (exit ${String(gated.ran.code)}, status ${String(gated.doc.status)})`);
  hold(!(await ctx.db.tableExists(table)), `${ctx.db.name}.${table} exists before the approval`);

  if (!ctx.broken) await p.approve(gated.doc.approve);
  const applied = await p.apply();
  hold(applied.ran.code === 0, `yodel apply after the approval exited ${String(applied.ran.code)}, status ${String(applied.doc.status)}`);
  hold(await ctx.db.tableExists(table), `${ctx.db.name}.${table} is not on the server after the approved apply`);
  const digest = gated.doc.planDigest ?? "";
  const rows = await ctx.db.count(`SELECT count(*) FROM ${ctx.db.history}.history`);
  const other = await ctx.db.count(`SELECT count(*) FROM ${ctx.db.history}.history WHERE plan_digest <> '${digest}'`);
  hold(rows > 0 && other === 0, `the history holds ${String(rows)} rows, ${String(other)} not under the approved digest ${digest}`);
}

export const approveAndApply: Claim = {
  name: "approve-and-apply",
  says: "a pending migration applies only after chant approve of its plan digest, and the history records that digest",
  dialects: { ch: body, pg: body },
};
