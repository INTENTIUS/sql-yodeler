import { renameSync } from "node:fs";
import { join } from "node:path";
import { hold, runParts, type Claim, type Ctx } from "../lib/claim.js";
import { parse, Project } from "../lib/project.js";
import { addColumn, addTable } from "../lib/schema.js";

interface Lint {
  p: Project;
  /** The second migration, adding a column; the fork part sets it aside. */
  note?: string;
}

/**
 * The replay check: `yodel lint --replay <env>` applies every migration in
 * order into a fresh database on the env's server and compares each with
 * the schema it recorded; it passes for migrations yodel new wrote, and
 * leaves no replayed database behind.
 * BREAK: a migration's statement is edited (in migration.json and
 * migration.sql alike, its checksum updated with --update-checksum), so it
 * no longer makes the schema it recorded.
 */
export async function replayPart(ctx: Ctx, s: Lint): Promise<void> {
  const { p } = s;
  await p.newMigration("create");
  addColumn(p, "note");
  const id = await p.newMigration("add-note");
  if (id === undefined) throw new Error("yodel new wrote no migration");
  s.note = id;
  if (ctx.broken) {
    const [from, to] = ctx.dialect === "ch" ? ["note String DEFAULT ''", "nope String DEFAULT ''"] : ["note text", "nope text"];
    p.edit(`migrations/${id}/migration.json`, from, to);
    p.edit(`migrations/${id}/migration.sql`, from, to);
    const updated = await p.yodel(["lint", "--update-checksum", id]);
    if (updated.code === 1) throw new Error(`yodel lint --update-checksum ${id} exited 1`);
  }
  await p.commit("two migrations");

  const ran = await p.yodel(["lint", "--replay", p.env, "--json"], { timeoutMs: 600_000 });
  hold(ran.code === 0, `yodel lint --replay exited ${String(ran.code)}: ${JSON.stringify(parse<unknown>(ran)).slice(0, 300)}`);
  const doc = JSON.stringify(parse<unknown>(ran));
  hold(!doc.includes(`"replay"`) || !/"rule":\s*"replay"/.test(doc), "the replay reported a finding");
  hold(!(await ctx.db.tableExists(ctx.dialect === "ch" ? "events" : "orders")), `the replayed ${ctx.db.name} was left on the server`);
}

/**
 * `yodel lint`, as a CI job runs it on a pull request: two branches each
 * added a migration after the same one, and both merged. Lint, offline,
 * exits 3 (an error) with a fork finding naming both migrations; nothing is
 * sent to the server. With only one of them it exits 0.
 * BREAK: only one of the two migrations is there, so there is no fork.
 */
export async function forkPart(ctx: Ctx, s: Lint): Promise<void> {
  const { p } = s;
  const a = s.note;
  if (a === undefined) throw new Error("the replay part wrote no second migration");
  // The column's migration goes on a branch of its own; the other branch adds a table after the same parent.
  const aside = join(ctx.work, "aside");
  p.moveMigration(a, aside);
  addTable(p, "audit");
  const b = await p.newMigration("add-audit");
  if (b === undefined) throw new Error("yodel new wrote no migration");
  const one = await p.yodel(["lint", "--json"]);
  if (one.code !== 0) throw new Error(`yodel lint fails one branch on its own (exit ${String(one.code)})`);
  // Both pull requests merged: the one set aside comes back, following the same parent as b.
  if (!ctx.broken) renameSync(aside, p.path("migrations", a));
  await p.commit("two branches merged");

  const ran = await p.yodel(["lint", "--json"], {
    env: { YODEL_CLAIMS_CLICKHOUSE_URL: "http://127.0.0.1:9", YODEL_CLAIMS_POSTGRES_URL: "postgres://127.0.0.1:9/postgres" },
  });
  hold(ran.code === 3, `yodel lint exited ${String(ran.code)}, not 3, on a directory with a fork`);
  const doc = JSON.stringify(parse<unknown>(ran));
  hold(doc.includes("fork") && doc.includes(a) && doc.includes(b), "yodel lint's findings do not name the fork and both its migrations");
  hold(!(await ctx.db.tableExists(ctx.dialect === "ch" ? "events" : "orders")), "lint changed the server");
}

/**
 * `yodel checkpoint` (#63), on a chain of two migrations yodel new wrote:
 * a checkpoint after the newest migration creates
 * its recorded schema from nothing. `yodel lint --replay` replays the chain,
 * then the checkpoint alone into an empty database, and both give that
 * schema. A fresh environment then applies the checkpoint only, skips the
 * migrations before it, and ends with no drift from the recorded schema:
 * the schema an environment that ran the chain has.
 * BREAK: the checkpoint's CREATE TABLE is edited (a column's type, in
 * migration.json and migration.sql alike, its checksum updated), so it no
 * longer creates the schema it records.
 */
export async function checkpointPart(ctx: Ctx, s: Lint): Promise<void> {
  const { p } = s;
  // The parts before leave two branches, and under BREAK an edited migration: the checkpoint's chain is the first migration and one yodel new writes now.
  for (const id of p.migrationIds()) if (p.migration(id).parent !== null) p.removeMigration(id);
  if ((await p.newMigration("note-and-audit")) === undefined) throw new Error("yodel new wrote no migration");
  const before = p.migrationIds();
  const wrote = await p.yodel(["checkpoint", "base", "--json"]);
  if (wrote.code !== 0) throw new Error(`yodel checkpoint exited ${String(wrote.code)}: ${wrote.err}`);
  const cp = parse<{ id: string }>(wrote).id;
  if (ctx.broken) {
    const doc = JSON.parse(p.read(`migrations/${cp}/migration.json`)) as { steps: Array<{ kind: string; sql?: string }> };
    const [from, to] = ctx.dialect === "ch" ? ["UInt64", "UInt32"] : ["bigint", "integer"];
    const step = doc.steps.find((x) => x.kind === "statement" && x.sql?.includes("CREATE TABLE") && x.sql.includes(from));
    if (!step?.sql) throw new Error(`the checkpoint ${cp} has no CREATE TABLE with ${from}`);
    const old = step.sql;
    step.sql = old.replace(from, to);
    p.write(`migrations/${cp}/migration.json`, `${JSON.stringify(doc, null, 2)}\n`);
    p.edit(`migrations/${cp}/migration.sql`, old, step.sql);
    const updated = await p.yodel(["lint", "--update-checksum", cp]);
    if (updated.code === 1) throw new Error(`yodel lint --update-checksum ${cp} exited 1`);
  }
  await p.commit("a checkpoint");

  const replay = await p.yodel(["lint", "--replay", p.env, "--json"], { timeoutMs: 600_000 });
  hold(replay.code === 0, `yodel lint --replay exited ${String(replay.code)} with the checkpoint ${cp}: ${JSON.stringify(parse<unknown>(replay)).slice(0, 400)}`);
  const replayed = parse<{ replay?: { matched?: Array<{ id: string; checkpoint?: boolean }> } }>(replay).replay?.matched ?? [];
  hold(replayed.some((m) => m.id === cp && m.checkpoint === true), `the replay did not replay the checkpoint ${cp} on its own`);

  // A fresh environment: it starts at the checkpoint.
  const applied = await p.stepsApply();
  hold(applied.code === 0, `yodel apply on a fresh environment exited ${String(applied.code)}: ${applied.err.slice(0, 300)}`);
  const status = (await p.yodel(["status", p.env, "--json"])).out;
  const doc = JSON.parse(status.slice(status.indexOf("{"))) as { applied: Array<{ id: string }>; skipped?: Array<{ id: string; reason: string }> };
  hold(doc.applied.map((a) => a.id).join() === cp, `the fresh environment applied ${doc.applied.map((a) => a.id).join(", ")}, not the checkpoint ${cp} alone`);
  hold((doc.skipped ?? []).map((k) => k.id).sort().join() === before.join(), `the fresh environment did not skip the migrations before the checkpoint: ${JSON.stringify(doc.skipped)}`);
  const drift = await p.yodel(["drift", p.env, "--json"]);
  hold(drift.code === 0, `yodel drift after starting from the checkpoint exited ${String(drift.code)}: the environment is not at the recorded schema`);
}

/** The parts, in order, on one project: two migrations replayed, a second branch forking them, then a checkpoint on one chain. */
const parts = [
  ["replay", replayPart],
  ["fork", forkPart],
  ["checkpoint", checkpointPart],
] as const;

async function body(ctx: Ctx): Promise<void> {
  await runParts<Lint>(ctx, { p: await Project.create(ctx) }, parts);
}

export const lintClaim: Claim = {
  name: "lint",
  says: "yodel lint --replay replays the migrations into a fresh database and each gives the schema it recorded; offline, yodel lint fails a migrations directory with a fork (exit 3), naming both migrations; a checkpoint replays alone to its recorded schema, and a fresh environment starts from it",
  dialects: { ch: body, pg: body },
  parts: parts.map(([name]) => name),
};
