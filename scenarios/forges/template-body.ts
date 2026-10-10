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
 * `yodel ci` (#65), which the template's `npm run ci` runs, the project takes
 * yodel from `npm pack` of this checkout instead, committed in the project
 * (vendor/), so every job's `npm ci` installs the same. The dev profile is
 * the claim's database yodel_34_<claim>, the history yodel_34_<claim>_history,
 * with a reader and a writer user made for it (yodel_34_reader,
 * yodel_34_writer). The lint job replays into its own service container
 * (replay-clickhouse / replay-postgres), never the shared emulator.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { hold, type Body, type Ctx } from "../lib/claim.js";
import { endpoints } from "../lib/db.js";
import { run, type Ran } from "../lib/exec.js";
import { repoRoot } from "../lib/project.js";
import { NODE_IMAGE, type Forge, type ForgeRepo, type ForgeRun } from "./forge.js";
import { judgeNotify, startNotifyPart, type NotifyPart } from "./notify-part.js";

const READER = { user: "yodel_34_reader", password: "yodel-34-reader" };
const WRITER = { user: "yodel_34_writer", password: "yodel-34-writer" };

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

/**
 * A team's first weeks with the template, on a forge: the first migration
 * pushed to main applies nothing until its digest is approved (chant
 * approve, pushed to chant/lifecycle), then the apply, run again, applies
 * it. A pull request adding a column gets lint (with the replay into the
 * job's own server) and the plan comment, both green; the comment's
 * approve command, run and pushed, lets the apply after the merge add the
 * column. The server is checked directly each time. Then the drift watch
 * (#49), run as its schedule would: with a change made by hand on the
 * server it fails and opens one tracking issue naming the environment and
 * the object; with a second change it updates that issue; with both put
 * back it passes and closes it.
 * The pipelines are rendered by the installed package (`yodel ci`, #65),
 * with a job of the project's own declared in ci/jobs.ts (yodel.config.ts
 * `ci.jobs`): the pull request runs it beside lint and the plan. A yodel
 * that renders differently (a newer release) makes `yodel ci --check` fail
 * until the files are rendered again and committed.
 * The first approval is `yodel approve dev` at a terminal (#47): it records
 * the approval, chant pushes it, and the forge starts the waiting job again
 * (GitHub re-runs it, Forgejo dispatches the workflow), which applies with
 * no new push. A forge without resume (GitLab here) is approved with chant
 * approve and run again by hand.
 * Every pull request job tries a write first and must be refused (#50).
 * On a forge with reviews (Forgejo, GitHub), approval modes (#48), each
 * judged on its own like the resume part: with dev's wave `approval:
 * "sealed"` and `.chant/allowed_signers` listing alice at the base, a merged
 * change that also adds mallory's key waits; an unsigned approval by alice
 * and one sealed by mallory apply nothing, and one sealed by alice applies.
 * Then with dev's wave `approval: "pr-review"`, a pull request whose head a
 * second writer approved applies on merge with no chant approve (the
 * author's own approval, refused by Forgejo, counts for nothing), the plans
 * recorded by the pull request's yodel-apply-plans workflow, whose job
 * runs the write probe before it plans, as the plan job does. BREAK: the
 * sealed wave is rendered as ledger, so the unsigned approval applies; the
 * pull request is approved by its author alone, so the apply waits.
 * BREAK: `yodel approve dev --no-resume`, so no job starts again and nothing
 * applies within the wait (this part is judged on its own: the claim then
 * runs the job by hand and goes on); the pull request is merged without
 * approving its digest, so the apply after the merge applies nothing; the server is not changed by
 * hand, so the watch opens no issue; the installed yodel is built to
 * drop the project's own jobs, so the pull request does not run it; and the
 * reader's secrets hold the writer, so the pull request's write probe goes
 * through and fails the job (judged on its own, as the resume is).
 */
export function templateBody(makeForge: () => Forge): Body {
  return async (ctx: Ctx): Promise<void> => {
    const forge = makeForge();
    const notify: { part?: NotifyPart | undefined } = {};
    try {
      await flow(ctx, forge, notify);
    } finally {
      await notify.part?.close();
      await forge.close();
    }
  };
}

async function flow(ctx: Ctx, forge: Forge, notify: { part?: NotifyPart | undefined }): Promise<void> {
  const d = ctx.dialect;
  const DIALECT = d === "ch" ? "CLICKHOUSE" : "POSTGRES";
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
    [`DEV_${DIALECT}_URL`]: d === "ch" ? endpoints.clickhouse : endpoints.postgres,
    [`DEV_${DIALECT}_READER_USER`]: READER.user,
    [`DEV_${DIALECT}_READER_PASSWORD`]: READER.password,
    NO_COLOR: "1",
  };
  const sh = async (cmd: string, args: string[], timeoutMs = 300_000): Promise<Ran> => {
    const ran = await run(cmd, args, { cwd: dir, env: local, timeoutMs });
    if (ran.code !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${String(ran.code)}`);
    return ran;
  };
  await sh("npm", ["install", "--no-audit", "--no-fund"], 600_000);
  // The template's range, resolved from the registry; package-lock.json records where from.
  const range = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { dependencies: Record<string, string> }).dependencies["@intentius/sql-yodeler"] ?? "";
  const locked = (JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8")) as { packages: Record<string, { version?: string; resolved?: string } | undefined> }).packages["node_modules/@intentius/sql-yodeler"];
  ctx.log(`@intentius/sql-yodeler ${range} installed ${locked?.version ?? "nothing"} from ${locked?.resolved ?? "nowhere"}`);
  hold(/^\^\d+\.\d+\.\d+$/.test(range), `the template's package.json takes @intentius/sql-yodeler as ${range}, not a registry range`);
  hold(locked?.resolved?.startsWith("https://registry.npmjs.org/@intentius/sql-yodeler/-/") === true, `npm install took @intentius/sql-yodeler from ${locked?.resolved ?? "nowhere"}, not the npm registry`);
  const installed = join(dir, "node_modules", "@intentius", "sql-yodeler");
  const approveJs = join(installed, "dist", "commands", "approve.js");
  if (!existsSync(join(installed, "dist", "ci", "render.js")) || !existsSync(approveJs) || !readFileSync(approveJs, "utf8").includes('"--resume"') || !existsSync(join(installed, "dist", "credentials.js")) || !existsSync(join(installed, "dist", "approval-mode", "index.js")) || !readFileSync(join(installed, "dist", "ci", "render.js"), "utf8").includes("the record-plans job has no chant run wave --record-plans") || !existsSync(join(installed, "dist", "lint", "annotations.js")) || !readFileSync(join(installed, "dist", "ci", "render.js"), "utf8").includes("code.forgejo.org/forgejo/upload-artifact")) {
    // The release in the template's range has no yodel ci (#65), no yodel approve that resumes (#47), no credentials() (#50), no approval modes (#48), no write probe in the plans job (#130), no lint annotations (#129) or no Forgejo report upload that works on Forgejo yet: this checkout's, packed and committed with the project.
    const vendor = join(dir, "vendor");
    mkdirSync(vendor, { recursive: true });
    const packed = await run("npm", ["pack", "--ignore-scripts", "--pack-destination", vendor], { cwd: repoRoot, timeoutMs: 300_000 });
    const file = packed.out.trim().split("\n").at(-1) ?? "";
    if (packed.code !== 0 || !file.endsWith(".tgz")) throw new Error(`npm pack of this checkout failed: ${packed.err}`);
    await sh("npm", ["install", "--no-audit", "--no-fund", `./vendor/${file}`], 600_000);
    ctx.log(`the release ${locked.version ?? "?"} has no yodel ci (#65), no resuming yodel approve (#47), no credentials() (#50), no approval modes (#48), no write probe in the plans job (#130), no lint annotations (#129) or no Forgejo report upload that works on Forgejo: the project takes this checkout's yodel, vendor/${file}`);
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
  if (ctx.broken) {
    // BREAK: the installed yodel built to drop the project's jobs.
    const render = join(dir, "node_modules", "@intentius", "sql-yodeler", "dist", "ci", "render.js");
    const text = readFileSync(render, "utf8");
    const broken = text.replace(/Object\.assign\(jobs, ownJobs\(/, "(() => {})(").replace(/for \(const \[name, job\] of Object\.entries\(ownJobs\(/, "for (const [name, job] of Object.entries(((..._a) => ({}))(");
    if (broken === text) throw new Error(`the project's jobs are not merged in ${render}; the broken build cannot drop them`);
    // BREAK (#129): and renders the lint job's plain `yodel lint`, with no annotations.
    const plain = broken.replace(/export const lintCommand = \(forge\) => /, "export const lintCommand = (_forge) => LINT;\nconst annotatedLint = (forge) => ");
    if (plain === broken) throw new Error(`no lintCommand in ${render}; the broken build cannot render plain lint`);
    writeFileSync(render, plain);
    ctx.log("BREAK: the installed yodel drops the project's own jobs, and renders plain yodel lint");
  }
  await sh("npx", ["yodel", "new", "init"]);
  // The webhook (#61): notify in yodel.config.ts and a receiver, before the pipelines are rendered again.
  notify.part = await startNotifyPart(ctx, dir);
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
  await upgraded(dir, sh);

  // The repository, fresh, with the secrets the pipelines name. BREAK: the writer mapped into the jobs that read, the pull request's among them.
  const read = ctx.broken ? WRITER : READER;
  if (ctx.broken) ctx.log("BREAK: the reader's secrets hold the writer, so the pull request job holds the writer");
  const repo = await forge.repo(ctx, repoName, {
    [`DEV_${DIALECT}_URL`]: forge.jobUrl(d),
    [`DEV_${DIALECT}_READER_USER`]: read.user,
    [`DEV_${DIALECT}_READER_PASSWORD`]: read.password,
    [`DEV_${DIALECT}_WRITER_USER`]: WRITER.user,
    [`DEV_${DIALECT}_WRITER_PASSWORD`]: WRITER.password,
    ...(notify.part?.secrets ?? {}),
  });
  await sh("git", ["remote", "add", "origin", repo.remote]);
  const head = async () => (await sh("git", ["rev-parse", "HEAD"])).out.trim();

  // 1. The first push applies nothing without an approval.
  await sh("git", ["push", "-q", "origin", "main"]);
  const first = await repo.pushed(await head());
  hold(!first.ok, `the first push's apply on ${forge.name} ended ${first.status}, with nothing approved`);
  const WAVE_APPROVE = /chant approve yodel-apply yodel-apply-wave-1 --plan jcs1-sha256:[0-9a-f]{64}/;
  const firstCmd = WAVE_APPROVE.exec(first.log)?.[0];
  hold(firstCmd !== undefined, "the waiting wave does not give the chant approve command");
  hold(!first.log.includes("SQL_YODELER_TOKEN"), "the apply job still has a step for SQL_YODELER_TOKEN; sql-yodeler installs from npm with no token");
  hold(!(await ctx.db.tableExists(table)), `${ctx.db.name}.${table} exists with nothing approved`);
  // The apply stopped at the gate: the receiver has the waiting event, signed with the key (BREAK: checked with another).
  judgeNotify(ctx, notify.part);

  // Approve what the waiting wave printed, push the approval, run the failed job again.
  const approve = async (cmd: string) => {
    await sh("npx", ["chant", ...cmd.split(" ").slice(1)]);
    await sh("git", ["push", "-q", "origin", "chant/lifecycle"]);
  };
  const second = repo.resumed && repo.resumeEnv ? await approveAndResume(ctx, { dir, env: local, repo, sha: await head(), waited: first, digest: /--plan (\S+)/.exec(firstCmd)?.[1] ?? "", table }) : undefined;
  if (!second) {
    if (repo.resumed && repo.resumeEnv) await sh("git", ["push", "-q", "origin", "chant/lifecycle"]);
    else await approve(firstCmd);
  }
  const applied = second ?? (await repo.applyAgain(await head()));
  hold(applied.ok, `the apply after the approval ended ${applied.status}`);
  hold(await ctx.db.tableExists(table), `${ctx.db.name}.${table} is not on the server after the approved apply`);

  // Approval modes (#48), on a forge with reviews.
  if (repo.review) {
    const modes = { ctx, dir, repo, sh, head, approve, table, dialect: d };
    await sealedPart(modes);
    await prReviewPart(modes);
  } else ctx.log(`${forge.name}: no reviews here, so no approval-mode parts (they run on Forgejo and GitHub)`);

  // 2. A pull request: lint with the replay, and the plan comment.
  await sh("git", ["checkout", "-q", "-b", "add-note"]);
  const schemaPath = join(dir, "src", "schema.ts");
  const schema = readFileSync(schemaPath, "utf8");
  const withNote = schema.replace(/\n {2}\)(\n|`)/, `,\n    note ${d === "ch" ? "String DEFAULT ''" : "text"}\n  )$1`);
  if (withNote === schema) throw new Error("could not add a column to the template's schema");
  writeFileSync(schemaPath, withNote);
  await sh("npx", ["yodel", "new", "add-note"]);
  await sh("git", ["add", "-A"]);
  await sh("git", ["commit", "-qm", "feat: a note column"]);
  await sh("git", ["push", "-q", "origin", "add-note"]);
  const pr = await repo.openPr("add-note", await head(), "feat: a note column");
  judgeWriteProbe(ctx, pr.checks.log);
  hold(pr.checks.log.includes("the project job, 42"), "the pull request did not run the project's own job, declared in ci/jobs.ts and rendered by yodel ci");
  hold(pr.checks.ok, `the pull request's lint and plan ended ${pr.checks.status}`);
  hold(pr.checks.log.includes("Every migration replays to its recorded schema."), "the pull request's lint job did not replay the migrations into its own server");
  const comment = (await repo.comments(pr.id)).find((c) => c.startsWith("<!-- yodel:plan env=dev -->")) ?? "";
  const cmd = /```sh\n(chant approve yodel-apply yodel-apply-wave-1 --plan jcs1-sha256:[0-9a-f]{64})\n/.exec(comment)?.[1];
  hold(cmd !== undefined, "the pull request has no plan comment with an approve command");
  hold(!(await ctx.db.columnExists(table, "note")), "the pull request's jobs changed the server");
  await annotationPart(ctx, forge, { dir, repo, sh, head });

  // 3. Approve from the comment (not under BREAK), merge, and the apply adds the column.
  await sh("git", ["checkout", "-q", "main"]);
  if (!ctx.broken) await approve(cmd);
  const merged = await repo.merge(pr.id);
  const after = await repo.pushed(merged);
  hold(after.ok, `the apply after the merge ended ${after.status}`);
  hold(await ctx.db.columnExists(table, "note"), `${ctx.db.name}.${table}.note is not on the server after the merge's apply`);

  // 4. The drift watch's tracking issue: opened, updated, closed.
  const n = ctx.db.name;
  const [byHand, byHandAgain, undo] =
    d === "ch"
      ? [[`ALTER TABLE ${n}.events MODIFY TTL at + INTERVAL 30 DAY`], [`ALTER TABLE ${n}.events MODIFY COLUMN kind LowCardinality(String) DEFAULT 'by hand'`], [`ALTER TABLE ${n}.events REMOVE TTL`, `ALTER TABLE ${n}.events MODIFY COLUMN kind REMOVE DEFAULT`]]
      : [[`ALTER TABLE ${n}.events ALTER COLUMN at SET DEFAULT '2000-01-01'`], [`ALTER TABLE ${n}.events ALTER COLUMN kind DROP NOT NULL`], [`ALTER TABLE ${n}.events ALTER COLUMN at SET DEFAULT now()`, `ALTER TABLE ${n}.events ALTER COLUMN kind SET NOT NULL`]];
  const secondObject = /column kind/;
  const tracking = async () => (await repo.issues()).filter((i) => i.body.includes("<!-- yodel:drift ") && i.body.includes("env=dev"));
  if (!ctx.broken) for (const sql of byHand) await ctx.db.exec(sql);
  const found = await repo.watch(merged);
  hold(!found.ok, `the drift watch ended ${found.status} with dev changed by hand`);
  const opened = await tracking();
  hold(opened.length === 1 && opened[0]?.open === true, `the drift watch did not open one tracking issue: ${JSON.stringify(opened.map((i) => ({ n: i.number, open: i.open, title: i.title })))}`);
  const issue = opened[0];
  hold(/^Drift in dev: .*events/.test(issue.title) && issue.body.includes("`events`"), `the tracking issue does not name dev and events: ${issue.title}`);
  for (const sql of byHandAgain) await ctx.db.exec(sql);
  const again = await repo.watch(merged);
  hold(!again.ok, `the drift watch ended ${again.status} with dev still changed`);
  const updated = await tracking();
  hold(updated.length === 1 && updated[0]?.number === issue.number && updated[0].open, `the second watch did not keep the one issue #${String(issue.number)} open: ${JSON.stringify(updated.map((i) => ({ n: i.number, open: i.open })))}`);
  hold(secondObject.test(updated[0].body), `the tracking issue was not updated with the second change: ${updated[0].body.slice(0, 600)}`);
  for (const sql of undo) await ctx.db.exec(sql);
  const clean = await repo.watch(merged);
  hold(clean.ok, `the drift watch ended ${clean.status} with dev put back`);
  const closed = await tracking();
  hold(closed.length === 1 && closed[0]?.number === issue.number && !closed[0].open, `the watch did not close #${String(issue.number)} once dev was put back: ${JSON.stringify(closed.map((i) => ({ n: i.number, open: i.open })))}`);
}

/**
 * The pull request's plan job tries a write before its plan (#50): with the
 * reader, the server refuses it and the job goes on. BREAK: the writer is
 * mapped into the job, the write goes through and the probe fails the job,
 * exit 4. Judged here, on its own: a broken run whose probe did not fail
 * the job fails the claim (not caught); a caught one goes on, and the
 * checks after it see the failed job too.
 */
function judgeWriteProbe(ctx: Ctx, log: string): void {
  const refused = log.includes("write probe   cannot write");
  const wrote = log.includes("dev: the credentials this process holds can write");
  if (!ctx.broken) {
    hold(refused && !wrote, "the pull request's plan job did not show that it cannot write (yodel config check dev --write-probe)");
    return;
  }
  if (!wrote) throw new Error("BREAK: the writer mapped into the pull request job, and its write probe did not fail it; the write-probe part did not catch its break");
  ctx.log("BREAK caught (write probe): the pull request job holding the writer was failed by yodel config check --write-probe");
}

/**
 * Lint findings where the forge shows them (#129): a pull request from
 * add-note with a second migration that follows the same parent, a fork.
 * Its lint job fails, and the fork is annotated on the newer migration's
 * migration.sql: a workflow command naming the file on Forgejo and GitHub,
 * and on GitLab the code quality report the job keeps as its artifact.
 * BREAK: the installed yodel renders plain `yodel lint` (no format), so
 * the log names no file and GitLab finds no report to keep. Judged here, on
 * its own: a broken run that annotates anyway fails the claim (not caught).
 * The pull request stays open; nothing after this reads it.
 */
async function annotationPart(
  ctx: Ctx,
  forge: Forge,
  p: { dir: string; repo: ForgeRepo; sh: (cmd: string, args: string[], timeoutMs?: number) => Promise<Ran>; head: () => Promise<string> },
): Promise<void> {
  const migrations = join(p.dir, "migrations");
  const newest = readdirSync(migrations).filter((f) => existsSync(join(migrations, f, "migration.json"))).sort().at(-1);
  if (!newest) throw new Error("the add-note branch has no migration to fork");
  const forked = `${newest}-again`;
  await p.sh("git", ["checkout", "-q", "-b", "fork-note"]);
  mkdirSync(join(migrations, forked));
  for (const f of readdirSync(join(migrations, newest))) copyFileSync(join(migrations, newest, f), join(migrations, forked, f));
  const json = join(migrations, forked, "migration.json");
  const doc = readFileSync(json, "utf8");
  if (!doc.includes(`"id": "${newest}"`)) throw new Error(`${newest}'s migration.json does not record its id`);
  writeFileSync(json, doc.replace(`"id": "${newest}"`, `"id": "${forked}"`));
  // Its checksum recorded, so the fork is the only finding; lint exits 3 on the fork all the same.
  await run("npx", ["yodel", "lint", "--update-checksum", forked], { cwd: p.dir, timeoutMs: 300_000 });
  await p.sh("git", ["add", "-A"]);
  await p.sh("git", ["commit", "-qm", "feat: the note again, a fork"]);
  await p.sh("git", ["push", "-q", "origin", "fork-note"]);
  const pr = await p.repo.openPr("fork-note", await p.head(), "feat: the note again, a fork");
  await p.sh("git", ["checkout", "-q", "add-note"]);
  hold(!pr.checks.ok, `the forked pull request's lint ended ${pr.checks.status}`);
  hold(pr.checks.log.includes(`${forked} both follow`), "the forked pull request's lint did not report the fork");
  const file = `migrations/${forked}/migration.sql`;
  const annotated = forge.name === "GitLab" ? /gl-code-quality-report\.json: found 1 matching/.test(pr.checks.log) : pr.checks.log.includes(`file=${file}`);
  const what = forge.name === "GitLab" ? "the lint job kept the code quality report as its artifact" : `the lint job annotated ${file}`;
  if (!ctx.broken) {
    hold(annotated, `the forked pull request's findings are not on the forge: not ${what}`);
    return;
  }
  if (annotated) throw new Error(`BREAK: the installed yodel renders plain yodel lint, and still ${what}; the annotation part did not catch its break`);
  ctx.log(`BREAK caught (annotations): plain yodel lint, so not ${what}`);
}

/**
 * `yodel approve dev` at a terminal, the answer typed being `dev`, with the
 * token the forge's resume needs (#47). It records the approval of the
 * waiting wave's digest, chant pushes it and starts the waiting job again,
 * and the run the forge starts applies without a new push: that run is
 * returned. BREAK: `--no-resume`, so no run starts within the wait and the
 * table is not created; the approval is recorded all the same, and
 * undefined is returned for the caller to run the job by hand. The part is
 * judged here, on its own: a run that starts anyway under BREAK fails the
 * claim (not caught).
 */
async function approveAndResume(
  ctx: Ctx,
  a: { dir: string; env: NodeJS.ProcessEnv; repo: ForgeRepo; sha: string; waited: ForgeRun; digest: string; table: string },
): Promise<ForgeRun | undefined> {
  const { repo } = a;
  if (!repo.resumed || !repo.resumeEnv) throw new Error("the forge has no resume");
  const env = { ...Object.fromEntries(Object.entries(a.env).filter(([k]) => !["CHANT_FORGE_TOKEN", "GH_TOKEN", "GITLAB_TOKEN", "NODE_OPTIONS"].includes(k))), ...(await repo.resumeEnv()) };
  const args = ["approve", "dev", "--plan", a.digest, ...(ctx.broken ? ["--no-resume"] : [])];
  if (ctx.broken) ctx.log("BREAK: yodel approve dev --no-resume, so the waiting job is not started again");
  const ran = await run("node", [askingYodel(ctx, a.dir), "dev", ...args], { cwd: a.dir, env, timeoutMs: 600_000 });
  ctx.log(`yodel ${args.join(" ")} exited ${String(ran.code)}:\n${ran.out}${ran.err}`);
  if (ran.code !== 0) throw new Error(`yodel ${args.join(" ")} exited ${String(ran.code)}`);
  const resumed = await repo.resumed(a.sha, a.waited, ctx.broken ? 60_000 : 120_000);
  const caught = (): string | undefined => {
    if (!resumed) return "after yodel approve dev, the forge started no run of the waiting apply again";
    if (!resumed.ok) return `the resumed apply ended ${resumed.status}`;
    return undefined;
  };
  const why = caught() ?? ((await ctx.db.tableExists(a.table)) ? undefined : `${ctx.db.name}.${a.table} is not on the server after the resumed apply`);
  if (!ctx.broken) {
    hold(why === undefined, why ?? "");
    return resumed;
  }
  if (why === undefined) throw new Error("BREAK: yodel approve --no-resume, and the waiting job applied anyway; the resume part did not catch its break");
  hold(!(await ctx.db.tableExists(a.table)), `BREAK: ${ctx.db.name}.${a.table} exists with the job not resumed`);
  ctx.log(`BREAK caught (resume): ${why}; the job is run again by hand so the parts after it are judged on their own`);
  return undefined;
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

/**
 * A newer yodel renders the pipelines differently: `yodel ci --check` fails
 * until `yodel ci` renders them again, and they are committed. Played with
 * the installed yodel's header line changed, then put back.
 */
async function upgraded(dir: string, sh: (cmd: string, args: string[], timeoutMs?: number) => Promise<Ran>): Promise<void> {
  const render = join(dir, "node_modules", "@intentius", "sql-yodeler", "dist", "ci", "render.js");
  const saved = `${render}.saved`;
  copyFileSync(render, saved);
  const text = readFileSync(render, "utf8");
  const newer = text.replace("# Edit those and render again;", "# Edit those, then render again;");
  if (newer === text) throw new Error(`the rendered files' header is not in ${render}`);
  try {
    writeFileSync(render, newer);
    const check = await run("npx", ["yodel", "ci", "--check"], { cwd: dir, timeoutMs: 300_000 });
    hold(check.code === 1 && check.err.includes("stale, run yodel ci"), `after the installed yodel changed its pipelines, yodel ci --check exited ${String(check.code)}`);
    await sh("npx", ["yodel", "ci"]);
    hold((await sh("npx", ["yodel", "ci", "--check"])).code === 0, "yodel ci --check failed after yodel ci");
    hold((await sh("git", ["status", "--porcelain"])).out.includes(".github/workflows/yodel-pr.yml"), "the newer yodel's yodel ci did not change the committed pipelines");
  } finally {
    copyFileSync(saved, render);
    rmSync(saved);
  }
  await sh("npx", ["yodel", "ci"]);
  hold((await sh("git", ["status", "--porcelain"])).out.trim() === "", "rendering again with the installed yodel did not give back the committed pipelines");
}

// ── Approval modes (#48) ──────────────────────────────────────────────────────

interface Modes {
  ctx: Ctx;
  dir: string;
  repo: ForgeRepo;
  sh: (cmd: string, args: string[], timeoutMs?: number) => Promise<Ran>;
  head: () => Promise<string>;
  /** Runs a printed chant approve command and pushes chant/lifecycle. */
  approve: (cmd: string) => Promise<void>;
  table: string;
  dialect: Ctx["dialect"];
}

/** dev's wave in yodel.config.ts with this approval mode (none: ledger), rendered again with yodel ci. */
async function setDevApproval(m: Modes, mode: "sealed" | "pr-review" | undefined): Promise<void> {
  const path = join(m.dir, "yodel.config.ts");
  const text = readFileSync(path, "utf8");
  const next = text.replace(/^( {4}\{ env: "dev", gate: "always")(, approval: "[^"]*")?( \},)$/m, `$1${mode ? `, approval: "${mode}"` : ""}$3`);
  if (!/^ {4}\{ env: "dev", gate: "always"/m.test(text)) throw new Error("yodel.config.ts has no dev wave to set the approval of");
  writeFileSync(path, next);
  await m.sh("npm", ["run", "ci"]);
}

/** A column added to the template's table and its migration, committed on a new branch, pushed, and a pull request opened. */
async function columnPr(m: Modes, column: string, extra: () => void = () => undefined): Promise<{ id: number; checks: ForgeRun }> {
  await m.sh("git", ["checkout", "-q", "-b", `add-${column}`]);
  const schemaPath = join(m.dir, "src", "schema.ts");
  const schema = readFileSync(schemaPath, "utf8");
  const next = schema.replace(/\n {2}\)(\n|`)/, `,\n    ${column} ${m.dialect === "ch" ? "String DEFAULT ''" : "text"}\n  )$1`);
  if (next === schema) throw new Error("could not add a column to the template's schema");
  writeFileSync(schemaPath, next);
  extra();
  await m.sh("npx", ["yodel", "new", `add-${column.replaceAll("_", "-")}`]);
  await m.sh("git", ["add", "-A"]);
  await m.sh("git", ["commit", "-qm", `feat: a ${column} column`]);
  await m.sh("git", ["push", "-q", "origin", `add-${column}`]);
  return m.repo.openPr(`add-${column}`, await m.head(), `feat: a ${column} column`);
}

/** Commits what changed on main, pushes it, and waits for its apply, which has nothing pending. */
async function onMain(m: Modes, message: string): Promise<void> {
  await m.sh("git", ["add", "-A"]);
  await m.sh("git", ["commit", "-qm", message]);
  await m.sh("git", ["push", "-q", "origin", "main"]);
  const ran = await m.repo.pushed(await m.head());
  hold(ran.ok, `the push of "${message}" ended ${ran.status}, with nothing pending`);
}

/** An ssh key for sealing approvals, outside the project. */
async function sshKey(m: Modes, name: string): Promise<{ file: string; pub: string }> {
  const file = join(m.ctx.work, `key-${name}`);
  if (!existsSync(file)) {
    const made = await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", name, "-f", file], { cwd: m.ctx.work });
    if (made.code !== 0) throw new Error(`ssh-keygen could not make ${name}'s key`);
  }
  return { file, pub: readFileSync(`${file}.pub`, "utf8").trim().split(" ").slice(0, 2).join(" ") };
}

const WAVE_CMD = /chant approve yodel-apply yodel-apply-wave-1 --plan jcs1-sha256:[0-9a-f]{64}/;

/**
 * Sealed (#48): dev's wave counts only an approval sealed by a key
 * `.chant/allowed_signers` lists at the base. BREAK: the wave stays ledger,
 * so the unsigned approval applies: caught here, and the part ends.
 */
async function sealedPart(m: Modes): Promise<void> {
  const { ctx } = m;
  const alice = await sshKey(m, "alice");
  const mallory = await sshKey(m, "mallory");
  if (ctx.broken) ctx.log("BREAK (sealed): dev's wave is left ledger, so any approval counts");
  await setDevApproval(m, ctx.broken ? undefined : "sealed");
  mkdirSync(join(m.dir, ".chant"), { recursive: true });
  writeFileSync(join(m.dir, ".chant", "allowed_signers"), `alice ${alice.pub}\n`);
  await onMain(m, "chore: dev's wave sealed; alice signs");

  // The change: a column, and mallory's key added to the signers file.
  const pr = await columnPr(m, "sealed_note", () => {
    writeFileSync(join(m.dir, ".chant", "allowed_signers"), `alice ${alice.pub}\nmallory ${mallory.pub}\n`);
  });
  hold(pr.checks.ok, `the sealed part's pull request checks ended ${pr.checks.status}`);
  await m.sh("git", ["checkout", "-q", "main"]);
  const merged = await m.repo.merge(pr.id);
  await m.sh("git", ["pull", "-q", "--ff-only", "origin", "main"]);
  const waited = await m.repo.pushed(merged);
  hold(!waited.ok, `the merged change applied with nothing approved (${waited.status})`);
  const printed = WAVE_CMD.exec(waited.log)?.[0];
  hold(printed !== undefined, "the waiting sealed wave did not print its chant approve command");
  if (!ctx.broken) hold(new RegExp(`${printed.replace(/[^\w]/g, "\\$&")} --sign`).test(waited.log), "the sealed wave's approve command does not end in --sign");

  // An unsigned approval by alice, and one sealed by mallory with the key the change added.
  const chantApprove = async (args: string[]) => {
    await m.sh("npx", ["chant", ...printed.split(" ").slice(1), ...args]);
  };
  await chantApprove(["--actor", "alice"]);
  await chantApprove(["--actor", "mallory", "--sign", mallory.file]);
  await m.sh("git", ["push", "-q", "origin", "chant/lifecycle"]);
  const unsealed = await m.repo.applyAgain(merged);
  const applied = unsealed.ok || (await ctx.db.columnExists(m.table, "sealed_note"));
  if (ctx.broken) {
    if (!applied) throw new Error("BREAK (sealed): the wave was ledger, and the unsigned approval did not apply; the sealed part did not catch its break");
    ctx.log("BREAK caught (sealed): under ledger the unsigned approval applied the column");
    return;
  }
  hold(!applied, "an unsigned approval, or one sealed by a key the change itself added, let the sealed wave apply");

  // Sealed by alice, listed at base: it applies.
  await chantApprove(["--actor", "alice", "--sign", alice.file]);
  await m.sh("git", ["push", "-q", "origin", "chant/lifecycle"]);
  const sealed = await m.repo.applyAgain(merged);
  hold(sealed.ok && (await ctx.db.columnExists(m.table, "sealed_note")), `alice's sealed approval did not apply the sealed wave (${sealed.status})`);
  hold(/approval sealed/.test(sealed.log), "the wave job did not say it was approved under sealed");
}

/**
 * Pull request review (#48): dev's wave is pr-review. A pull request whose
 * head another writer approved applies on merge, with no chant approve.
 * BREAK: the author alone approves (Forgejo refuses it), so the apply waits:
 * caught here, and the wave is approved by hand so the claim goes on.
 */
async function prReviewPart(m: Modes): Promise<void> {
  const { ctx } = m;
  await setDevApproval(m, "pr-review");
  await onMain(m, "chore: dev's wave approved by the pull request's review");
  const pr = await columnPr(m, "reviewed_note");
  hold(pr.checks.ok, `the pr-review part's pull request checks ended ${pr.checks.status}`);
  hold(pr.checks.log.includes("--record-plans"), "the pull request did not run chant run wave --record-plans");
  // The plans job holds readers only, and shows it with the write probe, as the plan job does (#50, #130).
  hold(pr.checks.log.split("write probe   cannot write").length - 1 >= 2, "the pull request's plans job (yodel-apply-plans) did not show that it cannot write (yodel config check --write-probe), as the plan job does");
  const sha = await m.head();
  await m.repo.review?.(pr.id, sha, "author");
  if (ctx.broken) ctx.log("BREAK (pr-review): the pull request is approved by its author alone");
  else await m.repo.review?.(pr.id, sha, "reviewer");
  await m.sh("git", ["checkout", "-q", "main"]);
  const merged = await m.repo.merge(pr.id);
  await m.sh("git", ["pull", "-q", "--ff-only", "origin", "main"]);
  const ran = await m.repo.pushed(merged);
  const applied = ran.ok && (await ctx.db.columnExists(m.table, "reviewed_note"));
  if (ctx.broken) {
    if (applied) throw new Error("BREAK (pr-review): the author's own approval applied the wave; the pr-review part did not catch its break");
    ctx.log("BREAK caught (pr-review): with the author's approval alone, the wave waits");
    const cmd = WAVE_CMD.exec(ran.log)?.[0];
    if (!cmd) throw new Error("the waiting pr-review wave printed no chant approve command");
    await m.approve(cmd);
    const levelled = await m.repo.applyAgain(merged);
    if (!levelled.ok) throw new Error(`levelling after the pr-review break: the apply ended ${levelled.status}`);
    return;
  }
  hold(applied, `the pull request approved by another writer did not apply on merge (${ran.status})`);
  hold(/review of #\d+/.test(ran.log), "the wave job did not name the review that approved it");
}
