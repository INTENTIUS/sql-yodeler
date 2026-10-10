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
 * is the released one, not this checkout. The dev profile is
 * the claim's database yodel_34_<claim>, the history yodel_34_<claim>_history,
 * with a reader and a writer user made for it (yodel_34_reader,
 * yodel_34_writer). The lint job replays into its own service container
 * (replay-clickhouse / replay-postgres), never the shared emulator.
 */

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hold, type Body, type Ctx } from "../lib/claim.js";
import { endpoints } from "../lib/db.js";
import { run, type Ran } from "../lib/exec.js";
import { repoRoot } from "../lib/project.js";
import type { Forge } from "./forge.js";
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
 * BREAK: the pull request is merged without approving its digest, so the
 * apply after the merge applies nothing; and the server is not changed by
 * hand, so the watch opens no issue.
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

  // The repository, fresh, with the secrets the pipelines name.
  const repo = await forge.repo(ctx, repoName, {
    [`DEV_${DIALECT}_URL`]: forge.jobUrl(d),
    [`DEV_${DIALECT}_READER_USER`]: READER.user,
    [`DEV_${DIALECT}_READER_PASSWORD`]: READER.password,
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
  await approve(firstCmd);
  const second = await repo.applyAgain(await head());
  hold(second.ok, `the apply after the approval ended ${second.status}`);
  hold(await ctx.db.tableExists(table), `${ctx.db.name}.${table} is not on the server after the approved apply`);

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
  hold(pr.checks.ok, `the pull request's lint and plan ended ${pr.checks.status}`);
  hold(pr.checks.log.includes("Every migration replays to its recorded schema."), "the pull request's lint job did not replay the migrations into its own server");
  const comment = (await repo.comments(pr.id)).find((c) => c.startsWith("<!-- yodel:plan env=dev -->")) ?? "";
  const cmd = /```sh\n(chant approve yodel-apply yodel-apply-wave-1 --plan jcs1-sha256:[0-9a-f]{64})\n/.exec(comment)?.[1];
  hold(cmd !== undefined, "the pull request has no plan comment with an approve command");
  hold(!(await ctx.db.columnExists(table, "note")), "the pull request's jobs changed the server");

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
