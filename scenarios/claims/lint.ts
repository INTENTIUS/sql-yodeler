import { renameSync } from "node:fs";
import { join } from "node:path";
import { hold, type Claim, type Ctx } from "../lib/claim.js";
import { parse, Project } from "../lib/project.js";
import { addColumn, addTable } from "../lib/schema.js";

/**
 * `yodel lint`, as a CI job runs it on a pull request: two branches each
 * added a migration after the same one, and both merged. Lint, offline,
 * exits 3 (an error) with a fork finding naming both migrations; nothing is
 * sent to the server. With only one of them it exits 0.
 * BREAK: only one of the two migrations is there, so there is no fork.
 */
async function lintCi(ctx: Ctx): Promise<void> {
  const p = await Project.create(ctx);
  await p.newMigration("create");
  addColumn(p, "note");
  const a = await p.newMigration("add-note");
  if (a === undefined) throw new Error("yodel new wrote no migration");
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
 * The replay check: `yodel lint --replay <env>` applies every migration in
 * order into a fresh database on the env's server and compares each with
 * the schema it recorded; it passes for migrations yodel new wrote, and
 * leaves no replayed database behind.
 * BREAK: a migration's statement is edited (in migration.json and
 * migration.sql alike, its checksum updated with --update-checksum), so it
 * no longer makes the schema it recorded.
 */
async function replay(ctx: Ctx): Promise<void> {
  const p = await Project.create(ctx);
  await p.newMigration("create");
  addColumn(p, "note");
  const id = await p.newMigration("add-note");
  if (id === undefined) throw new Error("yodel new wrote no migration");
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

export const lintCiClaim: Claim = {
  name: "lint-ci",
  says: "yodel lint, offline, fails a migrations directory with a fork (exit 3), naming both migrations",
  dialects: { ch: lintCi, pg: lintCi },
};

export const replayClaim: Claim = {
  name: "replay",
  says: "yodel lint --replay replays the migrations into a fresh database and each gives the schema it recorded",
  dialects: { ch: replay, pg: replay },
};
