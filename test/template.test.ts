/**
 * The starter templates (#17): `chant init --from <repo>#templates/<dialect>`
 * gives a project, and the pipelines committed in each template are the ones
 * `yodel ci` (src/ci/, #65) renders, with the writer's credentials only in
 * the apply jobs.
 */

import { execFile } from "node:child_process";
import { opExportName } from "../src/chant/export-name.js";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import type { OpConfig } from "@intentius/chant/op/types";
import { parseYAMLDocument } from "@intentius/chant/yaml";
import { migrateOpParts } from "../src/versioned/op.js";
import { YODEL_PRESETS } from "../src/ci/check-hooks.js";
import {
  render,
  environments,
  fetchApprovals,
  FORGEJO_UPLOAD_ARTIFACT,
  UPLOAD_ARTIFACT,
  readerVariables,
  readWaves,
  REPLAY,
  REPORT_DIR,
  reportArtifact,
  reportCommand,
  WAVES_SPEC,
  wavesSpec,
  WEBHOOK_VARIABLES,
  writerVariables,
  type Dialect,
} from "../src/ci/render.js";

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
    for (const f of files(templateDir(dialect)).filter((f) => f !== "chant.template.json")) expect(made).toContain(f);
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
    const P = dialect.toUpperCase();
    const roles = (env: string) => ({ reader: { variables: [`${env}_${P}_READER_USER`, `${env}_${P}_READER_PASSWORD`] }, writer: { variables: [`${env}_${P}_WRITER_USER`, `${env}_${P}_WRITER_PASSWORD`] } });
    expect(envs).toEqual({
      dialect,
      names: ["dev", "prod"],
      replay: true,
      waves: [{ env: "dev", gate: "always" }, { env: "prod", gate: "always", requires: "dev" }],
      forges: ["github", "gitlab", "forgejo"],
      // The profiles are made with credentials(): a reader and a writer each, by the default variables.
      credentials: { dev: roles("DEV"), prod: roles("PROD") },
      // The template commits src/sql-types.d.ts, so the lint job checks it (#228).
      typedColumns: true,
    });
    for (const env of envs.names) {
      // Each Op is exported under a name of its own (#2): migrateDev, watchDev.
      const migrateMod = (await import(pathToFileURL(join(dir, "ops", `migrate-${env}.op.ts`)).href)) as Record<string, { props: OpConfig }>;
      const migrate = migrateMod[opExportName(`migrate-${env}`)];
      if (!migrate) throw new Error(`ops/migrate-${env}.op.ts does not export ${opExportName(`migrate-${env}`)}`);
      expect(Object.keys(migrateMod)).toEqual([opExportName(`migrate-${env}`)]);
      expect(migrateOpParts(migrate.props, env)).toEqual({ gate: `approve-migrate-${env}`, quorum: false });
      const watchMod = (await import(pathToFileURL(join(dir, "ops", `watch-${env}.op.ts`)).href)) as Record<string, { props: OpConfig }>;
      const watch = watchMod[opExportName(`watch-${env}`)];
      if (!watch) throw new Error(`ops/watch-${env}.op.ts does not export ${opExportName(`watch-${env}`)}`);
      expect(Object.keys(watchMod)).toEqual([opExportName(`watch-${env}`)]);
      expect(watch.props.name).toBe(`watch-${env}`);
      const cron = watch.props.schedule?.cron;
      expect(cron).toMatch(/^\S+ \S+ \S+ \S+ \S+$/);
      for (const forge of [".github", ".forgejo"]) {
        const doc = load(readFileSync(join(dir, forge, "workflows", `watch-${env}.yml`), "utf8")) as { on: { schedule: Array<{ cron: string }> } };
        expect(doc.on.schedule[0]?.cron, `${forge} watch-${env}`).toBe(cron);
      }
      expect(readFileSync(join(dir, ".gitlab/yodel-watch.gitlab-ci.yml"), "utf8")).toContain(`watch-${env}: cron "${String(cron)}"`);
    }
  });

  it("commits the pull request and apply pipelines yodel ci renders", async () => {
    // Every file yodel ci renders, the workspace declaration with its check hooks among them (#298).
    // /yodel new (#312) reaches the templates with the release that ships it (AGENTS.md, Releasing): until
    // npm run templates:render writes its workflow there, the committed template is what yodel ci renders without it.
    const staged = !existsSync(join(dir, ".github", "workflows", "yodel-new.yml"));
    const rendered = await render(dir, staged ? { respondNew: "off", respondRebase: "off" } : {});
    expect(rendered.map((f) => f.path)).toContain("chant.workspace.json");
    expect(manifest.files).toContain("chant.workspace.json");
    // The actions pinned by SHA from chant's ACTION_PINS (#319) reach the templates with the same release, so until then a uses: line compares by its action alone.
    const actionOnly = (text: string) => (staged ? text.replace(/^(\s*(?:- )?uses: *)\S*?([^/\s@]+)@\S+(?: # \S+)?$/gm, "$1$2") : text);
    // The jobs' fetch of chant/lifecycle through chant's reader (#326) reaches them with that release too; until then they keep the git line it replaced.
    const ledgerFetch = (text: string) => (staged ? text.replaceAll(fetchApprovals(), STAGED_LEDGER_FETCH) : text);
    // The plan on chant's product plan (sql-yodeler issue 345) runs `yodel plan --pr-note`, which the templates' yodel range
    // gets with the release that ships it: until then the template keeps the pull request pipelines that release renders.
    const planStaged = !existsSync(join(dir, ".gitlab", "yodel-plan.gitlab-ci.yml"));
    const PR_PIPELINES = [".github/workflows/yodel-pr.yml", ".forgejo/workflows/yodel-pr.yml", ".gitlab-ci.yml", ".gitlab/yodel-plan.gitlab-ci.yml"];
    for (const file of rendered) {
      if (planStaged && PR_PIPELINES.includes(file.path)) continue;
      expect(actionOnly(readFileSync(join(dir, file.path), "utf8")), file.path).toBe(actionOnly(ledgerFetch(file.content)));
    }
  });

  it("applies as chant waves, one per environment in order, each job needing the one before and running chant run wave", () => {
    const spec = JSON.parse(readFileSync(join(dir, WAVES_SPEC), "utf8")) as ReturnType<typeof wavesSpec>;
    expect(spec.waves.map((w) => [w.name, w.gate])).toEqual([["dev", "always"], ["prod", "always"]]);
    // The sql lexicon's capability plans and applies each run, with no callback (#291), and chant stands a superseded run down (#293).
    expect(spec.step.kind).toBe("sql-migrate");
    expect(spec.standDown).toBe(true);
    expect(spec).not.toHaveProperty("plan");
    expect(spec).not.toHaveProperty("apply");
    // Through the product pipeline the wave jobs run chant as the yodel bin (#289).
    const wave2 = `yodel chant run wave --spec ${WAVES_SPEC} --wave 2`;
    for (const f of [".github/workflows/yodel-apply.yml", ".forgejo/workflows/yodel-apply.yml"]) {
      const doc = load(readFileSync(join(dir, f), "utf8")) as { jobs: Record<string, { needs?: string[]; steps: Array<{ run?: string }> }> };
      expect(Object.keys(doc.jobs), f).toEqual(["wave-1-dev", "wave-2-prod"]);
      expect(doc.jobs["wave-2-prod"]?.needs, f).toEqual(["wave-1-dev"]);
      expect(doc.jobs["wave-2-prod"]?.steps.map((s) => s.run), f).toContain(wave2);
    }
    const gitlab = load(readFileSync(join(dir, ".gitlab/yodel-apply.gitlab-ci.yml"), "utf8")) as Record<string, { needs?: string[]; stage?: string }>;
    expect(gitlab["wave-2-prod"]?.needs).toEqual(["wave-1-dev"]);
    const main = load(readFileSync(join(dir, ".gitlab-ci.yml"), "utf8")) as { stages: string[] };
    expect(main.stages).toEqual(["review", "wave-1-dev", "wave-2-prod", "ops"]);
  });

  it("gives an environment's writer to its wave job only, with its own reader and the reader of the wave before, and the reader to the rest", () => {
    const writerOnly = (e: string) => writerVariables(e, dialect).slice(1);
    let applyJobs = 0;
    for (const f of files(dir).filter((f) => PIPELINES(f) && f.endsWith(".yml"))) {
      const doc = load(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>;
      const jobs = (f.startsWith(".gitlab") ? doc : (doc.jobs as Record<string, unknown>));
      for (const [name, job] of Object.entries(jobs)) {
        if (typeof job !== "object" || job === null || name === "stages" || name === "variables") continue;
        const text = JSON.stringify(job);
        const wave = /^wave-\d+-(\w+)$/.exec(name)?.[1];
        if (wave) {
          applyJobs++;
          expect(text, `${f} ${name}`).toContain(`"YODEL_CREDENTIALS":"writer:${wave}"`);
          for (const other of ["dev", "prod"].filter((e) => e !== wave)) for (const v of writerOnly(other)) expect(text, `${f} ${name}`).not.toContain(v);
          // chant's sql-migrate plans the wave with the writer taken out, so the job holds its own reader too.
          if (!f.startsWith(".gitlab")) for (const v of readerVariables(wave, dialect)) expect(text, `${f} ${name}`).toContain(v);
          // prod's wave reads dev's history with dev's reader (GitLab's jobs have the unscoped readers already).
          if (wave === "prod" && !f.startsWith(".gitlab")) for (const v of readerVariables("dev", dialect)) expect(text, `${f} ${name}`).toContain(v);
        } else {
          expect(text, `${f} ${name}`).not.toContain("YODEL_CREDENTIALS");
          for (const v of ["dev", "prod"].flatMap(writerOnly)) expect(text, `${f} ${name}`).not.toContain(v);
        }
      }
    }
    expect(applyJobs).toBe(6); // a wave each for dev and prod on each of three forges
  });

  it("tries a write in each plan job before the plan, with every reader the job holds (#50)", () => {
    const probe = { dev: "yodel config check dev --write-probe", prod: "yodel config check prod dev --write-probe" };
    for (const f of [".github/workflows/yodel-pr.yml", ".forgejo/workflows/yodel-pr.yml"]) {
      const doc = load(readFileSync(join(dir, f), "utf8")) as { jobs: Record<string, { steps: Array<{ run?: string }> }> };
      for (const env of ["dev", "prod"] as const) {
        const runs = (doc.jobs[`plan-${env}`]?.steps ?? []).map((s) => s.run);
        expect(runs.indexOf(probe[env]), `${f} plan-${env}`).toBeGreaterThan(-1);
        expect(runs.indexOf(probe[env]), `${f} plan-${env}`).toBeLessThan(runs.indexOf(`yodel plan ${env} --comment`));
      }
    }
    const gitlab = load(readFileSync(join(dir, ".gitlab-ci.yml"), "utf8")) as Record<string, { script?: string[] }>;
    for (const env of ["dev", "prod"] as const) expect(gitlab[`plan-${env}`]?.script).toEqual([probe[env], `yodel plan ${env} --comment`]);
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

  it("keeps yodel report as an artifact of every plan and wave job, and passes the webhook's variables", () => {
    for (const f of [".github/workflows/yodel-pr.yml", ".forgejo/workflows/yodel-pr.yml", ".github/workflows/yodel-apply.yml", ".forgejo/workflows/yodel-apply.yml"]) {
      const doc = load(readFileSync(join(dir, f), "utf8")) as { jobs: Record<string, { env?: Record<string, string>; steps: Array<{ if?: string; run?: string; uses?: string; with?: Record<string, string> }> }> };
      for (const [name, job] of Object.entries(doc.jobs).filter(([n]) => n.startsWith("plan-") || n.startsWith("wave-"))) {
        const env = name.replace(/^plan-|^wave-\d+-/, "");
        expect(job.steps.find((s) => s.run === reportCommand(env))?.if, `${f} ${name}`).toBe("always()");
        // On Forgejo, upload-artifact v3: v4 refuses any server but github.com's. The templates take the pins with the release that has them (#319).
        const pinned = existsSync(join(dir, ".github", "workflows", "yodel-new.yml"));
        const upload = f.startsWith(".forgejo") ? (pinned ? FORGEJO_UPLOAD_ARTIFACT : "https://code.forgejo.org/forgejo/upload-artifact@v4") : pinned ? UPLOAD_ARTIFACT : "actions/upload-artifact@v4";
        // A wave job also uploads its outcome file (#4322), so pick the report's upload by name.
        expect(job.steps.find((s) => s.uses === upload && s.with?.name === reportArtifact(name))?.with, `${f} ${name}`).toMatchObject({ name: reportArtifact(name), path: REPORT_DIR });
        for (const v of WEBHOOK_VARIABLES) expect(job.env?.[v], `${f} ${name}`).toBe(`\${{ secrets.${v} }}`);
      }
    }
    for (const f of [".gitlab-ci.yml", ".gitlab/yodel-apply.gitlab-ci.yml"]) {
      const doc = load(readFileSync(join(dir, f), "utf8")) as Record<string, { after_script?: string[]; artifacts?: { when?: string; paths?: string[] } }>;
      for (const [name, job] of Object.entries(doc).filter(([n]) => n.startsWith("plan-") || n.startsWith("wave-"))) {
        expect(job.after_script, `${f} ${name}`).toEqual([reportCommand(name.replace(/^plan-|^wave-\d+-/, ""))]);
        expect(job.artifacts?.when, `${f} ${name}`).toBe("always");
        // A wave job keeps chant's outcome files beside the report (#4322), since yodel passes the report to chant (#4791).
        expect(job.artifacts?.paths, `${f} ${name}`).toContain(`${REPORT_DIR}/`);
      }
    }
  });

  it("lints and runs the replay check on pull requests", () => {
    // The checks are hooks in the declaration, which chant reads at the base and the lint job runs (#294).
    const declaration = JSON.parse(readFileSync(join(dir, "chant.workspace.json"), "utf8")) as { ci?: { hooks?: { check?: Array<{ name?: string; command: string[] }> } } };
    const hooks = declaration.ci?.hooks?.check ?? [];
    expect(hooks.map((h) => h.name)).toEqual(YODEL_PRESETS.filter((n) => n !== "yodel-test" && n !== "yodel-check"));
    expect(hooks.find((h) => h.name === "yodel-replay")?.command.join(" ")).toBe(REPLAY);
    for (const f of [".github/workflows/yodel-pr.yml", ".forgejo/workflows/yodel-pr.yml", ".gitlab-ci.yml"]) {
      const text = readFileSync(join(dir, f), "utf8");
      expect(text, f).toContain("yodel chant ci check --base ");
      expect(text, f).toContain("yodel plan dev --comment");
    }
  });
});

/** The templates' fetch of chant/lifecycle until the release that renders `yodel ci --fetch-ledger` there (#326). */
const STAGED_LEDGER_FETCH =
  "git fetch --no-tags origin '+refs/heads/chant/lifecycle:refs/remotes/origin/chant/lifecycle' && git branch -f chant/lifecycle origin/chant/lifecycle || echo 'no chant/lifecycle branch yet, so nothing is approved'";

describe("yodel ci and the templates' scripts", () => {
  it("read yodel.config.ts waves, refusing an environment that is not one and a gate that is not a policy", async () => {
    const { writeFileSync } = await import("node:fs");
    const project = (waves: string | undefined) => {
      const dir = mkdtempSync(join(tmpdir(), "yodel-waves-"));
      temps.push(dir);
      writeFileSync(join(dir, "yodel.config.ts"), waves === undefined ? "export default {};\n" : `export default { waves: ${waves} };\n`);
      return dir;
    };
    expect(await readWaves(project(undefined), ["dev", "prod"])).toEqual([{ env: "dev", gate: "always" }, { env: "prod", gate: "always", requires: "dev" }]);
    expect(await readWaves(project('[{ env: "dev", gate: "never" }, { env: "prod", gate: "on-destructive" }]'), ["dev", "prod"])).toEqual([
      { env: "dev", gate: "never" },
      { env: "prod", gate: "on-destructive", requires: "dev" },
    ]);
    expect(await readWaves(project('[{ env: "dev" }, { env: "prod", requires: false }]'), ["dev", "prod"])).toEqual([{ env: "dev", gate: "always" }, { env: "prod", gate: "always" }]);
    await expect(readWaves(project('[{ env: "staging" }]'), ["dev", "prod"])).rejects.toThrow(/staging is not an environment/);
    await expect(readWaves(project('[{ env: "dev", gate: "sometimes" }]'), ["dev", "prod"])).rejects.toThrow(/sometimes/);
  });

  it("are the same in every template", () => {
    for (const f of ["justfile", "package.json", "scripts/local.ts", "ops/migrate-dev.op.ts", "ops/watch-dev.op.ts"]) {
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
