import { hold, type Claim, type Ctx } from "../lib/claim.js";
import { parse } from "../lib/project.js";
import { mainTable } from "../lib/schema.js";
import { declared } from "./declarative.js";

/**
 * yodel drift reports a declared object changed on the server outside the
 * code (ClickHouse: the events TTL; Postgres: a column default), naming the
 * property, and a declared object dropped (daily; the orders_status_idx
 * index), and exits 2. Before that, with nothing changed, it exits 0.
 * BREAK: the server is not changed, so there is no drift to report.
 */
async function body(ctx: Ctx): Promise<void> {
  const p = await declared(ctx);
  const clean = await p.yodel(["drift", p.env, "--json"]);
  hold(clean.code === 0, `yodel drift exited ${String(clean.code)} with nothing changed`);
  hold(clean.out.includes('"drifted": false') || /"drifted":\s*false/.test(clean.out), "yodel drift says the freshly applied schema drifted");
  const n = ctx.db.name;
  const [changed, path, gone] = ctx.dialect === "ch" ? ["events", /^ttl$/, "daily"] : ["orders", /default/, "ordersStatus"];
  if (!ctx.broken) {
    if (ctx.dialect === "ch") {
      await ctx.db.exec(`ALTER TABLE ${n}.events MODIFY TTL ts + INTERVAL 30 DAY`);
      await ctx.db.exec(`DROP TABLE ${n}.daily SYNC`);
    } else {
      await ctx.db.exec(`ALTER TABLE ${n}.orders ALTER COLUMN status SET DEFAULT 'new'`);
      await ctx.db.exec(`DROP INDEX ${n}.orders_status_idx`);
    }
  }
  ctx.log(`the server's ${mainTable(ctx)}: ${await ctx.db.scalar(ctx.dialect === "ch" ? `SELECT engine_full FROM system.tables WHERE database = '${n}' AND name = 'events'` : `SELECT column_default FROM information_schema.columns WHERE table_schema = '${n}' AND table_name = 'orders' AND column_name = 'status'`)}`);
  const ran = await p.yodel(["drift", p.env, "--json"]);
  const doc = parse<{ drifted: boolean; changed: Array<{ name: string; changes: Array<{ path: string }> }>; missing: string[] }>(ran);
  hold(ran.code === 2 && doc.drifted, `yodel drift exited ${String(ran.code)} after the server changed`);
  hold(doc.changed.some((c) => c.name === changed && c.changes.some((x) => path.test(x.path))), `yodel drift does not name ${changed}'s ${String(path)}: ${JSON.stringify(doc.changed)}`);
  hold(doc.missing.includes(gone), `yodel drift does not report ${gone} gone: ${JSON.stringify(doc.missing)}`);
}

export const drift: Claim = {
  name: "drift",
  says: "yodel drift reports a declared object changed out of band, naming the property, and one dropped",
  dialects: { ch: body, pg: body },
};
