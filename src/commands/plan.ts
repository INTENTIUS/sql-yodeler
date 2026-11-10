import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { noteLimit } from "@intentius/chant/plan-summary";
import { eventFromRun, sendEvent } from "../notify/index.js";
import type { Command, Io } from "../command.js";
import { guarded } from "../env-args.js";
import { loadProject, resolveEnvironment, YodelError, type Environment, type Project } from "../project.js";
import { declarativeRefusal } from "../config/settings.js";
import { buildSchema } from "../chant/build.js";
import { planEnvironment } from "../chant/plan.js";
import { hasMigrations } from "../versioned/index.js";
import { collectDeclarativePlan, declarativePlanExitCode, declarativePlanJson, renderDeclarativeMarkdown, renderDeclarativeText } from "../declarative/plan.js";
import { runnable } from "../chant/runnable.js";
import { collectVersionedPlan } from "../pr/model.js";
import { planJsonVersioned, renderPlanText } from "../pr/render.js";
import { planPart, slotPart } from "../pr/part.js";
import { noteSubject, renderPlanNote, renderTenantSetNote } from "../pr/note.js";
import { YODEL_PR_ENV } from "../ci-words.js";
import { baseRef } from "../config/base.js";
import { collectTenantSetPlan, renderTenantSetMarkdown, renderTenantSetText, tenantSetExitCode, tenantSetJson } from "../pr/tenants.js";
import { tenantSetOf } from "../tenants/index.js";
import { tenantTarget } from "../tenants/target.js";
import { readAtRunTime, slotTenants, splitSlot } from "../tenants/wave.js";
import type { VersionedPlan } from "../pr/model.js";

const usage =
  "usage: yodel plan <env> [--json] [--dir <project>] [--format text|markdown|json]\n" +
  "                        [--allow-out-of-order] [--op <name>] [--part <file>]\n" +
  "                        [--pr-note <dir>]";

const help = `${usage}

Declarative project (no migrations/ directory): shows the classified change
from the environment's live database (sql.profiles.<env>) to the declared
schema, as chant sql plan reports it, with the lint findings over the
planned changes, each policy rule's outcome (yodel.config.ts policy, at the
base commit) and how the ApplyOp's gate is approved. --allow-out-of-order is for versioned migrations: the declarative path has
no history of migrations to be out of order with.

Versioned project (a migrations/ directory): shows the pending migrations,
each step with its rule and class (an Op step with the Op that makes it, a
manual step with what it needs), integrity problems (directory problems,
checksum mismatches, out-of-order migrations), and the plan digest yodel
apply asks approval for, with the yodel approve command that approves it.
When chant's gate ledger holds an approval of the migrations Op's gate for
another digest, it says what moved since. --part writes the plan as a
chant change-set part, for a chant Op that gates it together with another
member's plan. Reads only.

An environment with a tenant set (yodel.config.ts environments.<env>.tenants)
is planned tenant by tenant, each against its own history, and shown as one
plan: tenants with the same migrations pending once, as a group, then the
wave's one approval of the set digest over every tenant, as one note for the
set. <env>/<tenant> plans one tenant. For a set
read by a query, <env>/@<i>of<n> plans one slot of its wave as the apply
pipeline runs it: every tenant the query lists now whose name hashes to
the slot; with --part, one part for the slot.

Options:
  --json                print the plan as JSON (the same as --format json)
  --format <f>          text (default), markdown (the pull request comment),
                        json
  --allow-out-of-order  versioned: the plan yodel apply --allow-out-of-order
                        would run
  --op <name>           versioned: the migrations Op, when more than one
                        applies <env>
  --op <name>           declarative: the ApplyOp, when more than one applies
                        <env>
  --part <file>         versioned: also write the plan to <file> as a chant
                        change-set part (planner sql), one entry per object,
                        with the plan digest yodel apply binds; a chant Op
                        reads it with readChangeSetPart and composeChangeSet
  --pr-note <dir>       write the note for the pull (merge) request to
                        <dir>/pr-plan-note.json, chant's plan note hand-off,
                        which chant's note job posts with the plan status
                        yodel/plan/<env>; prints the text plan. It reads
                        PR_NUMBER, which chant's plan job sets, and needs no
                        forge token: the note job says what moved since the
                        previous note
  -C, --dir <dir>       the project directory (default: the working directory)

Exit codes:
  0  every change can be made in place, or there is none; versioned: apply
     would run (or has nothing to do). Pending migrations still exit 0: plan
     reports, and a CI job that posts it should not fail because a pull
     request adds a migration; yodel status exits 3 for them
  3  a change needs its own Op: a ClickHouse rebuild, a Postgres expand and
     contract (declarative); versioned: a pending migration has an Op or
     manual step apply does not run yet
  1  no plan could be made: a bad config, an unknown environment, a
     declaration chant cannot build, a server it cannot read, a live object
     it cannot read, a note that could not be written; versioned: apply would
     refuse: a checksum mismatch, an applied migration gone from the
     directory, an out-of-order migration, a fork or another problem in the
     migrations directory
`;

interface PlanArgs {
  env: string;
  dir: string;
  format: "text" | "markdown" | "json";
  /** Where `--pr-note` writes the plan note hand-off. */
  prNote: string | undefined;
  allowOutOfOrder: boolean;
  op: string | undefined;
  part: string | undefined;
  /** The flags only a versioned project takes. */
  versionedOnly: string[];
}

function parsePlanArgs(args: string[]): PlanArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: "boolean" },
        dir: { type: "string", short: "C" },
        format: { type: "string" },
        "pr-note": { type: "string" },
        "allow-out-of-order": { type: "boolean" },
        op: { type: "string" },
        part: { type: "string" },
      },
    });
  } catch (e) {
    throw new YodelError(`${e instanceof Error ? e.message : String(e)}\n${usage}`);
  }
  const { values: v, positionals } = parsed;
  const [env, ...rest] = positionals;
  if (env === undefined || rest.length > 0) throw new YodelError(usage);
  const str = (k: string) => (typeof v[k] === "string" ? v[k] : undefined);
  const format = str("format") ?? (v.json === true ? "json" : "text");
  if (format !== "text" && format !== "markdown" && format !== "json") throw new YodelError(`--format must be text, markdown or json, got ${JSON.stringify(format)}\n${usage}`);
  if (v.json === true && format !== "json") throw new YodelError(`--json and --format ${format} cannot be combined\n${usage}`);
  return {
    env,
    dir: str("dir") ?? process.cwd(),
    format,
    prNote: str("pr-note"),
    allowOutOfOrder: v["allow-out-of-order"] === true,
    op: str("op"),
    part: str("part"),
    versionedOnly: [...(v["allow-out-of-order"] === true ? ["--allow-out-of-order"] : []), ...(str("part") !== undefined ? ["--part"] : [])],
  };
}

/** `yodel plan <env>`; the exit codes are in `help`. */
export const plan: Command = {
  name: "plan",
  summary: "show what apply would change in an environment",
  implemented: true,
  run: (args, io) =>
    guarded("plan", io, args, help, async () => {
      const a = parsePlanArgs(args);
      const project = await loadProject(a.dir);
      const slot = splitSlot(a.env);
      if (slot) return slotPlan(project, slot, a, io);
      const env = resolveEnvironment(project, a.env);
      if (hasMigrations(project)) return versionedPlan(project, env, a, io);
      if (a.versionedOnly.length > 0) throw new YodelError(`${a.versionedOnly.join(", ")} ${a.versionedOnly.length === 1 ? "is" : "are"} for versioned migrations, and ${project.dir} has no migrations/ directory with a migration (see docs/workflows.md for what each path has)`);
      return declarativePlan(project, env, a, io);
    }),
};

/** `yodel plan <env>` with no migrations (#249): chant's plan, with its lint findings, policy and approval, and the comment. */
async function declarativePlan(project: Project, env: Environment, a: PlanArgs, io: Io): Promise<number> {
  const refusal = declarativeRefusal(project, env.name);
  if (refusal) throw refusal;
  const pr = a.prNote !== undefined ? prNoteTarget(project) : undefined;
  const build = await buildSchema(project);
  try {
    const result = await collectDeclarativePlan(project, env, build, await planEnvironment(project, env, build), { opName: a.op });
    const code = declarativePlanExitCode(result);
    if (pr && a.prNote !== undefined) {
      const body = renderDeclarativeMarkdown(result, { limit: noteLimit(noteForge()) });
      await writeNote(a.prNote, env.name, pr, body, code === 0 ? "success" : "failure", code === 0 ? "planned" : `a change needs its own Op (exit ${String(code)})`, undefined, io);
    }
    const doc = declarativePlanJson(result);
    if (a.format === "json") io.out(`${JSON.stringify(doc, null, 2)}\n`);
    else if (a.format === "markdown") io.out(renderDeclarativeMarkdown(result));
    else io.out(renderDeclarativeText(result));
    await sendEvent(project.yodel?.config.notify, eventFromRun("plan", doc), { io, verb: "plan" });
    return code;
  } finally {
    build.dispose();
  }
}

async function versionedPlan(project: Project, env: Environment, a: PlanArgs, io: Io): Promise<number> {
  if (!env.tenant && tenantSetOf(project, env.name)) {
    if (a.part !== undefined) throw new YodelError(`--part writes one environment's plan, and ${env.name} is a tenant set: plan one tenant, yodel plan ${env.name}/<tenant> --part <file>`);
    return tenantSetPlan(project, env, a, io);
  }
  // The pull request first: a job that does not name one fails before it reads the server.
  const pr = a.prNote !== undefined ? prNoteTarget(project) : undefined;
  const result = await collectVersionedPlan(project, env, { allowOutOfOrder: a.allowOutOfOrder, opName: a.op });
  const code = result.refusal?.exitCode ?? 0;

  // chant's note in yodel's words (#290), handed to chant's note job with the plan's subject (chant issues 4963, 4972).
  if (pr && a.prNote !== undefined) {
    const body = await renderPlanNote(result, { dir: project.dir, base: baseRef(project.dir).ref, limit: noteLimit(noteForge()) });
    const description = result.refusal ? `yodel apply would refuse (exit ${String(result.refusal.exitCode)})` : `${String(result.pending.length)} pending`;
    await writeNote(a.prNote, env.name, pr, body, result.refusal ? "failure" : "success", description, noteSubject(result), io);
  }
  if (a.part !== undefined) {
    const file = resolve(a.part);
    writeFileSync(file, `${JSON.stringify(planPart(result, basename(project.dir)), null, 2)}\n`);
    io.err(`yodel plan: wrote the change-set part to ${file}\n`);
  }
  const doc = planJsonVersioned(result);
  if (a.format === "json") io.out(`${JSON.stringify(doc, null, 2)}\n`);
  else if (a.format === "markdown") io.out(await renderPlanNote(result, { dir: project.dir, base: baseRef(project.dir).ref }));
  else io.out(renderPlanText(result, { runnable: (c) => runnable(c, project.dir) }));
  // A plan that is refused, or that the policy denies, is news before anyone merges it (#61).
  await sendEvent(project.yodel?.config.notify, eventFromRun("plan", doc), { io, verb: "plan" });
  return code;
}

/**
 * `yodel plan <env>/@<i>of<n>` (#56): a slot of the wave of a tenant set
 * read by a query, as the apply pipeline runs it. chant's `sql-migrate`
 * capability plans each run with `--part` before its `--wave-plan`, so the
 * slot plans here the way `yodel apply <slot> --wave-plan` does: every
 * tenant the query lists now whose name hashes to the slot, each against
 * its own history. The exit code is the first refused tenant's, else 0.
 */
async function slotPlan(project: Project, slot: { env: string; index: number; count: number }, a: PlanArgs, io: Io): Promise<number> {
  resolveEnvironment(project, slot.env);
  if (!readAtRunTime(tenantSetOf(project, slot.env))) {
    throw new YodelError(`${a.env} is a slot of a tenant set's wave, and ${slot.env}'s tenant set is not read by a query (yodel.config.ts environments.${slot.env}.tenants.query): plan a tenant with yodel plan ${slot.env}/<tenant>, or the set with yodel plan ${slot.env}`);
  }
  if (!hasMigrations(project)) throw new YodelError(`${a.env} is a slot of a tenant set's wave, for versioned migrations, and ${project.dir} has no migrations/ directory with a migration`);
  if (a.prNote !== undefined || a.format === "markdown") throw new YodelError(`${a.env} is a run of the apply pipeline, not something a pull request shows: plan the set with yodel plan ${slot.env}${a.prNote !== undefined ? " --pr-note <dir>" : " --format markdown"}`);
  const tenants: VersionedPlan[] = [];
  for (const t of await slotTenants(project, slot)) {
    tenants.push(await collectVersionedPlan(project, resolveEnvironment(project, tenantTarget(slot.env, t)), { allowOutOfOrder: a.allowOutOfOrder, opName: a.op, ledger: null }));
  }
  if (a.part !== undefined) {
    const file = resolve(a.part);
    writeFileSync(file, `${JSON.stringify(slotPart(a.env, tenants, basename(project.dir)), null, 2)}\n`);
    io.err(`yodel plan: wrote the change-set part of ${a.env} (${String(tenants.length)} tenant${tenants.length === 1 ? "" : "s"} of ${slot.env}, read now) to ${file}\n`);
  }
  if (a.format === "json") io.out(`${JSON.stringify({ environment: a.env, tenants: tenants.map(planJsonVersioned) }, null, 2)}\n`);
  else {
    io.out(`${a.env}: ${String(tenants.length)} tenant${tenants.length === 1 ? "" : "s"} of ${slot.env} (read now)\n`);
    for (const t of tenants) io.out(`\n${renderPlanText(t, { runnable: (c) => runnable(c, project.dir) })}`);
  }
  return tenants.find((t) => t.refusal)?.refusal?.exitCode ?? 0;
}

/** `yodel plan <set>` (#56): every tenant, grouped, and one note for the set. */
async function tenantSetPlan(project: Project, env: Environment, a: PlanArgs, io: Io): Promise<number> {
  const pr = a.prNote !== undefined ? prNoteTarget(project) : undefined;
  const result = await collectTenantSetPlan(project, env.name, { allowOutOfOrder: a.allowOutOfOrder });
  const code = tenantSetExitCode(result);
  if (pr && a.prNote !== undefined) {
    const limit = noteLimit(noteForge());
    // #56: chant's note would ask for an approval per tenant, so the set may keep yodel's own note, handed over as text (chant issue 4963).
    const body = (await renderTenantSetNote(result, { dir: project.dir, base: baseRef(project.dir).ref, limit })) ?? renderTenantSetMarkdown(result, { limit });
    await writeNote(a.prNote, env.name, pr, body, code === 0 ? "success" : "failure", code === 0 ? `${String(result.tenants.length)} tenants planned` : `a tenant's apply would refuse (exit ${String(code)})`, undefined, io);
  }
  if (a.format === "json") io.out(`${JSON.stringify(tenantSetJson(result), null, 2)}\n`);
  else if (a.format === "markdown") io.out(((await renderTenantSetNote(result, { dir: project.dir, base: baseRef(project.dir).ref })) ?? renderTenantSetMarkdown(result)));
  else io.out(renderTenantSetText(result, { runnable: (c) => runnable(c, project.dir) }));
  return code;
}

/** The pull request and commit chant's plan job plans: `PR_NUMBER` from the job, the head from git. */
function prNoteTarget(project: Project): { pr: number; head: string } {
  const pr = Number(process.env.PR_NUMBER);
  if (!Number.isInteger(pr) || pr <= 0) throw new YodelError("--pr-note writes the note for the pull request PR_NUMBER names, and PR_NUMBER is not set to one; chant's plan job sets it");
  let head = "";
  try {
    head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: project.dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    // Refused below.
  }
  if (!/^[0-9a-f]{40,64}$/.test(head)) throw new YodelError(`--pr-note names the commit planned, and ${project.dir} is not in a git checkout`);
  return { pr, head };
}

/** The forge whose note limit the note is cut to: GitLab's in a GitLab job, else GitHub's (Forgejo's is the same). */
const noteForge = (): "gitlab" | "github" => (process.env.GITLAB_CI === "true" ? "gitlab" : "github");

/**
 * Writes the plan note hand-off chant's note job posts (chant issue 4963):
 * yodel's note as text, under chant's marker and yodel's own line
 * `<!-- yodel:plan env=<env> -->`, with the plan's subject for the next
 * note to compare with (chant issue 4972).
 */
async function writeNote(dir: string, env: string, at: { pr: number; head: string }, markdown: string, state: "success" | "failure", description: string, subject: ReturnType<typeof noteSubject>, io: Io): Promise<void> {
  const { planBodyHandoff, PR_PLAN_NOTE_FILE } = await import("@intentius/chant/pr-plan-note");
  // chant writes its own marker and yodel's line above the body, so the body carries no marker of its own.
  const body = markdown.replace(/^(<!--[^\n]*-->\n)+/, "");
  const handoff = planBodyHandoff(body, { pr: at.pr, head: at.head, env: YODEL_PR_ENV, member: env, state, description, marker: `env=${env}`, ...(subject ? { subject } : {}) });
  const file = join(resolve(dir), PR_PLAN_NOTE_FILE);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(handoff, null, 2)}\n`);
  io.err(`yodel plan: wrote the plan note for pull request #${String(at.pr)} to ${file}\n`);
}
