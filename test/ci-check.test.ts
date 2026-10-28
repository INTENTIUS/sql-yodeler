/**
 * `yodel ci` with yodel.config.ts `check` (#1): the lint job runs yodel
 * check on another tool's migrations, and a project that declares no
 * environment, only the `replay` profile, gets the pull request job alone.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseYAMLDocument } from "@intentius/chant/yaml";
import { checkYodelConfig } from "../src/config/load.js";
import { copyTemplate, repoRoot, yodel } from "./helpers/run.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "yodel-ci-check-"));
  temps.push(dir);
  symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"));
  return dir;
};

type Workflow = { jobs: Record<string, { steps: Array<{ name?: string; run?: string }>; services?: Record<string, unknown> }> };

describe("yodel ci with check", () => {
  it("renders one job for a project that only checks another tool's migrations, and nothing else", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "package.json"), `{ "name": "goose-app", "private": true, "type": "module" }\n`);
    writeFileSync(
      join(dir, "chant.config.ts"),
      `import "@intentius/chant-lexicon-sql";
export default {
  lexicons: ["sql"],
  sql: { dialect: "postgres", profiles: { replay: { url: "postgres://replay.invalid:5432/postgres", user: { env: "REPLAY_POSTGRES_USER" }, password: { env: "REPLAY_POSTGRES_PASSWORD" }, schemas: ["app"] } } },
};
`,
    );
    writeFileSync(join(dir, "yodel.config.ts"), `export default { check: { dir: "db/migrations", tool: "goose" } };\n`);
    mkdirSync(join(dir, "db", "migrations"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: dir });

    const wrote = await yodel(["ci", "--dir", dir]);
    expect(wrote.code, wrote.err).toBe(0);
    expect(wrote.out.trim().split("\n").map((l) => l.replace(/^wrote /, "")).sort()).toEqual([".forgejo/workflows/yodel-pr.yml", ".github/workflows/yodel-pr.yml", ".gitlab-ci.yml"]);

    const pr = parseYAMLDocument(readFileSync(join(dir, ".github/workflows/yodel-pr.yml"), "utf8")) as Workflow & { permissions: Record<string, string> };
    expect(Object.keys(pr.jobs)).toEqual(["check"]);
    expect(pr.permissions).toEqual({ contents: "read" });
    const steps = pr.jobs.check?.steps.map((s) => s.run ?? "") ?? [];
    expect(steps).toContain("yodel check --env replay --reset --base origin/main --format github");
    expect(steps.some((s) => s.includes("chant/lifecycle"))).toBe(false);
    expect(Object.keys(pr.jobs.check?.services ?? {})).toEqual(["replay-postgres"]);

    const gitlab = parseYAMLDocument(readFileSync(join(dir, ".gitlab-ci.yml"), "utf8")) as Record<string, { script?: string[] }> & { stages: string[] };
    expect(gitlab.stages).toEqual(["review"]);
    expect(gitlab.check?.script).toContain("yodel check --env replay --reset --base origin/main --format gitlab --output gl-code-quality-report.json");
    expect(existsSync(join(dir, "yodel-waves.json"))).toBe(false);

    const again = await yodel(["ci", "--check", "--dir", dir]);
    expect(again.code, again.out + again.err).toBe(0);
  });

  it("adds yodel check to a yodel project's lint job, after the replay check on the same server", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yodel-ci-check-"));
    temps.push(dir);
    copyTemplate("clickhouse", dir);
    symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"));
    const config = join(dir, "yodel.config.ts");
    writeFileSync(config, readFileSync(config, "utf8").replace(/^export default \{$/m, 'export default {\n  check: { dir: "legacy/migrations" },'));
    execFileSync("git", ["init", "-q"], { cwd: dir });

    const wrote = await yodel(["ci", "--dir", dir]);
    expect(wrote.code, wrote.err).toBe(0);
    const pr = parseYAMLDocument(readFileSync(join(dir, ".github/workflows/yodel-pr.yml"), "utf8")) as Workflow;
    const names = pr.jobs.lint?.steps.map((s) => s.name ?? "") ?? [];
    expect(names.indexOf("yodel check")).toBeGreaterThan(names.indexOf("yodel lint --replay"));
    expect(Object.keys(pr.jobs)).toContain("plan-dev");
  });

  it("checks yodel.config.ts check", () => {
    expect(() => checkYodelConfig({ check: {} }, "yodel.config.ts")).toThrow(/check: \{ dir \}/);
    expect(() => checkYodelConfig({ check: { dir: "db", tool: "rails" } }, "yodel.config.ts")).toThrow(/check\.tool: one of golang-migrate, goose, flyway, dbmate/);
    expect(() => checkYodelConfig({ check: { dir: "db", env: "staging" } }, "yodel.config.ts", ["dev", "replay"])).toThrow(/check\.env: a profile chant\.config\.ts declares/);
    expect(() => checkYodelConfig({ check: { dir: "db", extra: 1 } }, "yodel.config.ts")).toThrow(/unknown setting extra/);
    expect(checkYodelConfig({ check: { dir: "db/migrations", tool: "flyway", env: "replay" } }, "yodel.config.ts", ["replay"]).check).toEqual({ dir: "db/migrations", tool: "flyway", env: "replay" });
  });
});
