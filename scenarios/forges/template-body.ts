/**
 * The starter template (#17), end to end on a forge: the body the template
 * claims share (template on Forgejo, template-github on act and the mock
 * GitHub, template-gitlab on a local GitLab). Each forge is in its own file
 * here; see ./forge.ts for what a forge provides.
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
 * A team's first weeks with the template, as parts ({@link templateParts},
 * run by runParts: under BREAK=1 each part breaks its own property and must
 * catch it, under BREAK=<part> that part alone is broken and the rest hold).
 * Before the parts, the setup: the project, its own job in ci/jobs.ts
 * (yodel.config.ts `ci.jobs`), the pipelines rendered by the installed yodel
 * (`yodel ci`, #65), a fresh repository with the secrets they name, and the
 * first push, whose apply must stop at the gate with the approve command and
 * apply nothing (a setup check: it fails the run both ways). The parts:
 *
 * - stale (#59): a newer yodel's rendering, and a pipeline file edited by
 *   hand, each fail `yodel ci --check` until `yodel ci` renders them again.
 *   BREAK: the installed yodel's --check is built to compare nothing.
 * - notify (#61): the waiting apply's webhook reaches a receiver that
 *   checks its signature. BREAK: the receiver checks with another key.
 * - resume (#47; forges with resume): `yodel approve dev` at a terminal
 *   records the approval and the forge starts the waiting job again, which
 *   applies. BREAK: --no-resume, so no job starts (then run by hand).
 *   A forge without resume is approved with chant approve and run again by
 *   hand in the setup.
 * - sealed, pr-review (#48; forges with reviews): approval modes. BREAK: the
 *   sealed wave is left ledger, so an unsigned approval applies; the pull
 *   request is approved by its author alone, so the apply waits.
 * - merge: a pull request adding a column gets lint (with the replay) and
 *   the plan comment, both green and changing nothing; the comment's
 *   approve command, run and pushed, lets the apply after the merge add the
 *   column. BREAK: merged without approving, so the column waits (then
 *   approved and applied, so the parts after it go on).
 * - project-job (#65): that pull request ran the project's own job. BREAK:
 *   the installed yodel is built to drop the project's jobs.
 * - lint-blocks (#59): a pull request with a forked migration fails its
 *   lint job. BREAK: the installed yodel renders the lint and replay steps
 *   with `|| true`.
 * - annotations (#129): that pull request's findings are on the forge: a
 *   workflow command naming the file (GitHub, Forgejo), the code quality
 *   report kept as the job's artifact (GitLab). BREAK: the installed yodel
 *   renders plain `yodel lint`.
 * - write-probe (#50, #59): a pull request's plan job tries a write and is
 *   refused. BREAK: for that pull request the reader's secrets hold the
 *   writer, so the write goes through and the probe fails the job.
 * - image (#66; forges where it runs): a pull request with yodel.config.ts
 *   `ci.image`, the CI image pinned by its digest, runs its jobs in that
 *   image with nothing installed, and the plan job comments. BREAK: no
 *   `ci.image`, so the jobs install with npm ci in node's image.
 * - command-token (#132; forges where it runs): a pull request whose dev
 *   reader's password is a `command` token source (scripts/mint-token.sh,
 *   standing in for a cloud's token command) plans with the token it mints:
 *   the job holds no reader password variable. BREAK: the command mints a
 *   wrong token, so the plan job cannot connect.
 * - watch (#49, #59): the drift watch, run as its schedule would: with a
 *   change made by hand on the server it fails and opens one tracking issue
 *   naming the environment and the object; with a second change it updates
 *   that issue; with both put back it passes and closes it. BREAK: the
 *   server is not changed by hand, so the watch opens no issue.
 */

import { copyFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { hold, partNames, runParts, type Body, type Ctx, type PartEntry } from "../lib/claim.js";
import { endpoints } from "../lib/db.js";
import { run, type Ran } from "../lib/exec.js";
import { repoRoot } from "../lib/project.js";
import { NODE_IMAGE, type Forge, type ForgeRepo, type ForgeRun } from "./forge.js";
import { startNotifyPart, type NotifyPart } from "./notify-part.js";

const READER = { user: "yodel_34_reader", password: "yodel-34-reader" };
const WRITER = { user: "yodel_34_writer", password: "yodel-34-writer" };
/** BREAK (write-probe): a user of its own that can write, in the reader's secrets. yodel refuses a reader and writer that are one user in every job, so the break is a reader that writes, not the writer itself. */
const LEAKY = { user: "yodel_34_reader_writes", password: "yodel-34-reader-writes" };

/** What a forge's template claim runs, beyond the parts every forge runs. */
export interface TemplateFeatures {
  /** `yodel approve` starts the waiting job again (#47). */
  resume: boolean;
  /** Pull request reviews, for the approval modes (#48). */
  review: boolean;
  /** A pull request whose jobs run in the CI image (#66). */
  image: boolean;
  /** A pull request whose reader's password is a `command` token source (#132). */
  commandToken: boolean;
}

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
  /** DEV_CLICKHOUSE or DEV_POSTGRES: what dev's variables start with. */
  prefix: string;
  notify: NotifyPart | undefined;
  /** The first push's waiting apply and the approve command it printed. */
  first: { run: ForgeRun; cmd: string };
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
      `CREATE USER IF NOT EXISTS ${LEAKY.user} IDENTIFIED WITH plaintext_password BY '${LEAKY.password}'`,
      `GRANT ALL ON ${name}.* TO ${LEAKY.user}`,
      `GRANT ALL ON ${history}.* TO ${LEAKY.user}`,
    ]) {
      await ctx.db.exec(sql);
    }
  } else {
    await ctx.db.exec(`DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${READER.user}') THEN CREATE ROLE ${READER.user} LOGIN PASSWORD '${READER.password}'; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${WRITER.user}') THEN CREATE ROLE ${WRITER.user} LOGIN PASSWORD '${WRITER.password}'; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${LEAKY.user}') THEN CREATE ROLE ${LEAKY.user} LOGIN PASSWORD '${LEAKY.password}'; END IF;
    END $$`);
    await ctx.db.exec(`GRANT pg_read_all_data TO ${READER.user}`);
    await ctx.db.exec(`GRANT CREATE ON DATABASE postgres TO ${WRITER.user}`);
    // Every privilege the writer has, the writer's own objects included.
    await ctx.db.exec(`GRANT ${WRITER.user} TO ${LEAKY.user}`);
  }
}

/** The parts a forge with `features` runs, in order. */
export function templateParts(features: TemplateFeatures): Array<PartEntry<State>> {
  return [
    ["stale", stalePart],
    ["notify", notifyPart],
    ...(features.resume ? [["resume", resumePart] as PartEntry<State>] : []),
    ...(features.review ? [["sealed", sealedPart] as PartEntry<State>, ["pr-review", prReviewPart] as PartEntry<State>] : []),
    ["merge", mergePart],
    ["project-job", projectJobPart],
    ["lint-blocks", lintBlocksPart],
    ["annotations", annotationsPart],
    ["write-probe", writeProbePart],
    ...(features.image ? [["image", imagePart] as PartEntry<State>] : []),
    ...(features.commandToken ? [["command-token", commandTokenPart] as PartEntry<State>] : []),
    ["watch", watchPart],
  ];
}

/** The names of {@link templateParts}, for the claim's `parts`. */
export const templatePartNames = (features: TemplateFeatures): string[] => partNames(templateParts(features));

export function templateBody(makeForge: () => Forge, features: TemplateFeatures): Body {
  return async (ctx: Ctx): Promise<void> => {
    const forge = makeForge();
    const notify: { part?: NotifyPart | undefined } = {};
    try {
      const state = await setup(ctx, forge, notify, features);
      await runParts(ctx, state, templateParts(features));
    } finally {
      await notify.part?.close();
      await forge.close();
    }
  };
}

async function setup(ctx: Ctx, forge: Forge, notify: { part?: NotifyPart | undefined }, features: TemplateFeatures): Promise<State> {
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
  if (!existsSync(join(installed, "dist", "ci", "render.js")) || !existsSync(approveJs) || !readFileSync(approveJs, "utf8").includes('"--resume"') || !existsSync(join(installed, "dist", "credentials.js")) || !existsSync(join(installed, "dist", "approval-mode", "index.js")) || !renderJs().includes("the record-plans job has no chant run wave --record-plans") || !existsSync(join(installed, "dist", "lint", "annotations.js")) || !renderJs().includes("code.forgejo.org/forgejo/upload-artifact")) {
    // The release in the template's range has no yodel ci (#65), no yodel approve that resumes (#47), no credentials() (#50), no approval modes (#48), no write probe in the plans job (#130), no lint annotations (#129) or no Forgejo report upload that works on Forgejo yet: this checkout's, packed and committed with the project.
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
  // The webhook (#61): notify in yodel.config.ts and a receiver, before the pipelines are rendered again. BREAK (notify): the receiver checks with another key.
  notify.part = await startNotifyPart({ ...ctx, broken: breaks(ctx, "notify") }, dir);
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

  // The repository, fresh, with the secrets the pipelines name (and the command-token part's reader user).
  const repo = await forge.repo(ctx, repoName, {
    [`${prefix}_URL`]: forge.jobUrl(d),
    [`${prefix}_READER_USER`]: READER.user,
    [`${prefix}_READER_PASSWORD`]: READER.password,
    [`${prefix}_WRITER_USER`]: WRITER.user,
    [`${prefix}_WRITER_PASSWORD`]: WRITER.password,
    ...(features.commandToken ? { [`${prefix}_TOKEN_USER`]: READER.user } : {}),
    ...(notify.part?.secrets ?? {}),
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
  const state: State = { outer: ctx, forge, repo, dir, env: local, sh, head, approve, table, prefix, notify: notify.part, first: { run: first, cmd: firstCmd } };

  // A forge without resume: approved with chant approve and run again by hand.
  if (!features.resume) {
    await approve(firstCmd);
    const applied = await repo.applyAgain(await head());
    must(applied.ok, `the apply after the approval ended ${applied.status}`);
    must(await ctx.db.tableExists(table), `${ctx.db.name}.${table} is not on the server after the approved apply`);
  }
  return state;
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

// ── stale (#59) ───────────────────────────────────────────────────────────────

/**
 * A newer yodel renders the pipelines differently: `yodel ci --check` fails
 * until `yodel ci` renders them again. Played with the installed yodel's
 * header line changed, then put back. Then a pipeline file edited by hand:
 * --check fails until `yodel ci` writes it back. BREAK: the installed
 * yodel's --check is built to record nothing as stale.
 */
async function stalePart(ctx: Ctx, s: State): Promise<void> {
  const dist = join(s.dir, "node_modules", "@intentius", "sql-yodeler", "dist");
  const render = join(dist, "ci", "render.js");
  const ciJs = join(dist, "commands", "ci.js");
  const saved = { render: readFileSync(render, "utf8"), ci: readFileSync(ciJs, "utf8") };
  try {
    if (ctx.broken) {
      const broken = saved.ci.replace("stale.push(file.path);", "void file;");
      if (broken === saved.ci) throw new Error(`${ciJs} has no stale.push; the broken build cannot drop the check`);
      writeFileSync(ciJs, broken);
      ctx.log("BREAK (stale): the installed yodel's ci --check records nothing as stale");
    }
    const newer = saved.render.replace("# Edit those and render again;", "# Edit those, then render again;");
    if (newer === saved.render) throw new Error(`the rendered files' header is not in ${render}`);
    writeFileSync(render, newer);
    const check = await run("npx", ["yodel", "ci", "--check"], { cwd: s.dir, timeoutMs: 300_000 });
    hold(check.code === 1 && check.err.includes("stale, run yodel ci"), `after the installed yodel changed its pipelines, yodel ci --check exited ${String(check.code)}`);
    await s.sh("npx", ["yodel", "ci"]);
    hold((await s.sh("npx", ["yodel", "ci", "--check"])).code === 0, "yodel ci --check failed after yodel ci");
    hold((await s.sh("git", ["status", "--porcelain"])).out.includes(".github/workflows/yodel-pr.yml"), "the newer yodel's yodel ci did not change the committed pipelines");
    writeFileSync(render, saved.render);
    await s.sh("npx", ["yodel", "ci"]);
    hold((await s.sh("git", ["status", "--porcelain"])).out.trim() === "", "rendering again with the installed yodel did not give back the committed pipelines");

    // A pipeline file edited by hand.
    const edited = join(s.dir, ".github", "workflows", "yodel-pr.yml");
    writeFileSync(edited, `${readFileSync(edited, "utf8")}# by hand\n`);
    const byHand = await run("npx", ["yodel", "ci", "--check"], { cwd: s.dir, timeoutMs: 300_000 });
    hold(byHand.code === 1 && byHand.err.includes(".github/workflows/yodel-pr.yml"), `with .github/workflows/yodel-pr.yml edited by hand, yodel ci --check exited ${String(byHand.code)}`);
    await s.sh("npx", ["yodel", "ci"]);
    hold((await s.sh("git", ["status", "--porcelain"])).out.trim() === "", "yodel ci did not write back the file edited by hand");
  } finally {
    writeFileSync(render, saved.render);
    writeFileSync(ciJs, saved.ci);
    await s.sh("git", ["checkout", "-q", "--", "."]);
  }
}

// ── notify (#61) ──────────────────────────────────────────────────────────────

/** The first push's waiting apply sent a waiting event for dev, signed with the key. BREAK: the receiver checks with another key (set up before the first push). */
function notifyPart(ctx: Ctx, s: State): Promise<void> {
  if (!s.notify) throw new Error("the webhook part has no receiver: the installed yodel has no notify (#61)");
  const skipped = s.notify.rendered();
  if (skipped) throw new Error(`the webhook part cannot run: ${skipped}`);
  const problem = s.notify.check();
  hold(problem === undefined, problem ?? "");
  if (ctx.broken) ctx.log("BREAK (notify): the receiver checked with another key, and accepted the event");
  return Promise.resolve();
}

// ── resume (#47) ──────────────────────────────────────────────────────────────

/**
 * `yodel approve dev` at a terminal, the answer typed being `dev`, with the
 * token the forge's resume needs. It records the approval of the waiting
 * wave's digest, chant pushes it and starts the waiting job again, and the
 * run the forge starts applies without a new push. BREAK: `--no-resume`,
 * so no run starts within the wait and the table is not created; the job
 * is then run by hand, so the parts after it go on, and the part fails.
 */
async function resumePart(ctx: Ctx, s: State): Promise<void> {
  const { repo, first } = s;
  if (!repo.resumed || !repo.resumeEnv) throw new Error("the forge has no resume");
  const sha = await s.head();
  const digest = /--plan (\S+)/.exec(first.cmd)?.[1] ?? "";
  const env = { ...Object.fromEntries(Object.entries(s.env).filter(([k]) => !["CHANT_FORGE_TOKEN", "GH_TOKEN", "GITLAB_TOKEN", "NODE_OPTIONS"].includes(k))), ...(await repo.resumeEnv()) };
  const args = ["approve", "dev", "--plan", digest, ...(ctx.broken ? ["--no-resume"] : [])];
  if (ctx.broken) ctx.log("BREAK (resume): yodel approve dev --no-resume, so the waiting job is not started again");
  const ran = await run("node", [askingYodel(ctx, s.dir), "dev", ...args], { cwd: s.dir, env, timeoutMs: 600_000 });
  ctx.log(`yodel ${args.join(" ")} exited ${String(ran.code)}:\n${ran.out}${ran.err}`);
  if (ran.code !== 0) throw new Error(`yodel ${args.join(" ")} exited ${String(ran.code)}`);
  const resumed = await repo.resumed(sha, first.run, ctx.broken ? 60_000 : 120_000);
  const why = !resumed ? "after yodel approve dev, the forge started no run of the waiting apply again" : !resumed.ok ? `the resumed apply ended ${resumed.status}` : (await ctx.db.tableExists(s.table)) ? undefined : `${ctx.db.name}.${s.table} is not on the server after the resumed apply`;
  if (why !== undefined && ctx.broken) {
    if (await ctx.db.tableExists(s.table)) throw new Error(`BREAK: ${ctx.db.name}.${s.table} exists with the job not resumed`);
    // Levelled: the approval is recorded, so the job run by hand applies.
    await s.sh("git", ["push", "-q", "origin", "chant/lifecycle"]);
    const byHand = await repo.applyAgain(sha);
    if (!byHand.ok || !(await ctx.db.tableExists(s.table))) throw new Error(`levelling after the resume break: the apply run by hand ended ${byHand.status}`);
  }
  hold(why === undefined, why ?? "");
}

/**
 * The project's yodel CLI (vendored or installed) with a terminal that
 * answers every question with argv[2]: a person typing the environment's name.
 */
function askingYodel(ctx: Ctx, dir: string): string {
  const root = join(ctx.work, "yodel-ask");
  const file = join(root, "ask.mjs");
  if (existsSync(file)) return file;
  mkdirSync(root, { recursive: true });
  symlinkSync(join(dir, "node_modules"), join(root, "node_modules"));
  const cli = pathToFileURL(join(realpathSync(join(dir, "node_modules", "@intentius", "sql-yodeler")), "dist", "cli.js")).href;
  writeFileSync(
    file,
    `import { register } from "tsx/esm/api";
register();
const { main } = await import(${JSON.stringify(cli)});
const [answer, ...args] = process.argv.slice(2);
process.exitCode = await main(args, {
  out: (t) => process.stdout.write(t),
  err: (t) => process.stderr.write(t),
  ask: async (q) => { process.stderr.write(q + answer + "\\n"); return answer; },
});
`,
  );
  return file;
}

// ── Approval modes (#48) ──────────────────────────────────────────────────────

/** dev's wave in yodel.config.ts with this approval mode (none: ledger), rendered again with yodel ci. */
async function setDevApproval(s: State, mode: "sealed" | "pr-review" | undefined): Promise<void> {
  const path = join(s.dir, "yodel.config.ts");
  const text = readFileSync(path, "utf8");
  if (!/^ {4}\{ env: "dev", gate: "always"/m.test(text)) throw new Error("yodel.config.ts has no dev wave to set the approval of");
  writeFileSync(path, text.replace(/^( {4}\{ env: "dev", gate: "always")(, approval: "[^"]*")?( \},)$/m, `$1${mode ? `, approval: "${mode}"` : ""}$3`));
  await s.sh("npm", ["run", "ci"]);
}

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

/** Commits what changed on main, pushes it, and waits for its apply, which has nothing pending. */
async function onMain(s: State, message: string): Promise<void> {
  await s.sh("git", ["add", "-A"]);
  await s.sh("git", ["commit", "-qm", message]);
  await s.sh("git", ["push", "-q", "origin", "main"]);
  const ran = await s.repo.pushed(await s.head());
  if (!ran.ok) throw new Error(`the push of "${message}" ended ${ran.status}, with nothing pending`);
}

/** An ssh key for sealing approvals, outside the project. */
async function sshKey(ctx: Ctx, name: string): Promise<{ file: string; pub: string }> {
  const file = join(ctx.work, `key-${name}`);
  if (!existsSync(file)) {
    const made = await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", name, "-f", file], { cwd: ctx.work });
    if (made.code !== 0) throw new Error(`ssh-keygen could not make ${name}'s key`);
  }
  return { file, pub: readFileSync(`${file}.pub`, "utf8").trim().split(" ").slice(0, 2).join(" ") };
}

/**
 * Sealed (#48): dev's wave counts only an approval sealed by a key
 * `.chant/allowed_signers` lists at the base. BREAK: the wave stays ledger,
 * so the unsigned approval applies. Either way it ends with the column
 * applied.
 */
async function sealedPart(ctx: Ctx, s: State): Promise<void> {
  const alice = await sshKey(ctx, "alice");
  const mallory = await sshKey(ctx, "mallory");
  if (ctx.broken) ctx.log("BREAK (sealed): dev's wave is left ledger, so any approval counts");
  await setDevApproval(s, ctx.broken ? undefined : "sealed");
  mkdirSync(join(s.dir, ".chant"), { recursive: true });
  writeFileSync(join(s.dir, ".chant", "allowed_signers"), `alice ${alice.pub}\n`);
  await onMain(s, "chore: dev's wave sealed; alice signs");

  // The change: a column, and mallory's key added to the signers file.
  const pr = await columnPr(s, "sealed_note", () => {
    writeFileSync(join(s.dir, ".chant", "allowed_signers"), `alice ${alice.pub}\nmallory ${mallory.pub}\n`);
  });
  if (!pr.checks.ok) throw new Error(`the sealed part's pull request checks ended ${pr.checks.status}`);
  const { merged, ran: waited } = await mergeAndApply(s, pr.id);
  hold(!waited.ok, `the merged change applied with nothing approved (${waited.status})`);
  const printed = WAVE_CMD.exec(waited.log)?.[0];
  if (printed === undefined) throw new Error("the waiting sealed wave did not print its chant approve command");
  if (!ctx.broken) hold(new RegExp(`${printed.replace(/[^\w]/g, "\\$&")} --sign`).test(waited.log), "the sealed wave's approve command does not end in --sign");

  // An unsigned approval by alice, and one sealed by mallory with the key the change added.
  const chantApprove = async (args: string[]) => {
    await s.sh("npx", ["chant", ...printed.split(" ").slice(1), ...args]);
  };
  await chantApprove(["--actor", "alice"]);
  await chantApprove(["--actor", "mallory", "--sign", mallory.file]);
  await s.sh("git", ["push", "-q", "origin", "chant/lifecycle"]);
  const unsealed = await s.repo.applyAgain(merged);
  const applied = unsealed.ok || (await ctx.db.columnExists(s.table, "sealed_note"));
  if (ctx.broken && !applied) throw new Error(`under ledger the unsigned approval did not apply (${unsealed.status})`);
  if (!applied) {
    // Sealed by alice, listed at base: it applies.
    await chantApprove(["--actor", "alice", "--sign", alice.file]);
    await s.sh("git", ["push", "-q", "origin", "chant/lifecycle"]);
    const sealed = await s.repo.applyAgain(merged);
    hold(sealed.ok && (await ctx.db.columnExists(s.table, "sealed_note")), `alice's sealed approval did not apply the sealed wave (${sealed.status})`);
    hold(/approval sealed/.test(sealed.log), "the wave job did not say it was approved under sealed");
  }
  hold(!applied, "an unsigned approval, or one sealed by a key the change itself added, let the sealed wave apply");
}

/**
 * Pull request review (#48): dev's wave is pr-review. A pull request whose
 * head another writer approved applies on merge, with no chant approve.
 * BREAK: the author alone approves (Forgejo refuses it), so the apply waits;
 * the wave is then approved by hand. Either way it ends with the column
 * applied, and dev's wave stays pr-review (a chant approve counts there too).
 */
async function prReviewPart(ctx: Ctx, s: State): Promise<void> {
  await setDevApproval(s, "pr-review");
  await onMain(s, "chore: dev's wave approved by the pull request's review");
  const pr = await columnPr(s, "reviewed_note");
  if (!pr.checks.ok) throw new Error(`the pr-review part's pull request checks ended ${pr.checks.status}`);
  // chant run wave --record-plans prints each wave's digest at the head (its step's name, not the command, is what a forge's log shows).
  const recorded = /wave \d+ \(dev\) at [0-9a-f]{7,40}: jcs1-sha256:[0-9a-f]{64}/.test(pr.checks.log);
  // The plans job holds readers only, and shows it with the write probe, as the plan job does (#50, #130).
  const probed = pr.checks.log.split("write probe   cannot write").length - 1 >= 2;
  const sha = (await s.sh("git", ["rev-parse", "add-reviewed_note"])).out.trim();
  await s.repo.review?.(pr.id, sha, "author");
  if (ctx.broken) ctx.log("BREAK (pr-review): the pull request is approved by its author alone");
  else await s.repo.review?.(pr.id, sha, "reviewer");
  const { merged, ran } = await mergeAndApply(s, pr.id);
  const applied = ran.ok && (await ctx.db.columnExists(s.table, "reviewed_note"));
  if (!applied) {
    // Levelled: the waiting wave approved by hand, so the parts after it go on.
    const cmd = WAVE_CMD.exec(ran.log)?.[0];
    if (!cmd) throw new Error("the waiting pr-review wave printed no chant approve command");
    await s.approve(cmd);
    const levelled = await s.repo.applyAgain(merged);
    if (!levelled.ok) throw new Error(`levelling after the pr-review wave waited: the apply ended ${levelled.status}`);
  }
  hold(recorded, "the pull request did not run chant run wave --record-plans: no wave's digest at the head in its log");
  hold(probed, "the pull request's plans job (yodel-apply-plans) did not show that it cannot write (yodel config check --write-probe), as the plan job does");
  hold(applied, `the pull request approved by another writer did not apply on merge (${ran.status})`);
  hold(/review of #\d+/.test(ran.log), "the wave job did not name the review that approved it");
}

// ── merge, project-job ────────────────────────────────────────────────────────

/**
 * A pull request adding a column: lint with the replay and the plan
 * comment, green, the server unchanged. The comment's approve command, run
 * and pushed, lets the apply after the merge add the column. BREAK: merged
 * without approving, so the apply waits; then approved by hand and applied.
 */
async function mergePart(ctx: Ctx, s: State): Promise<void> {
  const pr = await columnPr(s, "note");
  s.addNote = pr;
  hold(pr.checks.ok, `the pull request's lint and plan ended ${pr.checks.status}`);
  hold(pr.checks.log.includes("Every migration replays to its recorded schema."), "the pull request's lint job did not replay the migrations into its own server");
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
  const gitlab = s.forge.name === "GitLab";
  const annotated = gitlab ? /gl-code-quality-report\.json: found 1 matching/.test(checks.log) : checks.log.includes(`file=${file}`);
  hold(annotated, `the forked pull request's findings are not on the forge: not ${gitlab ? "the lint job kept the code quality report as its artifact" : `the lint job annotated ${file}`}`);
  return Promise.resolve();
}

// ── write-probe (#50, #59) ────────────────────────────────────────────────────

/**
 * A pull request's plan job tries a write before its plan and must be
 * refused. BREAK: for this pull request the reader's secrets hold a user of
 * their own that can write (not the writer: yodel refuses a reader and
 * writer that are one user), so the write goes through and the probe fails
 * the job (exit 4).
 */
async function writeProbePart(ctx: Ctx, s: State): Promise<void> {
  const reader = { [`${s.prefix}_READER_USER`]: READER.user, [`${s.prefix}_READER_PASSWORD`]: READER.password };
  if (ctx.broken) {
    if (!s.repo.setSecrets) throw new Error(`${s.forge.name}: the forge cannot change a secret, so the write-probe part cannot map the writer`);
    await s.repo.setSecrets({ [`${s.prefix}_READER_USER`]: LEAKY.user, [`${s.prefix}_READER_PASSWORD`]: LEAKY.password });
    ctx.log(`BREAK (write-probe): the reader's secrets hold ${LEAKY.user}, a user that can write, for this pull request`);
  }
  let pr: { id: number; checks: ForgeRun };
  try {
    pr = await branchPr(s, "probe", "docs: a line", () => {
      writeFileSync(join(s.dir, "README.md"), `${readFileSync(join(s.dir, "README.md"), "utf8")}\nA line.\n`);
    });
  } finally {
    if (ctx.broken) await s.repo.setSecrets?.(reader);
  }
  const refused = pr.checks.log.includes("write probe   cannot write");
  const wrote = pr.checks.log.includes("dev: the credentials this process holds can write");
  hold(refused && !wrote, wrote ? "the pull request's plan job holds credentials that can write (yodel config check dev --write-probe failed it)" : "the pull request's plan job did not show that it cannot write (yodel config check dev --write-probe)");
  hold(pr.checks.ok, `the write-probe part's pull request ended ${pr.checks.status}`);
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

// ── command-token (#132) ──────────────────────────────────────────────────────

/**
 * A pull request whose dev reader's password is a `command` token source,
 * scripts/mint-token.sh, standing in for a cloud's token command: yodel ci
 * maps no reader password variable into the plan job, which mints the token
 * when it connects and comments its plan. BREAK: the command mints a wrong
 * token, so the plan job cannot connect. The pull request stays open.
 */
async function commandTokenPart(ctx: Ctx, s: State): Promise<void> {
  const dialect = ctx.dialect === "ch" ? "clickhouse" : "postgres";
  const token = ctx.broken ? "not-the-token" : READER.password;
  if (ctx.broken) ctx.log("BREAK (command-token): scripts/mint-token.sh mints a wrong token");
  const pr = await branchPr(s, "command-token", "feat: dev's reader password from a command token source", async () => {
    const script = join(s.dir, "scripts", "mint-token.sh");
    mkdirSync(join(s.dir, "scripts"), { recursive: true });
    // Stands in for a cloud's token command, which mints from the job's identity.
    writeFileSync(script, `#!/bin/sh\necho "mint-token: a token for $${s.prefix}_TOKEN_USER" >&2\nprintf '%s\\n' '${token}'\n`);
    chmodSync(script, 0o755);
    const config = join(s.dir, "chant.config.ts");
    const text = readFileSync(config, "utf8");
    const call = `...credentials(env, "${dialect}"),`;
    if (!text.includes(call)) throw new Error(`chant.config.ts has no ${call}`);
    writeFileSync(config, text.replace(call, `...credentials(env, "${dialect}", env === "dev" ? { reader: { user: { env: "${s.prefix}_TOKEN_USER" }, password: { token: "command", command: ["./scripts/mint-token.sh"] } } } : {}),`));
    await s.sh("npm", ["run", "ci"]);
  });
  const rendered = [".github/workflows/yodel-pr.yml", ".forgejo/workflows/yodel-pr.yml", ".gitlab-ci.yml"].map((f) => join(s.dir, f)).filter((f) => existsSync(f));
  await s.sh("git", ["checkout", "-q", "command-token"]);
  const pipelines = rendered.map((f) => readFileSync(f, "utf8")).join("\n");
  await s.sh("git", ["checkout", "-q", "main"]);
  if (pipelines.includes(`${s.prefix}_READER_PASSWORD`)) throw new Error(`the rendered pull request pipelines still pass ${s.prefix}_READER_PASSWORD with the reader's password from a command`);
  const comment = (await s.repo.comments(pr.id)).find((c) => c.startsWith("<!-- yodel:plan env=dev -->"));
  hold(pr.checks.ok, `the pull request whose reader's password is a command token ended ${pr.checks.status}`);
  hold(comment !== undefined, "the plan job, with the reader's password minted by a command, did not comment its plan");
}

// ── watch (#49) ───────────────────────────────────────────────────────────────

/** The drift watch's tracking issue: opened, updated, closed. BREAK: the server is not changed by hand, so the watch passes and opens none. */
async function watchPart(ctx: Ctx, s: State): Promise<void> {
  const n = ctx.db.name;
  // Each change is to a property the template declares: chant reports a property the declaration leaves out (a TTL, a default) as unclaimed, not as drift.
  const [byHand, byHandAgain, undo] =
    ctx.dialect === "ch"
      ? [[`ALTER TABLE ${n}.events MODIFY COMMENT 'changed by hand'`], [`ALTER TABLE ${n}.events MODIFY COLUMN kind String`], [`ALTER TABLE ${n}.events MODIFY COMMENT 'One row per event'`, `ALTER TABLE ${n}.events MODIFY COLUMN kind LowCardinality(String)`]]
      : [[`ALTER TABLE ${n}.events ALTER COLUMN at SET DEFAULT '2000-01-01'`], [`ALTER TABLE ${n}.events ALTER COLUMN kind DROP NOT NULL`], [`ALTER TABLE ${n}.events ALTER COLUMN at SET DEFAULT now()`, `ALTER TABLE ${n}.events ALTER COLUMN kind SET NOT NULL`]];
  const main = await s.head();
  const tracking = async () => (await s.repo.issues()).filter((i) => i.body.includes("<!-- yodel:drift ") && i.body.includes("env=dev"));
  if (ctx.broken) ctx.log("BREAK (watch): the server is not changed by hand");
  else for (const sql of byHand) await ctx.db.exec(sql);
  const found = await s.repo.watch(main);
  hold(!found.ok, `the drift watch ended ${found.status} with dev changed by hand`);
  const opened = await tracking();
  hold(opened.length === 1 && opened[0]?.open === true, `the drift watch did not open one tracking issue: ${JSON.stringify(opened.map((i) => ({ n: i.number, open: i.open, title: i.title })))}`);
  const issue = opened[0];
  hold(/^Drift in dev: .*events/.test(issue.title) && issue.body.includes("`events`"), `the tracking issue does not name dev and events: ${issue.title}`);
  for (const sql of byHandAgain) await ctx.db.exec(sql);
  const again = await s.repo.watch(main);
  hold(!again.ok, `the drift watch ended ${again.status} with dev still changed`);
  const updated = await tracking();
  hold(updated.length === 1 && updated[0]?.number === issue.number && updated[0].open, `the second watch did not keep the one issue #${String(issue.number)} open: ${JSON.stringify(updated.map((i) => ({ n: i.number, open: i.open })))}`);
  hold(/column kind/.test(updated[0].body), `the tracking issue was not updated with the second change: ${updated[0].body.slice(0, 600)}`);
  for (const sql of undo) await ctx.db.exec(sql);
  const clean = await s.repo.watch(main);
  hold(clean.ok, `the drift watch ended ${clean.status} with dev put back`);
  const closed = await tracking();
  hold(closed.length === 1 && closed[0]?.number === issue.number && !closed[0].open, `the watch did not close #${String(issue.number)} once dev was put back: ${JSON.stringify(closed.map((i) => ({ n: i.number, open: i.open })))}`);
}

