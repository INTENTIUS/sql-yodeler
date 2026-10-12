import { hold, runParts, type Claim, type Ctx } from "../../lib/claim.js";
import { Project } from "../../lib/project.js";
import { insertEvents } from "../../lib/schema.js";

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
  planDigest?: string;
  approve?: string;
  dropped?: string[];
}

/** The digest of the drop the cleanup part approved, for the cleanup-gate part. */
const cleanupApproved = new WeakMap<Project, string>();

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
    if (gated.doc.planDigest) cleanupApproved.set(p, gated.doc.planDigest);
  }
  const done = await cleanup();
  hold(done.code === 0 && done.doc.dropped?.includes(name) === true && !(await ctx.db.tableExists("events__chant_old")), `yodel cleanup did not drop ${name} once its date had passed and the drop was approved (exit ${String(done.code)}, dropped ${JSON.stringify(done.doc.dropped)})`);
}

/**
 * A cleanup's approval is recorded on a gate of its own, the migrations
 * Op's gate name with -cleanup (#119): after the cleanup part's drop was
 * approved and run, yodel plan names the newest approval of the migrations
 * gate as the apply's, never the cleanup's.
 * BREAK: the cleanup's digest is approved on the migrations gate, as yodel
 * recorded it before #119.
 */
export async function cleanupGatePart(ctx: Ctx, p: Project): Promise<void> {
  const digest = cleanupApproved.get(p) ?? `jcs1-sha256:${"0".repeat(64)}`;
  if (ctx.broken) {
    await p.approve(`chant approve migrate-${p.env} approve-migrate-${p.env} --plan ${digest}`);
    ctx.log("BREAK: the cleanup's digest is approved on the migrations gate");
  }
  const plan = await p.yodel(["plan", p.env, "--json"]);
  if (plan.code !== 0) throw new Error(`yodel plan exited ${String(plan.code)}: ${plan.err}`);
  const doc = JSON.parse(plan.out) as { gate?: string; approval?: { digest?: string } };
  hold(doc.approval?.digest !== digest, `yodel plan names the cleanup's approval (${digest}) as the newest approval of ${doc.gate ?? "the migrations gate"}`);
  const text = await p.yodel(["plan", p.env]);
  hold(!text.out.includes(digest), `yodel plan's text names the cleanup's approval (${digest}):\n${text.out}`);
}

/**
 * The parts, in order, on one project: an approved rebuild, then the old
 * table it kept cleaned up (its approval apart from the apply's). That no
 * approval runs nothing, and the seal checks, are chant's gate.
 */
const parts = [
  ["as-step", asStepPart],
  ["cleanup", cleanupPart],
  ["cleanup-gate", cleanupGatePart],
] as const;

async function body(ctx: Ctx): Promise<void> {
  await runParts(ctx, await withRows(ctx), parts);
}

export const rebuild: Claim = {
  name: "rebuild",
  says: "ClickHouse: a sort-key change is a ClickHouseRebuildOp step inside the migration, never an ALTER or a drop; approved, it runs and keeps every row; yodel cleanup drops the old table it kept only after its retention date, behind an approval on a gate of its own",
  dialects: { ch: body },
  parts: parts.map(([name]) => name),
};
