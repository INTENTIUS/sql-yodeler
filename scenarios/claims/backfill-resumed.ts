import { hold, type Claim, type Ctx } from "../lib/claim.js";
import { endpoints, clickhouseAt } from "../lib/db.js";
import { Project } from "../lib/project.js";
import { addColumn, insertEvents } from "../lib/schema.js";

const FAIL = "YODEL_34_FAIL_AT";

/** Three batches, one per month present in events; the batch whose index YODEL_34_FAIL_AT names fails before it changes anything. */
const backfill = (db: string, months: number[]) => `import { EffectReceipt } from "@intentius/chant";
import { Op, activity, effect, phase } from "@intentius/chant/op";

const months = ${JSON.stringify(months)};
const failAt = Number(process.env.${FAIL} ?? -1);
const sync = { mutations_sync: "2" };

const batch = (m: number, i: number) =>
  effect(EffectReceipt(\`note-\${String(m)}\`, { effect: \`note/\${String(m)}\`, flavor: "existence" }), [
    ...(i === failAt ? [activity("yodelSql", { sql: "SELECT throwIf(1, 'forced interruption')" }, "atMostOnce")] : []),
    activity("yodelSql", { sql: \`ALTER TABLE ${db}.events UPDATE note = concat('n-', kind) WHERE toYYYYMM(ts) = \${String(m)}\`, settings: sync }, "atMostOnce"),
    activity("yodelSql", { sql: \`INSERT INTO ${db}.backfill_log (batch) VALUES (\${String(m)})\` }, "atMostOnce"),
  ]);

export const op = Op({ name: "backfill-note", overview: "note from kind, a month at a time", phases: [phase("Backfill", months.map(batch))] });
`;

/**
 * A hand-written backfill is a step of its migration, one receipt per
 * batch. Interrupted at its last batch, the apply fails with the first
 * batches done; the rerun skips every batch with a receipt and runs the
 * rest, so each batch ran exactly once (backfill_log has one row per
 * batch, and an INSERT run twice would leave two) and every row is filled.
 * BREAK: the receipts are deleted before the rerun, so it cannot resume.
 */
async function body(ctx: Ctx): Promise<void> {
  const prefix = `yodel/${ctx.env}/`;
  const receiptsThere = async () => (await ctx.db.scalar("EXISTS TABLE chant_receipts.receipts")) === "1";
  const dropReceipts = async () => {
    if (await receiptsThere()) await ctx.db.exec(`ALTER TABLE chant_receipts.receipts DELETE WHERE startsWith(address, '${prefix}') SETTINGS mutations_sync = 2`);
  };
  await dropReceipts();
  const p = await Project.create(ctx);
  await p.newMigration("create");
  if ((await p.approvedApply()).ran.code !== 0) throw new Error("the first migration did not apply");
  await insertEvents(ctx);
  const months = (await clickhouseAt(endpoints.clickhouse, `SELECT DISTINCT toYYYYMM(ts) AS m FROM ${ctx.db.name}.events ORDER BY m`)).trim().split("\n").map(Number);
  if (months.length < 2) throw new Error(`events spans ${String(months.length)} months`);

  addColumn(p, "note");
  p.write(
    "src/backfill_log.ts",
    `import { table } from "@intentius/chant-lexicon-sql/clickhouse";\nimport { db } from "./schema.js";\n\nexport const backfillLog = table\`\n  CREATE TABLE \${db}.backfill_log (\n    batch UInt32\n  )\n  ENGINE = MergeTree\n  ORDER BY batch\`;\n`,
  );
  p.write("backfill.ts", backfill(ctx.db.name, months));
  const id = await p.newMigration("note", ["--backfill", "backfill.ts"]);
  if (id === undefined) throw new Error("yodel new wrote no migration");
  await p.commit("note, with its backfill");

  const last = months.length - 1;
  const failed = await p.approvedApply([], { [FAIL]: String(last) });
  if (failed.ran.code !== 1) throw new Error(`the interrupted backfill did not fail (exit ${String(failed.ran.code)})`);
  const done = await ctx.db.count(`SELECT count() FROM ${ctx.db.name}.backfill_log`);
  hold(done === last, `${String(done)} batches ran before the interruption, not ${String(last)}`);

  if (ctx.broken) await dropReceipts();
  const resumed = await p.approvedApply();
  hold(resumed.ran.code === 0, `the rerun did not finish (exit ${String(resumed.ran.code)})`);
  const log = await ctx.db.scalar(`SELECT groupArray(batch) FROM (SELECT batch FROM ${ctx.db.name}.backfill_log ORDER BY batch)`);
  hold(log === `[${months.join(",")}]`, `the batches that ran, in order: ${log}; each should have run once: [${months.join(",")}]`);
  const unfilled = await ctx.db.count(`SELECT count() FROM ${ctx.db.name}.events WHERE note != concat('n-', kind)`);
  hold(unfilled === 0, `${String(unfilled)} events were not backfilled`);
  await dropReceipts();
}

export const backfillResumed: Claim = {
  name: "backfill-resumed",
  says: "a hand-written backfill step interrupted part way resumes from its receipts, running each batch once",
  // On Postgres a backfill step refuses ("runs its SQL on ClickHouse"); #39.
  dialects: { ch: body, pg: { needs: "#39" } },
  shares: ["chant_receipts"],
};
