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
 * column. The server is checked directly each time.
 * BREAK: the pull request is merged without approving its digest, so the
 * apply after the merge applies nothing.
 */
export function templateBody(makeForge: () => Forge): Body {
  return async (ctx: Ctx): Promise<void> => {
    const forge = makeForge();
    try {
      await flow(ctx, forge);
    } finally {
      await forge.close();
    }
  };
}

async function flow(ctx: Ctx, forge: Forge): Promise<void> {
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
  // chant finds Ops from the git root, so the repository comes before rendering the pipelines again for dev alone.
  await sh("git", ["init", "-q", "-b", "main"]);
  await sh("git", ["config", "user.name", "yodel34"]);
  await sh("git", ["config", "user.email", "yodel34@example.invalid"]);
  await sh("git", ["config", "commit.gpgsign", "false"]);
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
  });
  await sh("git", ["remote", "add", "origin", repo.remote]);
  const head = async () => (await sh("git", ["rev-parse", "HEAD"])).out.trim();

  // 1. The first push applies nothing without an approval.
  await sh("git", ["push", "-q", "origin", "main"]);
  const first = await repo.pushed(await head());
  hold(!first.ok, `the first push's apply on ${forge.name} ended ${first.status}, with nothing approved`);
  hold(first.log.includes("approve migrate-dev approve-migrate-dev --plan jcs1-sha256:"), "the failed apply does not give the chant approve command");
  hold(!first.log.includes("SQL_YODELER_TOKEN"), "the apply job still has a step for SQL_YODELER_TOKEN; sql-yodeler installs from npm with no token");
  hold(!(await ctx.db.tableExists(table)), `${ctx.db.name}.${table} exists with nothing approved`);

  // Approve what yodel plan shows, push the approval, run the apply again.
  const approveCmd = async (): Promise<string> => {
    const plan = await sh("npx", ["yodel", "plan", "dev", "--json"]);
    const cmd = (JSON.parse(plan.out.slice(plan.out.indexOf("{"))) as { approve?: string }).approve;
    if (!cmd?.startsWith("chant approve ")) throw new Error("yodel plan dev gave no chant approve command");
    return cmd;
  };
  const approve = async (cmd: string) => {
    await sh("npx", ["chant", ...cmd.split(" ").slice(1)]);
    await sh("git", ["push", "-q", "origin", "chant/lifecycle"]);
  };
  await approve(await approveCmd());
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
  const cmd = /```sh\n(chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:[0-9a-f]{64})\n/.exec(comment)?.[1];
  hold(cmd !== undefined, "the pull request has no plan comment with an approve command");
  hold(!(await ctx.db.columnExists(table, "note")), "the pull request's jobs changed the server");

  // 3. Approve from the comment (not under BREAK), merge, and the apply adds the column.
  await sh("git", ["checkout", "-q", "main"]);
  if (!ctx.broken) await approve(cmd);
  const after = await repo.pushed(await repo.merge(pr.id));
  hold(after.ok, `the apply after the merge ended ${after.status}`);
  hold(await ctx.db.columnExists(table, "note"), `${ctx.db.name}.${table}.note is not on the server after the merge's apply`);
}
