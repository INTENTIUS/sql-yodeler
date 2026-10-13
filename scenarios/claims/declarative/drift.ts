import { hold, partNames, runParts, type Claim, type Ctx } from "../../lib/claim.js";
import { parse, Project } from "../../lib/project.js";
import { addColumn, mainTable } from "../../lib/schema.js";
import { declared } from "./declarative.js";

interface DriftDoc {
  drifted: boolean;
  changed: Array<{ name: string; changes: Array<{ path: string }> }>;
  missing: string[];
  fingerprint?: string;
  against?: { source: string; migration?: string | null };
}

/** Changes the main table's TTL (ClickHouse) or a column default (Postgres) by hand, adds it a column (#273), and drops a declared object (unless `drop` is false). */
async function changeByHand(ctx: Ctx, drop = true): Promise<void> {
  const n = ctx.db.name;
  if (ctx.dialect === "ch") {
    await ctx.db.exec(`ALTER TABLE ${n}.events MODIFY TTL ts + INTERVAL 30 DAY`);
    await ctx.db.exec(`ALTER TABLE ${n}.events ADD COLUMN by_hand String`);
    if (drop) await ctx.db.exec(`DROP TABLE ${n}.daily SYNC`);
  } else {
    await ctx.db.exec(`ALTER TABLE ${n}.orders ALTER COLUMN status SET DEFAULT 'new'`);
    await ctx.db.exec(`ALTER TABLE ${n}.orders ADD COLUMN by_hand text`);
    if (drop) await ctx.db.exec(`DROP INDEX ${n}.orders_status_idx`);
  }
}

const changedProperty = (ctx: Ctx): [string, RegExp] => (ctx.dialect === "ch" ? ["events", /^ttl$/] : ["orders", /default/]);

/**
 * yodel drift reports a declared object changed on the server outside the
 * code (ClickHouse: the events TTL; Postgres: a column default), naming the
 * property, a column added by hand to it (#273), and a declared object
 * dropped (daily; the orders_status_idx index), and exits 2. Before that, with nothing changed, it exits 0.
 * BREAK: the server is not changed, so there is no drift to report.
 */
async function declarativePart(ctx: Ctx): Promise<void> {
  await ctx.db.reset();
  const p = await declared(ctx);
  const clean = await p.yodel(["drift", p.env, "--json"]);
  hold(clean.code === 0, `yodel drift exited ${String(clean.code)} with nothing changed`);
  hold(clean.out.includes('"drifted": false') || /"drifted":\s*false/.test(clean.out), "yodel drift says the freshly applied schema drifted");
  const n = ctx.db.name;
  const [changed, path] = changedProperty(ctx);
  const gone = ctx.dialect === "ch" ? "daily" : "ordersStatus";
  if (!ctx.broken) await changeByHand(ctx);
  ctx.log(`the server's ${mainTable(ctx)}: ${await ctx.db.scalar(ctx.dialect === "ch" ? `SELECT engine_full FROM system.tables WHERE database = '${n}' AND name = 'events'` : `SELECT column_default FROM information_schema.columns WHERE table_schema = '${n}' AND table_name = 'orders' AND column_name = 'status'`)}`);
  const ran = await p.yodel(["drift", p.env, "--json"]);
  const doc = parse<DriftDoc>(ran);
  hold(ran.code === 2 && doc.drifted, `yodel drift exited ${String(ran.code)} after the server changed`);
  hold(doc.changed.some((c) => c.name === changed && c.changes.some((x) => path.test(x.path))), `yodel drift does not name ${changed}'s ${String(path)}: ${JSON.stringify(doc.changed)}`);
  hold(doc.changed.some((c) => c.name === changed && c.changes.some((x) => x.path === "column by_hand")), `yodel drift does not report the column by_hand added to ${changed} by hand: ${JSON.stringify(doc.changed)}`);
  hold(doc.missing.includes(gone), `yodel drift does not report ${gone} gone: ${JSON.stringify(doc.missing)}`);
}

/**
 * On the versioned path drift compares with the history (#49): the schema
 * the newest applied migration records. A migration merged but not applied
 * (a column added in src/ and written by yodel new) is not drift: yodel
 * drift exits 0 and names the applied migration it compared with. A change
 * made by hand is still drift, named, with a fingerprint.
 * BREAK: drift compares with src/ (--against src), so the pending column
 * reads as drift.
 */
async function historyPart(ctx: Ctx): Promise<void> {
  await ctx.db.reset();
  const p = await Project.create(ctx, { name: "versioned" });
  const created = await p.newMigration("create");
  if (created === undefined) throw new Error("yodel new wrote no first migration");
  await p.setupApply();
  addColumn(p, "pending_note");
  if ((await p.newMigration("add-pending-note")) === undefined) throw new Error("yodel new wrote no migration");
  await p.commit("a migration merged, not applied");

  const against = ctx.broken ? ["--against", "src"] : [];
  const pending = await p.yodel(["drift", p.env, "--json", ...against]);
  const doc = parse<DriftDoc>(pending);
  hold(pending.code === 0 && !doc.drifted, `yodel drift exited ${String(pending.code)} with a migration pending and nothing changed by hand: ${JSON.stringify({ changed: doc.changed, missing: doc.missing })}`);
  hold(doc.against?.source === "history" && doc.against.migration === created, `yodel drift compared with ${JSON.stringify(doc.against)}, not ${created}'s recorded schema`);

  await changeByHand(ctx, false);
  const [changed, path] = changedProperty(ctx);
  const ran = await p.yodel(["drift", p.env, "--json", ...against]);
  const after = parse<DriftDoc>(ran);
  hold(ran.code === 2 && after.drifted, `yodel drift exited ${String(ran.code)} after a change by hand`);
  hold(after.changed.some((c) => c.name === changed && c.changes.some((x) => path.test(x.path))), `yodel drift against the history does not name ${changed}'s ${String(path)}: ${JSON.stringify(after.changed)}`);
  hold(/^sha256:[0-9a-f]{64}$/.test(after.fingerprint ?? ""), `yodel drift --json gave no fingerprint: ${String(after.fingerprint)}`);
}

/** The parts, in order, each on its own database (emptied first): the versioned path, then the declarative one. */
const parts = [
  ["history", historyPart],
  ["declarative", declarativePart],
] as const;

async function body(ctx: Ctx): Promise<void> {
  await runParts(ctx, undefined, parts);
}

export const drift: Claim = {
  name: "drift",
  says: "yodel drift reports a declared object changed out of band, naming the property, a column added to it by hand, and one dropped; on the versioned path it compares with the newest applied migration's recorded schema, so a pending migration is not drift",
  dialects: { ch: body, pg: body },
  parts: partNames(parts),
};
