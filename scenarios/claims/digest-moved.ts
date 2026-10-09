import { hold, type Claim, type Ctx } from "../lib/claim.js";
import { Project } from "../lib/project.js";
import { addColumn, mainTable } from "../lib/schema.js";

/**
 * An approval binds the plan it was given for. The migration is approved,
 * then its migration.sql is edited by hand: yodel apply stops at the gate
 * again, the Op's Apply step handed the old approval refuses, and nothing
 * reaches the server or the history.
 * BREAK: the migration is not edited after the approval, so it applies.
 */
async function body(ctx: Ctx): Promise<void> {
  const p = await Project.create(ctx);
  await p.newMigration("create");
  if ((await p.approvedApply()).ran.code !== 0) throw new Error("the first migration did not apply");
  addColumn(p, "note");
  const id = await p.newMigration("add-note");
  if (id === undefined) throw new Error("yodel new wrote no migration");
  await p.commit("add note");

  const gated = await p.apply();
  if (gated.ran.code !== 3) throw new Error(`yodel apply did not stop at the gate (exit ${String(gated.ran.code)})`);
  await p.approve(gated.doc.approve);
  if (!ctx.broken) {
    const sql = `migrations/${id}/migration.sql`;
    if (ctx.dialect === "ch") p.edit(sql, "note String DEFAULT ''", "note String DEFAULT 'tampered'");
    else p.edit(sql, "note text", "note varchar(8)");
    await p.commit("an edit after the approval");
  }

  const again = await p.apply();
  hold(again.ran.code !== 0, "yodel apply ran a migration edited after its approval");
  const stale = await p.yodel(["apply", p.env, "--execute"], { env: { YODEL_APPROVED_PLAN: gated.doc.planDigest } });
  hold(stale.code !== 0, "the Apply step ran with an approval given before the migration was edited");
  hold(!(await ctx.db.columnExists(mainTable(ctx), "note")), `${ctx.db.name}.${mainTable(ctx)}.note is on the server: the moved plan was applied`);
  hold((await ctx.db.count(`SELECT count(*) FROM ${ctx.db.history}.history WHERE migration_id = '${id}'`)) === 0, `the history records ${id}`);
}

export const digestMoved: Claim = {
  name: "digest-moved",
  says: "an approval is refused once the migration changed after it, and nothing is applied",
  dialects: { ch: body, pg: body },
};
