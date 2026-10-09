import { hold, type Claim, type Ctx } from "../lib/claim.js";
import { postgresSession } from "../lib/db.js";
import { Project } from "../lib/project.js";
import { addColumn, mainTable } from "../lib/schema.js";

/**
 * Postgres: a statement blocked behind another session's lock gives up at
 * the profile's lock_timeout (500 ms in the fixture) instead of queueing
 * everyone behind it, and is retried. Another session holds a SHARE lock
 * on the table until the ALTER TABLE has waited on it past one timeout;
 * the statement times out, is retried, and succeeds once the lock goes, and its history row says it hit the
 * timeout.
 * BREAK: the other session keeps its lock for the whole apply.
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

  const holder = await postgresSession();
  try {
    await holder.query("BEGIN");
    await holder.query(`LOCK TABLE ${ctx.db.name}.${mainTable(ctx)} IN SHARE MODE`);
    ctx.log("another session holds a SHARE lock on the table");
    // The Op's Apply step itself, with the approved digest, so the statement meets the lock while it is held.
    const applying = p.yodel(["apply", p.env, "--execute"], { env: { YODEL_APPROVED_PLAN: gated.doc.planDigest, YODEL_LOCK_RETRIES: "4" } });
    if (!ctx.broken) {
      // Let go once the ALTER TABLE has waited on the lock past one lock_timeout (500 ms), however slow the machine.
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const waiting = await ctx.db.count(`SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE 'ALTER TABLE%${ctx.db.name}.${mainTable(ctx)}%'`);
        if (waiting > 0) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      await new Promise((r) => setTimeout(r, 1_500));
      await holder.query("COMMIT");
      ctx.log("the other session let go");
    }
    const applied = await applying;
    hold(applied.code === 0, `the apply blocked behind the lock did not succeed (exit ${String(applied.code)})`);
    hold(/lock_timeout/.test(applied.err), "the apply never hit the lock timeout");
  } finally {
    await holder.query("COMMIT").catch(() => undefined);
    await holder.end();
  }
  hold(await ctx.db.columnExists(mainTable(ctx), "note"), "the column is not on the server");
  const retried = await ctx.db.count(`SELECT count(*) FROM ${ctx.db.history}.history WHERE migration_id = '${id}' AND kind = 'statement' AND status = 'succeeded' AND note LIKE 'lock_timeout%hit%'`);
  hold(retried === 1, "no succeeded statement row says it hit the lock timeout");
}

export const lockRetry: Claim = {
  name: "lock-retry",
  says: "Postgres: a statement blocked behind another session's lock times out at lock_timeout and is retried until it succeeds",
  dialects: { pg: body },
};
