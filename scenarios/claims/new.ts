import { hold, type Claim, type Ctx } from "../lib/claim.js";
import { Project } from "../lib/project.js";
import { addColumn, mainTable } from "../lib/schema.js";

/**
 * `yodel new` writes the next migration from the declared schema with no
 * server to read, dev or otherwise: the profile points at a closed port
 * while it runs. The migration it wrote then applies, and the column is on
 * the server.
 * BREAK: the declared column is added after yodel new ran, so no migration
 * carries it.
 */
async function body(ctx: Ctx): Promise<void> {
  const p = await Project.create(ctx);
  const offline = ctx.dialect === "ch" ? { YODEL_CLAIMS_CLICKHOUSE_URL: "http://127.0.0.1:9" } : { YODEL_CLAIMS_POSTGRES_URL: "postgres://127.0.0.1:9/postgres" };
  const first = await p.newMigration("create", [], offline);
  hold(first !== undefined, "yodel new wrote no first migration with no server to reach");
  const created = await p.approvedApply();
  if (created.ran.code !== 0) throw new Error(`the first migration did not apply (exit ${String(created.ran.code)})`);

  if (!ctx.broken) addColumn(p, "note");
  const second = await p.newMigration("add-note", [], offline);
  if (ctx.broken) addColumn(p, "note");
  hold(second !== undefined, "yodel new wrote no migration for the declared column");
  hold(p.read(`migrations/${second}/migration.sql`).includes("note"), `migrations/${second}/migration.sql does not add the column`);
  await p.commit("add note");

  const applied = await p.approvedApply();
  hold(applied.ran.code === 0, `the migration yodel new wrote did not apply (exit ${String(applied.ran.code)})`);
  hold(await ctx.db.columnExists(mainTable(ctx), "note"), `${ctx.db.name}.${mainTable(ctx)} has no column note`);
}

export const newClaim: Claim = {
  name: "new",
  says: "yodel new writes the next migration offline, with no dev database, and it applies",
  dialects: { ch: body, pg: body },
};
