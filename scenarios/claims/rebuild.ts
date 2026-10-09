import { hold, type Claim, type Ctx } from "../lib/claim.js";
import { Project } from "../lib/project.js";
import { insertEvents } from "../lib/schema.js";

/** A project whose events table holds 30 rows, and a pending migration changing its sort key. */
async function rekeyed(ctx: Ctx): Promise<{ p: Project; id: string }> {
  const p = await Project.create(ctx);
  await p.newMigration("create");
  if ((await p.approvedApply()).ran.code !== 0) throw new Error("the first migration did not apply");
  await insertEvents(ctx);
  p.edit("src/schema.ts", "ORDER BY (kind, ts)", "ORDER BY (ts, kind)");
  const id = await p.newMigration("rekey");
  if (id === undefined) throw new Error("yodel new wrote no migration for the sort-key change");
  await p.commit("rekey");
  const steps = p.migration(id).steps;
  hold(steps.length === 1 && steps[0]?.kind === "op" && steps[0].op === "ClickHouseRebuildOp", `the sort-key change is not one ClickHouseRebuildOp step: ${JSON.stringify(steps.map((s) => s.op ?? s.sql))}`);
  return { p, id };
}

const sortingKey = (ctx: Ctx) => ctx.db.scalar(`SELECT sorting_key FROM system.tables WHERE database = '${ctx.db.name}' AND name = 'events'`);
const staging = (ctx: Ctx) => ctx.db.count(`SELECT count() FROM system.tables WHERE database = '${ctx.db.name}' AND name LIKE 'events\\_\\_chant%'`);

/**
 * A sort-key change is never an ALTER or a DROP and CREATE: yodel new
 * writes it as a ClickHouseRebuildOp step, and without an approval of its
 * plan nothing runs, neither through yodel apply nor through the Op's
 * Apply step handed the digest. The table keeps its sort key and rows, no
 * staging table is made, and the history has no row for it.
 * BREAK: the plan is approved, so the rebuild runs.
 */
async function refused(ctx: Ctx): Promise<void> {
  const { p, id } = await rekeyed(ctx);
  const gated = await p.apply();
  if (gated.ran.code !== 3) throw new Error(`yodel apply did not stop at the gate (exit ${String(gated.ran.code)})`);
  if (ctx.broken) await p.approve(gated.doc.approve);
  await p.apply();
  await p.yodel(["apply", p.env, "--execute"], { env: { YODEL_APPROVED_PLAN: gated.doc.planDigest } });
  hold((await sortingKey(ctx)) === "kind, ts", `the sort key is ${await sortingKey(ctx)}: the rebuild ran without an approval`);
  hold((await staging(ctx)) === 0, "a staging table was made");
  hold((await ctx.db.count(`SELECT count() FROM ${ctx.db.name}.events`)) === 30, "events lost rows");
  hold((await ctx.db.count(`SELECT count() FROM ${ctx.db.history}.history WHERE migration_id = '${id}'`)) === 0, `the history records ${id}`);
}

/**
 * Approved, the sort-key change runs as a ClickHouseRebuildOp step inside
 * the migration: the table has the new sort key and every row, the old
 * table is kept aside, and the history records the step.
 * BREAK: the approval is not given, so the step does not run.
 */
async function asStep(ctx: Ctx): Promise<void> {
  const { p, id } = await rekeyed(ctx);
  const applied = ctx.broken ? await p.apply() : await p.approvedApply();
  hold(applied.ran.code === 0, `the approved rebuild did not apply (exit ${String(applied.ran.code)})`);
  hold((await sortingKey(ctx)) === "ts, kind", `the sort key is ${await sortingKey(ctx)}, not ts, kind`);
  hold((await ctx.db.count(`SELECT count() FROM ${ctx.db.name}.events`)) === 30, "events does not hold its 30 rows after the rebuild");
  hold(await ctx.db.tableExists("events__chant_old"), "the old table was not kept as events__chant_old");
  const step = await ctx.db.count(`SELECT count() FROM ${ctx.db.history}.history WHERE migration_id = '${id}' AND kind = 'step' AND status = 'succeeded'`);
  hold(step === 1, "the history has no succeeded step row for the rebuild");
}

export const rebuildRefused: Claim = {
  name: "rebuild-refused",
  says: "ClickHouse: a sort-key change is a rebuild step that does not run without an approval, never an ALTER or a drop",
  dialects: { ch: refused },
};

export const rebuildAsStep: Claim = {
  name: "rebuild-as-step",
  says: "ClickHouse: an approved sort-key change runs as a ClickHouseRebuildOp step inside the migration, keeping every row",
  dialects: { ch: asStep },
};
