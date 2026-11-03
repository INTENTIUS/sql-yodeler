/**
 * The review agent (#304): yodel.config.ts `review` turns on chant's
 * reviewAgent for `yodel ci`. The review job reads the migrations the pull
 * request adds from the files (`yodel plan --pull-request`), holds no forge
 * write token and no database credential, and a note job posts its one
 * note; on GitLab from a pipeline of the default branch (chant#4544). The
 * model reads yodel's SQL rules from .chant/yodel-review.md at the base.
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseYAMLDocument } from "@intentius/chant/yaml";
import { checkYodelConfig } from "../src/config/load.js";
import { REVIEW_CHANGE_SET, REVIEW_INSTRUCTIONS, REVIEW_OP_FILE, reviewInstructions, reviewOf, reviewOpFile } from "../src/ci/review.js";
import { copyTemplate, repoRoot, yodel } from "./helpers/run.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

/** A copy of the ClickHouse template with `review` set, resolving chant and the lexicons from this checkout. */
function project(review: string | undefined, dialect: "clickhouse" | "postgres" = "clickhouse"): string {
  const dir = mkdtempSync(join(tmpdir(), "yodel-review-"));
  temps.push(dir);
  copyTemplate(dialect, dir);
  symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"));
  const config = join(dir, "yodel.config.ts");
  const text = readFileSync(config, "utf8");
  const next = review === undefined ? text : text.replace(/^( {2}ci: .*,)$/m, `$1\n  review: ${review},`);
  if (review !== undefined && next === text) throw new Error("the template's yodel.config.ts has no ci line to put review after");
  writeFileSync(config, next);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

const FAKE = 'cat >/dev/null; printf "Adds a column.\\n\\nrisk: low\\n"';

type ActionsDoc = {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, { env?: Record<string, string>; permissions?: Record<string, string>; needs?: string; steps: Array<{ name?: string; run?: string; env?: Record<string, string> }> }>;
};
type GitLabDoc = Record<string, { script?: string[]; rules?: Array<{ if?: string }>; variables?: Record<string, string>; artifacts?: { paths?: string[] } }>;

describe("yodel.config.ts review (#304)", () => {
  it("is true, or { command, keyEnv, timeout, rules }, and refuses anything else", () => {
    expect(checkYodelConfig({ review: true }, "yodel.config.ts").review).toBe(true);
    expect(checkYodelConfig({ review: { command: "./bin/review", keyEnv: "OPENAI_API_KEY", timeout: 5, rules: ["No table without a comment."] } }, "yodel.config.ts").review).toMatchObject({ keyEnv: "OPENAI_API_KEY" });
    expect(() => checkYodelConfig({ review: "yes" }, "yodel.config.ts")).toThrow(/review: true, or/);
    expect(() => checkYodelConfig({ review: { key_env: "X" } }, "yodel.config.ts")).toThrow(/review\.key_env: unknown setting/);
    expect(() => checkYodelConfig({ review: { keyEnv: "sk-ant-123" } }, "yodel.config.ts")).toThrow(/review\.keyEnv: the name of the variable/);
    expect(() => checkYodelConfig({ review: { timeout: 0 } }, "yodel.config.ts")).toThrow(/review\.timeout/);
    expect(() => checkYodelConfig({ review: { command: " " } }, "yodel.config.ts")).toThrow(/review\.command/);
    expect(() => checkYodelConfig({ review: { rules: ["", "x"] } }, "yodel.config.ts")).toThrow(/review\.rules/);
  });

  it("takes chant's defaults where it sets none, and is off when absent or false", () => {
    expect(reviewOf({})).toBeUndefined();
    expect(reviewOf({ review: false })).toBeUndefined();
    expect(reviewOf({ review: true })).toEqual({ keyEnv: "ANTHROPIC_API_KEY", rules: [] });
    const op = reviewOpFile({ keyEnv: "ANTHROPIC_API_KEY", rules: [] });
    expect(op).toContain('mode: "handoff"');
    expect(op).toContain(`changeSetFile: "${REVIEW_CHANGE_SET}"`);
    expect(op).toContain(`instructions: "${REVIEW_INSTRUCTIONS}"`);
    expect(op).not.toContain("command:");
    expect(op).toContain(`shell("yodel plan --pull-request --change-set ${REVIEW_CHANGE_SET}")`);
  });

  it("gives the model SQL rules for the dialect: destructive drops, the statements that take a lock, a rewrite of a large table, then the team's", () => {
    const pg = reviewInstructions("postgres", { keyEnv: "K", rules: ["Every new table in shop has an owner comment."] });
    expect(pg).toMatch(/`drop` class, or a step with `destructive: true`/);
    expect(pg).toContain("ACCESS EXCLUSIVE");
    expect(pg).toContain("SHARE UPDATE EXCLUSIVE");
    expect(pg).toMatch(/how large the table is/);
    expect(pg).toMatch(/## The team's rules\n\n- Every new table in shop has an owner comment\.\n$/);
    const ch = reviewInstructions("clickhouse", { keyEnv: "K", rules: [] });
    expect(ch).toContain("mutation");
    expect(ch).toContain("ClickHouseRebuildOp");
    expect(ch).not.toContain("ACCESS EXCLUSIVE");
    expect(ch).not.toContain("The team's rules");
  });
});

describe("yodel ci with review (#304)", () => {
  it("renders nothing of the review without the key", async () => {
    const dir = project(undefined);
    expect((await yodel(["ci", "--dir", dir])).code).toBe(0);
    expect(existsSync(join(dir, REVIEW_OP_FILE))).toBe(false);
    expect(existsSync(join(dir, ".github/workflows/yodel-review.yml"))).toBe(false);
    expect(readFileSync(join(dir, ".gitlab-ci.yml"), "utf8")).not.toContain("yodel-review");
  });

  it("renders the Op, the instructions and, on GitHub and Forgejo, a review job with no write token or database secret and a note job that posts", async () => {
    const dir = project(`{ command: ${JSON.stringify(FAKE)}, timeout: 3 }`);
    const wrote = await yodel(["ci", "--dir", dir]);
    expect(wrote.code, wrote.err).toBe(0);
    expect(readFileSync(join(dir, REVIEW_OP_FILE), "utf8")).toContain(`command: ${JSON.stringify(FAKE)}`);
    expect(readFileSync(join(dir, REVIEW_INSTRUCTIONS), "utf8")).toContain("(ClickHouse)");
    // The generator's own directory is gone.
    expect(readdirSync(dir).filter((f) => f.startsWith(".yodel-review-"))).toEqual([]);

    for (const forge of ["github", "forgejo"] as const) {
      const text = readFileSync(join(dir, `.${forge}/workflows/yodel-review.yml`), "utf8");
      expect(text.startsWith("# Rendered by yodel ci")).toBe(true);
      const doc = parseYAMLDocument(text) as ActionsDoc;
      expect(Object.keys(doc.on)).toEqual(["pull_request"]);
      expect(Object.keys(doc.jobs)).toEqual(["yodel-review", "yodel-review-note"]);
      const job = doc.jobs["yodel-review"] ?? { steps: [] };
      // The model's key is the one secret the review job maps: no reader, no writer, no forge token.
      expect(job.env).toEqual({ ANTHROPIC_API_KEY: "${{ secrets.ANTHROPIC_API_KEY }}" });
      expect(text.match(/secrets\.\w+/g)).toEqual(["secrets.ANTHROPIC_API_KEY"]);
      expect(text).not.toMatch(/CLICKHOUSE_(URL|READER|WRITER)/);
      expect(job.permissions).toBeUndefined();
      expect(job.steps.at(-1)?.run).toMatch(/\nyodel chant run yodel-review\n?$/);
      const note = doc.jobs["yodel-review-note"] ?? { steps: [] };
      expect(note.needs).toBe("yodel-review");
      expect(note.steps.some((s) => s.run?.includes("postReviewNote"))).toBe(true);
      if (forge === "github") {
        expect(doc.permissions).toEqual({ "contents": "read" });
        expect(note.permissions).toEqual({ "pull-requests": "write" });
      }
    }
    expect((await yodel(["ci", "--check", "--dir", dir])).code).toBe(0);
  });

  it("on GitLab, unsets every environment's database variables in the review job and posts from a pipeline of the default branch", async () => {
    const dir = project("true");
    const wrote = await yodel(["ci", "--dir", dir]);
    expect(wrote.code, wrote.err).toBe(0);
    const main = readFileSync(join(dir, ".gitlab-ci.yml"), "utf8");
    expect((parseYAMLDocument(main) as { include: Array<{ local: string }> }).include.map((i) => i.local)).toContain(".gitlab/yodel-review.gitlab-ci.yml");
    expect(main).toContain("CHANT_REVIEW_NOTES=1");
    const doc = parseYAMLDocument(readFileSync(join(dir, ".gitlab/yodel-review.gitlab-ci.yml"), "utf8")) as GitLabDoc;
    const review = doc["yodel-review"] ?? {};
    expect(review.rules?.[0]?.if).toBe('$CI_PIPELINE_SOURCE == "merge_request_event"');
    const script = review.script ?? [];
    const unset = script.find((l) => l.startsWith("unset DEV_")) ?? "";
    for (const v of ["DEV_CLICKHOUSE_URL", "DEV_CLICKHOUSE_READER_USER", "DEV_CLICKHOUSE_READER_PASSWORD", "DEV_CLICKHOUSE_WRITER_USER", "DEV_CLICKHOUSE_WRITER_PASSWORD", "PROD_CLICKHOUSE_READER_PASSWORD"]) expect(unset.split(" ")).toContain(v);
    expect(script.indexOf(unset)).toBeGreaterThanOrEqual(0);
    expect(script.indexOf(unset)).toBeLessThan(script.indexOf("yodel chant run yodel-review"));
    const note = doc["yodel-review-note"] ?? {};
    expect(note.rules?.[0]?.if).toContain('$CHANT_REVIEW_NOTES == "1"');
    expect(note.variables).toEqual({ GIT_STRATEGY: "none" });
  });
});

describe("yodel plan --pull-request (#304)", () => {
  const git = (dir: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: dir, stdio: "ignore" });

  it("lists the migrations the base does not have and writes them as one change set, with no server", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yodel-pr-added-"));
    temps.push(dir);
    cpSync(join(repoRoot, "examples", "postgres"), dir, { recursive: true });
    symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"));
    writeFileSync(join(dir, ".gitignore"), "node_modules\n.chant/\n");
    const migrations = readdirSync(join(dir, "migrations")).sort();
    const newest = migrations.at(-1) ?? "";
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "rm", "-rq", "--cached", `migrations/${newest}`);
    git(dir, "commit", "-qm", "base");
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "the pull request");

    const saved = process.env.YODEL_BASE;
    process.env.YODEL_BASE = base;
    try {
      const ran = await yodel(["plan", "--pull-request", "--change-set", join(dir, REVIEW_CHANGE_SET), "--dir", dir]);
      expect(ran.code, ran.err).toBe(0);
      expect(ran.out).toContain(`The pull request adds 1 migration:\n  ${newest}\n`);
      const doc = JSON.parse(readFileSync(join(dir, REVIEW_CHANGE_SET), "utf8")) as { members: Array<{ member: string; status: string }>; entries: Array<{ member: string; address: string }> };
      expect(doc.members).toEqual([expect.objectContaining({ member: "migrations", status: "planned" })]);
      expect(doc.entries.length).toBeGreaterThan(0);
      expect(doc.entries.every((e) => e.member === "migrations")).toBe(true);

      // The base itself adds nothing.
      process.env.YODEL_BASE = "HEAD";
      const none = await yodel(["plan", "--pull-request", "--dir", dir]);
      expect(none.out).toContain("The pull request adds no migration.");
    } finally {
      if (saved === undefined) delete process.env.YODEL_BASE;
      else process.env.YODEL_BASE = saved;
    }
  });

  it("takes no environment and none of the server's flags", async () => {
    expect((await yodel(["plan", "dev", "--pull-request"])).err).toContain("--pull-request plans the migrations the pull request adds, for no environment");
    expect((await yodel(["plan", "--pull-request", "--comment"])).err).toContain("--pull-request takes only --change-set and --dir");
    expect((await yodel(["plan", "dev", "--change-set", "x.json"])).err).toContain("--change-set goes with --pull-request");
  });
});
