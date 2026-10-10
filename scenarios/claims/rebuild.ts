import { hold, runParts, type Claim, type Ctx } from "../lib/claim.js";
import { Project } from "../lib/project.js";
import { insertEvents } from "../lib/schema.js";

/** A project whose events table holds 30 rows. */
async function withRows(ctx: Ctx): Promise<Project> {
  const p = await Project.create(ctx);
  await p.newMigration("create");
  await p.setupApply();
  await insertEvents(ctx);
  return p;
}

/** A pending migration changing events' sort key from `from` to `to`, checked to be one ClickHouseRebuildOp step. */
async function rekey(p: Project, name: string, from: string, to: string): Promise<string> {
  p.edit("src/schema.ts", `ORDER BY (${from})`, `ORDER BY (${to})`);
  const id = await p.newMigration(name);
  if (id === undefined) throw new Error("yodel new wrote no migration for the sort-key change");
  await p.commit(`rekey to ${to}`);
  const steps = p.migration(id).steps;
  hold(steps.length === 1 && steps[0]?.kind === "op" && steps[0].op === "ClickHouseRebuildOp", `the sort-key change is not one ClickHouseRebuildOp step: ${JSON.stringify(steps.map((s) => s.op ?? s.sql))}`);
  return id;
}

const sortingKey = (ctx: Ctx) => ctx.db.scalar(`SELECT sorting_key FROM system.tables WHERE database = '${ctx.db.name}' AND name = 'events'`);
const staging = (ctx: Ctx) => ctx.db.count(`SELECT count() FROM system.tables WHERE database = '${ctx.db.name}' AND name LIKE 'events\\_\\_chant%'`);

/**
 * Approved, a sort-key change runs as a ClickHouseRebuildOp step inside the
 * migration: the table has the new sort key and every row, the old table is
 * kept aside, and the history records the step.
 * BREAK: the approval is not given, so the step does not run.
 */
export async function asStepPart(ctx: Ctx, p: Project): Promise<void> {
  const id = await rekey(p, "rekey", "kind, ts", "ts, kind");
  const applied = ctx.broken ? (await p.apply()).ran : await p.stepsApply();
  hold(applied.code === 0, `the approved rebuild did not apply (exit ${String(applied.code)})`);
  hold((await sortingKey(ctx)) === "ts, kind", `the sort key is ${await sortingKey(ctx)}, not ts, kind`);
  hold((await ctx.db.count(`SELECT count() FROM ${ctx.db.name}.events`)) === 30, "events does not hold its 30 rows after the rebuild");
  hold(await ctx.db.tableExists("events__chant_old"), "the old table was not kept as events__chant_old");
  const step = await ctx.db.count(`SELECT count() FROM ${ctx.db.history}.history WHERE migration_id = '${id}' AND kind = 'step' AND status = 'succeeded'`);
  hold(step === 1, "the history has no succeeded step row for the rebuild");
}

interface CleanupDoc {
  retained?: Array<{ name: string; due: boolean }>;
  approve?: string;
  dropped?: string[];
}

/**
 * The old table the rebuild kept is dropped by yodel cleanup once its
 * retention date has passed, behind an approval, and never before. Before
 * the date, yodel plan names it, and yodel cleanup lists it and drops
 * nothing. Once the date has passed (moved back in its comment, as a week
 * would), yodel cleanup stops at the gate with the drop's digest and drops
 * nothing; approved, it drops the table.
 * BREAK: the date is left where it is, so nothing is due and the table is
 * not dropped.
 */
export async function cleanupPart(ctx: Ctx, p: Project): Promise<void> {
  const name = `${ctx.db.name}.events__chant_old`;
  const cleanup = async () => {
    const ran = await p.yodel(["cleanup", p.env, "--json"]);
    try {
      return { code: ran.code, doc: JSON.parse(ran.out) as CleanupDoc };
    } catch {
      throw new Error(`yodel cleanup printed no JSON (exit ${String(ran.code)}): ${ran.err}`);
    }
  };
  const before = await cleanup();
  hold(before.code === 0 && before.doc.retained?.some((r) => r.name === name && !r.due) === true, `yodel cleanup does not list ${name} as kept and not due (exit ${String(before.code)}): ${JSON.stringify(before.doc.retained)}`);
  hold(await ctx.db.tableExists("events__chant_old"), "yodel cleanup dropped the old table before its retention date");
  const plan = await p.yodel(["plan", p.env]);
  hold(plan.out.includes(`${name} (until `), `yodel plan does not name ${name} and its date:\n${plan.out}`);

  if (!ctx.broken) {
    const comment = await ctx.db.scalar(`SELECT comment FROM system.tables WHERE database = '${ctx.db.name}' AND name = 'events__chant_old'`);
    const past = comment.replace(/retain-until=[^ \]]+/, "retain-until=2000-01-01T00%3A00%3A00.000Z");
    await ctx.db.exec(`ALTER TABLE ${name} MODIFY COMMENT '${past.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`);
  }
  const gated = await cleanup();
  if (gated.doc.approve) {
    hold(gated.code === 3 && (await ctx.db.tableExists("events__chant_old")), `yodel cleanup dropped ${name} without an approval (exit ${String(gated.code)})`);
    await p.approve(gated.doc.approve);
  }
  const done = await cleanup();
  hold(done.code === 0 && done.doc.dropped?.includes(name) === true && !(await ctx.db.tableExists("events__chant_old")), `yodel cleanup did not drop ${name} once its date had passed and the drop was approved (exit ${String(done.code)}, dropped ${JSON.stringify(done.doc.dropped)})`);
}

/**
 * A sort-key change is never an ALTER or a DROP and CREATE, and without an
 * approval of its plan nothing runs, neither through yodel apply nor
 * through the Op's Apply step handed the digest. The table keeps its sort
 * key and rows, no staging table is made, and the history has no row for
 * it. The old table the earlier rebuild kept aside is dropped first, as a
 * team does once it is happy with the rebuild.
 * BREAK: the plan is approved, so the rebuild runs.
 */
export async function refusedPart(ctx: Ctx, p: Project): Promise<void> {
  await ctx.db.exec(`DROP TABLE IF EXISTS ${ctx.db.name}.events__chant_old SYNC`);
  const before = await sortingKey(ctx);
  // A key neither earlier state has, so a rebuild that ran shows whatever the parts before left.
  const id = await rekey(p, "rekey-again", "ts, kind", "id, ts");
  const gated = await p.apply();
  if (gated.ran.code !== 3) throw new Error(`yodel apply did not stop at the gate (exit ${String(gated.ran.code)})`);
  if (ctx.broken) await p.approve(gated.doc.approve);
  await p.apply();
  await p.yodel(["apply", p.env, "--execute"], { env: { YODEL_APPROVED_PLAN: gated.doc.planDigest } });
  hold((await sortingKey(ctx)) === before, `the sort key is ${await sortingKey(ctx)}, not ${before}: the rebuild ran without an approval`);
  hold((await staging(ctx)) === 0, "a staging table was made");
  hold((await ctx.db.count(`SELECT count() FROM ${ctx.db.name}.events`)) === 30, "events lost rows");
  hold((await ctx.db.count(`SELECT count() FROM ${ctx.db.history}.history WHERE migration_id = '${id}'`)) === 0, `the history records ${id}`);
}

/** The parts, in order, on one project: an approved rebuild, the old table it kept cleaned up, then a second rebuild refused. */
const parts = [
  ["as-step", asStepPart],
  ["cleanup", cleanupPart],
  ["refused", refusedPart],
] as const;

async function body(ctx: Ctx): Promise<void> {
  await runParts(ctx, await withRows(ctx), parts);
}

export const rebuild: Claim = {
  name: "rebuild",
  says: "ClickHouse: a sort-key change is a ClickHouseRebuildOp step inside the migration, never an ALTER or a drop; approved, it runs and keeps every row, and without an approval it does not run; yodel cleanup drops the old table it kept only after its retention date, behind an approval",
  dialects: { ch: body },
  parts: parts.map(([name]) => name),
};
