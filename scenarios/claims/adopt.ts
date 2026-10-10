import { hold, type Claim, type Ctx } from "../lib/claim.js";
import { parse, Project } from "../lib/project.js";

/** The database a team already has, made by hand: no ownership markers, and data. */
async function handMade(ctx: Ctx): Promise<void> {
  const n = ctx.db.name;
  if (ctx.dialect === "ch") {
    await ctx.db.exec(`CREATE DATABASE ${n}`);
    await ctx.db.exec(`CREATE TABLE ${n}.events (id UInt64, ts DateTime, kind LowCardinality(String), payload String DEFAULT '') ENGINE = MergeTree PARTITION BY toYYYYMM(ts) ORDER BY (kind, id) COMMENT 'raw events'`);
    await ctx.db.exec(`CREATE TABLE ${n}.daily (day Date, kind String, n UInt64) ENGINE = SummingMergeTree ORDER BY (day, kind)`);
    await ctx.db.exec(`CREATE VIEW ${n}.recent AS SELECT * FROM ${n}.events WHERE ts > now() - INTERVAL 1 DAY`);
    await ctx.db.exec(`INSERT INTO ${n}.events (id, ts, kind) VALUES (1, now(), 'click'), (2, now(), 'view')`);
  } else {
    await ctx.db.exec(`
      CREATE SCHEMA ${n};
      CREATE TABLE ${n}.customers (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, email text NOT NULL UNIQUE);
      CREATE TABLE ${n}.orders (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, customer_id bigint NOT NULL REFERENCES ${n}.customers(id), status text NOT NULL DEFAULT 'placed');
      CREATE INDEX orders_status_idx ON ${n}.orders (status);
      COMMENT ON TABLE ${n}.orders IS 'raw orders';
      CREATE FUNCTION ${n}.orders_lower_status() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.status := lower(NEW.status); RETURN NEW; END $$;
      CREATE TRIGGER orders_lower_status BEFORE INSERT OR UPDATE ON ${n}.orders FOR EACH ROW EXECUTE FUNCTION ${n}.orders_lower_status();
      INSERT INTO ${n}.customers (email) VALUES ('a@example.invalid'), ('b@example.invalid');`);
  }
}

const comment = (ctx: Ctx) =>
  ctx.db.scalar(
    ctx.dialect === "ch"
      ? `SELECT comment FROM system.tables WHERE database = '${ctx.db.name}' AND name = 'events'`
      : `SELECT obj_description('${ctx.db.name}.orders'::regclass, 'pg_class')`,
  );
const rows = (ctx: Ctx) => ctx.db.count(`SELECT count(*) FROM ${ctx.db.name}.${ctx.dialect === "ch" ? "events" : "customers"}`);

/**
 * `yodel init --from <env>` adopts a database made by hand (on Postgres,
 * with a trigger function and a trigger): it writes the declarations and a
 * baseline migration, records the baseline applied without running it (the objects keep their data and stay as they were),
 * and then yodel plan shows no change and yodel apply has nothing to do.
 * BREAK: one adopted declaration is edited after init (a column's type),
 * so the declared schema no longer matches the server.
 */
async function body(ctx: Ctx): Promise<void> {
  await handMade(ctx);
  const before = { comment: await comment(ctx), rows: await rows(ctx) };
  const p = await Project.create(ctx, { noSource: true });
  const init = await p.yodel(["init", "--from", p.env, "--json"]);
  const doc = parse<{ status: string; migration?: { id: string; checksum: string } }>(init);
  hold(init.code === 0 && doc.status === "adopted", `yodel init --from exited ${String(init.code)} (${doc.status})`);
  hold(doc.migration !== undefined && p.migrationIds().length === 1, "init wrote no baseline migration");
  await p.commit("adopted");
  if (ctx.dialect === "pg") {
    // Functions and triggers are adopted with the tables (#44), so the declared schema holds what the server does.
    const src = p.read("src/schema.ts");
    hold(/= func`/.test(src) && /= trigger`/.test(src) && src.includes("orders_lower_status"), "yodel init --from did not declare the function and the trigger it found");
  }

  if (ctx.broken) {
    if (ctx.dialect === "ch") p.edit("src/schema.ts", "kind LowCardinality(String)", "kind String");
    else p.edit("src/schema.ts", "email text NOT NULL", "email varchar(200) NOT NULL");
  }

  // What a team does next: write a migration for any change, then plan. Neither finds anything.
  const next = await p.newMigration("after-adopt");
  hold(next === undefined, `yodel new after init wrote ${String(next)}: the declarations do not match the adopted baseline`);
  const plan = await p.yodel(["plan", p.env, "--json"]);
  const planned = parse<{ pending?: unknown[]; problems?: unknown[] }>(plan);
  hold(plan.code === 0, `yodel plan after init exited ${String(plan.code)}`);
  hold(planned.pending?.length === 0 && planned.problems?.length === 0, `yodel plan after init shows ${String(planned.pending?.length)} pending and ${String(planned.problems?.length)} problems`);

  // From the server: nothing was sent. The objects are as they were, unmarked, with their data.
  hold((await comment(ctx)) === before.comment, `the adopted table's comment changed from ${JSON.stringify(before.comment)} to ${JSON.stringify(await comment(ctx))}`);
  hold((await rows(ctx)) === before.rows, "the adopted table lost rows");
  {
    const baseline = await ctx.db.count(
      `SELECT count(*) FROM ${ctx.db.history}.history WHERE kind = 'migration' AND status = 'succeeded' AND note LIKE 'baseline:%' AND checksum = '${doc.migration.checksum}'`,
    );
    const statements = await ctx.db.count(`SELECT count(*) FROM ${ctx.db.history}.history WHERE kind = 'statement'`);
    hold(baseline === 1 && statements === 0, `the history holds ${String(baseline)} baseline rows and ${String(statements)} statement rows, not one and none`);
    const status = await p.status();
    hold(status.ran.code === 0 && status.doc.pending?.length === 0, `yodel status after init exited ${String(status.ran.code)} with ${String(status.doc.pending?.length)} pending`);
  }
}

export const adopt: Claim = {
  name: "adopt",
  says: "yodel init --from adopts a live database without touching it, and yodel plan then shows no change",
  dialects: { ch: body, pg: body },
};
