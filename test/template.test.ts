/**
 * The starter templates (#17): `chant init --from <repo>#templates/<dialect>`
 * gives a project, and the pipelines committed in each template are the ones
 * its scripts/ci.ts renders, with the writer's credentials only in the apply
 * jobs.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import type { OpConfig } from "@intentius/chant/op/types";
import { parseYAMLDocument } from "@intentius/chant/yaml";
import { migrateOpParts } from "../src/versioned/op.js";
import {
  environments,
  readerVariables,
  REPLAY,
  reviewAndApply,
  writerVariables,
  type Dialect,
} from "../templates/clickhouse/scripts/ci.js";

const run = promisify(execFile);
const load = (text: string): unknown => parseYAMLDocument(text);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chant = join(root, "node_modules", ".bin", "chant");
const DIALECTS: readonly Dialect[] = ["clickhouse", "postgres"];
const templateDir = (d: Dialect) => join(root, "templates", d);

const PARAMS: Record<Dialect, Record<string, string>> = {
  clickhouse: { name: "events-schema", database: "events_db", history_database: "events_history" },
  postgres: { name: "app-schema", schema: "app_schema", history_schema: "app_history" },
};

/** Every file under `dir`, relative, `.git` left out. */
function files(dir: string, at = dir): string[] {
  return readdirSync(at).flatMap((name) => {
    if (name === ".git" || name === "node_modules") return [];
    const abs = join(at, name);
    return statSync(abs).isDirectory() ? files(dir, abs) : [relative(dir, abs)];
  });
}

const PIPELINES = (f: string) => f.startsWith(".github/") || f.startsWith(".forgejo/") || f.startsWith(".gitlab");

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

describe.each(DIALECTS)("templates/%s", (dialect) => {
  const dir = templateDir(dialect);
  const manifest = JSON.parse(readFileSync(join(dir, "chant.template.json"), "utf8")) as {
    parameters: Record<string, { default?: string }>;
    files: string[];
  };

  it("declares every placeholder its files carry, and lists every file that carries one", () => {
    const carrying = files(dir).filter((f) => f !== "chant.template.json" && readFileSync(join(dir, f), "utf8").includes("{{chant:"));
    expect(carrying.sort()).toEqual([...manifest.files].sort());
    for (const f of carrying) {
      for (const [, name] of readFileSync(join(dir, f), "utf8").matchAll(/\{\{chant:([A-Za-z_][A-Za-z0-9_]*)\}\}/g)) {
        expect(Object.keys(manifest.parameters), `${f}: {{chant:${String(name)}}}`).toContain(name);
      }
    }
  });

  it("chant init --from gives the project, its parameters substituted", async () => {
    const out = mkdtempSync(join(tmpdir(), `yodel-template-${dialect}-`));
    temps.push(out);
    const params = Object.entries(PARAMS[dialect]).flatMap(([k, v]) => ["--param", `${k}=${v}`]);
    await run(chant, ["init", "--from", `${root}#templates/${dialect}`, ...params, "project"], { cwd: out });
    const project = join(out, "project");

    const made = files(project);
    expect(made).not.toContain("chant.template.json");
    expect(made).toContain(".chant/workspace.lock.json");
    for (const f of files(dir).filter((f) => f !== "chant.template.json")) expect(made).toContain(f);
    for (const f of made) expect(readFileSync(join(project, f), "utf8"), f).not.toContain("{{chant:");

    const config = readFileSync(join(project, "chant.config.ts"), "utf8");
    const yodel = readFileSync(join(project, "yodel.config.ts"), "utf8");
    if (dialect === "clickhouse") {
      expect(config).toContain('databases: ["events_db"]');
      expect(yodel).toContain('history: { database: "events_history" }');
    } else {
      expect(config).toContain('schemas: ["app_schema"]');
      expect(yodel).toContain('history: { database: "app_history" }');
    }
    expect(JSON.parse(readFileSync(join(project, "package.json"), "utf8"))).toMatchObject({ name: PARAMS[dialect].name });
  });

  it("has a migrate Op yodel apply runs and a WatchOp on a schedule for each environment, in each forge's pipelines", async () => {
    const envs = await environments(dir);
    expect(envs).toEqual({ dialect, names: ["dev", "prod"], replay: true });
    for (const env of envs.names) {
      const migrate = (await import(pathToFileURL(join(dir, "ops", `migrate-${env}.op.ts`)).href)) as { op: { props: OpConfig } };
      expect(migrateOpParts(migrate.op.props, env)).toEqual({ gate: `approve-migrate-${env}`, quorum: false });
      const watch = (await import(pathToFileURL(join(dir, "ops", `watch-${env}.op.ts`)).href)) as { op: { props: OpConfig } };
      expect(watch.op.props.name).toBe(`watch-${env}`);
      const cron = watch.op.props.schedule?.cron;
      expect(cron).toMatch(/^\S+ \S+ \S+ \S+ \S+$/);
      for (const forge of [".github", ".forgejo"]) {
        const doc = load(readFileSync(join(dir, forge, "workflows", `watch-${env}.yml`), "utf8")) as { on: { schedule: Array<{ cron: string }> } };
        expect(doc.on.schedule[0]?.cron, `${forge} watch-${env}`).toBe(cron);
      }
      expect(readFileSync(join(dir, ".gitlab/yodel-watch.gitlab-ci.yml"), "utf8")).toContain(`watch-${env}: cron "${String(cron)}"`);
    }
  });

  it("commits the pull request and apply pipelines its scripts/ci.ts renders", async () => {
    for (const file of reviewAndApply(await environments(dir))) {
      expect(readFileSync(join(dir, file.path), "utf8"), file.path).toBe(file.content);
    }
  });

  it("gives the writer's credentials to the apply jobs only, and the reader's to the rest", () => {
    const readers = ["dev", "prod"].flatMap((e) => readerVariables(e, dialect));
    const writerOnly = ["dev", "prod"].flatMap((e) => writerVariables(e, dialect).slice(1));
    let applyJobs = 0;
    for (const f of files(dir).filter((f) => PIPELINES(f) && f.endsWith(".yml"))) {
      const doc = load(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>;
      const jobs = (f.startsWith(".gitlab") ? doc : (doc.jobs as Record<string, unknown>));
      for (const [name, job] of Object.entries(jobs)) {
        if (typeof job !== "object" || job === null || name === "stages" || name === "variables") continue;
        const text = JSON.stringify(job);
        if (name.startsWith("apply-")) {
          applyJobs++;
          expect(text, `${f} ${name}`).toContain('"YODEL_CREDENTIALS":"writer"');
          for (const v of readers.filter((r) => !r.endsWith("_URL"))) expect(text, `${f} ${name}`).not.toContain(v);
        } else {
          expect(text, `${f} ${name}`).not.toContain("YODEL_CREDENTIALS");
          for (const v of writerOnly) expect(text, `${f} ${name}`).not.toContain(v);
        }
      }
    }
    expect(applyJobs).toBe(6); // dev and prod on each of three forges
  });

  it("never points the replay profile at another profile's server, and gives it the history's database", async () => {
    const { loadChantConfig } = await import("@intentius/chant/config");
    const { config } = await loadChantConfig(dir);
    const profiles = (config as { sql: { profiles: Record<string, { url: string }> } }).sql.profiles;
    const server = (url: string) => new URL(url).host;
    const replayServer = server(profiles.replay?.url ?? "");
    expect(replayServer).toMatch(/\.invalid(:\d+)?$/);
    for (const [name, p] of Object.entries(profiles)) if (name !== "replay") expect(server(p.url), name).not.toBe(replayServer);
    const yodel = readFileSync(join(dir, "yodel.config.ts"), "utf8");
    expect(yodel).toMatch(/^ {4}replay: \{.*history: \{ database: "\{\{chant:history_(database|schema)\}\}" \} \},$/m);
    expect(readFileSync(join(dir, "README.md"), "utf8")).not.toContain("npx yodel lint --replay replay --reset");
  });

  it("has a just target for each routine step, and its README gives the command beside each", () => {
    const justfile = readFileSync(join(dir, "justfile"), "utf8");
    const targets = [...justfile.matchAll(/^([a-z][a-z-]*)(?: [^:]*)?:$/gm)].map((m) => m[1] ?? "");
    expect(targets).toEqual(["default", "up", "down", "new", "lint", "replay", "plan", "approve", "apply", "drift", "status", "ci", "ci-check"]);
    // approve prints the command; it never runs chant approve itself.
    expect(justfile).not.toMatch(/^\s+(npx @intentius\/)?chant approve/m);
    const readme = readFileSync(join(dir, "README.md"), "utf8");
    for (const t of targets.filter((t) => t !== "default")) expect(readme, t).toMatch(new RegExp(`^\\| \`just ${t}[\` ]`, "m"));
  });

  it("lints and runs the replay check on pull requests", () => {
    for (const f of [".github/workflows/yodel-pr.yml", ".forgejo/workflows/yodel-pr.yml", ".gitlab-ci.yml"]) {
      const text = readFileSync(join(dir, f), "utf8");
      expect(text, f).toContain("yodel lint\n");
      expect(text, f).toContain(REPLAY);
      expect(text, f).toContain("npm run ci:check");
      expect(text, f).toContain("yodel plan dev --comment");
    }
  });
});

describe("the templates' scripts", () => {
  it("are the same in every template", () => {
    for (const f of ["justfile", "scripts/ci.ts", "scripts/local.ts", "ops/migrate-dev.op.ts", "ops/watch-dev.op.ts"]) {
      expect(readFileSync(join(templateDir("postgres"), f), "utf8"), f).toBe(readFileSync(join(templateDir("clickhouse"), f), "utf8"));
    }
  });

  it("ends each watch with yodel drift --issue, with a token that can write issues", () => {
    for (const dialect of DIALECTS) {
      const dir = templateDir(dialect);
      for (const forge of [".github", ".forgejo"]) {
        const doc = load(readFileSync(join(dir, forge, "workflows", "watch-dev.yml"), "utf8")) as { permissions?: Record<string, string>; jobs: Record<string, { env?: Record<string, string>; steps: Array<{ run?: string }> }> };
        const job = doc.jobs["watch-dev"];
        expect(job?.steps.at(-1)?.run, `${dialect} ${forge}`).toBe("yodel drift dev --issue");
        expect(job?.env?.GITHUB_TOKEN, `${dialect} ${forge}`).toBe("${{ github.token }}");
        if (forge === ".github") expect(doc.permissions).toEqual({ contents: "read", issues: "write" });
      }
      const gitlab = load(readFileSync(join(dir, ".gitlab", "yodel-watch.gitlab-ci.yml"), "utf8")) as Record<string, { script?: string[] }>;
      expect(gitlab["watch-dev"]?.script?.at(-1)).toBe('yodel drift "${CI_JOB_NAME#watch-}" --issue');
    }
  });
});
