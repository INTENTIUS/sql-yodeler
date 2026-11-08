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
 *   tsx scenarios/harness/act.ts reply <branch> <text>
 *       Waits, up to 15 minutes, for chant's commit job to answer the newest
 *       `/yodel` comment on the open pull request from <branch> (its BREAK
 *       arm's, <branch>-break, in that arm): 0 when the reply holds <text>,
 *       else 1, with the reply.
 *   tsx scenarios/harness/act.ts move-main <job>
 *       Waits, up to 15 minutes, for forgejo-runner to start a container
 *       for <job> (yodel-rebase-push: the command has run on the base it
 *       merged, and the push has not landed yet), then commits a note to
 *       main through the forge's API, with [skip ci], so main moves while
 *       the commit job runs. 0 once main moved.
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

interface Comment {
  body: string;
}

/** The open pull request from `branch`, or from `<branch>-break`, the newest. */
async function pullFrom(a: ForgeAccess, branch: string): Promise<number | undefined> {
  const pulls = (await forgejo<Array<{ number: number; head?: { ref?: string } }>>(a, a.admin, "GET", `/repos/${a.repo}/pulls?state=open&limit=50`)) ?? [];
  return pulls
    .filter((p) => p.head?.ref === branch || p.head?.ref === `${branch}-break`)
    .map((p) => p.number)
    .sort((x, y) => y - x)[0];
}

/** chant's reply to the newest `/yodel` comment on `pull`: the first `yodel: ` comment after it. */
export function replyTo(comments: readonly Comment[]): string | undefined {
  const asked = comments.map((c) => c.body.trimStart().startsWith("/yodel ")).lastIndexOf(true);
  if (asked < 0) return undefined;
  return comments.slice(asked + 1).find((c) => c.body.startsWith("yodel: "))?.body;
}

/** Waits for chant's commit job to answer on the pull request from `branch`; 0 when the reply holds `text`. */
async function reply(a: ForgeAccess, branch: string, text: string): Promise<number> {
  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    const pull = await pullFrom(a, branch);
    if (pull !== undefined) {
      const comments = (await forgejo<Comment[]>(a, a.admin, "GET", `/repos/${a.repo}/issues/${String(pull)}/comments?limit=50`)) ?? [];
      const said = replyTo(comments);
      if (said !== undefined) {
        process.stdout.write(`pull request ${String(pull)}: ${said}\n`);
        if (said.includes(text)) return 0;
        process.stderr.write(`the reply does not hold ${JSON.stringify(text)}\n`);
        return 1;
      }
    }
    if (Date.now() > deadline) {
      process.stderr.write(`no reply from the commit job on ${pull === undefined ? `a pull request from ${branch}` : `pull request ${String(pull)}`} in 15 minutes\n`);
      return 1;
    }
    await new Promise((res) => setTimeout(res, 5_000));
  }
}

/** forgejo-runner's job containers carry this in their names (chant's JOB_CONTAINER_MARK). */
const JOB_CONTAINER_MARK = "ACTIONS-TASK";

/** Whether `docker ps` names (one per line) show a running container of `job`. */
export function jobRunning(names: string, job: string): boolean {
  return names.split("\n").some((n) => n.includes(JOB_CONTAINER_MARK) && n.includes(`JOB-${job}`));
}

/** Once `job`'s container is up, a commit on main: a note, with [skip ci], so no pipeline starts. */
async function moveMain(a: ForgeAccess, job: string): Promise<number> {
  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    const ps = await run("docker", ["ps", "--format", "{{.Names}}"], { cwd: process.cwd(), timeoutMs: 30_000, echo: false });
    if (ps.code === 0 && jobRunning(ps.out, job)) break;
    if (Date.now() > deadline) {
      process.stderr.write(`no ${job} job started in 15 minutes${ps.code === 0 ? "" : ` (docker ps exited ${String(ps.code)}: ${ps.err.trim()})`}\n`);
      return 1;
    }
    await new Promise((res) => setTimeout(res, 2_000));
  }
  const at = new Date().toISOString();
  const path = `notes/moved-${at.replace(/[^0-9]/g, "")}.md`;
  await forgejo(a, a.admin, "POST", `/repos/${a.repo}/contents/${path}`, {
    branch: "main",
    message: `chore: main moves while ${job} runs [skip ci]`,
    content: Buffer.from(`main moved at ${at}, while ${job} ran.\n`).toString("base64"),
  });
  process.stdout.write(`main moved: ${path}, while ${job} ran\n`);
  return 0;
}

export async function act(argv: string[]): Promise<number> {
  const [verb, env, ...rest] = argv;
  if (!verb || !env) {
    process.stderr.write("usage: tsx scenarios/harness/act.ts approve|override|audit <env> [--rule <id> --reason <text>], reply <branch> <text>, or move-main <job>\n");
    return 2;
  }
  if (verb === "reply") {
    const text = rest.join(" ");
    if (!text) {
      process.stderr.write("usage: tsx scenarios/harness/act.ts reply <branch> <text>\n");
      return 2;
    }
    return reply(forgeAccess(process.env, "", ""), env, text);
  }
  if (verb === "move-main") return moveMain(forgeAccess(process.env, "", ""), env);
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
      process.stderr.write(`act.ts: ${verb} is not approve, override, audit, reply or move-main\n`);
      return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await act(process.argv.slice(2));
}
