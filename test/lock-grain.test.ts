/**
 * #293, #303: the lock grain from the sql lexicon and the stand-down
 * through chant. The waves spec sets `standDown`, and the apply jobs carry
 * no lock settings of their own. A held lock and a superseded apply exit 5
 * and 6 from chant's table. `YODEL_LOCK_WAIT` and `YODEL_STAND_DOWN`, which
 * a pipeline rendered by yodel 0.10 sets on its wave jobs, are refused by
 * name, except as `yodel apply`'s hand-off to its Op's steps.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { wavesSpec, type Wave } from "../src/ci/render.js";
import { retiredVariableRefusal } from "../src/config/settings.js";
import { EXIT_HELD, EXIT_SUPERSEDED } from "../src/exit.js";
import { standDownLine } from "../src/commands/apply.js";
import { repoRoot, yodel } from "./helpers/run.js";

const waves: Wave[] = [{ env: "staging", gate: "never" }, { env: "prod", gate: "always" }];

describe("the waves spec's stand-down (#293)", () => {
  it("is chant's, on the sql capability", () => {
    const spec = wavesSpec(waves);
    expect(spec.standDown).toBe(true);
    expect(spec.step).toEqual({ kind: "sql-migrate", environment: "{target}", spec: "yodel-waves.json" });
  });

  it("leaves the templates' apply jobs without YODEL_LOCK_WAIT or YODEL_STAND_DOWN", () => {
    for (const dialect of ["clickhouse", "postgres"]) {
      const files = [".github/workflows", ".forgejo/workflows"].flatMap((d) => readdirSync(join(repoRoot, "templates", dialect, d)).map((f) => join(d, f)));
      for (const f of [...files, ".gitlab/yodel-apply.gitlab-ci.yml", "yodel-waves.json"]) {
        const text = readFileSync(join(repoRoot, "templates", dialect, f), "utf8");
        expect(text, `${dialect}/${f}`).not.toMatch(/YODEL_LOCK_WAIT|YODEL_STAND_DOWN/);
      }
    }
  });
});

describe("held and superseded on chant's table (#293)", () => {
  it("are 5 and 6", () => {
    expect([EXIT_HELD, EXIT_SUPERSEDED]).toEqual([5, 6]);
  });
});

describe("the stand-down line", () => {
  it("names the branch, both commits and the environment", () => {
    expect(standDownLine("prod", { branch: "main", head: "a".repeat(40), tip: "b".repeat(40) })).toBe(
      `standing down: main on origin is at ${"b".repeat(12)}, newer than this run's ${"a".repeat(12)}, and its own apply applies prod. Nothing was applied by this run.`,
    );
  });
});

describe("a 0.10.1 pipeline's lock variables (#303)", () => {
  const saved = { wait: process.env.YODEL_LOCK_WAIT, down: process.env.YODEL_STAND_DOWN };
  afterEach(() => {
    if (saved.wait === undefined) delete process.env.YODEL_LOCK_WAIT;
    else process.env.YODEL_LOCK_WAIT = saved.wait;
    if (saved.down === undefined) delete process.env.YODEL_STAND_DOWN;
    else process.env.YODEL_STAND_DOWN = saved.down;
  });

  it("are refused by name, pointing at yodel upgrade", () => {
    expect(retiredVariableRefusal({}, "yodel apply")).toBeUndefined();
    const both = retiredVariableRefusal({ YODEL_LOCK_WAIT: "10m", YODEL_STAND_DOWN: "1" }, "yodel apply");
    expect(both?.refused).toBe(true);
    expect(both?.exitCode).toBe(1);
    expect(both?.message).toMatch(/^refused: YODEL_LOCK_WAIT and YODEL_STAND_DOWN are set, as a pipeline rendered by yodel 0\.10 sets them/);
    expect(both?.message).toContain("npx yodel upgrade");
    expect(retiredVariableRefusal({ YODEL_STAND_DOWN: "1" }, "yodel revert")?.message).toMatch(/YODEL_STAND_DOWN is set.*yodel revert no longer reads it/);
  });

  it("stop a wave job's yodel apply --wave-plan before it reads anything", async () => {
    process.env.YODEL_LOCK_WAIT = "10m";
    process.env.YODEL_STAND_DOWN = "1";
    const ran = await yodel(["apply", "prod", "--wave-plan", "plan.json", "--spec", "yodel-waves.json", "--dir", "/nowhere"]);
    expect(ran.code).toBe(1);
    expect(ran.err).toMatch(/refused: YODEL_LOCK_WAIT and YODEL_STAND_DOWN are set/);
    expect(ran.err).toContain("yodel upgrade");
  });

  it("stop yodel apply and yodel revert at a terminal too", async () => {
    process.env.YODEL_LOCK_WAIT = "10m";
    expect((await yodel(["apply", "prod", "--dir", "/nowhere"])).err).toMatch(/refused: YODEL_LOCK_WAIT is set/);
    expect((await yodel(["revert", "prod", "20261009T1000-one", "--dir", "/nowhere"])).err).toMatch(/refused: YODEL_LOCK_WAIT is set/);
  });

  it("are the Op's steps' hand-off, which they take without refusing", async () => {
    process.env.YODEL_LOCK_WAIT = "10m";
    process.env.YODEL_STAND_DOWN = "1";
    const ran = await yodel(["apply", "prod", "--digest", "--dir", "/nowhere"]);
    expect(ran.err).not.toMatch(/YODEL_LOCK_WAIT|YODEL_STAND_DOWN/);
  });
});
