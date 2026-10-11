import { hold, partDialects, partNames, runParts, type Claim, type Ctx, type PartEntry } from "../../lib/claim.js";
import { parse, Project } from "../../lib/project.js";
import { declareRoutines, insertedStatus, routinesOnServer } from "../../lib/routines.js";
import { addColumn, mainTable } from "../../lib/schema.js";

/**
 * `yodel new` writes the next migration from the declared schema with no
 * server to read, dev or otherwise: the profile points at a closed port
 * while it runs. The migration it wrote then applies, and the column is on
 * the server.
 * BREAK: the declared column is added after yodel new ran, so no migration
 * carries it.
 */
/** The project with its first migration applied, and the environment that points its profile at a closed port. */
interface New {
  p: Project;
  offline: Record<string, string>;
}

async function column(ctx: Ctx, { p, offline }: New): Promise<void> {
  if (!ctx.broken) addColumn(p, "note");
  const second = await p.newMigration("add-note", [], offline);
  if (ctx.broken) addColumn(p, "note");
  hold(second !== undefined, "yodel new wrote no migration for the declared column");
  hold(p.read(`migrations/${second}/migration.sql`).includes("note"), `migrations/${second}/migration.sql does not add the column`);
  await p.commit("add note");

  const applied = await p.stepsApply();
  hold(applied.code === 0, `the migration yodel new wrote did not apply (exit ${String(applied.code)})`);
  hold(await ctx.db.columnExists(mainTable(ctx), "note"), `${ctx.db.name}.${mainTable(ctx)} has no column note`);
}

/**
 * Postgres functions, procedures and triggers (#44): yodel new writes the
 * function before the trigger that runs it, labels the trigger on the
 * existing orders table SQLPG283 (the lock it takes) and lint passes it; it
 * applies and the trigger fires. Then yodel lint flags a migration that
 * changes the procedure's signature (pg-signature) and drops the function
 * while the trigger still names it (pg-routine-in-use); that migration is
 * thrown away.
 * BREAK: the routines are declared after yodel new ran, so no migration
 * carries them.
 */
async function routines(ctx: Ctx, { p, offline }: New): Promise<void> {
  if (!ctx.broken) declareRoutines(p);
  const id = await p.newMigration("routines", [], offline);
  if (ctx.broken) declareRoutines(p);
  hold(id !== undefined, "yodel new wrote no migration for the declared function, procedure and trigger");
  const steps = p.migration(id).steps.map((s) => `${s.object ?? ""} ${s.rule ?? ""} ${s.class ?? ""}`);
  const fn = steps.indexOf("lowerStatus SQLPG200 create");
  const trigger = steps.indexOf("ordersLowerStatus SQLPG283 metadata");
  hold(fn >= 0 && trigger > fn && steps.includes("archiveOrders SQLPG200 create"), `migrations/${id} does not create the function, then the trigger as SQLPG283: ${steps.join(", ")}`);
  const clean = await p.yodel(["lint", "--json"]);
  hold(clean.code === 0, `yodel lint flags the migration that creates the routines (exit ${String(clean.code)})`);
  await p.commit("routines");

  const applied = await p.stepsApply();
  hold(applied.code === 0, `the routines migration did not apply (exit ${String(applied.code)})`);
  const on = await routinesOnServer(ctx);
  hold(on.fn && on.proc && on.trigger, `on the server: function ${String(on.fn)}, procedure ${String(on.proc)}, trigger ${String(on.trigger)}`);
  hold((await insertedStatus(ctx)) === "shipped", "the trigger did not lower-case an inserted status");

  declareRoutines(p, { byName: true, keep: true });
  const bad = await p.newMigration("drop-function", [], offline);
  hold(bad !== undefined, "yodel new wrote no migration dropping the function");
  const linted = await p.yodel(["lint", "--json"]);
  const found = parse<{ findings: Array<{ rule: string; migration?: string }> }>(linted).findings.filter((f) => f.migration === bad).map((f) => f.rule);
  hold(linted.code === 3 && found.includes("pg-signature") && found.includes("pg-routine-in-use"), `yodel lint on a changed signature and a function a trigger uses: exit ${String(linted.code)}, ${found.join(", ") || "no findings"}`);
  p.removeMigration(bad);
  declareRoutines(p);
}

/** The parts, in order, on one project: a column, then on Postgres the routines (#44). */
const parts: ReadonlyArray<PartEntry<New>> = [
  ["column", column],
  ["routines", routines, ["pg"]],
];

async function body(ctx: Ctx): Promise<void> {
  const p = await Project.create(ctx);
  const offline = ctx.dialect === "ch" ? { YODEL_CLAIMS_CLICKHOUSE_URL: "http://127.0.0.1:9" } : { YODEL_CLAIMS_POSTGRES_URL: "postgres://127.0.0.1:9/postgres" };
  const first = await p.newMigration("create", [], offline);
  hold(first !== undefined, "yodel new wrote no first migration with no server to reach");
  await p.setupApply();
  await runParts(ctx, { p, offline }, parts);
}

export const newClaim: Claim = {
  name: "new",
  says: "yodel new writes the next migration offline, with no dev database, and it applies; on Postgres, functions, procedures and triggers too, which lint checks",
  dialects: { ch: body, pg: body },
  parts: partNames(parts),
  partDialects: partDialects(parts),
};
