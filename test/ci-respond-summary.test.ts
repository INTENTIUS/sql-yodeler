/**
 * `ci.respond.wave-refused: "summary"` and `ci.agent["wave-refused"]`: yodel
 * maps its config onto chant's refused-wave summary and builds no summary
 * logic of its own. The refused wave is the one test/ci-respond.test.ts uses,
 * run through chant's respond step with a fake model command and ledger.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertProductWords, respondOpWave, waveSummaryEnv, type WaveSummaryDeps } from "@intentius/chant/ci-product";
import { YODEL_WORDS } from "../src/ci-words.js";
import { wavesSpec } from "../src/ci/render.js";
import { checkYodelConfig } from "../src/config/load.js";
import { copyTemplate, repoRoot, yodel } from "./helpers/run.js";
import { offline } from "./helpers/new-suite.js";

offline();

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function template(ci: string): string {
  const dir = mkdtempSync(join(tmpdir(), "yodel-summary-"));
  temps.push(dir);
  copyTemplate("clickhouse", dir);
  symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"));
  const config = join(dir, "yodel.config.ts");
  writeFileSync(config, readFileSync(config, "utf8").replace(/^ {2}ci: .*$/m, `  ci: ${ci},`));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

const read = (dir: string, f: string) => readFileSync(join(dir, f), "utf8");
const specOf = (dir: string) => JSON.parse(read(dir, "yodel-waves.json")) as { respond?: Record<string, string>; waveSummary?: Record<string, unknown> };

function fakeForge(pr: number | null = null) {
  const comments: Array<{ pr: number; marker: string; body: string }> = [];
  const forge = {
    upsertComment: (n: number, marker: string, body: string) => {
      comments.push({ pr: n, marker, body });
      return Promise.resolve({ action: "created" as const, url: `https://forge.test/pull/${String(n)}#c1` });
    },
    trackIssue: () => Promise.resolve({ action: "created" as const, url: "https://forge.test/issues/9" }),
    pullRequestFor: () => Promise.resolve(pr),
  };
  return { forge: forge as never, comments };
}

const refused = (op: string) =>
  ({
    result: {
      exitCode: 4,
      applied: [],
      failed: [],
      moved: ["prod/acme"],
      hooks: [],
      plans: { "prod/acme": { planDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbb" } },
      decision: { digest: "sha256:aaaa", op, members: [{ member: "prod/acme", planDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaa" }] },
    },
  }) as never;

/** A model command that answers with a fixed summary, and a ledger that records. */
function model() {
  const calls: string[] = [];
  const records: unknown[] = [];
  const stdout = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "The prod/acme plan moved after the approval.", total_cost_usd: 0.01 });
  const deps: WaveSummaryDeps = {
    env: { ANTHROPIC_API_KEY: "sk-test", PATH: "/bin" },
    run: (command) => {
      calls.push(command);
      return Promise.resolve({ stdout, exitCode: 0 });
    },
    readRuns: () => Promise.resolve([]),
    record: (input) => {
      records.push(input);
      return Promise.resolve();
    },
    now: () => new Date("2026-11-20T12:00:00Z"),
    workDir: () => mkdtempSync(join(tmpdir(), "yodel-summary-work-")),
    log: () => {},
  };
  return { deps, calls, records };
}

const words = assertProductWords(YODEL_WORDS);
const WAVES = [{ env: "dev", gate: "never" as const }, { env: "prod", gate: "always" as const }];
const SETTINGS = { command: "claude -p", key_secret: "MODEL_KEY", timeout: 5, max_runs: 3, max_cost_usd: 2.5 };

describe("ci.respond.wave-refused: summary in the waves spec", () => {
  it("maps ci.agent onto chant's waveSummary, only with summary", () => {
    expect(wavesSpec(WAVES, undefined, undefined, "summary", SETTINGS).waveSummary).toEqual({ command: "claude -p", keyEnv: "MODEL_KEY", timeout: 5, maxRuns: 3, maxCostUsd: 2.5 });
    expect(wavesSpec(WAVES, undefined, undefined, "summary").respond).toEqual({ "wave-refused": "summary" });
    expect(wavesSpec(WAVES, undefined, undefined, "summary")).not.toHaveProperty("waveSummary");
    expect(wavesSpec(WAVES, undefined, undefined, "diff", SETTINGS)).not.toHaveProperty("waveSummary");
    expect(wavesSpec(WAVES)).not.toHaveProperty("waveSummary");
  });

  it("checks the settings", () => {
    const ok = { respond: { "wave-refused": "summary" }, agent: { "wave-refused": SETTINGS } };
    expect(() => checkYodelConfig({ ci: ok }, "yodel.config.ts")).not.toThrow();
    expect(() => checkYodelConfig({ ci: { respond: { "wave-refused": "diff" }, agent: { "wave-refused": SETTINGS } } }, "yodel.config.ts")).toThrow(/ci\.agent\.wave-refused: read with/);
    expect(() => checkYodelConfig({ ci: { agent: { "wave-refused": SETTINGS } } }, "yodel.config.ts")).toThrow(/ci\.agent\.wave-refused: read with/);
    expect(() => checkYodelConfig({ ci: { ...ok, agent: { "wave-refused": { max_runs: 0 } } } }, "yodel.config.ts")).toThrow(/max_runs: a number above 0/);
    expect(() => checkYodelConfig({ ci: { ...ok, agent: { "wave-refused": { model: "x" } } } }, "yodel.config.ts")).toThrow(/ci\.agent\.wave-refused: expected/);
    expect(() => checkYodelConfig({ ci: { ...ok, agent: { other: {} } } }, "yodel.config.ts")).toThrow(/ci\.agent: expected/);
  });
});

describe("yodel ci renders the summary's settings", () => {
  it("with summary writes the spec and the wave jobs' variables on every forge", async () => {
    const dir = template(`{ forges: ["github", "gitlab", "forgejo"], respond: { "wave-refused": "summary" }, agent: { "wave-refused": ${JSON.stringify(SETTINGS)} } }`);
    const wrote = await yodel(["ci", "--dir", dir]);
    expect(wrote.code, wrote.err).toBe(0);
    expect(specOf(dir).respond).toEqual({ "wave-refused": "summary" });
    expect(specOf(dir).waveSummary).toEqual({ command: "claude -p", keyEnv: "MODEL_KEY", timeout: 5, maxRuns: 3, maxCostUsd: 2.5 });
    const github = read(dir, ".github/workflows/yodel-apply.yml");
    expect(github).toContain("CHANT_WAVE_SUMMARY_MAX_RUNS");
    expect(github).toContain("secrets.MODEL_KEY");
    expect(github).toContain("pull-requests: write");
    expect(read(dir, ".forgejo/workflows/yodel-apply.yml")).toContain("secrets.MODEL_KEY");
    const gitlab = read(dir, ".gitlab/yodel-apply.gitlab-ci.yml");
    expect(gitlab).toContain("CHANT_WAVE_SUMMARY_MAX_RUNS");
    expect(gitlab).not.toContain("secrets.MODEL_KEY");
    const check = await yodel(["ci", "--check", "--dir", dir]);
    expect(check.code, check.err + check.out).toBe(0);
  });

  it("is off unless set: unset and diff render no summary variable and no model key", async () => {
    for (const ci of ['{ forges: ["github", "gitlab", "forgejo"] }', '{ forges: ["github", "gitlab", "forgejo"], respond: { "wave-refused": "diff" } }']) {
      const dir = template(ci);
      const wrote = await yodel(["ci", "--dir", dir]);
      expect(wrote.code, wrote.err).toBe(0);
      expect(specOf(dir)).not.toHaveProperty("waveSummary");
      for (const f of [".github/workflows/yodel-apply.yml", ".forgejo/workflows/yodel-apply.yml", ".gitlab/yodel-apply.gitlab-ci.yml"]) {
        expect(read(dir, f)).not.toMatch(/CHANT_WAVE_SUMMARY|ANTHROPIC_API_KEY/);
      }
    }
  });
});

describe("a refused wave, through chant's respond step", () => {
  it("posts the model's summary above the diff on the pull request, with summary", async () => {
    const { forge, comments } = fakeForge();
    const m = model();
    const spec = wavesSpec(WAVES, undefined, undefined, "summary", {}) as never;
    await respondOpWave(spec, 2, refused("pr-12"), { forge, head: "abc", env: {}, words, summary: m.deps });
    expect(m.calls).toHaveLength(1);
    expect(m.records).toHaveLength(1);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.pr).toBe(12);
    const body = comments[0]?.body ?? "";
    expect(body).toContain("The prod/acme plan moved after the approval.");
    expect(body).toContain("aaaaaaaaaaaa");
    expect(body).toContain("bbbbbbbbbbbb");
    expect(body.indexOf("The prod/acme plan moved")).toBeLessThan(body.indexOf("aaaaaaaaaaaa"));
  });

  it("posts the diff alone and runs no model with diff, off, or the key unset", async () => {
    for (const mode of ["diff", undefined] as const) {
      const { forge, comments } = fakeForge();
      const m = model();
      const spec = wavesSpec(WAVES, undefined, undefined, mode) as never;
      await respondOpWave(spec, 2, refused("pr-12"), { forge, head: "abc", env: {}, words, summary: m.deps });
      expect(m.calls).toHaveLength(0);
      expect(m.records).toHaveLength(0);
      expect(comments[0]?.body).toContain("bbbbbbbbbbbb");
      expect(comments[0]?.body).not.toContain("The prod/acme plan moved");
    }
    const { forge, comments } = fakeForge();
    const m = model();
    await respondOpWave(wavesSpec(WAVES, undefined, undefined, "off"), 2, refused("pr-12"), { forge, head: "abc", env: {}, words, summary: m.deps });
    expect(m.calls).toHaveLength(0);
    expect(comments).toHaveLength(0);
  });

  it("posts the diff alone, and says so, when the daily limit is reached", async () => {
    const { forge, comments } = fakeForge();
    const m = model();
    m.deps.readRuns = () => Promise.resolve([{ started: "2026-11-20T08:00:00Z", outcomes: {} } as never]);
    const rendered = wavesSpec(WAVES, undefined, undefined, "summary", { max_runs: 1 });
    // The job's variables are what chant's generator writes from the spec's waveSummary.
    m.deps.env = { ...m.deps.env, ...waveSummaryEnv(rendered.waveSummary ?? {}) };
    await respondOpWave(rendered, 2, refused("pr-12"), { forge, head: "abc", env: {}, words, summary: m.deps });
    expect(m.calls).toHaveLength(0);
    expect(comments[0]?.body).toMatch(/summary was skipped/i);
    expect(comments[0]?.body).toContain("bbbbbbbbbbbb");
  });
});
