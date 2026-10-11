import { hold, runParts, type Claim, type Ctx } from "../../lib/claim.js";
import { Project } from "../../lib/project.js";

/** A table of `name` with an id and one more column, as a declaration. */
const declared = (name: string, column: string) =>
  `import { table } from "@intentius/chant-lexicon-sql/postgres";\nimport { db } from "./schema.js";\n\nexport const ${name} = table\`\n  CREATE TABLE \${db}.${name} (\n    id bigint PRIMARY KEY,\n    ${column}\n  )\`;\n`;

const columnsOf = async (ctx: Ctx, table: string) =>
  (await ctx.db.scalar(`SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = '${ctx.db.name}' AND table_name = '${table}'`)) || "";

/** A pending migration for a rename (or, without its hint, a new column and a dropped one), committed. */
async function renameMigration(p: Project, name: string): Promise<string> {
  const id = await p.newMigration(name);
  if (id === undefined) throw new Error(`yodel new wrote no migration for ${name}`);
  await p.commit(name);
  return id;
}

/**
 * The step fails after its backfill has started and resumes from its
 * receipts: members.nick (2500 rows, batches of 1000) becomes members.alias.
 * A trigger made by hand fails every update of a row past id 2000, so the
 * first apply fills two batches and fails on the third. The step keeps what
 * it did (`onFailure: "keep"`): the new column and two receipts. With the
 * trigger gone, the rerun skips the two batches with a receipt, fills the
 * third, switches and contracts, and every value is under the new name.
 * BREAK: the receipts are deleted before the rerun, so it fills every batch again.
 */
export async function resumePart(ctx: Ctx, p: Project): Promise<void> {
  const db = ctx.db.name;
  p.write("src/members.ts", declared("members", "alias text NOT NULL -- previously: nick"));
  const id = await renameMigration(p, "rename-nick");
  const steps = p.migration(id).steps;
  hold(steps.length === 1 && steps[0]?.op === "PostgresMigrationOp", `the rename is not one PostgresMigrationOp step: ${JSON.stringify(steps.map((s) => s.op ?? s.sql))}`);

  await ctx.db.exec(
    `CREATE FUNCTION ${db}.yodel_71_stop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id > 2000 THEN RAISE EXCEPTION 'forced interruption'; END IF; RETURN NEW; END $$`,
  );
  await ctx.db.exec(`CREATE TRIGGER yodel_71_stop BEFORE UPDATE ON ${db}.members FOR EACH ROW EXECUTE FUNCTION ${db}.yodel_71_stop()`);
  const failed = await p.stepsApply();
  await ctx.db.exec(`DROP TRIGGER yodel_71_stop ON ${db}.members`);
  await ctx.db.exec(`DROP FUNCTION ${db}.yodel_71_stop()`);
  if (failed.code !== 1) throw new Error(`the interrupted step did not fail (exit ${String(failed.code)})`);

  const receipts = `${db}.__chant_receipts`;
  const there = (await ctx.db.scalar(`SELECT to_regclass('${receipts}')::text`)) !== "";
  const kept = there ? await ctx.db.count(`SELECT count(*) FROM ${receipts} WHERE address LIKE '%migrate/%'`) : 0;
  hold(kept === 2, `${String(kept)} batch receipts kept after the failure, not 2`);
  hold((await columnsOf(ctx, "members")).split(",").length === 3, `the failed step did not keep its new column: members has ${await columnsOf(ctx, "members")}`);

  if (ctx.broken) await ctx.db.exec(`DELETE FROM ${receipts} WHERE address LIKE '%migrate/%'`);
  const resumed = await p.stepsApply();
  // Under BREAK the rerun fills every batch again and finishes: the next part goes on from there.
  hold(resumed.code === 0, `the rerun did not finish the step (exit ${String(resumed.code)})`);
  const note = await ctx.db.scalar(`SELECT note FROM ${ctx.db.history}.history WHERE migration_id = '${id}' AND kind = 'step' AND status = 'succeeded' ORDER BY seq DESC LIMIT 1`);
  const summary = JSON.parse(note || "{}") as { skipped?: number; filled?: number; dropped?: boolean };
  hold(summary.skipped === 2 && summary.filled === 1, `the rerun skipped ${String(summary.skipped)} and filled ${String(summary.filled)} batches, not 2 and 1: ${note}`);
  hold(summary.dropped === true, `the rerun did not contract: ${note}`);
  hold((await columnsOf(ctx, "members")) === "id,alias", `members' columns are ${await columnsOf(ctx, "members")}, not id,alias`);
  const moved = await ctx.db.count(`SELECT count(*) FROM ${db}.members WHERE alias = 'm' || id`);
  hold(moved === 2500, `${String(moved)} of 2500 rows kept their value under the new name`);
}

/**
 * A column rename is a PostgresMigrationOp step (expand, backfill, switch,
 * contract) inside the migration, and the data comes along: people.login,
 * 2500 rows, becomes people.handle with every value.
 * BREAK: the rename is declared without its `-- previously: login` hint,
 * so it is a new column and a dropped one, and the values do not follow.
 */
export async function renamePart(ctx: Ctx, p: Project): Promise<void> {
  p.write("src/people.ts", declared("people", ctx.broken ? "handle text NOT NULL" : "handle text NOT NULL -- previously: login"));
  const id = await renameMigration(p, "rename-login");
  const kinds = p.migration(id).steps.map((s) => s.op ?? s.kind);
  ctx.log(`the migration's steps: ${kinds.join(", ")}`);

  const applied = await p.stepsApply();
  hold(applied.code === 0, `the rename did not apply (exit ${String(applied.code)}; steps ${kinds.join(", ")})`);
  const columns = await columnsOf(ctx, "people");
  hold(columns === "id,handle", `people's columns are ${columns}, not id,handle`);
  const kept = await ctx.db.count(`SELECT count(*) FROM ${ctx.db.name}.people WHERE handle = 'user' || id`);
  hold(kept === 2500, `${String(kept)} of 2500 rows kept their value under the new name`);
  const step = await ctx.db.count(`SELECT count(*) FROM ${ctx.db.history}.history WHERE migration_id = '${id}' AND kind = 'step' AND status = 'succeeded'`);
  hold(step === 1, "the history has no succeeded PostgresMigrationOp step row");
}

/**
 * The parts, in order, on one project: a rename whose step fails part way
 * and resumes, then a rename that applies in one go (last, as its break
 * leaves a migration that does not apply).
 */
const parts = [
  ["resume", resumePart],
  ["rename", renamePart],
] as const;

async function body(ctx: Ctx): Promise<void> {
  const p = await Project.create(ctx);
  p.write("src/people.ts", declared("people", "login text NOT NULL"));
  p.write("src/members.ts", declared("members", "nick text NOT NULL"));
  await p.newMigration("create");
  await p.setupApply();
  await ctx.db.exec(`INSERT INTO ${ctx.db.name}.people (id, login) SELECT g, 'user' || g FROM generate_series(1, 2500) g`);
  await ctx.db.exec(`INSERT INTO ${ctx.db.name}.members (id, nick) SELECT g, 'm' || g FROM generate_series(1, 2500) g`);
  await runParts(ctx, p, parts);
}

export const columnChange: Claim = {
  name: "column-change",
  says: "Postgres: a column rename runs as a PostgresMigrationOp step (expand, backfill, switch, contract) and keeps every value; a step that fails part way keeps its work and resumes from its receipts",
  dialects: { pg: body },
  parts: parts.map(([name]) => name),
};
