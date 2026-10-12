/**
 * The starter template (#17), end to end on a local Forgejo: the body of the
 * forge claim. The forge is in ./forgejo.ts; see ./forge.ts for what a forge
 * provides.
 *
 * The project is made with `chant init --from <this checkout>#templates/<dialect>`
 * (the template in the tree under test, not main's) and keeps `dev` only.
 * Its package.json is left as the template wrote it, so `npm install` here
 * and `npm ci` in every job take @intentius/sql-yodeler from the npm
 * registry, at the version the template's range resolves to, with no
 * token: the claim runs the project a user gets, and the yodel its jobs run
 * is the released one, not this checkout. Until a release in that range has
 * what the claim checks, the project takes yodel from `npm pack` of this
 * checkout instead, committed in the project (vendor/), so every job's
 * `npm ci` installs the same. The dev profile is the claim's database
 * yodel_34_<claim>, the history yodel_34_<claim>_history, with a reader and
 * a writer user made for it (yodel_34_reader, yodel_34_writer). The lint job
 * replays into its own service container (replay-clickhouse /
 * replay-postgres), never the shared emulator.
 *
 * The approval, the stale-approval and seal checks, notify, the resume of a
 * waiting job and the tracking issue's writes are chant's, proven by chant.
 * What runs here is what only a forge's runner shows of yodel's own
 * rendered pipelines, as parts ({@link templateParts}, run by runParts:
 * under BREAK=1 each part breaks its own property and must catch it, under
 * BREAK=<part> that part alone is broken and the rest hold). Before the
 * parts, the setup: the project, its own job in ci/jobs.ts (yodel.config.ts
 * `ci.jobs`), the pipelines rendered by the installed yodel (`yodel ci`,
 * #65), a fresh repository with the secrets they name, and the first push,
 * whose apply must stop at the gate with the approve command and apply
 * nothing, then applies once approved (a setup check: it fails the run both
 * ways). The parts:
 *
 * - merge: a pull request adding a column gets lint (with the replay) and
 *   the plan comment, both green and changing nothing, and its plan job
 *   shows it cannot write (#50); the comment's approve command, run and
 *   pushed, lets the apply after the merge add the column. BREAK: merged
 *   without approving, so the column waits (then approved and applied, so
 *   the parts after it go on).
 * - project-job (#65): that pull request ran the project's own job. BREAK:
 *   the installed yodel is built to drop the project's jobs.
 * - lint-blocks (#59): a pull request with a forked migration fails its
 *   lint job. BREAK: the installed yodel renders the lint and replay steps
 *   with `|| true`.
 * - annotations (#129): that pull request's findings are on the forge, a
 *   workflow command naming the file. BREAK: the installed yodel renders
 *   plain `yodel lint`.
 * - apply-off (#175): a pull request that sets `ci: { apply: false }`,
 *   renders again and deletes the apply pipeline's files gets lint (with
 *   `yodel ci --check`) and the plan comment, green. BREAK: the apply files
 *   are deleted without the setting, so `yodel ci --check` fails the lint job.
 * - image (#66): a pull request with yodel.config.ts `ci.image`, the CI
 *   image pinned by its digest, runs its jobs in that image with nothing
 *   installed, and the plan job comments. BREAK: no `ci.image`, so the jobs
 *   install with npm ci in node's image.
 * - watch (#49): the drift watch, run as its schedule would, with a change
 *   made by hand on the server fails and opens one tracking issue naming the
 *   environment and the object. BREAK: the server is not changed by hand,
 *   so the watch opens no issue.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hold, partNames, runParts, type Body, type Ctx, type PartEntry } from "../lib/claim.js";
import { endpoints } from "../lib/db.js";
import { run, type Ran } from "../lib/exec.js";
import { repoRoot } from "../lib/project.js";
import { NODE_IMAGE, type Forge, type ForgeRepo, type ForgeRun } from "./forge.js";

const READER = { user: "yodel_34_reader", password: "yodel-34-reader" };
const WRITER = { user: "yodel_34_writer", password: "yodel-34-writer" };
/** Whether the run breaks `part`: BREAK=1 breaks every part, BREAK=<part> that one. */
const breaks = (outer: Ctx, part: string): boolean => outer.broken && (outer.breaking === undefined || outer.breaking === part);

/** A setup step that did not go as it must: an error, so a fail both ways (never a catch). */
function must(cond: boolean, what: string): asserts cond {
  if (!cond) throw new Error(what);
}

type Sh = (cmd: string, args: string[], timeoutMs?: number) => Promise<Ran>;

/** What the parts share: the project, its repository, and what the parts before left. */
interface State {
  /** The run's own ctx, which says which parts are broken. */
  outer: Ctx;
  forge: Forge;
  repo: ForgeRepo;
  dir: string;
  env: NodeJS.ProcessEnv;
  sh: Sh;
  head: () => Promise<string>;
  /** Runs a printed chant approve command and pushes chant/lifecycle. */
  approve: (cmd: string) => Promise<void>;
  table: string;
  /** The add-note pull request (the merge part's). */
  addNote?: { id: number; checks: ForgeRun };
  /** The forked pull request (the lint-blocks part's). */
  fork?: { checks: ForgeRun; forked: string };
}

/** The reader and the writer for the template's dev profile, on the emulator. */
async function users(ctx: Ctx): Promise<void> {
  const { name, history } = ctx.db;
  if (ctx.dialect === "ch") {
    for (const sql of [
      `CREATE USER IF NOT EXISTS ${READER.user} IDENTIFIED WITH plaintext_password BY '${READER.password}' SETTINGS readonly = 1`,
      `GRANT SELECT, SHOW ON ${name}.* TO ${READER.user}`,
      `GRANT SELECT, SHOW ON ${history}.* TO ${READER.user}`,
      `CREATE USER IF NOT EXISTS ${WRITER.user} IDENTIFIED WITH plaintext_password BY '${WRITER.password}'`,
      `GRANT ALL ON ${name}.* TO ${WRITER.user}`,
      `GRANT ALL ON ${history}.* TO ${WRITER.user}`,
    ]) {
      await ctx.db.exec(sql);
    }
  } else {
    await ctx.db.exec(`DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${READER.user}') THEN CREATE ROLE ${READER.user} LOGIN PASSWORD '${READER.password}'; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${WRITER.user}') THEN CREATE ROLE ${WRITER.user} LOGIN PASSWORD '${WRITER.password}'; END IF;
    END $$`);
    await ctx.db.exec(`GRANT pg_read_all_data TO ${READER.user}`);
    await ctx.db.exec(`GRANT CREATE ON DATABASE postgres TO ${WRITER.user}`);
  }
}

/** The parts, in order. */
export function templateParts(): Array<PartEntry<State>> {
  return [
    ["merge", mergePart],
    ["project-job", projectJobPart],
    ["lint-blocks", lintBlocksPart],
    ["annotations", annotationsPart],
    ["apply-off", applyOffPart],
    ["image", imagePart],
    ["watch", watchPart],
  ];
}

/** The names of {@link templateParts}, for the claim's `parts`. */
export const templatePartNames = (): string[] => partNames(templateParts());

export function templateBody(makeForge: () => Forge): Body {
  return async (ctx: Ctx): Promise<void> => {
    const forge = makeForge();
    try {
      await runParts(ctx, await setup(ctx, forge), templateParts());
    } finally {
      await forge.close();
    }
  };
}

async function setup(ctx: Ctx, forge: Forge): Promise<State> {
  const d = ctx.dialect;
  const DIALECT = d === "ch" ? "CLICKHOUSE" : "POSTGRES";
  const prefix = `DEV_${DIALECT}`;
  const repoName = `yodel-34-${ctx.claim}-${d}${ctx.broken ? "-break" : ""}`;
  const dir = join(ctx.work, "project");
  const table = "events"; // the table both templates declare
  await users(ctx);

  // The project, from the template in this tree.
  const chant = join(repoRoot, "node_modules", ".bin", "chant");
  const params = d === "ch" ? ["database", "history_database"] : ["schema", "history_schema"];
  const init = await run(chant, ["init", "--from", `${repoRoot}#templates/${d === "ch" ? "clickhouse" : "postgres"}`, "--param", `name=${repoName}`, "--param", `${params[0] ?? ""}=${ctx.db.name}`, "--param", `${params[1] ?? ""}=${ctx.db.history}`, "project"], { cwd: ctx.work });
  if (init.code !== 0) throw new Error("chant init --from the template failed");

  // dev only: prod's profile, config, Ops and pipelines go.
  const edit = (file: string, re: RegExp) => {
    const path = join(dir, file);
    const text = readFileSync(path, "utf8");
    if (!re.test(text)) throw new Error(`${file} has no ${String(re)}`);
    writeFileSync(path, text.replace(re, ""));
  };
  edit("chant.config.ts", /^ {6}prod: \w+\("prod".*\n/m);
  edit("yodel.config.ts", /^ {4}prod: .*\n/m);
  edit("yodel.config.ts", /^ {4}\{ env: "prod".*\n/m);
  for (const f of ["ops/migrate-prod.op.ts", "ops/watch-prod.op.ts", ".forgejo/workflows/watch-prod.yml", ".github/workflows/watch-prod.yml"]) rmSync(join(dir, f), { force: true });
  for (const f of existsSync(join(dir, ".gitlab")) ? readdirSync(join(dir, ".gitlab"), { recursive: true }) : []) {
    if (String(f).includes("prod")) rmSync(join(dir, ".gitlab", String(f)), { force: true });
  }

  const local: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "CI" && !k.startsWith("GITHUB_") && !k.startsWith("YODEL_"))),
    PATH: `${join(dir, "node_modules", ".bin")}:${process.env.PATH ?? ""}`,
    [`${prefix}_URL`]: d === "ch" ? endpoints.clickhouse : endpoints.postgres,
    [`${prefix}_READER_USER`]: READER.user,
    [`${prefix}_READER_PASSWORD`]: READER.password,
    NO_COLOR: "1",
  };
  const sh: Sh = async (cmd, args, timeoutMs = 300_000) => {
    const ran = await run(cmd, args, { cwd: dir, env: local, timeoutMs });
    if (ran.code !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${String(ran.code)}`);
    return ran;
  };
  await sh("npm", ["install", "--no-audit", "--no-fund"], 600_000);
  // The template's range, resolved from the registry; package-lock.json records where from.
  const range = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { dependencies: Record<string, string> }).dependencies["@intentius/sql-yodeler"] ?? "";
  const locked = (JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8")) as { packages: Record<string, { version?: string; resolved?: string } | undefined> }).packages["node_modules/@intentius/sql-yodeler"];
  ctx.log(`@intentius/sql-yodeler ${range} installed ${locked?.version ?? "nothing"} from ${locked?.resolved ?? "nowhere"}`);
  must(/^\^\d+\.\d+\.\d+$/.test(range), `the template's package.json takes @intentius/sql-yodeler as ${range}, not a registry range`);
  must(locked?.resolved?.startsWith("https://registry.npmjs.org/@intentius/sql-yodeler/-/") === true, `npm install took @intentius/sql-yodeler from ${locked?.resolved ?? "nowhere"}, not the npm registry`);
  const installed = join(dir, "node_modules", "@intentius", "sql-yodeler");
  const approveJs = join(installed, "dist", "commands", "approve.js");
  const renderJs = () => readFileSync(join(installed, "dist", "ci", "render.js"), "utf8");
  // The chant minor the installed yodel takes and the one the template pins: in 0.x a caret range stays in its minor, so when they differ the project holds two chants and yodel's lexicons are not the project's.
  const minor = (v: string | undefined) => (v ?? "").replace(/^[\^~]/, "").split(".").slice(0, 2).join(".");
  const yodelChant = (JSON.parse(readFileSync(join(installed, "package.json"), "utf8")) as { dependencies?: Record<string, string> }).dependencies?.["@intentius/chant"];
  const projectChant = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { dependencies: Record<string, string> }).dependencies["@intentius/chant"];
  const chantApart = minor(yodelChant) !== minor(projectChant);
  if (chantApart) ctx.log(`the installed yodel takes @intentius/chant ${yodelChant ?? "?"}, the template pins ${projectChant ?? "?"}`);
  if (chantApart || !existsSync(join(installed, "dist", "ci", "render.js")) || !existsSync(approveJs) || !readFileSync(approveJs, "utf8").includes('"--resume"') || !existsSync(join(installed, "dist", "credentials.js")) || !existsSync(join(installed, "dist", "approval-mode", "index.js")) || !renderJs().includes("the record-plans job has no chant run wave --record-plans") || !existsSync(join(installed, "dist", "lint", "annotations.js")) || !renderJs().includes("code.forgejo.org/forgejo/upload-artifact") || !renderJs().includes("rendersApply")) {
    // The release in the template's range has no yodel ci (#65), no yodel approve that resumes (#47), no credentials() (#50), no approval modes (#48), no write probe in the plans job (#130), no lint annotations (#129), no Forgejo report upload that works on Forgejo or no ci.apply (#175) yet, or takes another chant minor than the template pins: this checkout's, packed and committed with the project.
    const vendor = join(dir, "vendor");
    mkdirSync(vendor, { recursive: true });
    const packed = await run("npm", ["pack", "--ignore-scripts", "--pack-destination", vendor], { cwd: repoRoot, timeoutMs: 300_000 });
    const file = packed.out.trim().split("\n").at(-1) ?? "";
    if (packed.code !== 0 || !file.endsWith(".tgz")) throw new Error(`npm pack of this checkout failed: ${packed.err}`);
    await sh("npm", ["install", "--no-audit", "--no-fund", `./vendor/${file}`], 600_000);
    ctx.log(`the release ${locked.version ?? "?"} lacks what the claim checks: the project takes this checkout's yodel, vendor/${file}`);
  }
  // The project's own job (#65), declared with chant in ci/jobs.ts; yodel ci adds it to the pull request's pipeline.
  mkdirSync(join(dir, "ci"), { recursive: true });
  writeFileSync(
    join(dir, "ci", "jobs.ts"),
    `import { Job, Step } from "@intentius/chant-lexicon-github";
import { Image, Job as GitLabJob, Rule } from "@intentius/chant-lexicon-gitlab";

// The output is not the command's text, so a log that echoes commands does not hold it.
const say = 'echo "the project job, $((40 + 2))"';
export const actions = { "project-job": new Job({ "runs-on": "ubuntu-latest", steps: [new Step({ run: say })] }) };
export const gitlab = {
  "project-job": new GitLabJob({ stage: "test", image: new Image({ name: "${NODE_IMAGE}" }), rules: [new Rule({ if: '$CI_PIPELINE_SOURCE == "merge_request_event"' })], script: [say] }),
};
`,
  );
  {
    const path = join(dir, "yodel.config.ts");
    writeFileSync(path, readFileSync(path, "utf8").replace(/^( {2}ci: \{ forges: \[[^\]]*\])( \},)$/m, '$1, jobs: "ci/jobs.ts"$2'));
    if (!readFileSync(path, "utf8").includes('jobs: "ci/jobs.ts"')) throw new Error("could not name ci/jobs.ts in yodel.config.ts ci");
  }
  const brokenRender = breakRender(ctx, join(installed, "dist", "ci", "render.js"));
  if (brokenRender !== undefined) {
    // The jobs run the same broken build: packed and committed with the project, as a release would be. Otherwise their yodel ci --check finds the pipelines stale and the lint job stops before it lints.
    const vendor = join(dir, "vendor");
    mkdirSync(vendor, { recursive: true });
    const packed = await run("npm", ["pack", "--ignore-scripts", "--pack-destination", vendor, realpathSync(installed)], { cwd: dir, timeoutMs: 300_000 });
    const file = packed.out.trim().split("\n").at(-1) ?? "";
    if (packed.code !== 0 || !file.endsWith(".tgz")) throw new Error(`npm pack of the broken build failed: ${packed.err}`);
    await sh("npm", ["install", "--no-audit", "--no-fund", `./vendor/${file}`], 600_000);
    if (renderJs() !== brokenRender) throw new Error("the broken build did not survive npm install from vendor/");
    ctx.log("BREAK: the jobs install the same broken build, from vendor/");
  }
  await sh("npx", ["yodel", "new", "init"]);
  // chant finds Ops from the git root, so the repository comes before rendering the pipelines again for dev alone.
  await sh("git", ["init", "-q", "-b", "main"]);
  await sh("git", ["config", "user.name", "yodel34"]);
  await sh("git", ["config", "user.email", "yodel34@example.invalid"]);
  await sh("git", ["config", "commit.gpgsign", "false"]);
  // The apply waves read their gate at the first parent, so the first push has one.
  await sh("git", ["commit", "-q", "--allow-empty", "-m", "chore: start"]);
  await sh("npm", ["run", "ci"]);
  await sh("git", ["add", "-A"]);
  await sh("git", ["commit", "-qm", "feat: the schema"]);

  // The repository, fresh, with the secrets the pipelines name.
  const repo = await forge.repo(ctx, repoName, {
    [`${prefix}_URL`]: forge.jobUrl(d),
    [`${prefix}_READER_USER`]: READER.user,
    [`${prefix}_READER_PASSWORD`]: READER.password,
    [`${prefix}_WRITER_USER`]: WRITER.user,
    [`${prefix}_WRITER_PASSWORD`]: WRITER.password,
  });
  await sh("git", ["remote", "add", "origin", repo.remote]);
  const head = async () => (await sh("git", ["rev-parse", "HEAD"])).out.trim();
  const approve = async (cmd: string) => {
    await sh("npx", ["chant", ...cmd.split(" ").slice(1)]);
    await sh("git", ["push", "-q", "origin", "chant/lifecycle"]);
  };

  // The first push applies nothing without an approval.
  await sh("git", ["push", "-q", "origin", "main"]);
  const first = await repo.pushed(await head());
  must(!first.ok, `the first push's apply on ${forge.name} ended ${first.status}, with nothing approved`);
  const firstCmd = WAVE_CMD.exec(first.log)?.[0];
  must(firstCmd !== undefined, "the waiting wave does not give the chant approve command");
  must(!first.log.includes("SQL_YODELER_TOKEN"), "the apply job still has a step for SQL_YODELER_TOKEN; sql-yodeler installs from npm with no token");
  must(!(await ctx.db.tableExists(table)), `${ctx.db.name}.${table} exists with nothing approved`);

  // Approved with chant approve and run again (resuming the waiting job is chant's).
  await approve(firstCmd);
  const applied = await repo.applyAgain(await head());
  must(applied.ok, `the apply after the approval ended ${applied.status}`);
  must(await ctx.db.tableExists(table), `${ctx.db.name}.${table} is not on the server after the approved apply`);
  return { outer: ctx, forge, repo, dir, env: local, sh, head, approve, table };
}

/**
 * The broken builds of the installed yodel's render.js the parts ask for:
 * project-job drops the project's own jobs; annotations renders plain
 * `yodel lint`; lint-blocks renders the lint and replay steps with `|| true`.
 */
function breakRender(outer: Ctx, render: string): string | undefined {
  const dropJobs = breaks(outer, "project-job");
  const plainLint = breaks(outer, "annotations");
  const lintPasses = breaks(outer, "lint-blocks");
  if (!dropJobs && !plainLint && !lintPasses) return undefined;
  let text = readFileSync(render, "utf8");
  const swap = (re: RegExp, to: string, why: string) => {
    const next = text.replace(re, to);
    if (next === text) throw new Error(`${render} has no ${String(re)}; the broken build cannot ${why}`);
    text = next;
  };
  if (dropJobs) {
    swap(/Object\.assign\(jobs, ownJobs\(/, "Object.assign(jobs, ((..._a) => ({}))(", "drop the project's jobs");
    swap(/for \(const \[name, job\] of Object\.entries\(ownJobs\(/, "for (const [name, job] of Object.entries(((..._a) => ({}))(", "drop the project's GitLab jobs");
    outer.log("BREAK (project-job): the installed yodel drops the project's own jobs");
  }
  if (plainLint || lintPasses) {
    const lint = `${plainLint ? "LINT" : "annotatedLint(forge)"}${lintPasses ? ' + " || true"' : ""}`;
    swap(/export const lintCommand = \(forge\) => /, `export const lintCommand = (forge) => ${lint};\nconst annotatedLint = (forge) => `, "change the lint command");
    if (plainLint) outer.log("BREAK (annotations): the installed yodel renders plain yodel lint");
  }
  if (lintPasses) {
    swap(/export const REPLAY = `([^`]*)`;/, "export const REPLAY = `$1 || true`;", "let the replay pass");
    outer.log("BREAK (lint-blocks): the installed yodel renders the lint and replay steps with || true");
  }
  writeFileSync(render, text);
  return text;
}

const WAVE_CMD = /chant approve yodel-apply yodel-apply-wave-1 --plan jcs1-sha256:[0-9a-f]{64}/;

/** A branch from main with `change` made in it, committed and pushed, and its pull request opened; the checkout goes back to main. */
async function branchPr(s: State, branch: string, title: string, change: () => Promise<void> | void): Promise<{ id: number; checks: ForgeRun }> {
  await s.sh("git", ["checkout", "-q", "main"]);
  await s.sh("git", ["checkout", "-q", "-b", branch]);
  await change();
  await s.sh("git", ["add", "-A"]);
  await s.sh("git", ["commit", "-qm", title]);
  await s.sh("git", ["push", "-q", "origin", branch]);
  const pr = await s.repo.openPr(branch, await s.head(), title);
  await s.sh("git", ["checkout", "-q", "main"]);
  return pr;
}

// ── merge, project-job ────────────────────────────────────────────────────────

/** A column added to the template's table and its migration, on a new branch from main, pushed, and a pull request opened. */
async function columnPr(s: State, column: string, extra: () => void = () => undefined): Promise<{ id: number; checks: ForgeRun }> {
  return branchPr(s, `add-${column}`, `feat: a ${column} column`, async () => {
    const schemaPath = join(s.dir, "src", "schema.ts");
    const schema = readFileSync(schemaPath, "utf8");
    const next = schema.replace(/\n {2}\)(\n|`)/, `,\n    ${column} ${s.outer.dialect === "ch" ? "String DEFAULT ''" : "text"}\n  )$1`);
    if (next === schema) throw new Error("could not add a column to the template's schema");
    writeFileSync(schemaPath, next);
    extra();
    await s.sh("npx", ["yodel", "new", `add-${column.replaceAll("_", "-")}`]);
  });
}

/** Merges pull request `id`, pulls main, and waits for the apply the merge started. */
async function mergeAndApply(s: State, id: number): Promise<{ merged: string; ran: ForgeRun }> {
  await s.sh("git", ["checkout", "-q", "main"]);
  const merged = await s.repo.merge(id);
  await s.sh("git", ["pull", "-q", "--ff-only", "origin", "main"]);
  return { merged, ran: await s.repo.pushed(merged) };
}

/**
 * A pull request adding a column: lint with the replay and the plan
 * comment, green, the server unchanged, and the plan job shows it cannot
 * write (#50). The comment's approve command, run
 * and pushed, lets the apply after the merge add the column. BREAK: merged
 * without approving, so the apply waits; then approved by hand and applied.
 */
async function mergePart(ctx: Ctx, s: State): Promise<void> {
  const pr = await columnPr(s, "note");
  s.addNote = pr;
  hold(pr.checks.ok, `the pull request's lint and plan ended ${pr.checks.status}`);
  hold(pr.checks.log.includes("Every migration replays to its recorded schema."), "the pull request's lint job did not replay the migrations into its own server");
  hold(pr.checks.log.includes("write probe   cannot write") && !pr.checks.log.includes("dev: the credentials this process holds can write"), "the pull request's plan job did not show that it cannot write (yodel config check dev --write-probe)");
  const comment = (await s.repo.comments(pr.id)).find((c) => c.startsWith("<!-- yodel:plan env=dev -->")) ?? "";
  const cmd = /```sh\n(chant approve yodel-apply yodel-apply-wave-1 --plan jcs1-sha256:[0-9a-f]{64})\n/.exec(comment)?.[1];
  hold(cmd !== undefined, "the pull request has no plan comment with an approve command");
  hold(!(await ctx.db.columnExists(s.table, "note")), "the pull request's jobs changed the server");
  if (ctx.broken) ctx.log("BREAK (merge): merged without approving the plan comment's digest");
  else await s.approve(cmd);
  const { merged, ran } = await mergeAndApply(s, pr.id);
  const applied = ran.ok && (await ctx.db.columnExists(s.table, "note"));
  if (!applied && ctx.broken) {
    const waiting = WAVE_CMD.exec(ran.log)?.[0];
    if (!waiting) throw new Error("the apply after the unapproved merge printed no chant approve command");
    await s.approve(waiting);
    const levelled = await s.repo.applyAgain(merged);
    if (!levelled.ok || !(await ctx.db.columnExists(s.table, "note"))) throw new Error(`levelling after the merge break: the apply ended ${levelled.status}`);
  }
  hold(ran.ok, `the apply after the merge ended ${ran.status}`);
  hold(applied, `${ctx.db.name}.${s.table}.note is not on the server after the merge's apply`);
}

/** The add-note pull request ran the project's own job, declared in ci/jobs.ts (#65). BREAK: the installed yodel drops it (setup). */
function projectJobPart(_ctx: Ctx, s: State): Promise<void> {
  if (!s.addNote) throw new Error("the merge part opened no pull request");
  hold(s.addNote.checks.log.includes("the project job, 42"), "the pull request did not run the project's own job, declared in ci/jobs.ts and rendered by yodel ci");
  return Promise.resolve();
}

// ── lint-blocks, annotations (#59, #129) ──────────────────────────────────────

/**
 * A pull request with a second migration that follows the same parent as
 * main's newest, a fork: its lint fails it. BREAK: the installed yodel
 * renders the lint and replay steps with `|| true` (setup), so it passes.
 * The pull request stays open.
 */
async function lintBlocksPart(_ctx: Ctx, s: State): Promise<void> {
  const migrations = join(s.dir, "migrations");
  const newest = readdirSync(migrations).filter((f) => existsSync(join(migrations, f, "migration.json"))).sort().at(-1);
  if (!newest) throw new Error("main has no migration to fork");
  const forked = `${newest}-again`;
  const pr = await branchPr(s, "fork-note", "feat: the newest migration again, a fork", async () => {
    mkdirSync(join(migrations, forked));
    for (const f of readdirSync(join(migrations, newest))) copyFileSync(join(migrations, newest, f), join(migrations, forked, f));
    const json = join(migrations, forked, "migration.json");
    const doc = readFileSync(json, "utf8");
    if (!doc.includes(`"id": "${newest}"`)) throw new Error(`${newest}'s migration.json does not record its id`);
    writeFileSync(json, doc.replace(`"id": "${newest}"`, `"id": "${forked}"`));
    // Its checksum recorded, so the fork is the only finding; lint exits 3 on the fork all the same.
    await run("npx", ["yodel", "lint", "--update-checksum", forked], { cwd: s.dir, timeoutMs: 300_000 });
  });
  s.fork = { checks: pr.checks, forked };
  hold(pr.checks.log.includes(`${forked} both follow`), "the forked pull request's lint did not report the fork");
  // The plan job fails on a fork too, so the lint job's own outcome is what is judged, where the forge says.
  const lintFailed = pr.checks.failed ? pr.checks.failed.includes("lint") : !pr.checks.ok;
  hold(lintFailed, `the forked pull request's lint job did not fail it (failed jobs: ${pr.checks.failed?.join(", ") ?? pr.checks.status})`);
}

/** The forked pull request's findings are on the forge. BREAK: plain `yodel lint` (setup), so nothing names the file. */
function annotationsPart(_ctx: Ctx, s: State): Promise<void> {
  if (!s.fork) throw new Error("the lint-blocks part opened no forked pull request");
  const { checks, forked } = s.fork;
  const file = `migrations/${forked}/migration.sql`;
  hold(checks.log.includes(`file=${file}`), `the forked pull request's findings are not on the forge: the lint job did not annotate ${file}`);
  return Promise.resolve();
}

// ── apply-off (#175) ──────────────────────────────────────────────────────────

/** The apply pipeline's files on every forge, as yodel ci renders them with apply on. */
const applyFiles = (dir: string): string[] => [
  "yodel-waves.json",
  ".gitlab/yodel-apply.gitlab-ci.yml",
  ...[".github/workflows", ".forgejo/workflows"].flatMap((d) => (existsSync(join(dir, d)) ? readdirSync(join(dir, d)).filter((f) => f.startsWith("yodel-apply")).map((f) => `${d}/${f}`) : [])),
];

/**
 * Lint and plan on pull requests only: a pull request sets `ci: { apply:
 * false }`, renders again and deletes the apply files, which yodel ci no
 * longer writes. Its lint job's `yodel ci --check` passes, and the plan
 * comment is posted. The pull request stays open. BREAK: the apply files
 * are deleted without the setting, so --check finds them missing and fails
 * the lint job.
 */
async function applyOffPart(ctx: Ctx, s: State): Promise<void> {
  if (ctx.broken) ctx.log("BREAK (apply-off): the apply pipeline's files deleted without ci.apply: false");
  const pr = await branchPr(s, "apply-off", "ci: lint and plan on pull requests only", async () => {
    if (!ctx.broken) {
      const path = join(s.dir, "yodel.config.ts");
      const text = readFileSync(path, "utf8").replace(/^( {2}ci: \{ .*?)( \},)$/m, "$1, apply: false$2");
      if (!text.includes("apply: false")) throw new Error("could not set ci.apply: false in yodel.config.ts");
      writeFileSync(path, text);
      await s.sh("npm", ["run", "ci"]);
    }
    const gone = applyFiles(s.dir).filter((f) => existsSync(join(s.dir, f)));
    if (!gone.includes("yodel-waves.json")) throw new Error("main has no yodel-waves.json to delete");
    for (const f of gone) rmSync(join(s.dir, f));
    if (!ctx.broken) await s.sh("npx", ["yodel", "ci", "--check"]);
  });
  const comment = (await s.repo.comments(pr.id)).find((c) => c.startsWith("<!-- yodel:plan env=dev -->"));
  const lintFailed = pr.checks.failed ? pr.checks.failed.includes("lint") : !pr.checks.ok;
  hold(!lintFailed && pr.checks.ok, `the pull request with ci.apply: false and no apply pipeline ended ${pr.checks.status}${pr.checks.failed ? ` (failed jobs: ${pr.checks.failed.join(", ")})` : ""}`);
  hold(comment !== undefined, "the pull request with ci.apply: false got no plan comment");
}

// ── image (#66) ───────────────────────────────────────────────────────────────

/** The CI image the jobs run in: YODEL_CLAIMS_CI_IMAGE, else ghcr.io/intentius/sql-yodeler at the installed version; with its digest. */
async function ciImage(s: State): Promise<{ ref: string; digest: string }> {
  const version = (JSON.parse(readFileSync(join(s.dir, "node_modules", "@intentius", "sql-yodeler", "package.json"), "utf8")) as { version: string }).version;
  const tag = process.env.YODEL_CLAIMS_CI_IMAGE ?? `ghcr.io/intentius/sql-yodeler:${version}`;
  const inspected = await run("docker", ["buildx", "imagetools", "inspect", tag, "--format", "{{json .Manifest}}"], { cwd: s.dir, timeoutMs: 120_000 });
  const digest = /"digest":\s*"(sha256:[0-9a-f]{64})"/.exec(inspected.out)?.[1];
  if (inspected.code !== 0 || !digest) throw new Error(`the CI image ${tag} has no digest (docker buildx imagetools inspect exited ${String(inspected.code)}); set YODEL_CLAIMS_CI_IMAGE to an image that is published`);
  return { ref: `${tag}@${digest}`, digest };
}

/**
 * A pull request with yodel.config.ts `ci.image`, the CI image pinned by its
 * digest: its jobs run in that image, install nothing, and the plan job
 * plans and comments with the image's yodel. BREAK: no `ci.image`, so the
 * jobs run in node's image and install with npm ci. The pull request stays
 * open and is never merged.
 */
async function imagePart(ctx: Ctx, s: State): Promise<void> {
  const image = await ciImage(s);
  if (ctx.broken) ctx.log("BREAK (image): yodel.config.ts names no ci.image, so the jobs install with npm ci");
  const pr = await branchPr(s, "ci-image", "ci: every job in the CI image", async () => {
    if (ctx.broken) {
      writeFileSync(join(s.dir, "README.md"), `${readFileSync(join(s.dir, "README.md"), "utf8")}\nThe CI image.\n`);
      return;
    }
    const path = join(s.dir, "yodel.config.ts");
    const text = readFileSync(path, "utf8");
    // The project's own jobs need the github and gitlab lexicons, which the image does not carry: a project in the image has none.
    const next = text.replace(', jobs: "ci/jobs.ts"', "").replace(/^( {2}ci: \{ forges: \[[^\]]*\])( \},)$/m, `$1, image: "${image.ref}"$2`);
    if (next === text) throw new Error("could not set ci.image in yodel.config.ts");
    writeFileSync(path, next);
    await s.sh("npm", ["run", "ci"]);
  });
  ctx.log(`the CI image: ${image.ref}`);
  const comment = (await s.repo.comments(pr.id)).find((c) => c.startsWith("<!-- yodel:plan env=dev -->"));
  hold(pr.checks.log.includes(image.digest), `the pull request's jobs did not run in the CI image pinned by its digest (${image.digest} is not in their log)`);
  hold(!/added \d+ packages/.test(pr.checks.log), "a job in the CI image installed packages (npm ci): the image's yodel and chant were not used");
  hold(comment !== undefined, "the plan job in the CI image did not comment its plan");
}

// ── watch (#49) ───────────────────────────────────────────────────────────────

/** The drift watch opens one tracking issue naming dev and the object; updating and closing it are chant's. BREAK: the server is not changed by hand, so the watch passes and opens none. */
async function watchPart(ctx: Ctx, s: State): Promise<void> {
  const n = ctx.db.name;
  // A property the template declares: chant reports a property the declaration leaves out (a TTL, a default) as unclaimed, not as drift.
  const byHand = ctx.dialect === "ch" ? `ALTER TABLE ${n}.events MODIFY COMMENT 'changed by hand'` : `ALTER TABLE ${n}.events ALTER COLUMN at SET DEFAULT '2000-01-01'`;
  if (ctx.broken) ctx.log("BREAK (watch): the server is not changed by hand");
  else await ctx.db.exec(byHand);
  const found = await s.repo.watch(await s.head());
  hold(!found.ok, `the drift watch ended ${found.status} with dev changed by hand`);
  const opened = (await s.repo.issues()).filter((i) => i.body.includes("<!-- yodel:drift ") && i.body.includes("env=dev"));
  hold(opened.length === 1 && opened[0]?.open === true, `the drift watch did not open one tracking issue: ${JSON.stringify(opened.map((i) => ({ n: i.number, open: i.open, title: i.title })))}`);
  const issue = opened[0];
  hold(/^Drift in dev: .*events/.test(issue.title) && issue.body.includes("`events`"), `the tracking issue does not name dev and events: ${issue.title}`);
}
