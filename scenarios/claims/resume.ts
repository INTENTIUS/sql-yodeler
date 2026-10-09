import { hold, type Claim, type Ctx } from "../lib/claim.js";
import { Project } from "../lib/project.js";
import { addColumn, addColumnByHand, addTable, createTableByHand, forgetMigration, mainTable } from "../lib/schema.js";

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
async function body(ctx: Ctx): Promise<void> {
  const p = await Project.create(ctx);
  await p.newMigration("create");
  if ((await p.approvedApply()).ran.code !== 0) throw new Error("the first migration did not apply");
  addColumn(p, "note");
  addTable(p, "audit");
  const id = await p.newMigration("note-and-audit");
  if (id === undefined) throw new Error("yodel new wrote no migration");
  await p.commit("note and audit");

  const steps = p.migration(id).steps;
  const audit = steps.findIndex((s) => s.kind === "statement" && /CREATE TABLE \S*audit/.test(s.sql ?? ""));
  const note = steps.findIndex((s) => s.kind === "statement" && /ADD COLUMN \S*note/.test(s.sql ?? ""));
  if (audit < 0 || note < 0) throw new Error(`the migration's statements are not the column and the table: ${JSON.stringify(steps.map((s) => s.sql))}`);
  const [earlier, later] = audit < note ? [audit, note] : [note, audit];
  const table = mainTable(ctx);
  if (later === audit) await createTableByHand(ctx, "audit");
  else await addColumnByHand(ctx, "note");

  const failed = await p.approvedApply();
  if (failed.ran.code !== 1) throw new Error(`the apply did not fail at statement ${String(later)} (exit ${String(failed.ran.code)})`);
  const status = await p.status();
  const partWay = status.doc.partWay?.find((w) => w.id === id);
  hold(partWay?.resumeAt === later, `yodel status says ${id} resumes at ${String(partWay?.resumeAt)}, not statement ${String(later)}`);

  if (ctx.broken) await forgetMigration(ctx, id);
  if (later === audit) await ctx.db.exec(`DROP TABLE ${ctx.db.name}.audit`);
  else await ctx.db.exec(`ALTER TABLE ${ctx.db.name}.${table} DROP COLUMN note`);

  const resumed = await p.approvedApply();
  hold(resumed.ran.code === 0, `the rerun did not finish the migration (exit ${String(resumed.ran.code)}): it did not resume at statement ${String(later)}`);
  hold((await ctx.db.columnExists(table, "note")) && (await ctx.db.tableExists("audit")), "the column or the table is missing after the rerun");
  const started = await ctx.db.count(
    `SELECT count(*) FROM ${ctx.db.history}.history WHERE migration_id = '${id}' AND kind = 'statement' AND statement_index = ${String(earlier)} AND status = 'started'`,
  );
  hold(started === 1, `statement ${String(earlier)} was sent ${String(started)} times`);
}

export const resume: Claim = {
  name: "resume",
  says: "a migration that failed part way resumes at the statement that failed, never resending one that ran",
  dialects: { ch: body, pg: body },
};
