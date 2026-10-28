/**
 * `yodel ci` through chant's product pipeline (#289): one pipeline per forge
 * for each template, rendered before (yodel's own generator, as a chant
 * without @intentius/chant/ci-product renders) and after (chant's
 * productPipelineJobs with yodel's words), compared after the command each
 * job runs chant as: the same files, jobs, statuses, ops, gates, secrets per
 * job and permissions, so docs/forges.md's table holds unchanged.
 *
 * The cases that need chant's product entry skip on a chant without it.
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseYAMLDocument } from "@intentius/chant/yaml";
import { APPLY_LOCK, chantLocksWaves, hasSqlCapability, render, WAVES_SPEC, type RenderedFile } from "../src/ci/render.js";
import { YODEL_CHANT_BIN } from "../src/ci-words.js";
import { PRODUCT } from "./helpers/chant-bin.js";
import { repoRoot } from "./helpers/run.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

/** A copy of a template with `ci` and `waves` replaced, resolving chant and the lexicons from this checkout. */
function project(dialect: "clickhouse" | "postgres", ci: string, waves?: string): string {
  const dir = mkdtempSync(join(tmpdir(), `yodel-ci-product-${dialect}-`));
  temps.push(dir);
  cpSync(join(repoRoot, "templates", dialect), dir, { recursive: true });
  symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"));
  const config = join(dir, "yodel.config.ts");
  let text = readFileSync(config, "utf8").replace(/^ {2}ci: .*$/m, `  ci: ${ci},`);
  if (waves !== undefined) text = text.replace(/^ {2}waves: \[[\s\S]*?^ {2}\],$/m, `  waves: ${waves},`);
  writeFileSync(config, text);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

/** Whether the installed chant plans and applies each run through the sql lexicon's capability (#291), and stands a wave down for a newer commit (#293). */
const CAPABILITY = await hasSqlCapability();
const STAND_DOWN = await chantLocksWaves();
/** Whether chant stands a wave down and holds its lease, in place of the wave jobs' YODEL_LOCK_WAIT and YODEL_STAND_DOWN (#293). */
const CHANT_STANDS_DOWN = CAPABILITY && STAND_DOWN;

/**
 * A file's document with every `yodel chant ` command read as `chant `, and
 * the spec's gate pattern dropped. The spec's plan and apply callbacks, or
 * the capability's step and stand-down in their place, are dropped too, and
 * with chant's stand-down so is the wave jobs' own lock and stand-down
 * (APPLY_LOCK, #293): the second case checks which one the installed chant
 * gives.
 */
function normalized(file: RenderedFile): unknown {
  if (file.path === WAVES_SPEC) {
    const spec = JSON.parse(file.content) as Record<string, unknown>;
    expect(spec.gateName === undefined || spec.gateName === "yodel-apply-wave-{k}", file.path).toBe(true);
    const dropped = new Set(["gateName", "plan", "apply", "step", "standDown"]);
    return Object.fromEntries(Object.entries(spec).filter(([k]) => !dropped.has(k)));
  }
  const doc = parseYAMLDocument(file.content);
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return v.replace(new RegExp(`(^|\\n)${YODEL_CHANT_BIN} `, "g"), "$1chant ");
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([k]) => !(CHANT_STANDS_DOWN && k in APPLY_LOCK)).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(doc);
}

const CASES = [
  { name: "clickhouse, with ci.resume", dir: () => project("clickhouse", '{ forges: ["github", "gitlab", "forgejo"], resume: { schedule: "*/10 * * * *" } }') },
  {
    name: "postgres, with a pr-review wave and a sealed one",
    dir: () => project("postgres", '{ forges: ["github", "gitlab", "forgejo"] }', '[{ env: "dev", gate: "always", approval: "pr-review" }, { env: "prod", gate: "on-destructive", approval: "sealed" }]'),
  },
];

describe.skipIf(!PRODUCT)("yodel ci through chant's product pipeline (#289)", () => {
  it.each(CASES)("$name: the same pipelines as yodel's own generator, after the command each job runs chant as", async ({ dir: make }) => {
    const dir = make();
    const before = await render(dir, { product: false });
    const after = await render(dir);
    expect(after.map((f) => f.path)).toEqual(before.map((f) => f.path));
    for (const [i, file] of after.entries()) {
      const was = before[i];
      if (!was) throw new Error(`no file ${file.path} before`);
      expect(normalized(file), file.path).toEqual(normalized(was));
    }
  });

  it.each(CASES)("$name: every chant line a job runs is yodel chant, and the waves keep yodel-apply's op and gates", async ({ dir: make }) => {
    const dir = make();
    const after = await render(dir);
    for (const file of after.filter((f) => f.path !== WAVES_SPEC)) {
      // A step's run or a script line that starts with chant, outside the comments.
      const lines = file.content.split("\n").filter((l) => !/^\s*#/.test(l));
      expect(lines.filter((l) => /^\s*(?:- )?(?:run: )?chant [a-z]/.test(l)), file.path).toEqual(
        // The pull request pipeline's lint job keeps `chant sql types --check` until the check hook (#294).
        file.path.endsWith("yodel-pr.yml") || file.path === ".gitlab-ci.yml" ? lines.filter((l) => l.includes("chant sql types --check")) : [],
      );
    }
    const spec = JSON.parse(after.find((f) => f.path === WAVES_SPEC)?.content ?? "{}") as { name?: string; gateName?: string; plan?: string[]; apply?: string[]; step?: unknown; standDown?: boolean };
    expect(spec.name).toBe("yodel-apply");
    expect(spec.gateName).toBe("yodel-apply-wave-{k}");
    if (CAPABILITY) {
      // The sql lexicon's capability plans and applies each run, with no callback (#291).
      expect(spec.step).toEqual({ kind: "sql-migrate", environment: "{target}", spec: WAVES_SPEC });
      expect([spec.plan, spec.apply]).toEqual([undefined, undefined]);
      expect(spec.standDown).toBe(STAND_DOWN ? true : undefined);
    } else {
      expect(spec.plan).toContain("--wave-plan");
      expect(spec.apply).toContain("--wave-apply");
    }
    const apply = parseYAMLDocument(after.find((f) => f.path === ".github/workflows/yodel-apply.yml")?.content ?? "") as { jobs: Record<string, { steps: Array<{ run?: string }> }> };
    expect(apply.jobs["wave-2-prod"]?.steps.map((s) => s.run)).toContain(`${YODEL_CHANT_BIN} run wave --spec ${WAVES_SPEC} --wave 2`);
    const applyText = after.find((f) => f.path === ".github/workflows/yodel-apply.yml")?.content ?? "";
    for (const k of Object.keys(APPLY_LOCK)) expect(applyText.includes(k), k).toBe(!CHANT_STANDS_DOWN);
  });

  it("the pull request pipeline is yodel's own until chant can plan a SQL environment (chant#4569, #290)", async () => {
    const dir = CASES[0]?.dir() ?? "";
    const before = await render(dir, { product: false });
    const after = await render(dir);
    for (const path of [".github/workflows/yodel-pr.yml", ".forgejo/workflows/yodel-pr.yml", ".gitlab-ci.yml"]) {
      expect(after.find((f) => f.path === path)?.content, path).toBe(before.find((f) => f.path === path)?.content);
    }
  });
});

describe("yodel ci with a chant before its product pipeline (#289)", () => {
  it("renders with yodel's own generator when asked to, whatever chant is installed", async () => {
    const dir = CASES[0]?.dir() ?? "";
    const files = await render(dir, { product: false });
    const apply = files.find((f) => f.path === ".github/workflows/yodel-apply.yml")?.content ?? "";
    expect(apply).toContain(`run: chant run wave --spec ${WAVES_SPEC} --wave 1`);
    expect(apply).not.toContain(`${YODEL_CHANT_BIN} run`);
    expect(JSON.parse(files.find((f) => f.path === WAVES_SPEC)?.content ?? "{}")).not.toHaveProperty("gateName");
  });
});
