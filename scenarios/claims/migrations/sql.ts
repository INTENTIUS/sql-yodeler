import { hold, type Claim, type Ctx } from "../../lib/claim.js";
import { parse, Project } from "../../lib/project.js";

/**
 * A hand-written migration (#248). After the first migration, `yodel new
 * seed --sql` writes an empty one; its migration.sql gets reference rows
 * (an INSERT), a column the declarations gain too, and an UPDATE filling
 * it. `yodel lint --update-checksum` records the statements, `yodel lint
 * --replay` shows they give the schema the migration records, and the
 * migrations apply behind the gate: the rows are there, filled, and the
 * next `yodel new` sees no change.
 * BREAK: the column is left out of src/, so the migration records a schema
 * its statements do not give, and the replay must catch it.
 */
async function body(ctx: Ctx): Promise<void> {
  const p = await Project.create(ctx);
  const first = await p.newMigration("create");
  if (first === undefined) throw new Error("yodel new wrote no first migration");
  await p.commit("create");

  const made = await p.yodel(["new", "seed", "--sql", "--json"]);
  if (made.code !== 0) throw new Error(`yodel new seed --sql exited ${String(made.code)}: ${made.err.slice(-300)}`);
  const id = parse<{ id: string }>(made).id;
  const table = `${ctx.db.name}.orders`;
  const sql = p.read(`migrations/${id}/migration.sql`);
  p.write(
    `migrations/${id}/migration.sql`,
    `${sql}\nINSERT INTO ${table} (status, amount) VALUES ('seeded', 1), ('seeded', 2);\nALTER TABLE ${table} ADD COLUMN label text;\nUPDATE ${table} SET label = 'from-' || status;\n`,
  );
  if (ctx.broken) ctx.log("BREAK: the label column is not declared in src/");
  else p.edit("src/schema.ts", "amount numeric(12, 2) NOT NULL\n", "amount numeric(12, 2) NOT NULL,\n    label  text\n");
  const recorded = await p.yodel(["lint", "--update-checksum", id, "--json"]);
  if (recorded.code !== 0) throw new Error(`yodel lint --update-checksum ${id} exited ${String(recorded.code)}: ${recorded.err.slice(-300)}`);
  await p.commit("a hand-written seed");

  const replay = await p.yodel(["lint", "--replay", p.env, "--json"], { timeoutMs: 600_000 });
  hold(replay.code === 0, `yodel lint --replay exited ${String(replay.code)}: the hand-written ${id} does not replay to the schema it records: ${JSON.stringify(parse<unknown>(replay)).slice(0, 400)}`);

  const applied = await p.approvedApply();
  hold(applied.ran.code === 0, `the migrations did not apply (exit ${String(applied.ran.code)})`);
  const rows = await ctx.db.scalar(`SELECT count(*) FROM ${table} WHERE status = 'seeded' AND label = 'from-seeded'`);
  hold(rows === "2", `${table} holds ${rows} seeded rows with their label, not 2`);
  const next = await p.yodel(["new", "after", "--json"]);
  hold(next.code === 0 && !parse<{ written: boolean }>(next).written, `yodel new after the hand-written migration wrote a migration: it does not diff from the schema the hand-written one records`);
}

export const sqlClaim: Claim = {
  name: "sql",
  says: "yodel new --sql writes a migration a person writes; its reference rows and a column declared in src/ too are recorded from migration.sql, replay to the schema it records, apply behind the gate, and the next yodel new diffs from it",
  // Reading migration.sql and recording it is the same on both dialects; apply and replay are the parts lint and resume prove on each.
  dialects: { pg: body },
};
