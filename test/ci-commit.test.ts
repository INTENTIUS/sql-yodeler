/**
 * `/yodel new` through chant's commit job (#312): the jobs `yodel ci`
 * renders from the sql lexicon's `yodelCommitSpec`, `ci.respond.new`, the
 * check `yodel lint --commit-trigger new`, the refusal reply the bin sets
 * before `chant commit land`, and `yodel new` in a worktree with no
 * `node_modules`, as the commit job runs it.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeCommitRefusalReply, setCommitRefusalReply } from "@intentius/chant/ci-commit";
import { parseYAMLDocument } from "@intentius/chant/yaml";
import { yodelCommitRefusalReply, yodelRefusalReply } from "@intentius/chant-lexicon-sql/yodel-run";
import { createMigration, readMigrations, writeMigration } from "../src/migrations/index.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { commitSpecs, NEW_CHECK_COMMAND } from "../src/ci/commit.js";
import { rebaseRespond } from "../src/ci/render.js";
import { runChantVerb, setRefusalReply } from "../src/commands/chant.js";
import { checkYodelConfig } from "../src/config/load.js";
import { fallbackImportArgs, ownModules } from "../src/chant/resolve-fallback.js";
import { copyTemplate, fixture, json, repoRoot, yodel } from "./helpers/run.js";
import { offline } from "./helpers/new-suite.js";

offline();

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

/** The ClickHouse template in a directory of its own, with yodel's node_modules linked in and `ci` set to `ci`, as test/ci.test.ts makes it. */
function template(ci: string): string {
  const dir = mkdtempSync(join(tmpdir(), "yodel-commit-"));
  temps.push(dir);
  copyTemplate("clickhouse", dir);
  symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"));
  const config = join(dir, "yodel.config.ts");
  writeFileSync(config, readFileSync(config, "utf8").replace(/^ {2}ci: .*$/m, `  ci: ${ci},`));
  // chant finds the Ops from the git root.
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

const read = (dir: string, f: string) => readFileSync(join(dir, f), "utf8");

describe("yodel ci renders /yodel new through chant's commit job (#312)", () => {
  it("by default answers the comment on every forge, with the lexicon's argv, migrations/ only and the push token", async () => {
    const dir = template('{ forges: ["github", "gitlab", "forgejo"] }');
    const wrote = await yodel(["ci", "--dir", dir]);
    expect(wrote.code, wrote.err).toBe(0);
    for (const f of [".github/workflows/yodel-new.yml", ".forgejo/workflows/yodel-new.yml"]) {
      const text = read(dir, f);
      expect(text, f).toContain("startsWith(github.event.comment.body, '/yodel new')");
      // Every applied environment's history, read with its reader (chant pull request 4834), and the comment's name (4835).
      expect(text, f).toContain(`CHANT_COMMIT_COMMAND: '["yodel","new","--if-changed","--replace-own","--env","dev","--env","prod"]'`);
      expect(text, f).toContain(`CHANT_COMMIT_COMMAND_ENV: '["DEV_CLICKHOUSE_URL","DEV_CLICKHOUSE_READER_USER","DEV_CLICKHOUSE_READER_PASSWORD","PROD_CLICKHOUSE_URL","PROD_CLICKHOUSE_READER_USER","PROD_CLICKHOUSE_READER_PASSWORD"]'`);
      expect(text, f).toContain(`CHANT_COMMIT_COMMENT_ARG: '{"pattern":"^[a-z0-9]+(?:[-_][a-z0-9]+)*$","position":2}'`);
      expect(text, f).not.toMatch(/WRITER|YODEL_ROLE|YODEL_CREDENTIALS/);
      expect(text, f).toContain(`CHANT_COMMIT_ALLOWED: '["migrations/"]'`);
      expect(text, f).toContain("secrets.YODEL_PUSH_TOKEN");
      expect(text, f).toContain("yodel chant commit land --forge");
      expect(text, f).toContain("# The push job reads the YODEL_PUSH_TOKEN secret");
      // The command's job holds no push token.
      const doc = parseYAMLDocument(text) as { jobs: Record<string, { steps: Array<{ env?: Record<string, string> }> }> };
      expect(JSON.stringify(doc.jobs["yodel-new"])).not.toContain("YODEL_PUSH_TOKEN");
    }
    const gitlab = read(dir, ".gitlab/yodel-commit.gitlab-ci.yml");
    expect(gitlab).toContain('$CHANT_COMMIT == "new"');
    expect(gitlab).toContain("yodel chant commit land --forge gitlab");
    expect(gitlab).toContain("$YODEL_PUSH_TOKEN");
    expect((parseYAMLDocument(read(dir, ".gitlab-ci.yml")) as { include: Array<{ local: string }> }).include).toContainEqual({ local: ".gitlab/yodel-commit.gitlab-ci.yml" });
    expect((await yodel(["ci", "--check", "--dir", dir])).code).toBe(0);
  }, 120_000);

  it("with respond.new on-change, also follows a check that exits 2 on lint's unmigrated; with off, renders none", async () => {
    const dir = template('{ forges: ["github", "gitlab"], respond: { new: "on-change" } }');
    const wrote = await yodel(["ci", "--dir", dir]);
    expect(wrote.code, wrote.err).toBe(0);
    const check = read(dir, ".github/workflows/yodel-new-check.yml");
    expect(check).toContain(NEW_CHECK_COMMAND.join(" "));
    expect(check).toContain("pull_request");
    expect(check).toContain("CHANT_COMMIT_ON: check");
    const gitlab = read(dir, ".gitlab/yodel-commit.gitlab-ci.yml");
    expect(gitlab).toContain("yodel-new-check");
    expect(gitlab).toContain(NEW_CHECK_COMMAND.join(" "));

    const off = template('{ forges: ["github", "gitlab"], respond: { new: "off" } }');
    // The starter template ships the /yodel new workflow; this project turns it off, so start without it.
    rmSync(join(off, ".github/workflows/yodel-new.yml"), { force: true });
    expect((await yodel(["ci", "--dir", off])).code).toBe(0);
    expect(existsSync(join(off, ".github/workflows/yodel-new.yml"))).toBe(false);
    expect(read(off, ".gitlab-ci.yml")).not.toContain("yodel-commit");
  }, 120_000);

  it("takes the specs from yodelCommitSpec, and nothing installed in the yodel image", () => {
    const { comment, check } = commitSpecs({ dir: "/p", respond: "on-change", yodelImage: true }, "gitlab");
    expect(comment).toMatchObject({ name: "yodel-new", commit: { on: "comment", comment: "/yodel new", allowed: ["migrations/"], tokenEnv: "YODEL_PUSH_TOKEN" } });
    expect(comment?.setup).toBeUndefined();
    expect(check).toMatchObject({ name: "yodel-new-check", commit: { on: "check", findings: [2], gitlabCheck: true } });
    expect(commitSpecs({ dir: "/p", respond: "on-change", yodelImage: false }, "github").check?.commit).not.toHaveProperty("gitlabCheck");
  });

  it("renders /yodel rebase on the base merged into the head, with every environment's reader and no writer (#313)", async () => {
    const dir = template('{ forges: ["github", "gitlab", "forgejo"] }');
    const wrote = await yodel(["ci", "--dir", dir]);
    expect(wrote.code, wrote.err).toBe(0);
    for (const f of [".github/workflows/yodel-rebase.yml", ".forgejo/workflows/yodel-rebase.yml"]) {
      const text = read(dir, f);
      expect(text, f).toContain("startsWith(github.event.comment.body, '/yodel rebase')");
      expect(text, f).toContain(`CHANT_COMMIT_COMMAND: '["yodel","rebase","--env","dev","--env","prod"]'`);
      expect(text, f).toContain("CHANT_COMMIT_MERGE_BASE: '1'");
      expect(text, f).toContain(`CHANT_COMMIT_COMMAND_ENV: '["DEV_CLICKHOUSE_URL","DEV_CLICKHOUSE_READER_USER","DEV_CLICKHOUSE_READER_PASSWORD","PROD_CLICKHOUSE_URL","PROD_CLICKHOUSE_READER_USER","PROD_CLICKHOUSE_READER_PASSWORD"]'`);
      expect(text, f).not.toMatch(/WRITER|YODEL_ROLE|YODEL_CREDENTIALS/);
    }
    // GitLab: no comment job (chant refuses mergeBase there), the check trigger only.
    const gitlab = read(dir, ".gitlab/yodel-rebase.gitlab-ci.yml");
    expect(gitlab).toContain("yodel lint --commit-trigger rebase");
    expect(gitlab).toContain("yodel-rebase-check-commit:");
    expect(gitlab).not.toContain('$CHANT_COMMIT == "rebase"');
    expect((parseYAMLDocument(read(dir, ".gitlab-ci.yml")) as { include: Array<{ local: string }> }).include).toContainEqual({ local: ".gitlab/yodel-rebase.gitlab-ci.yml" });

    const fork = template('{ forges: ["github"], respond: { rebase: "on-fork", new: "off" } }');
    rmSync(join(fork, ".github/workflows/yodel-new.yml"), { force: true });
    expect((await yodel(["ci", "--dir", fork])).code).toBe(0);
    expect(read(fork, ".github/workflows/yodel-rebase-check.yml")).toContain("yodel lint --commit-trigger rebase");
    expect(existsSync(join(fork, ".github/workflows/yodel-new.yml"))).toBe(false);
  }, 120_000);

  it("passes /yodel new each environment with its reader, and none when a reader is cloud-minted (#312)", () => {
    const readers = { envs: ["dev"], variables: ["DEV_POSTGRES_URL", "DEV_POSTGRES_READER_USER", "DEV_POSTGRES_READER_PASSWORD"] };
    expect(commitSpecs({ dir: "/p", respond: "comment", readers, yodelImage: true }, "forgejo").comment?.commit).toMatchObject({
      command: ["yodel", "new", "--if-changed", "--replace-own", "--env", "dev"],
      commandEnv: readers.variables,
      commentArg: { position: 2 },
    });
    const none = commitSpecs({ dir: "/p", respond: "comment", yodelImage: true }, "forgejo").comment?.commit;
    expect(none?.command).toEqual(["yodel", "new", "--if-changed", "--replace-own"]);
    expect(none).not.toHaveProperty("commandEnv");
  });

  it("leaves /yodel rebase off by default with a cloud-minted reader, which the commit job gets no identity for, and refuses asking for it", () => {
    const envs = { names: ["dev"], credentials: { dev: { reader: { cloud: "rds-iam" }, writer: {} } } as never };
    expect(rebaseRespond(envs)).toBe("off");
    expect(() => rebaseRespond({ ...envs, respondRebase: "comment" })).toThrow(/ci\.respond\.rebase: comment reads each environment's history in chant's commit job, and dev's reader mints its password from a cloud identity/);
    expect(rebaseRespond({ names: ["dev"] })).toBe("comment");
    expect(commitSpecs({ dir: "/p", respond: "off", respondRebase: "comment", readers: { envs: ["dev"], variables: ["DEV_POSTGRES_URL", "DEV_POSTGRES_READER_USER", "DEV_POSTGRES_READER_PASSWORD"] }, yodelImage: true }, "github", "rebase").comment?.commit).toMatchObject({
      on: "comment",
      comment: "/yodel rebase",
      mergeBase: true,
      command: ["yodel", "rebase", "--env", "dev"],
      commandEnv: ["DEV_POSTGRES_URL", "DEV_POSTGRES_READER_USER", "DEV_POSTGRES_READER_PASSWORD"],
    });
  });

  it("checks ci.respond", () => {
    expect(checkYodelConfig({ ci: { respond: { new: "on-change" } } }, "yodel.config.ts").ci).toEqual({ respond: { new: "on-change" } });
    expect(checkYodelConfig({ ci: { respond: { rebase: "on-fork" } } }, "yodel.config.ts").ci).toEqual({ respond: { rebase: "on-fork" } });
    expect(() => checkYodelConfig({ ci: { respond: { rebase: "on-change" } } }, "yodel.config.ts")).toThrow(/ci\.respond\.rebase: one of off, comment, on-fork/);
    expect(() => checkYodelConfig({ ci: { respond: { new: "always" } } }, "yodel.config.ts")).toThrow(/ci\.respond\.new: one of off, comment, on-change/);
    expect(() => checkYodelConfig({ ci: { respond: { merge: "comment" } } }, "yodel.config.ts")).toThrow(/ci\.respond: expected \{ new\?, rebase\? \}/);
  });
});

describe("yodel lint --commit-trigger new (#312)", () => {
  it("exits 2 while the declared schema is ahead of the newest migration, 0 once it is not", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yodel-trigger-"));
    temps.push(dir);
    cpSync(fixture("postgres"), dir, { recursive: true });
    symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"));
    expect((await yodel(["new", "init", "--dir", dir])).code).toBe(0);
    expect((await yodel(["lint", "--commit-trigger", "new", "--dir", dir])).code).toBe(0);
    const schema = join(dir, "src", "schema.ts");
    writeFileSync(schema, readFileSync(schema, "utf8").replace("amount numeric(12, 2) NOT NULL\n", "amount numeric(12, 2) NOT NULL,\n    note   text\n"));
    const ahead = await yodel(["lint", "--commit-trigger", "new", "--dir", dir]);
    expect(ahead.code).toBe(2);
    expect(ahead.out).toContain("warning  unmigrated:");
    // rebase reads the fork finding: there is none.
    expect((await yodel(["lint", "--commit-trigger", "rebase", "--dir", dir])).code).toBe(0);
    const bad = await yodel(["lint", "--commit-trigger", "merge", "--dir", dir]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("--commit-trigger takes new or rebase");
  }, 60_000);
});

describe("yodel rebase's refusal, read by chant's reply (#313)", () => {
  it("names both sides and the object when two branches change one table differently", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yodel-rebase-reply-"));
    temps.push(dir);
    cpSync(fixture("postgres"), dir, { recursive: true });
    symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"));
    expect((await yodel(["new", "init", "--dir", dir])).code).toBe(0);
    const migrations = join(dir, "migrations");
    const [init] = readMigrations(migrations);
    if (!init) throw new Error("no init");
    const orders = init.document.schema.objects.find((o) => o.export === "orders");
    if (!orders) throw new Error("no orders");
    const ids: string[] = [];
    for (const [name, column, minute] of [["add-note", "note text", 1], ["add-memo", "memo text", 2]] as const) {
      const ddl = orders.ddl.replace("amount numeric(12, 2) NOT NULL", `amount numeric(12, 2) NOT NULL,\n    ${column}`);
      const made = createMigration({ name, previous: init, now: new Date(Date.UTC(2030, 0, 1, 0, minute)), build: { ...init.document.schema, objects: init.document.schema.objects.map((o) => (o.export === "orders" ? { ...o, ddl } : o)) } });
      if (made.id === undefined) throw new Error(`no change for ${name}`);
      writeMigration(migrations, made);
      ids.push(made.id);
    }
    const argv = ["rebase", "--dir", dir];
    const refused = await yodel(argv);
    expect(refused.code).toBe(1);
    // The wording stays as it is (#311): the other side is the range of migrations it moves onto.
    expect(refused.err).toContain(`yodel rebase: refused: ${ids[1] ?? ""} and the migrations after ${init.id} up to ${ids[0] ?? ""} both change orders, differently;`);
    // chant's reply names both sides and the object, from yodel's refusal line as it prints it (chant 0.124.88).
    expect(yodelRefusalReply({ command: ["yodel", ...argv], rc: "1", output: refused.err })).toBe(
      `\`yodel rebase\` refused: \`${ids[1] ?? ""}\` and the migrations after \`${init.id}\` up to \`${ids[0] ?? ""}\` both change \`orders\`, differently, and a rebase does not merge two changes to one object. ` +
        `Resolve it on the branch: delete \`${ids[1] ?? ""}\`'s directory, declare both changes, then run \`yodel new\` (or comment \`/yodel new\`).`,
    );
  }, 60_000);
});

describe("the refusal reply (#312)", () => {
  const was = activeCommitRefusalReply();
  afterAll(() => {
    setCommitRefusalReply(was);
  });
  it("is the sql lexicon's, set before chant's commit commands run", async () => {
    setCommitRefusalReply(undefined);
    await setRefusalReply();
    expect(activeCommitRefusalReply()).toBe(yodelCommitRefusalReply);
    setCommitRefusalReply(undefined);
    // Through the verb: a commit command sets it, whatever chant then does with the argv.
    let ran: string[] = [];
    const code = await runChantVerb(["commit", "land", "--help"], { out: () => undefined, err: () => undefined }, {
      product: () => Promise.resolve({ runChantInProcess: (argv: string[]) => ((ran = argv), Promise.resolve(0)) } as never),
    });
    expect(code).toBe(0);
    expect(ran).toEqual(["commit", "land", "--help"]);
    expect(activeCommitRefusalReply()).toBe(yodelCommitRefusalReply);
  });
});

describe("yodel new in a worktree with no node_modules (#312)", () => {
  let project = "";
  beforeAll(() => {
    // Outside the repository and any node_modules, as chant's commit job's worktree of the head is.
    project = mkdtempSync(join(tmpdir(), "yodel-worktree-"));
    cpSync(fixture("postgres"), project, { recursive: true });
  });
  afterAll(() => {
    rmSync(project, { recursive: true, force: true });
  });

  it("finds yodel's own install, and gives chant's children the hook", () => {
    expect(ownModules()).toBe(join(repoRoot, "node_modules"));
    const args = fallbackImportArgs();
    expect(args[0]).toBe("--import");
    expect(args[1]).toMatch(/^data:text\/javascript,/);
  });

  it("resolves the project's packages from yodel's install, so the migration is written", () => {
    expect(readdirSync(project)).not.toContain("node_modules");
    const tsx = createRequire(import.meta.url).resolve("tsx");
    const ran = spawnSync(process.execPath, ["--import", tsx, join(repoRoot, "src", "bin.ts"), "new", "--if-changed", "--replace-own", "--json", "--dir", project], {
      cwd: project,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", CHANT_COMMIT_PR: "3", YODEL_E2E_POSTGRES_URL: "postgres://127.0.0.1:9/postgres" },
      timeout: 120_000,
    });
    expect(ran.status, ran.stderr).toBe(0);
    expect(json({ code: 0, out: ran.stdout, err: "" })).toMatchObject({ written: true, id: expect.stringMatching(/-pr-3$/) as unknown });
    // Only migrations/: src/sql-types.d.ts is not refreshed in the commit job, which may change migrations/ alone.
    expect(readdirSync(project).sort()).toEqual([...readdirSync(fixture("postgres")), "migrations"].sort());
  }, 120_000);
});
