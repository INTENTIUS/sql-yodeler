/**
 * Signed checks (sql-yodeler issue 346, chant issues 4867 to 4870, 4964,
 * 4978): yodel.config.ts `ci.evidence` names the runner identity, and each
 * environment's note job signs `plan:<env>` and `policy:<env>`, chant's
 * check job signs each hook that passed (GitHub, Forgejo), and each wave
 * signs its plan. `ci.refGate` adds the ref gate's rule for main to
 * `.chant/trust.json`, needing each environment's two checks, and the job
 * that sets `chant/ref-gate`. Rendering only.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseYAMLDocument } from "@intentius/chant/yaml";
import { checkYodelConfig } from "../src/config/load.js";
import { actionsReview, gitlabPlan, type Environments } from "../src/ci/render.js";
import { copyTemplate, repoRoot, yodel } from "./helpers/run.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

const envs: Environments = { dialect: "postgres", names: ["dev", "prod"], replay: true, waves: [{ env: "dev", gate: "always" }, { env: "prod", gate: "always", requires: "dev" }], evidence: { runnerKeySecret: "CHANT_RUNNER_KEY" } };
type Step = { name?: string; run?: string; env?: Record<string, string> };
type ActionsDoc = { jobs: Record<string, { steps: Step[]; needs?: string[] }> };

describe("ci.evidence and ci.refGate", () => {
  it("are checked: one identity, and the gate only with evidence", () => {
    expect(checkYodelConfig({ ci: { evidence: { runnerKeySecret: "CHANT_RUNNER_KEY" }, refGate: true } }, "yodel.config.ts").ci).toEqual({ evidence: { runnerKeySecret: "CHANT_RUNNER_KEY" }, refGate: true });
    expect(checkYodelConfig({ ci: { evidence: { identity: "oidc", audience: "sigstore" } } }, "yodel.config.ts").ci).toEqual({ evidence: { identity: "oidc", audience: "sigstore" } });
    expect(() => checkYodelConfig({ ci: { evidence: {} } }, "yodel.config.ts")).toThrow(/ci\.evidence: give one of runnerKeySecret/);
    expect(() => checkYodelConfig({ ci: { evidence: { runnerKeySecret: "K", identity: "oidc" } } }, "yodel.config.ts")).toThrow(/give one of/);
    expect(() => checkYodelConfig({ ci: { evidence: { runnerKeySecret: "not a name" } } }, "yodel.config.ts")).toThrow(/runnerKeySecret/);
    expect(() => checkYodelConfig({ ci: { refGate: true } }, "yodel.config.ts")).toThrow(/ci\.refGate: the ref gate needs signed checks/);
    expect(() => checkYodelConfig({ ci: { refGate: "yes" } }, "yodel.config.ts")).toThrow(/ci\.refGate: true or false/);
  });

  it("sign each environment's plan as plan:<env> and policy:<env> in its note job, and each hook in check-evidence", () => {
    for (const forge of ["github", "forgejo"] as const) {
      const doc = parseYAMLDocument(actionsReview(forge, { ...envs, checkHooks: true }).content) as ActionsDoc;
      for (const env of envs.names) {
        const sign = doc.jobs[`plan-note-${env}`]?.steps.find((s) => s.name === "Sign the plan and policy evidence");
        expect(sign?.run, `${forge} ${env}`).toContain(`ci evidence sign --from-report .chant/pr --member ${env}`);
        expect(sign?.env?.CHANT_RUNNER_KEY, `${forge} ${env}`).toContain("CHANT_RUNNER_KEY");
      }
      expect(Object.keys(doc.jobs), forge).toEqual(expect.arrayContaining(["check", "check-evidence"]));
      expect(doc.jobs).not.toHaveProperty("ref-gate");
    }
    // GitLab: each plan's evidence job in the plan notes pipeline.
    const gitlab = parseYAMLDocument(gitlabPlan(envs).file.content) as Record<string, { script?: string[]; environment?: unknown }>;
    for (const env of envs.names) expect(gitlab[`${env}-plan-evidence`]?.script?.join("\n")).toContain(`--member ${env}`);
  });

  it("renders the ref gate's rule and status job with ci.refGate, and nothing of either without it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yodel-signed-"));
    temps.push(dir);
    copyTemplate("postgres", dir);
    symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"));
    const config = join(dir, "yodel.config.ts");
    writeFileSync(config, readFileSync(config, "utf8").replace(/^ {2}ci: .*$/m, '  ci: { forges: ["github", "gitlab"], evidence: { runnerKeySecret: "CHANT_RUNNER_KEY" }, refGate: true },'));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const wrote = await yodel(["ci", "--dir", dir]);
    expect(wrote.code, wrote.err).toBe(0);
    expect(wrote.out).toContain("wrote .chant/trust.json\n");
    const trust = JSON.parse(readFileSync(join(dir, ".chant/trust.json"), "utf8")) as { refs: Array<{ ref: string; checks: Array<{ check: string }> }> };
    expect(trust.refs.map((r) => r.ref)).toEqual(["refs/heads/main"]);
    expect(trust.refs[0]?.checks.map((c) => c.check).sort()).toEqual(["plan:dev", "plan:prod", "policy:dev", "policy:prod"]);
    const pr = parseYAMLDocument(readFileSync(join(dir, ".github/workflows/yodel-pr.yml"), "utf8")) as ActionsDoc;
    expect(pr.jobs["ref-gate"]?.steps.some((s) => s.run?.includes("yodel chant workspace ref-gate status --ref refs/heads/main"))).toBe(true);
    // The waves sign their plans: on GitLab each deciding wave's evidence job.
    const apply = parseYAMLDocument(readFileSync(join(dir, ".gitlab/yodel-apply.gitlab-ci.yml"), "utf8")) as Record<string, unknown>;
    expect(Object.keys(apply)).toEqual(expect.arrayContaining(["wave-1-dev-evidence", "wave-2-prod-evidence"]));
    expect((await yodel(["ci", "--check", "--dir", dir])).code).toBe(0);

    // Without ci.refGate: no rule and no status job.
    const plain = parseYAMLDocument(actionsReview("github", envs).content) as ActionsDoc;
    expect(plain.jobs).not.toHaveProperty("ref-gate");
  });
});
