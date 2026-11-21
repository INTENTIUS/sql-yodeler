/**
 * `ci.respond.wave-refused`: a wave that applied nothing because its plan
 * moved posts chant's diff of the migration plan when the project
 * sets `diff`. The refused wave here is a share job that read different plan
 * digests than the decision approved, run through chant's own respond step.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertProductWords, respondOpWave } from "@intentius/chant/ci-product";
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

/** The ClickHouse template in a directory of its own with `ci` set to `ci`. */
function template(ci: string): string {
  const dir = mkdtempSync(join(tmpdir(), "yodel-respond-"));
  temps.push(dir);
  copyTemplate("clickhouse", dir);
  symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"));
  const config = join(dir, "yodel.config.ts");
  writeFileSync(config, readFileSync(config, "utf8").replace(/^ {2}ci: .*$/m, `  ci: ${ci},`));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

const read = (dir: string, f: string) => readFileSync(join(dir, f), "utf8");
const specOf = (dir: string) => JSON.parse(read(dir, "yodel-waves.json")) as { respond?: Record<string, string> };

/** A forge that records what a response posts. */
function fakeForge(pr: number | null = null) {
  const comments: Array<{ pr: number; marker: string; body: string }> = [];
  const issues: Array<{ marker: string; finding: unknown }> = [];
  const forge = {
    upsertComment: (n: number, marker: string, body: string) => {
      comments.push({ pr: n, marker, body });
      return Promise.resolve({ action: "created" as const, url: `https://forge.test/pull/${String(n)}#c1` });
    },
    trackIssue: (marker: string, finding: unknown) => {
      issues.push({ marker, finding });
      return Promise.resolve({ action: "created" as const, url: "https://forge.test/issues/9" });
    },
    pullRequestFor: () => Promise.resolve(pr),
  };
  return { forge: forge as never, comments, issues };
}

/** Wave 2 (prod) of yodel-apply, refused: the share job read another plan for prod/acme than the decision approved. */
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

/** yodel's words, completed as chant completes them for a product. */
const words = assertProductWords(YODEL_WORDS);

const WAVES = [{ env: "dev", gate: "never" as const }, { env: "prod", gate: "always" as const }];

describe("ci.respond.wave-refused in the waves spec", () => {
  it("says nothing unless the project sets the key", () => {
    expect(wavesSpec(WAVES)).not.toHaveProperty("respond");
    expect(wavesSpec(WAVES, undefined, undefined, "off").respond).toEqual({ "wave-refused": "off" });
    expect(wavesSpec(WAVES, undefined, undefined, "diff").respond).toEqual({ "wave-refused": "diff" });
  });

  it("checks the word", () => {
    expect(() => checkYodelConfig({ ci: { respond: { "wave-refused": "diff" } } }, "yodel.config.ts")).not.toThrow();
    expect(() => checkYodelConfig({ ci: { respond: { "wave-refused": "tldr" } } }, "yodel.config.ts")).toThrow(/ci\.respond\.wave-refused: one of off, diff, summary/);
    expect(() => checkYodelConfig({ ci: { respond: { wave_refused: "diff" } } }, "yodel.config.ts")).toThrow(/ci\.respond: expected/);
  });
});

describe("yodel ci renders the refused-wave diff", () => {
  it("by default writes nothing about it, and gives the wave jobs no extra token permissions", async () => {
    const dir = template('{ forges: ["github", "gitlab", "forgejo"] }');
    const wrote = await yodel(["ci", "--dir", dir]);
    expect(wrote.code, wrote.err).toBe(0);
    expect(specOf(dir)).not.toHaveProperty("respond");
    expect(read(dir, ".github/workflows/yodel-apply.yml")).not.toMatch(/pull-requests: write/);
  });

  it("with diff writes it into the spec and hands GitHub and Forgejo wave jobs a token that can comment", async () => {
    const dir = template('{ forges: ["github", "gitlab", "forgejo"], respond: { "wave-refused": "diff" } }');
    const wrote = await yodel(["ci", "--dir", dir]);
    expect(wrote.code, wrote.err).toBe(0);
    expect(specOf(dir).respond).toEqual({ "wave-refused": "diff" });
    const github = read(dir, ".github/workflows/yodel-apply.yml");
    expect(github).toContain("pull-requests: write");
    expect(github).toContain("issues: write");
    // Forgejo reads no permissions block; its wave jobs hold the token.
    expect(read(dir, ".forgejo/workflows/yodel-apply.yml")).toContain("GITHUB_TOKEN");
    // GitLab's jobs read CHANT_FORGE_TOKEN, a CI/CD variable.
    expect(read(dir, ".gitlab/yodel-apply.gitlab-ci.yml")).not.toContain("pull-requests");
    const check = await yodel(["ci", "--check", "--dir", dir]);
    expect(check.code, check.err + check.out).toBe(0);
  });
});

describe("a refused wave, through chant's respond step", () => {
  it("posts the diff on a tracking issue when the wave has no pull request", async () => {
    const { forge, comments, issues } = fakeForge();
    const spec = wavesSpec(WAVES, undefined, undefined, "diff") as never;
    const posts = await respondOpWave(spec, 2, refused("migrate-prod"), { forge, head: "abc", env: {}, words });
    expect(posts).toHaveLength(1);
    expect(issues).toHaveLength(1);
    expect(comments).toHaveLength(0);
    expect(JSON.stringify(issues[0]?.finding)).toMatch(/prod\/acme/);
  });

  it("posts on the pull request the decision names", async () => {
    const { forge, comments } = fakeForge();
    const spec = wavesSpec(WAVES, undefined, undefined, "diff") as never;
    await respondOpWave(spec, 2, refused("pr-12"), { forge, head: "abc", env: {}, words });
    expect(comments).toHaveLength(1);
    expect(comments[0]?.pr).toBe(12);
    expect(comments[0]?.body).toContain("prod/acme");
    expect(comments[0]?.body).toContain("aaaaaaaaaaaa");
    expect(comments[0]?.body).toContain("bbbbbbbbbbbb");
    expect(comments[0]?.marker).toContain("wave-refused");
  });

  it("posts nothing when the spec says off", async () => {
    const { forge, comments, issues } = fakeForge();
    const spec = wavesSpec(WAVES, undefined, undefined, "off") as never;
    const posts = await respondOpWave(spec, 2, refused("pr-12"), { forge, head: "abc", env: {}, words });
    expect(posts).toEqual([]);
    expect(comments).toHaveLength(0);
    expect(issues).toHaveLength(0);
  });
});
