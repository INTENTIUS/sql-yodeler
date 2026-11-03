/**
 * `yodel ci` through chant's product pipeline (#289), one pipeline per
 * forge for each template: every chant line a job runs is `yodel chant`,
 * the waves keep yodel-apply's op and gate names, and the sql lexicon's
 * capability plans and applies each run with chant's stand-down (#291,
 * #293). yodel's own generator, which these cases once compared against,
 * left in 0.12 (#303), with the wave jobs' own YODEL_LOCK_WAIT and
 * YODEL_STAND_DOWN.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseYAMLDocument } from "@intentius/chant/yaml";
import { render, WAVES_SPEC } from "../src/ci/render.js";
import { YODEL_CHANT_BIN } from "../src/ci-words.js";
import { copyTemplate, repoRoot } from "./helpers/run.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

/** A copy of a template with no workspace declaration, `ci` and `waves` replaced, resolving chant and the lexicons from this checkout. */
function project(dialect: "clickhouse" | "postgres", ci: string, waves?: string): string {
  const dir = mkdtempSync(join(tmpdir(), `yodel-ci-product-${dialect}-`));
  temps.push(dir);
  copyTemplate(dialect, dir);
  symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"));
  const config = join(dir, "yodel.config.ts");
  let text = readFileSync(config, "utf8").replace(/^ {2}ci: .*$/m, `  ci: ${ci},`);
  if (waves !== undefined) text = text.replace(/^ {2}waves: \[[\s\S]*?^ {2}\],$/m, `  waves: ${waves},`);
  writeFileSync(config, text);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

const CASES = [
  { name: "clickhouse, with ci.resume", dir: () => project("clickhouse", '{ forges: ["github", "gitlab", "forgejo"], resume: { schedule: "*/10 * * * *" } }') },
  {
    name: "postgres, with a pr-review wave and a sealed one",
    dir: () => project("postgres", '{ forges: ["github", "gitlab", "forgejo"] }', '[{ env: "dev", gate: "always", approval: "pr-review" }, { env: "prod", gate: "on-destructive", approval: "sealed" }]'),
  },
];

describe("yodel ci through chant's product pipeline (#289)", () => {
  it.each(CASES)("$name: every chant line a job runs is yodel chant, and the waves keep yodel-apply's op and gates", async ({ dir: make }) => {
    const dir = make();
    const after = await render(dir);
    for (const file of after.filter((f) => f.path !== WAVES_SPEC)) {
      // A step's run or a script line that starts with chant, outside the comments.
      const lines = file.content.split("\n").filter((l) => !/^\s*#/.test(l));
      expect(lines.filter((l) => /^\s*(?:- )?(?:run: )?chant [a-z]/.test(l)), file.path).toEqual(
        // A project with no workspace declaration keeps the lint job's own steps, `chant sql types --check` among them (#294).
        file.path.endsWith("yodel-pr.yml") || file.path === ".gitlab-ci.yml" ? lines.filter((l) => l.includes("chant sql types --check")) : [],
      );
      expect(file.content, file.path).not.toMatch(/YODEL_LOCK_WAIT|YODEL_STAND_DOWN/);
    }
    const spec = JSON.parse(after.find((f) => f.path === WAVES_SPEC)?.content ?? "{}") as Record<string, unknown>;
    expect(spec.name).toBe("yodel-apply");
    expect(spec.gateName).toBe("yodel-apply-wave-{k}");
    // The sql lexicon's capability plans and applies each run, with no callback (#291), and chant stands a superseded wave down (#293).
    expect(spec.step).toEqual({ kind: "sql-migrate", environment: "{target}", spec: WAVES_SPEC });
    expect(spec).not.toHaveProperty("plan");
    expect(spec).not.toHaveProperty("apply");
    expect(spec.standDown).toBe(true);
    const apply = parseYAMLDocument(after.find((f) => f.path === ".github/workflows/yodel-apply.yml")?.content ?? "") as { jobs: Record<string, { steps: Array<{ run?: string }> }> };
    expect(apply.jobs["wave-2-prod"]?.steps.map((s) => s.run)).toContain(`${YODEL_CHANT_BIN} run wave --spec ${WAVES_SPEC} --wave 2`);
  });
});
