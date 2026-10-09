import { hold, type Claim, type Ctx } from "../lib/claim.js";
import { Project } from "../lib/project.js";

/**
 * Postgres: a column rename is a PostgresMigrationOp step (expand,
 * backfill, switch, contract) inside the migration, and the data comes
 * along: people.login, 2500 rows, becomes people.handle with every value.
 * BREAK: the rename is declared without its `-- previously: login` hint,
 * so it is a new column and a dropped one, and the values do not follow.
 */
async function body(ctx: Ctx): Promise<void> {
  const p = await Project.create(ctx);
  const people = (column: string) =>
    `import { table } from "@intentius/chant-lexicon-sql/postgres";\nimport { db } from "./schema.js";\n\nexport const people = table\`\n  CREATE TABLE \${db}.people (\n    id bigint PRIMARY KEY,\n    ${column}\n  )\`;\n`;
  p.write("src/people.ts", people("login text NOT NULL"));
  await p.newMigration("create");
  if ((await p.approvedApply()).ran.code !== 0) throw new Error("the first migration did not apply");
  await ctx.db.exec(`INSERT INTO ${ctx.db.name}.people (id, login) SELECT g, 'user' || g FROM generate_series(1, 2500) g`);

  p.write("src/people.ts", people(ctx.broken ? "handle text NOT NULL" : "handle text NOT NULL -- previously: login"));
  const id = await p.newMigration("rename-login");
  if (id === undefined) throw new Error("yodel new wrote no migration for the rename");
  await p.commit("rename login");
  const kinds = p.migration(id).steps.map((s) => s.op ?? s.kind);
  ctx.log(`the migration's steps: ${kinds.join(", ")}`);

  const applied = await p.approvedApply();
  hold(applied.ran.code === 0, `the rename did not apply (exit ${String(applied.ran.code)}; steps ${kinds.join(", ")})`);
  const columns = (await ctx.db.scalar(`SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = '${ctx.db.name}' AND table_name = 'people'`)) || "";
  hold(columns === "id,handle", `people's columns are ${columns}, not id,handle`);
  const kept = await ctx.db.count(`SELECT count(*) FROM ${ctx.db.name}.people WHERE handle = 'user' || id`);
  hold(kept === 2500, `${String(kept)} of 2500 rows kept their value under the new name`);
  const step = await ctx.db.count(`SELECT count(*) FROM ${ctx.db.history}.history WHERE migration_id = '${id}' AND kind = 'step' AND status = 'succeeded'`);
  hold(step === 1, "the history has no succeeded PostgresMigrationOp step row");
}

export const columnChange: Claim = {
  name: "column-change",
  says: "Postgres: a column rename runs as a PostgresMigrationOp step (expand, backfill, switch, contract) and keeps every value",
  dialects: { pg: body },
};
