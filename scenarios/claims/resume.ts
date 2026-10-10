import { hold, runParts, type Claim, type Ctx } from "../lib/claim.js";
import { endpoints, clickhouseAt } from "../lib/db.js";
import { Project } from "../lib/project.js";
import { addColumn, addColumnByHand, addTable, createTableByHand, forgetMigration, insertEvents, mainTable } from "../lib/schema.js";

const FAIL = "YODEL_34_FAIL_AT";

/**
 * The backfill module: one effect() per batch, each filling the batch's rows
 * and logging the batch in backfill_log. The batch whose index
 * YODEL_34_FAIL_AT names fails: on ClickHouse before it changes anything, on
 * Postgres after its UPDATE and INSERT, which its transaction rolls back.
 */
const backfill = (ctx: Ctx, batches: number[]) => {
  const db = ctx.db.name;
  const statements =
    ctx.dialect === "ch"
      ? `...(i === failAt ? [activity("yodelSql", { sql: "SELECT throwIf(1, 'forced interruption')" }, "atMostOnce")] : []),
    activity("yodelSql", { sql: \`ALTER TABLE ${db}.events UPDATE note = concat('n-', kind) WHERE toYYYYMM(ts) = \${String(b)}\`, settings: { mutations_sync: "2" } }, "atMostOnce"),
    activity("yodelSql", { sql: \`INSERT INTO ${db}.backfill_log (batch) VALUES (\${String(b)})\` }, "atMostOnce"),`
      : `activity("yodelSql", { sql: \`UPDATE ${db}.orders SET note = 'n-' || status WHERE id % ${String(batches.length)} = \${String(b)}\` }, "atMostOnce"),
    activity("yodelSql", { sql: \`INSERT INTO ${db}.backfill_log (batch) VALUES (\${String(b)})\` }, "atMostOnce"),
    ...(i === failAt ? [activity("yodelSql", { sql: "DO $$ BEGIN RAISE EXCEPTION 'forced interruption'; END $$" }, "atMostOnce")] : []),`;
  return `import { EffectReceipt } from "@intentius/chant";
import { Op, activity, effect, phase } from "@intentius/chant/op";

const batches = ${JSON.stringify(batches)};
const failAt = Number(process.env.${FAIL} ?? -1);

const batch = (b: number, i: number) =>
  effect(EffectReceipt(\`note-\${String(b)}\`, { effect: \`note/\${String(b)}\`, flavor: "existence" }), [
    ${statements}
  ]);

export const op = Op({ name: "backfill-note", overview: "note from the row, a batch at a time", phases: [phase("Backfill", batches.map(batch))] });
`;
};

/** Where the receipts are: chant's receipts table on ClickHouse; on Postgres, __chant_receipts in the history's schema. */
const receipts = (ctx: Ctx) => {
  const prefix = `yodel/${ctx.env}/`;
  if (ctx.dialect === "ch") {
    return {
      count: async () => ((await ctx.db.scalar("EXISTS TABLE chant_receipts.receipts")) === "1" ? ctx.db.count(`SELECT uniqExact(address) FROM chant_receipts.receipts WHERE startsWith(address, '${prefix}')`) : 0),
      drop: async () => {
        if ((await ctx.db.scalar("EXISTS TABLE chant_receipts.receipts")) === "1") {
          await ctx.db.exec(`ALTER TABLE chant_receipts.receipts DELETE WHERE startsWith(address, '${prefix}') SETTINGS mutations_sync = 2`);
        }
      },
    };
  }
  const table = `${ctx.db.history}.__chant_receipts`;
  const there = async () => (await ctx.db.scalar(`SELECT to_regclass('${table}')::text`)) !== "";
  return {
    count: async () => ((await there()) ? ctx.db.count(`SELECT count(*) FROM ${table} WHERE starts_with(address, '${prefix}')`) : 0),
    drop: async () => {
      if (await there()) await ctx.db.exec(`DELETE FROM ${table} WHERE starts_with(address, '${prefix}')`);
    },
  };
};

const backfillLog = (ctx: Ctx) =>
  ctx.dialect === "ch"
    ? `import { table } from "@intentius/chant-lexicon-sql/clickhouse";\nimport { db } from "./schema.js";\n\nexport const backfillLog = table\`\n  CREATE TABLE \${db}.backfill_log (\n    batch UInt32\n  )\n  ENGINE = MergeTree\n  ORDER BY batch\`;\n`
    : `import { table } from "@intentius/chant-lexicon-sql/postgres";\nimport { db } from "./schema.js";\n\nexport const backfillLog = table\`\n  CREATE TABLE \${db}.backfill_log (\n    batch integer NOT NULL\n  )\`;\n`;

/**
 * A hand-written backfill is a step of its migration, one receipt per
 * batch. Interrupted at its last batch, the apply fails with the first
 * batches done (on Postgres, the last batch's own changes rolled back with
 * its transaction); the rerun skips every batch with a receipt and runs the
 * rest, so each batch ran exactly once (backfill_log has one row per batch,
 * and an INSERT run twice would leave two) and every row is filled.
 * BREAK: the receipts are deleted before the rerun, so it cannot resume.
 */
export async function backfillPart(ctx: Ctx, p: Project): Promise<void> {
  const store = receipts(ctx);
  await store.drop();
  let batches: number[];
  let rows: string;
  if (ctx.dialect === "ch") {
    await insertEvents(ctx);
    batches = (await clickhouseAt(endpoints.clickhouse, `SELECT DISTINCT toYYYYMM(ts) AS m FROM ${ctx.db.name}.events ORDER BY m`)).trim().split("\n").map(Number);
    if (batches.length < 2) throw new Error(`events spans ${String(batches.length)} months`);
    rows = `SELECT count() FROM ${ctx.db.name}.events WHERE note != concat('n-', kind)`;
  } else {
    await ctx.db.exec(`INSERT INTO ${ctx.db.name}.orders (status, amount) SELECT CASE WHEN g % 2 = 0 THEN 'placed' ELSE 'paid' END, g FROM generate_series(1, 30) g`);
    batches = [0, 1, 2];
    rows = `SELECT count(*) FROM ${ctx.db.name}.orders WHERE note IS DISTINCT FROM 'n-' || status`;
  }

  addColumn(p, "note");
  p.write("src/backfill_log.ts", backfillLog(ctx));
  p.write("backfill.ts", backfill(ctx, batches));
  const id = await p.newMigration("note", ["--backfill", "backfill.ts"]);
  if (id === undefined) throw new Error("yodel new wrote no migration");
  await p.commit("note, with its backfill");

  const last = batches.length - 1;
  const failed = await p.stepsApply({ [FAIL]: String(last) });
  if (failed.code !== 1) throw new Error(`the interrupted backfill did not fail (exit ${String(failed.code)})`);
  const done = await ctx.db.count(`SELECT count(*) FROM ${ctx.db.name}.backfill_log`);
  hold(done === last, `${String(done)} batches ran before the interruption, not ${String(last)}`);
  const kept = await store.count();
  hold(kept === last, `${String(kept)} receipts after the interruption, not ${String(last)}`);

  if (ctx.broken) await store.drop();
  const resumed = await p.stepsApply();
  // Under BREAK the rerun runs every batch again, and finishes: the next part goes on from there.
  hold(resumed.code === 0, `the rerun did not finish (exit ${String(resumed.code)})`);
  await store.drop();
  const log =
    ctx.dialect === "ch"
      ? await ctx.db.scalar(`SELECT groupArray(batch) FROM (SELECT batch FROM ${ctx.db.name}.backfill_log ORDER BY batch)`)
      : `[${await ctx.db.scalar(`SELECT string_agg(batch::text, ',' ORDER BY batch) FROM ${ctx.db.name}.backfill_log`)}]`;
  hold(log === `[${batches.join(",")}]`, `the batches that ran, in order: ${log}; each should have run once: [${batches.join(",")}]`);
  const unfilled = await ctx.db.count(rows);
  hold(unfilled === 0, `${String(unfilled)} rows were not backfilled`);
}

/**
 * A migration that fails part way resumes at the statement that failed.
 * The migration adds a column and a table; the object its later statement
 * makes is made by hand first, so that statement fails after the earlier
 * one ran. Once the hand-made object is gone, the rerun sends only the
 * failed statement: the earlier one, sent again, would fail (the object is
 * there), and the history shows it started once.
 * BREAK: the history's rows for the migration are deleted before the rerun,
 * so yodel no longer knows where it stopped.
 */
export async function statementPart(ctx: Ctx, p: Project): Promise<void> {
  addColumn(p, "memo");
  addTable(p, "audit");
  const id = await p.newMigration("memo-and-audit");
  if (id === undefined) throw new Error("yodel new wrote no migration");
  await p.commit("memo and audit");

  const steps = p.migration(id).steps;
  const audit = steps.findIndex((s) => s.kind === "statement" && /CREATE TABLE \S*audit/.test(s.sql ?? ""));
  const memo = steps.findIndex((s) => s.kind === "statement" && /ADD COLUMN \S*memo/.test(s.sql ?? ""));
  if (audit < 0 || memo < 0) throw new Error(`the migration's statements are not the column and the table: ${JSON.stringify(steps.map((s) => s.sql))}`);
  const [earlier, later] = audit < memo ? [audit, memo] : [memo, audit];
  const table = mainTable(ctx);
  if (later === audit) await createTableByHand(ctx, "audit");
  else await addColumnByHand(ctx, "memo");

  const failed = await p.stepsApply();
  if (failed.code !== 1) throw new Error(`the apply did not fail at statement ${String(later)} (exit ${String(failed.code)})`);
  const status = await p.status();
  const partWay = status.doc.partWay?.find((w) => w.id === id);
  hold(partWay?.resumeAt === later, `yodel status says ${id} resumes at ${String(partWay?.resumeAt)}, not statement ${String(later)}`);

  if (ctx.broken) await forgetMigration(ctx, id);
  if (later === audit) await ctx.db.exec(`DROP TABLE ${ctx.db.name}.audit`);
  else await ctx.db.exec(`ALTER TABLE ${ctx.db.name}.${table} DROP COLUMN memo`);

  const resumed = await p.stepsApply();
  hold(resumed.code === 0, `the rerun did not finish the migration (exit ${String(resumed.code)}): it did not resume at statement ${String(later)}`);
  hold((await ctx.db.columnExists(table, "memo")) && (await ctx.db.tableExists("audit")), "the column or the table is missing after the rerun");
  const started = await ctx.db.count(
    `SELECT count(*) FROM ${ctx.db.history}.history WHERE migration_id = '${id}' AND kind = 'statement' AND statement_index = ${String(earlier)} AND status = 'started'`,
  );
  hold(started === 1, `statement ${String(earlier)} was sent ${String(started)} times`);
}

/**
 * The parts, in order, on one project: a migration whose backfill step is
 * interrupted and resumed from its receipts, then one whose statement
 * fails and is resumed from the history.
 */
const parts = [
  ["backfill", backfillPart],
  ["statement", statementPart],
] as const;

async function body(ctx: Ctx): Promise<void> {
  const p = await Project.create(ctx);
  await p.newMigration("create");
  await p.setupApply();
  await runParts(ctx, p, parts);
}

export const resume: Claim = {
  name: "resume",
  says: "an interrupted apply resumes where it stopped: a hand-written backfill step from its receipts, running each batch once, and a failed statement at that statement, never resending one that ran",
  dialects: { ch: body, pg: body },
  parts: parts.map(([name]) => name),
};
