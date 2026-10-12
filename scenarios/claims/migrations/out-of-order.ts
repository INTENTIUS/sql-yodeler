import { hold, type Claim, type Ctx } from "../../lib/claim.js";
import { Project } from "../../lib/project.js";
import { addColumn, addTable } from "../../lib/schema.js";

/**
 * Two branches each add a migration after the same one. main's (B) merges
 * and is applied first; the feature branch's (A) merges after. The fork is
 * resolved the way a team might without --env: `yodel rebase B --onto A`
 * rewrites B, which already ran, so `yodel repair B` records the edit. A
 * is now before B in the chain but not applied: out of order. yodel apply
 * refuses it with exit 4 and the table it makes is not created; with
 * --allow-out-of-order it applies (never skipped).
 * BREAK: the files are ordered the other way, A rebased onto B, so A is in
 * order and the plain apply runs it.
 */
async function body(ctx: Ctx): Promise<void> {
  const p = await Project.create(ctx);
  await p.newMigration("create");
  await p.commit("create");
  await p.setupApply();

  await p.git("checkout", "-q", "-b", "feature");
  addTable(p, "late");
  const a = await p.newMigration("add-late");
  await p.commit("add late");
  await p.git("checkout", "-q", "main");
  addColumn(p, "note");
  const b = await p.newMigration("add-note");
  await p.commit("add note");
  if (a === undefined || b === undefined) throw new Error("yodel new wrote no migration");
  await p.setupApply();
  await p.git("merge", "-q", "--no-edit", "feature");

  if (ctx.broken) {
    const rebased = await p.yodel(["rebase", a, "--onto", b]);
    if (rebased.code !== 0) throw new Error(`yodel rebase ${a} --onto ${b} exited ${String(rebased.code)}`);
  } else {
    const rebased = await p.yodel(["rebase", b, "--onto", a]);
    if (rebased.code !== 0) throw new Error(`yodel rebase ${b} --onto ${a} exited ${String(rebased.code)}`);
    const repaired = await p.yodel(["repair", b, p.env, "--reason", `rebased onto ${a}`]);
    if (repaired.code !== 0) throw new Error(`yodel repair ${b} exited ${String(repaired.code)}`);
  }
  await p.commit("the fork resolved");

  const status = await p.status();
  hold((status.doc.outOfOrder ?? []).includes(a), `yodel status does not list ${a} out of order (${JSON.stringify(status.doc.outOfOrder)})`);
  const refused = await p.approvedApply();
  hold(refused.ran.code === 4, `yodel apply exited ${String(refused.ran.code)}, not 4, with ${a} out of order`);
  hold(!(await ctx.db.tableExists("late")), `${a} was applied out of order without --allow-out-of-order`);

  // What yodel apply --allow-out-of-order hands the Op's steps.
  const allowed = await p.stepsApply({ YODEL_ALLOW_OUT_OF_ORDER: "1" });
  hold(allowed.code === 0 && (await ctx.db.tableExists("late")), `with --allow-out-of-order ${a} did not apply (exit ${String(allowed.code)})`);
}

export const outOfOrder: Claim = {
  name: "out-of-order",
  says: "a migration merged late, before one already applied, is refused unless --allow-out-of-order, and never skipped",
  // History ordering, the same on both dialects.
  dialects: { pg: body },
};
