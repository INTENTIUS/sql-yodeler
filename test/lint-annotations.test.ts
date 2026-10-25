/**
 * #129: yodel lint's findings as forge annotations. The output formats
 * (workflow commands for GitHub and Forgejo, GitLab's code quality report),
 * the command's --format and --output, and the lint job yodel ci renders
 * on each forge.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BuildOutput, BuiltObject } from "../src/chant/build.js";
import { actionsReview, gitlabPipeline, lintCommand, type Environments } from "../src/ci/render.js";
import { declarativeLint } from "../src/declarative/review.js";
import { codeQuality, CODE_QUALITY_FILE, workflowCommands, type LintReport } from "../src/lint/index.js";
import { createMigration, newestMigration, readMigrations, writeMigration, type CreatedMigration } from "../src/migrations/index.js";
import { parseYAMLDocument } from "@intentius/chant/yaml";
import { projectFrom, yodel } from "./helpers/run.js";

const report = (findings: LintReport["findings"]): LintReport => ({
  dir: "/repo/migrations",
  dialect: "postgres",
  environment: undefined,
  migrations: ["20261010T0900-create", "20261010T0901-drop"],
  findings,
  silences: {},
  errors: findings.filter((f) => f.level === "error" && f.silenced === undefined).length,
  warnings: findings.filter((f) => f.level === "warning" && f.silenced === undefined).length,
  silenced: findings.filter((f) => f.silenced !== undefined).length,
});

describe("the annotation formats", () => {
  const r = report([
    { rule: "destructive", level: "error", migration: "20261010T0901-drop", step: 0, line: 3, message: "step 0: drop a column, 50% gone: for good,\nreally" },
    { rule: "data-dependent", level: "warning", migration: "20261010T0901-drop", message: "step 1: can fail on the rows" },
    { rule: "pg-lock", level: "error", migration: "20261010T0900-create", line: 2, message: "step 0: index build", silenced: "small table" },
    { rule: "directory", level: "error", message: "junk is not a migration" },
  ]);

  it("writes a workflow command per finding, on the migration.sql and line, escaped as the runner reads it", () => {
    expect(workflowCommands(r, "/repo").split("\n")).toEqual([
      "::error file=migrations/20261010T0901-drop/migration.sql,line=3,title=yodel lint destructive::step 0: drop a column, 50%25 gone: for good,%0Areally",
      "::warning file=migrations/20261010T0901-drop/migration.sql,line=1,title=yodel lint data-dependent::step 1: can fail on the rows",
      "::notice file=migrations/20261010T0900-create/migration.sql,line=2,title=yodel lint pg-lock::step 0: index build (silenced: small table)",
      "::error title=yodel lint directory::junk is not a migration",
      "",
    ]);
    expect(workflowCommands(report([]), "/repo")).toBe("");
  });

  it("writes GitLab's code quality report, error major, warning minor, silenced info", () => {
    const issues = codeQuality(r, "/repo");
    expect(issues.map((i) => [i.check_name, i.severity, i.location.path, i.location.lines.begin])).toEqual([
      ["destructive", "major", "migrations/20261010T0901-drop/migration.sql", 3],
      ["data-dependent", "minor", "migrations/20261010T0901-drop/migration.sql", 1],
      ["pg-lock", "info", "migrations/20261010T0900-create/migration.sql", 2],
      ["directory", "major", "migrations", 1],
    ]);
    expect(new Set(issues.map((i) => i.fingerprint)).size).toBe(4);
    for (const i of issues) expect(i.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // The same finding on another pipeline is the same issue to GitLab.
    expect(codeQuality(r, "/repo")[0]?.fingerprint).toBe(issues[0]?.fingerprint);
    expect(codeQuality(report([]), "/repo")).toEqual([]);
  });
  it("points a declarative project's findings at no file, since src/ (the declared schema) and the plan are not files", () => {
    const d = declarativeLint({
      project: { dir: "/repo/db", dialect: "postgres" },
      schema: [{ rule: "naming", object: "events", message: "table events: does not match", level: "warning" }],
      plan: { environment: "dev", findings: [{ rule: "destructive", object: "events (app.events)", message: "drop column on events (app.events) note: removes data" }] },
    });
    expect(d.findings.map((f) => f.migration)).toEqual(["src/ (the declared schema)", "the plan for dev"]);
    expect(workflowCommands(d, "/repo").split("\n")).toEqual([
      "::warning title=yodel lint naming::table events: does not match",
      "::error title=yodel lint destructive::drop column on events (app.events) note: removes data",
      "",
    ]);
    expect(codeQuality(d, "/repo").map((i) => i.location.path)).toEqual(["db", "db"]);
  });
});

const db: BuiltObject = { export: "db", type: "ClickHouse::Database", ddl: "CREATE DATABASE yodel_129 ENGINE = Atomic", dependsOn: [] };
const events = (columns: string): BuiltObject => ({ export: "events", type: "ClickHouse::Table", ddl: `CREATE TABLE yodel_129.events (${columns}) ENGINE = MergeTree ORDER BY id`, dependsOn: ["db"] });
const ch = (columns: string): BuildOutput => ({ dialect: "clickhouse", objects: [db, events(columns)] });

function add(dir: string, name: string, build: BuildOutput, minute: number, parent?: CreatedMigration): CreatedMigration {
  const previous = parent ? readMigrations(dir).find((m) => m.id === parent.id) : newestMigration(readMigrations(dir));
  const m = createMigration({ name, build, previous, now: new Date(Date.UTC(2026, 9, 10, 9, minute)) });
  if (m.id === undefined) throw new Error(`no change for ${name}`);
  writeMigration(dir, m);
  return m;
}

describe("yodel lint --format", () => {
  const disposers: Array<() => void> = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const d of disposers.splice(0)) d();
  });

  /** A project with a fork: add-b, the newer, is the one to rebase. */
  function forked(): { dir: string; b: CreatedMigration } {
    const { dir, dispose } = projectFrom("lint-clickhouse");
    disposers.push(dispose);
    const migrations = join(dir, "migrations");
    const first = add(migrations, "create", ch("id UInt64"), 0);
    add(migrations, "add-a", ch("id UInt64, a String DEFAULT ''"), 1, first);
    const b = add(migrations, "add-b", ch("id UInt64, b String DEFAULT ''"), 2, first);
    // The forge's checkout is the project here, as in a repository made from a template.
    vi.stubEnv("GITHUB_WORKSPACE", dir);
    vi.stubEnv("CI_PROJECT_DIR", "");
    return { dir, b };
  }

  it("github: the report, then the fork as an error on the newer migration", async () => {
    const { dir, b } = forked();
    const ran = await yodel(["lint", "--format", "github", "--dir", dir]);
    expect(ran.code).toBe(3);
    expect(ran.out).toContain("3 migrations: 1 error, 0 warnings, 0 silenced.");
    expect(ran.out).toMatch(new RegExp(`^::error file=migrations/${b.id}/migration\\.sql,line=1,title=yodel lint fork::.* and ${b.id} both follow `, "m"));
  });

  it("gitlab: the report, and the code quality file at --output, written with no findings too", async () => {
    const { dir, b } = forked();
    const out = join(dir, "quality.json");
    const ran = await yodel(["lint", "--format", "gitlab", "--output", out, "--dir", dir]);
    expect(ran.code).toBe(3);
    expect(ran.out).not.toContain("::error");
    const issues = JSON.parse(readFileSync(out, "utf8")) as Array<{ check_name: string; severity: string; location: { path: string } }>;
    expect(issues).toMatchObject([{ check_name: "fork", severity: "major", location: { path: `migrations/${b.id}/migration.sql` } }]);

    const { dir: clean, dispose } = projectFrom("lint-clickhouse");
    disposers.push(dispose);
    const empty = join(clean, "quality.json");
    expect((await yodel(["lint", "--format", "gitlab", "--output", empty, "--dir", clean])).code).toBe(0);
    expect(JSON.parse(readFileSync(empty, "utf8"))).toEqual([]);
  });

  it("text by default, json as --json, and refuses a format it does not know or --output without gitlab", async () => {
    const { dir } = forked();
    const text = await yodel(["lint", "--dir", dir]);
    expect(text.out).not.toContain("::error");
    expect(existsSync(join(dir, CODE_QUALITY_FILE))).toBe(false);
    expect(JSON.parse((await yodel(["lint", "--format", "json", "--dir", dir])).out)).toMatchObject({ status: "failed" });
    for (const args of [["--format", "sarif"], ["--output", "x.json"], ["--format", "github", "--output", "x.json"], ["--json", "--format", "github"]]) {
      const ran = await yodel(["lint", ...args, "--dir", dir]);
      expect(ran.code, args.join(" ")).toBe(1);
    }
  });
});

describe("yodel ci renders each forge's lint job with its format", () => {
  const envs: Environments = { dialect: "postgres", names: ["dev"], replay: true, waves: [{ env: "dev", gate: "always" }] };
  type ActionsDoc = { jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }> };
  type GitLabDoc = Record<string, { script?: string[]; artifacts?: unknown }>;

  it("GitHub and Forgejo: workflow commands", () => {
    expect(lintCommand("github")).toBe("yodel lint --format github");
    expect(lintCommand("forgejo")).toBe("yodel lint --format github");
    for (const forge of ["github", "forgejo"] as const) {
      for (const replay of [true, false]) {
        const doc = parseYAMLDocument(actionsReview(forge, { ...envs, replay }).content) as ActionsDoc;
        expect(doc.jobs.lint?.steps.find((s) => s.name === "yodel lint")?.run, `${forge} replay=${String(replay)}`).toBe("yodel lint --format github");
      }
    }
  });

  it("GitLab: the code quality report, kept as the job's artifact whatever its outcome", () => {
    for (const replay of [true, false]) {
      const doc = parseYAMLDocument(gitlabPipeline({ ...envs, replay }).content) as GitLabDoc;
      expect(doc.lint?.script, `replay=${String(replay)}`).toContain(`yodel lint --format gitlab --output ${CODE_QUALITY_FILE}`);
      expect(doc.lint?.artifacts).toEqual({ when: "always", reports: { codequality: CODE_QUALITY_FILE } });
    }
  });
});
