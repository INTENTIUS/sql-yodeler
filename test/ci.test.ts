/**
 * `yodel ci` (#65): the pipelines rendered by the package, the forges
 * yodel.config.ts `ci.forges` picks, and the project's own jobs (`ci.jobs`)
 * merged after yodel's and kept on every render.
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseYAMLDocument } from "@intentius/chant/yaml";
import { checkYodelConfig } from "../src/config/load.js";
import { repoRoot, yodel } from "./helpers/run.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

/** A copy of the ClickHouse template, resolving chant and the lexicons from this checkout. */
function project(ci: string, jobs?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "yodel-ci-"));
  temps.push(dir);
  cpSync(join(repoRoot, "templates", "clickhouse"), dir, { recursive: true });
  symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"));
  const config = join(dir, "yodel.config.ts");
  const text = readFileSync(config, "utf8").replace(/^ {2}ci: .*$/m, `  ci: ${ci},`);
  writeFileSync(config, text);
  if (jobs !== undefined) writeFileSync(join(dir, "jobs.ts"), jobs);
  // chant finds the Ops from the git root.
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

const JOBS = `import { Job, Step } from "@intentius/chant-lexicon-github";
import { Image, Job as GitLabJob } from "@intentius/chant-lexicon-gitlab";

export const actions = {
  unit: new Job({ "runs-on": "ubuntu-latest", steps: [new Step({ run: "echo the project's own job" })] }),
};
export const gitlab = {
  unit: new GitLabJob({ stage: "test", image: new Image({ name: "node:22" }), script: ["echo the project's own job"] }),
};
`;

describe("yodel ci", () => {
  it("renders the forges ci.forges names, with the project's own jobs after yodel's, and keeps them on every render", async () => {
    const dir = project('{ forges: ["github", "gitlab"], jobs: "jobs.ts" }', JOBS);
    const wrote = await yodel(["ci", "--dir", dir]);
    expect(wrote.code, wrote.err).toBe(0);
    expect(existsSync(join(dir, ".github/workflows/yodel-pr.yml"))).toBe(true);
    expect(wrote.out).not.toContain(".forgejo/");

    const pr = parseYAMLDocument(readFileSync(join(dir, ".github/workflows/yodel-pr.yml"), "utf8")) as { jobs: Record<string, { steps: Array<{ run?: string }> }> };
    expect(Object.keys(pr.jobs)).toEqual(["lint", "plan-dev", "plan-prod", "unit"]);
    expect(pr.jobs.unit?.steps[0]?.run).toBe("echo the project's own job");
    const gitlab = parseYAMLDocument(readFileSync(join(dir, ".gitlab-ci.yml"), "utf8")) as Record<string, unknown> & { stages: string[] };
    expect(gitlab.stages).toEqual(["review", "test", "wave-1-dev", "wave-2-prod", "ops"]);
    expect(gitlab.unit).toMatchObject({ stage: "test", script: ["echo the project's own job"] });

    expect((await yodel(["ci", "--check", "--dir", dir])).code).toBe(0);
    // A pipeline edited by hand, or rendered by an older yodel: --check names it, and yodel ci renders it again, the project's job kept.
    const file = join(dir, ".github/workflows/yodel-pr.yml");
    writeFileSync(file, readFileSync(file, "utf8").replace(/\n {2}unit:\n[\s\S]*$/, "\n"));
    const stale = await yodel(["ci", "--check", "--dir", dir]);
    expect(stale.code).toBe(1);
    expect(stale.err).toContain("stale, run yodel ci: .github/workflows/yodel-pr.yml");
    expect((await yodel(["ci", "--dir", dir])).out).toBe("wrote .github/workflows/yodel-pr.yml\n");
    expect(readFileSync(file, "utf8")).toContain("echo the project's own job");
  });

  it("refuses a project job named as one of yodel's, and a jobs module that is not there", async () => {
    const clash = project('{ forges: ["github"], jobs: "jobs.ts" }', JOBS.replace("unit: new Job", "lint: new Job"));
    const ran = await yodel(["ci", "--dir", clash]);
    expect(ran.code).toBe(1);
    expect(ran.err).toContain("actions job lint has the name of one of yodel's jobs");
    const missing = project('{ jobs: "nowhere.ts" }');
    expect((await yodel(["ci", "--dir", missing])).err).toContain("ci.jobs names nowhere.ts, which is not there");
  });

  it("checks yodel.config.ts ci", () => {
    expect(() => checkYodelConfig({ ci: { forges: ["github", "bitbucket"] } }, "yodel.config.ts")).toThrow(/ci\.forges: a list of github, gitlab, forgejo/);
    expect(() => checkYodelConfig({ ci: { forges: [] } }, "yodel.config.ts")).toThrow(/ci\.forges/);
    expect(() => checkYodelConfig({ ci: { jobs: 3 } }, "yodel.config.ts")).toThrow(/ci\.jobs/);
    expect(() => checkYodelConfig({ ci: { image: "x" } }, "yodel.config.ts")).toThrow(/ci\.image: unknown setting/);
    expect(checkYodelConfig({ ci: { forges: ["gitlab"], jobs: "ci/jobs.ts" } }, "yodel.config.ts").ci).toEqual({ forges: ["gitlab"], jobs: "ci/jobs.ts" });
  });

  it("takes --check or --replay, not both, and options after -- only with --replay", async () => {
    expect((await yodel(["ci", "--check", "--replay"])).err).toContain("--check and --replay are two things");
    expect((await yodel(["ci", "--", "--json"])).err).toContain("options after -- are for --replay");
  });
});
