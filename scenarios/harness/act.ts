/**
 * The out-of-band steps of yodel's harness scenarios (INTENTIUS/sql-yodeler#302):
 * what a person does between the forge's runs, in the arm's project. chant's
 * driver runs these through its no-real-cloud wrapper and reads the exit code.
 *
 *   tsx scenarios/harness/act.ts approve <env>
 *       yodel approve <env>, answered with <env> as a person types it: it
 *       records the approval of the plan the waiting wave would run, pushes
 *       chant/lifecycle and starts the waiting job again. Exits when that run
 *       has finished: 0 when yodel approve did, else its code.
 *   tsx scenarios/harness/act.ts override <env> --rule <id> --reason <text>
 *       yodel override <env> as the harness's overrider, pushed, and the
 *       apply pipeline started again by hand on main; exits when that run
 *       has finished, with yodel override's code.
 *   tsx scenarios/harness/act.ts audit <env>
 *       yodel report <env>: 0 when every applied migration has its approval,
 *       its override or none needed, and no gap.
 *
 * scenarios/harness/run.ts gives them the arm's project and the forge:
 * YODEL_HARNESS_PROJECT, and the YODEL_HARNESS_FORGEJO_URL, _REPO and _ADMIN
 * that scenarios/harness/seed.ts reads.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { run } from "../lib/exec.js";
import { forgeAccess, forgejo, HARNESS_OVERRIDER, pullProject, pushLedger, yodelAsking, type ForgeAccess, type Seeded } from "./seed.js";

interface Run {
  id: number;
  status: string;
}

const DONE = new Set(["success", "failure", "cancelled", "skipped"]);

const runs = async (a: ForgeAccess): Promise<Run[]> => (await forgejo<{ workflow_runs?: Run[] }>(a, a.admin, "GET", `/repos/${a.repo}/actions/runs?limit=50`))?.workflow_runs ?? [];

/** Waits for the first run not in `before` to finish, up to 15 minutes. */
async function nextRunDone(a: ForgeAccess, before: ReadonlySet<number>): Promise<Run> {
  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    const r = (await runs(a)).filter((x) => !before.has(x.id)).sort((x, y) => x.id - y.id)[0];
    if (r && DONE.has(r.status)) return r;
    if (Date.now() > deadline) throw new Error(`no new run finished on ${a.repo} in 15 minutes (${r ? `run ${String(r.id)} ${r.status}` : "none started"})`);
    await new Promise((res) => setTimeout(res, 3_000));
  }
}

/** The arm's project, with the environment seed.ts gave yodel (the dev profile's server and reader, read back from its file). */
function project(): Pick<Seeded, "dir" | "env"> {
  const dir = process.env.YODEL_HARNESS_PROJECT;
  if (!dir) throw new Error("YODEL_HARNESS_PROJECT is not set; scenarios/harness/run.ts sets it for each arm");
  const saved = JSON.parse(readFileSync(join(dir, "..", "yodel-env.json"), "utf8")) as Record<string, string>;
  return { dir, env: { ...process.env, ...saved, PATH: `${join(dir, "node_modules", ".bin")}:${process.env.PATH ?? ""}` } };
}

export async function act(argv: string[]): Promise<number> {
  const [verb, env, ...rest] = argv;
  if (!verb || !env) {
    process.stderr.write("usage: tsx scenarios/harness/act.ts approve|override|audit <env> [--rule <id> --reason <text>]\n");
    return 2;
  }
  const p = project();
  const a = forgeAccess(process.env, "", "");
  // yodel approve starts the waiting job again through Forgejo's API with this token.
  const forgeToken = { CHANT_FORGE_TOKEN: a.admin.token };
  await pullProject(p);
  switch (verb) {
    case "approve": {
      const before = new Set((await runs(a)).map((r) => r.id));
      const approved = await yodelAsking(p, env, ["approve", env], forgeToken);
      if (approved.code !== 0) return approved.code;
      const resumed = await nextRunDone(a, before);
      process.stdout.write(`the resumed run ${String(resumed.id)} ended ${resumed.status}\n`);
      return 0;
    }
    case "override": {
      const over = await run("npx", ["yodel", "override", env, ...rest, "--by", HARNESS_OVERRIDER], { cwd: p.dir, env: p.env, timeoutMs: 600_000 });
      if (over.code !== 0) return over.code;
      await pushLedger(p);
      const before = new Set((await runs(a)).map((r) => r.id));
      await forgejo(a, a.admin, "POST", `/repos/${a.repo}/actions/workflows/yodel-apply.yml/dispatches`, { ref: "main" });
      const again = await nextRunDone(a, before);
      process.stdout.write(`the apply started again, run ${String(again.id)}, ended ${again.status}\n`);
      return 0;
    }
    case "audit":
      return (await run("npx", ["yodel", "report", env], { cwd: p.dir, env: p.env, timeoutMs: 600_000 })).code;
    default:
      process.stderr.write(`act.ts: ${verb} is not approve, override or audit\n`);
      return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await act(process.argv.slice(2));
}
