/**
 * The pull request's check on chant's check moment (#294, chant#4556):
 * yodel's checks as hook presets, squawk and sqlfluff off unless named, the
 * lint job running `yodel chant ci check` against the base (so a pull
 * request cannot remove a required check), the presets written into the
 * workspace declaration, and `--format forge`.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseYAMLDocument } from "@intentius/chant/yaml";
import { chantCheckHooks, checkPresets, declarationWithHooks, type ChantCheckHooks, type CheckHook, type PresetInput } from "../src/ci/check-hooks.js";
import { actionsReview, checkHooksLine, checkHooksOf, gitlabPipeline, type Environments } from "../src/ci/render.js";
import { CODE_QUALITY_FILE, forgeFormat } from "../src/lint/index.js";
import { checkYodelConfig } from "../src/config/index.js";

const input = (over: Partial<PresetInput> = {}): PresetInput => ({
  dialect: "postgres",
  commands: { ci: "yodel ci --check", types: "chant sql types --check", lint: "yodel lint --format forge", replay: "yodel lint --replay replay --reset", test: "yodel test --env replay --reset --junit yodel-test.xml", check: "yodel check --env replay --reset --base origin/main --format forge" },
  typedColumns: false,
  replay: false,
  tests: false,
  check: false,
  tools: [],
  ...over,
});

describe("yodel's check presets (#294)", () => {
  it("are the lint job's checks, in its order, each as an argv", () => {
    expect(checkPresets(input()).map((h) => h.name)).toEqual(["yodel-ci-check", "yodel-lint"]);
    const all = checkPresets(input({ typedColumns: true, replay: true, tests: true, check: true }));
    expect(all.map((h) => h.name)).toEqual(["yodel-ci-check", "yodel-sql-types", "yodel-lint", "yodel-replay", "yodel-test", "yodel-check"]);
    expect(all.find((h) => h.name === "yodel-lint")?.command).toEqual(["yodel", "lint", "--format", "forge"]);
  });

  it("leave squawk and sqlfluff off unless ci.tools names them", () => {
    expect(checkPresets(input()).some((h) => h.name === "squawk" || h.name === "sqlfluff")).toBe(false);
    const tools = checkPresets(input({ tools: ["squawk", "sqlfluff"] }));
    expect(tools.find((h) => h.name === "squawk")?.command).toEqual(["sh", "-c", "squawk migrations/*/migration.sql"]);
    expect(tools.find((h) => h.name === "sqlfluff")?.command).toEqual(["sqlfluff", "lint", "migrations", "--dialect", "postgres"]);
  });

  it("refuse squawk on a ClickHouse project", () => {
    expect(() => checkPresets(input({ dialect: "clickhouse", tools: ["squawk"] }))).toThrow(/Postgres migrations only/);
    expect(checkPresets(input({ dialect: "clickhouse", tools: ["sqlfluff"] })).at(-1)?.command).toContain("clickhouse");
  });

  it("take ci.tools from yodel.config.ts, and refuse an unknown tool", () => {
    expect(checkYodelConfig({ ci: { tools: ["squawk"] } }, "yodel.config.ts").ci?.tools).toEqual(["squawk"]);
    expect(() => checkYodelConfig({ ci: { tools: ["pgformatter"] } }, "yodel.config.ts")).toThrow(/ci.tools/);
  });

  it("print in the format of the forge the hook runs on", () => {
    expect(forgeFormat({ GITLAB_CI: "true" })).toBe("gitlab");
    expect(forgeFormat({ GITHUB_ACTIONS: "true" })).toBe("github");
    expect(forgeFormat({})).toBe("text");
    const envs: Environments = { dialect: "postgres", names: ["dev"], replay: true, waves: [] };
    expect(checkHooksOf(envs).find((h) => h.name === "yodel-lint")?.command).toEqual(["yodel", "lint", "--format", "forge", "--output", CODE_QUALITY_FILE]);
  });
});

describe("the lint job on the check moment (#294)", () => {
  const envs: Environments = { dialect: "postgres", names: ["dev"], replay: true, typedColumns: true, waves: [{ env: "dev", gate: "always" }], checkHooks: true };
  type ActionsDoc = { jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }> };
  type GitLabDoc = Record<string, { script?: string[]; artifacts?: unknown }>;

  it("runs the hooks read at the pull request's base and none of the checks itself, so a pull request cannot remove one", () => {
    for (const forge of ["github", "forgejo"] as const) {
      for (const replay of [true, false]) {
        const runs = (parseYAMLDocument(actionsReview(forge, { ...envs, replay }).content) as ActionsDoc).jobs.lint?.steps.map((s) => s.run ?? "") ?? [];
        expect(runs.at(-1), `${forge} replay=${String(replay)}`).toBe("yodel chant ci check --base ${{ github.event.pull_request.base.sha }}");
        expect(runs.some((r) => /^yodel (lint|ci --check|test|check)\b|^chant sql types/.test(r))).toBe(false);
      }
    }
    for (const replay of [true, false]) {
      const lint = (parseYAMLDocument(gitlabPipeline({ ...envs, replay }).content) as GitLabDoc).lint;
      expect(lint?.script?.at(-1)).toBe(checkHooksLine("gitlab"));
      expect(lint?.script?.some((r) => /^yodel lint/.test(r))).toBe(false);
      expect(lint?.artifacts).toEqual({ when: "always", reports: { codequality: CODE_QUALITY_FILE } });
    }
  });

  it("runs the checks itself without the check moment, as before", () => {
    const without: Environments = { dialect: envs.dialect, names: envs.names, replay: envs.replay, waves: envs.waves, typedColumns: true };
    const runs = (parseYAMLDocument(actionsReview("github", without).content) as ActionsDoc).jobs.lint?.steps.map((s) => s.run ?? "") ?? [];
    expect(runs).toContain("yodel ci --check");
    expect(runs.some((r) => r.startsWith("yodel chant ci check"))).toBe(false);
  });
});

describe("the presets in the workspace declaration (#294)", () => {
  /** chant's writeCiHook in miniature: replace a hook of the same name, else add it. */
  const fake: ChantCheckHooks = {
    writeCiHook(root, moment, hook) {
      const file = join(root, "chant.workspace.json");
      const doc = JSON.parse(readFileSync(file, "utf8")) as { ci?: { hooks?: Record<string, CheckHook[]> } };
      const list = doc.ci?.hooks?.[moment] ?? [];
      const at = list.findIndex((h) => h.name === hook.name);
      const next = at < 0 ? [...list, hook] : list.map((h, i) => (i === at ? hook : h));
      doc.ci = { ...doc.ci, hooks: { ...doc.ci?.hooks, [moment]: next } };
      writeFileSync(file, JSON.stringify(doc, null, 2));
      return { file, replaced: at >= 0 };
    },
    runCheckHooks: () => ({ status: "none" }),
  };

  it("are written on a copy, keeping the project's own hooks, and the project's file is untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "yodel-294-"));
    const own = { version: 1, members: [], ci: { hooks: { check: [{ name: "pre-commit", command: ["pre-commit", "run", "--all-files"] }] } } };
    writeFileSync(join(dir, "chant.workspace.json"), JSON.stringify(own, null, 2));
    const out = JSON.parse(declarationWithHooks(fake, dir, "chant.workspace.json", checkPresets(input({ tools: ["sqlfluff"] })))) as typeof own;
    expect(out.ci.hooks.check.map((h) => h.name)).toEqual(["pre-commit", "yodel-ci-check", "yodel-lint", "sqlfluff"]);
    expect(JSON.parse(readFileSync(join(dir, "chant.workspace.json"), "utf8"))).toEqual(own);
  });

  it("are accepted by chant's own writer when the installed chant has the check moment", async () => {
    const chant = await chantCheckHooks();
    if (!chant) return;
    const dir = mkdtempSync(join(tmpdir(), "yodel-294-"));
    writeFileSync(join(dir, "chant.workspace.json"), `${JSON.stringify({ version: 1, members: [] }, null, 2)}\n`);
    const out = JSON.parse(declarationWithHooks(chant, dir, "chant.workspace.json", checkPresets(input({ replay: true })))) as { ci: { hooks: { check: CheckHook[] } } };
    expect(out.ci.hooks.check.map((h) => h.name)).toEqual(["yodel-ci-check", "yodel-lint", "yodel-replay"]);
  });
});
