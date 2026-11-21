/**
 * The environments as stages of chant's pipeline (#384): `ci.promotion`
 * and the stage keys under `ci.environments`, mapped onto chant's
 * `pipelineFromConfig`, the file chant folds, the first stage's spec the
 * merge applies, the promote and reject jobs, and the change risk in the
 * plan note.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { asPipelineSpec, foldPipelineSource, stageWavesSpec } from "@intentius/chant/pipeline";
import { checkYodelConfig } from "../src/config/load.js";
import { environmentSetsOf, ignoreWaveWorkDirs, pipelineConfigProblem, releaseGreenNote, stageRisk, WAVE_WORK_DIRS } from "../src/ci/pipeline.js";
import { commandToken } from "../src/ci/render.js";
import { planRisk } from "../src/pr/note.js";
import { PIPELINE_WORDS, YODEL_WORDS } from "../src/ci-words.js";
import { promote, reject, pause, resume } from "../src/commands/stages.js";
import type { Io } from "../src/command.js";
import { copyTemplate, repoRoot, yodel } from "./helpers/run.js";
import { offline } from "./helpers/new-suite.js";

offline();

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

/** A public key for `.chant/allowed_signers`; nothing signs with it here. */
const SIGNER = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";

/** The ClickHouse template (waves dev, prod) in a directory of its own with `ci` set to `ci`. */
function template(ci: string): string {
  const dir = mkdtempSync(join(tmpdir(), "yodel-pipeline-"));
  temps.push(dir);
  copyTemplate("clickhouse", dir);
  symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"));
  const config = join(dir, "yodel.config.ts");
  writeFileSync(config, readFileSync(config, "utf8").replace(/^ {2}ci: .*$/m, `  ci: ${ci},`));
  // A signer, so a rule that needs a proven approver has one who can meet it (chant refuses the spec otherwise).
  mkdirSync(join(dir, ".chant"), { recursive: true });
  writeFileSync(join(dir, ".chant", "allowed_signers"), `alice ${SIGNER}\n`);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

const read = (dir: string, f: string) => readFileSync(join(dir, f), "utf8");
const FORGES = 'forges: ["github", "gitlab", "forgejo"]';
const WAVES = [{ env: "dev" }, { env: "prod" }];

describe("the pipeline keys in yodel.config.ts", () => {
  const check = (ci: unknown, waves: unknown = WAVES) => () => checkYodelConfig({ waves, ci }, "yodel.config.ts");

  it("take ci.promotion in the waves' order, and refuse another order", () => {
    expect(check({ promotion: ["dev", "prod"] })).not.toThrow();
    expect(check({ promotion: ["prod", "dev"] })).toThrow(/ci\.promotion: prod, dev; the waves apply dev, prod/);
    expect(check({ promotion: ["dev"] })).toThrow(/the promotion order is the waves' order/);
    expect(check({ promotion: [] })).toThrow(/ci\.promotion: the environments in promotion order/);
  });

  it("read each stage key, and refuse a key no stage takes or a stage that is not one", () => {
    expect(check({ promotion: ["dev", "prod"], environments: { prod: { hold: true, freeze: [], after: ["dev"], queue: "replace", urgent: { role: "sre" }, pauseAfterRollback: true, publish: {}, reads: {}, config: {}, secrets: {}, imports: [] } } })).not.toThrow();
    expect(check({ promotion: ["dev", "prod"], environments: { prod: { gate: "always" } } })).toThrow(/ci\.environments\.prod\.gate: unknown stage setting/);
    expect(check({ promotion: ["dev", "prod"], environments: { qa: {} } })).toThrow(/ci\.environments\.qa: qa is not a stage/);
  });

  it("take soak checks of the kinds a SQL stage reads, and name the missing health reader for a health check", () => {
    const soak = (kind: string) => ({ promotion: ["dev", "prod"], environments: { dev: { soak: { duration: "30m", checks: [{ kind }] } } } });
    for (const kind of ["http", "prometheus", "command"]) expect(check(soak(kind))).not.toThrow();
    expect(check(soak("health"))).toThrow(/a SQL stage soaks on http, prometheus, command checks \(the sql lexicon has no lifecycle health reader\)/);
    expect(check(soak("drift"))).toThrow(/a check of kind "drift"/);
  });

  it("refuse a stage key without ci.promotion, and take the sets and the risk without it", () => {
    expect(check({ release: { cut: false } })).toThrow(/ci\.release: a pipeline key, read with ci\.promotion/);
    expect(check({ environments: { prod: { hold: true } } })).toThrow(/ci\.environments\.prod\.hold: a stage key, read with ci\.promotion/);
    expect(check({ risk: { approveAbove: 0.4 }, environments: { prod: { config: { REGION: "us-east-1" }, risk: { approveAbove: 0.2 } } } })).not.toThrow();
    expect(check({ risk: { approveAbove: 2 } })).toThrow(/ci\.risk: \{ approveAbove\?: a score from 0 to 1/);
  });

  it("refuse ci.promotion with ci.apply: false", () => {
    expect(check({ apply: false, promotion: ["dev", "prod"] })).toThrow(/ci\.promotion: the pipeline's first stage is the apply pipeline's wave/);
  });

  it("are checked against the waves the profiles give when the config names none", () => {
    expect(pipelineConfigProblem({ promotion: ["dev", "prod"] }, ["dev", "prod"], "ci")).toBeUndefined();
    expect(pipelineConfigProblem({ promotion: ["dev", "staging", "prod"] }, ["dev", "prod"], "ci")).toMatch(/the waves apply dev, prod/);
  });
});

describe("the stage risk and the sets", () => {
  it("give each stage its own threshold, else ci.risk's, with the stage's extra rules", () => {
    const ci = { promotion: ["dev", "prod"], risk: { approveAbove: 0.5 }, environments: { prod: { risk: { approvalRules: [{ count: 2, roles: ["sre"] }] } } } };
    expect(stageRisk(ci, "dev")).toEqual({ approveAbove: 0.5 });
    expect(stageRisk(ci, "prod")).toEqual({ approveAbove: 0.5, quorum: [{ count: 2, roles: ["sre"] }] });
    expect(stageRisk({}, "dev")).toBeUndefined();
  });

  it("give every wave environment a set once one stage names one, and none otherwise", () => {
    expect(environmentSetsOf({}, ["dev", "prod"])).toBeUndefined();
    expect(environmentSetsOf({ environments: { prod: { config: { REGION: "us-east-1" }, secrets: { API: "PROD_API" }, imports: ["common"] } }, configSets: { common: { config: { LOG: "info" } } } }, ["dev", "prod"])).toEqual({
      environments: { dev: {}, prod: { imports: ["common"], config: { REGION: "us-east-1" }, secrets: { API: "PROD_API" } } },
      configSets: { common: { config: { LOG: "info" } } },
    });
  });
});

describe("yodel ci with ci.promotion", () => {
  const ci = `{ ${FORGES}, promotion: ["dev", "prod"], approvalRules: [{ count: 1, notAuthor: true }], risk: { approveAbove: 0.5 }, recheck: { schedule: "*/15 * * * *" }, environments: { dev: { soak: { duration: "30m", checks: [{ kind: "http", url: "https://dev.example.test/health" }] } }, prod: { hold: { reason: "launch", until: "2026-12-01T00:00:00Z" }, urgent: { role: "sre" }, risk: { approvalRules: [{ count: 2 }] } } } }`;

  it("writes .chant/pipeline.ts that chant folds to the stages, with each key passed as written", async () => {
    const dir = template(ci);
    const wrote = await yodel(["ci", "--dir", dir]);
    expect(wrote.code, wrote.err).toBe(0);
    const text = read(dir, ".chant/pipeline.ts");
    expect(text.split("\n")[0]).toBe("// Written by yodel from yodel.config.ts. Change the config and run `yodel ci`;");
    const folded = foldPipelineSource(text);
    if (!("spec" in folded)) throw new Error("the pipeline does not fold");
    const spec = folded.spec;
    expect(spec.name).toBe("yodel-apply");
    expect(spec.stages.map((s) => s.name)).toEqual(["dev", "prod"]);
    expect(spec.stages[0]?.soak).toEqual({ duration: "30m", checks: [{ kind: "http", url: "https://dev.example.test/health" }] });
    expect(spec.stages[1]).toMatchObject({ hold: { reason: "launch", until: "2026-12-01T00:00:00Z" }, gate: { quorum: [{ count: 1, notAuthor: true }], urgent: { role: "sre" }, holds: { risk: { approveAbove: 0.5, quorum: [{ count: 2 }] } } } });
    expect(spec.stages[0]?.gate?.holds?.risk).toEqual({ approveAbove: 0.5 });
    expect(spec.recheck).toEqual({ schedule: "*/15 * * * *" });
    expect(spec.release?.bin).toEqual(["yodel", "chant"]);
    expect(spec.defaults?.step).toEqual({ kind: "sql-migrate", environment: "{target}", spec: "yodel-waves.json" });
  });

  it("commits the first stage's spec from the folded file as yodel-waves.json, under the ledger's op name, with the release cut", async () => {
    const dir = template(ci);
    expect((await yodel(["ci", "--dir", dir])).code).toBe(0);
    const folded = foldPipelineSource(read(dir, ".chant/pipeline.ts"));
    if (!("spec" in folded)) throw new Error("the pipeline does not fold");
    const first = Object.fromEntries(Object.entries(stageWavesSpec(asPipelineSpec(folded.spec), "dev") as unknown as Record<string, unknown>).filter(([k]) => k !== "labels"));
    const committed = JSON.parse(read(dir, "yodel-waves.json")) as Record<string, unknown> & { waves: Array<{ name: string; hooks?: unknown }> };
    expect(committed).toEqual({ ...first, name: "yodel-apply" });
    expect(committed.waves.map((w) => w.name)).toEqual(["dev"]);
    // The merge's apply records under the pipeline's component, which the promotes' soak and skip checks read.
    expect(committed.release).toEqual({ component: "yodel-apply" });
    expect(JSON.stringify(committed.waves[0]?.hooks)).toContain('"release","cut","auto","--yes"');
  });

  it("renders the merge's wave for the first stage and a promote job for each later stage, on every forge", async () => {
    const dir = template(ci);
    expect((await yodel(["ci", "--dir", dir])).code).toBe(0);
    expect(read(dir, ".github/workflows/yodel-apply.yml")).not.toMatch(/wave-2-prod/);
    for (const file of [".github/workflows/yodel-apply-promote.yml", ".forgejo/workflows/yodel-apply-promote.yml", ".gitlab/yodel-apply-promote.gitlab-ci.yml"]) {
      const text = read(dir, file);
      expect(text, file).toContain("yodel chant components promote --to prod");
      expect(text, file).toContain("writer:prod");
      expect(text, file).toContain("npm ci");
      expect(text, file).toMatch(/recheck-prod/);
    }
    expect(read(dir, ".gitlab-ci.yml")).toContain(".gitlab/yodel-apply-promote.gitlab-ci.yml");
    for (const file of [".github/workflows/yodel-reject.yml", ".forgejo/workflows/yodel-reject.yml"]) {
      expect(read(dir, file), file).toContain("yodel chant components pr-comment --forge");
    }
    expect(existsSync(join(dir, ".gitlab/yodel-reject.gitlab-ci.yml"))).toBe(false);
  });

  it("passes yodel ci --check, and fails it with chant's diff while .chant/pipeline.ts is stale", async () => {
    const dir = template(ci);
    expect((await yodel(["ci", "--dir", dir])).code).toBe(0);
    const ok = await yodel(["ci", "--check", "--dir", dir]);
    expect(ok.code, ok.err + ok.out).toBe(0);
    const file = join(dir, ".chant/pipeline.ts");
    writeFileSync(file, readFileSync(file, "utf8").replace('"count": 2', '"count": 1'));
    const stale = await yodel(["ci", "--check", "--dir", dir]);
    expect(stale.code).toBe(1);
    expect(stale.err).toContain(".chant/pipeline.ts is not what the config writes; run `yodel ci` and commit it");
    expect(stale.err).toMatch(/^\+\s+"count": 2$/m);
    expect(stale.err).toContain("stale, run yodel ci: .chant/pipeline.ts");
  });

  it("gives the merge's wave jobs a token that reads the commit's checks, for the release cut's forge-checks gate (#395)", async () => {
    const dir = template(ci);
    const wrote = await yodel(["ci", "--dir", dir]);
    expect(wrote.code).toBe(0);
    expect(wrote.err).toContain('note: chant.config.ts: set release: { green: "forge-checks" } in it');
    expect(JSON.stringify(JSON.parse(read(dir, "yodel-waves.json")))).toContain('"release","cut","auto","--yes","--wait-checks"');
    for (const file of [".github/workflows/yodel-apply.yml", ".forgejo/workflows/yodel-apply.yml"]) {
      const text = read(dir, file);
      expect(text, file).toContain("GITHUB_TOKEN: '${{ github.token }}'");
    }
    expect(read(dir, ".github/workflows/yodel-apply.yml")).toMatch(/checks: read\n\s+statuses: read/);
    // A chant.config.ts that names the gate hears nothing.
    const config = join(dir, "chant.config.ts");
    writeFileSync(config, readFileSync(config, "utf8").replace('lexicons: ["sql"],', 'lexicons: ["sql"],\n  release: { green: "forge-checks" },'));
    const again = await yodel(["ci", "--check", "--dir", dir]);
    expect(again.code, again.err).toBe(0);
    expect(again.err).not.toContain("release.green");
  });

  it("names the release gate and asks for the token only under ci.promotion with the cut on", () => {
    expect(releaseGreenNote(undefined, {})).toBeUndefined();
    expect(releaseGreenNote({ promotion: ["dev", "prod"] }, {})).toContain('release: { green: "forge-checks" }');
    expect(releaseGreenNote({ promotion: ["dev", "prod"] }, { release: { green: "chant" } })).toBeUndefined();
    expect(releaseGreenNote({ promotion: ["dev", "prod"], release: { cut: false } }, {})).toBeUndefined();
    expect(commandToken("github", undefined, undefined)).toBeUndefined();
    expect(commandToken("github", undefined, { promotion: ["dev"] })).toEqual({ commandToken: { permissions: { checks: "read", statuses: "read" } } });
    expect(commandToken("forgejo", "diff", { promotion: ["dev"] })).toEqual({ commandToken: { permissions: { "pull-requests": "write", issues: "write", checks: "read", statuses: "read" } } });
    expect(commandToken("github", undefined, { promotion: ["dev"], release: { cut: false } })).toBeUndefined();
    expect(commandToken("gitlab", "diff", { promotion: ["dev"] })).toBeUndefined();
  });

  it("refuses onVerifyFail: rollback on a sql-migrate stage with chant's reason", async () => {
    const dir = template(`{ ${FORGES}, promotion: ["dev", "prod"], environments: { prod: { onVerifyFail: "rollback" } } }`);
    const ran = await yodel(["ci", "--dir", dir]);
    expect(ran.code).toBe(1);
    expect(ran.err).toMatch(/stage "prod" sets onVerifyFail: "rollback".*it runs migrations, and applying an earlier release does not take back a migration that ran/);
    expect(existsSync(join(dir, ".chant/pipeline.ts"))).toBe(false);
  });

  it("writes no pipeline without ci.promotion: the waves apply on merge as before", async () => {
    const dir = template(`{ ${FORGES} }`);
    expect((await yodel(["ci", "--dir", dir])).code).toBe(0);
    expect(existsSync(join(dir, ".chant/pipeline.ts"))).toBe(false);
    expect(existsSync(join(dir, ".github/workflows/yodel-apply-promote.yml"))).toBe(false);
    expect(existsSync(join(dir, ".github/workflows/yodel-reject.yml"))).toBe(false);
    expect((JSON.parse(read(dir, "yodel-waves.json")) as { waves: Array<{ name: string }> }).waves.map((w) => w.name)).toEqual(["dev", "prod"]);
  });
});

describe("the change risk in the plan note", () => {
  it("names the sql lexicon's destructive classes of the pending steps, and is over the stage's threshold", async () => {
    const plan = {
      environment: "prod",
      dialect: "postgres",
      pending: [],
      wave: { destructiveSteps: [{ migration: "20260101_drop", step: 0, what: "DROP COLUMN", why: "destructive, pg-lock" }] },
    } as never;
    const risk = (await planRisk(plan, { members: [], entries: [] }, { approveAbove: 0.3 })) as { score: number; over: boolean; reasons: Array<{ id: string; detail: string }> };
    const sql = risk.reasons.find((r) => r.id === "sql.destructive");
    expect(sql?.detail).toBe("destructive migration classes: destructive, pg-lock");
    expect(risk.over).toBe(true);
  });
});

describe("the stage words and commands", () => {
  it("give the reject line in yodel's words, and map /yodel reject onto chant's reject for the comment job alone", () => {
    expect(YODEL_WORDS.reject).toBe("yodel reject {op} {gate} --plan {digest} --reason {reason} {sign}");
    expect(YODEL_WORDS.commands).not.toHaveProperty("reject");
    expect(PIPELINE_WORDS.commands).toEqual({ ...YODEL_WORDS.commands, reject: "reject" });
  });

  it("print their usage", async () => {
    for (const [command, usage] of [[promote, "yodel promote --to <env>"], [reject, "yodel reject <pipeline> <env>"], [pause, "yodel pause <env>"], [resume, "yodel resume <env>"]] as const) {
      let out = "";
      const io: Io = { out: (t) => (out += t), err: () => undefined };
      expect(await command.run(["--help"], io)).toBe(0);
      expect(out).toContain(usage);
    }
  });
});

describe("the wave's work directories under ci.promotion", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const fresh = (gitignore?: string): string => {
    const d = mkdtempSync(join(tmpdir(), "yodel-ignore-"));
    dirs.push(d);
    if (gitignore !== undefined) writeFileSync(join(d, ".gitignore"), gitignore);
    return d;
  };

  it("adds them to .gitignore once, keeping what is there", () => {
    const d = fresh("node_modules");
    expect(ignoreWaveWorkDirs({ promotion: ["dev", "prod"] }, d)).toBe(true);
    expect(readFileSync(join(d, ".gitignore"), "utf8")).toBe(`node_modules\n${WAVE_WORK_DIRS}\n`);
    expect(ignoreWaveWorkDirs({ promotion: ["dev", "prod"] }, d)).toBe(false);
  });

  it("leaves .gitignore alone without ci.promotion or with the cut off", () => {
    const d = fresh();
    expect(ignoreWaveWorkDirs({}, d)).toBe(false);
    expect(ignoreWaveWorkDirs({ promotion: ["dev"], release: { cut: false } }, d)).toBe(false);
    expect(existsSync(join(d, ".gitignore"))).toBe(false);
  });
});
