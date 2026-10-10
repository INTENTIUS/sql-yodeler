/**
 * Approval modes (#48): the config, the sealed check `--execute` and
 * `--wave-apply` make, the pipelines `yodel ci` renders for a pr-review wave
 * on each forge, and what `yodel approve --sign` asks chant.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { memoryGateLedgerPort } from "@intentius/chant/op/gate";
import type { GateResolutionRecord } from "@intentius/chant/lifecycle/gate-ledger";
import { sealGateApproval } from "@intentius/chant/workspace/trust/seal";
import { parseYAMLDocument } from "@intentius/chant/yaml";
import { checkYodelConfig } from "../src/config/load.js";
import { describeApprovalMode, migrationsApproval, migrationsApprovalAtBase, portFor, RECORD_PLANS_ENV, waveApproval } from "../src/approval-mode/index.js";
import { verifyApproval } from "../src/versioned/approval.js";
import { applyPipelines, gitlabPipeline, readWaves, wavesSpec, type Wave } from "../src/ci/render.js";
import { chantApproveArgs } from "../src/commands/approve.js";
import { describeWave } from "../src/waves/index.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});
const temp = (label: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `yodel-48-${label}-`));
  temps.push(dir);
  return dir;
};

describe("yodel.config.ts approval", () => {
  it("takes ledger, pr-review or sealed on a wave, and ledger or sealed on an environment", () => {
    expect(() => checkYodelConfig({ waves: [{ env: "dev", approval: "pr-review" }, { env: "prod", approval: "sealed" }] }, "yodel.config.ts")).not.toThrow();
    expect(() => checkYodelConfig({ environments: { prod: { approval: "sealed" } } }, "yodel.config.ts")).not.toThrow();
    expect(() => checkYodelConfig({ waves: [{ env: "dev", approval: "anyone" }] }, "yodel.config.ts")).toThrow(/waves\[0\]\.approval: "anyone" is not an approval mode/);
    expect(() => checkYodelConfig({ environments: { prod: { approval: "pr-review" } } }, "yodel.config.ts")).toThrow(/pr-review is a wave's/);
  });

  it("defaults the wave to ledger, and the migrations Op to the environment's, else sealed when its wave is", () => {
    const config = { environments: { qa: { approval: "ledger" as const } }, waves: [{ env: "qa", approval: "sealed" as const }, { env: "prod", approval: "sealed" as const }, { env: "dev", approval: "pr-review" as const }] };
    expect(waveApproval(config, "prod")).toBe("sealed");
    expect(waveApproval(config, "prod/acme")).toBe("sealed");
    expect(waveApproval(config, "other")).toBe("ledger");
    expect(migrationsApproval(config, "prod")).toBe("sealed");
    expect(migrationsApproval(config, "qa")).toBe("ledger");
    expect(migrationsApproval(config, "dev")).toBe("ledger");
    expect(migrationsApproval(undefined, "dev")).toBe("ledger");
  });

  it("is read at the base commit, so a change cannot loosen its own", async () => {
    const dir = temp("base");
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: dir, stdio: "pipe" });
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "yodel.config.ts"), `export default { environments: { prod: { approval: "sealed" } } };\n`);
    git("add", "-A");
    git("commit", "-qm", "base");
    writeFileSync(join(dir, "yodel.config.ts"), `export default { environments: { prod: { approval: "ledger" } } };\n`);
    git("commit", "-qam", "the change");
    const at = await migrationsApprovalAtBase({ dir, yodel: { config: { environments: { prod: { approval: "ledger" } } } } }, "prod", {});
    expect(at.mode).toBe("sealed");
    expect(at.note).toMatch(/as yodel.config.ts has it at the base commit/);
  });
});

const hasSshKeygen = spawnSync("ssh-keygen", ["-Y"], { stdio: "ignore" }).error === undefined;

describe.skipIf(!hasSshKeygen)("a sealed gate, as --execute and --wave-apply check it", () => {
  const dir = temp("sealed");
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8", stdio: "pipe" }).trim();
  const key = (name: string) => {
    const file = join(dir, "..", `${name}-${String(process.pid)}`);
    temps.push(file, `${file}.pub`);
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", name, "-f", file]);
    return { file, pub: readFileSync(`${file}.pub`, "utf8").trim().split(" ").slice(0, 2).join(" ") };
  };
  git("init", "-q", "-b", "main");
  const alice = key("alice");
  const mallory = key("mallory");
  mkdirSync(join(dir, ".chant"));
  writeFileSync(join(dir, ".chant", "allowed_signers"), `alice ${alice.pub}\n`);
  git("add", "-A");
  git("commit", "-qm", "base: alice signs");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(dir, ".chant", "allowed_signers"), `alice ${alice.pub}\nmallory ${mallory.pub}\n`);
  git("commit", "-qam", "the change adds mallory");

  const op = { name: "migrate-prod", filePath: "ops/migrate-prod.op.ts", gate: "approve-migrate-prod", quorum: false };
  const digest = `jcs1-sha256:${"a".repeat(64)}`;
  const approval = (by: string, keyFile?: string): GateResolutionRecord => {
    const a = { op: op.name, gate: op.gate, resolvedBy: by, timestamp: "2026-10-10T00:00:00.000Z", planDigest: digest };
    return { version: 1, ...a, ...(keyFile ? { seal: sealGateApproval(keyFile, a) } : {}) };
  };
  const check = async (r: GateResolutionRecord, mode: "ledger" | "sealed" = "sealed", at: string | undefined = base) =>
    verifyApproval(await portFor(memoryGateLedgerPort({ resolutions: [r] }), mode, dir, at), op, digest);

  it("refuses an unsigned approval, saying why", async () => {
    await expect(check(approval("alice"))).rejects.toThrow(/does not count/);
    // The same approval counts under ledger.
    expect((await check(approval("alice"), "ledger")).resolvedBy).toBe("alice");
  });

  it("refuses a seal by a key the change itself added to the signers file", async () => {
    await expect(check(approval("mallory", mallory.file))).rejects.toThrow(/mallory/);
  });

  it("counts a seal by a signer the base lists, and names the signer", async () => {
    expect(await check(approval("alice", alice.file))).toMatchObject({ resolvedBy: "alice", signer: "alice" });
  });

  it("counts nothing with no base to read the signers at", async () => {
    const port = await portFor(memoryGateLedgerPort({ resolutions: [approval("alice", alice.file)] }), "sealed", dir, undefined);
    await expect(verifyApproval(port, op, digest)).rejects.toThrow(/no base commit/);
  });
});

describe("yodel approve --sign", () => {
  it("asks chant approve to seal, with the key and the approver given", () => {
    expect(chantApproveArgs("yodel-apply", "yodel-apply-wave-1", "d", true)).toEqual(["approve", "yodel-apply", "yodel-apply-wave-1", "--plan", "d", "--resume"]);
    expect(chantApproveArgs("yodel-apply", "yodel-apply-wave-1", "d", true, { sign: true })).toEqual(["approve", "yodel-apply", "yodel-apply-wave-1", "--plan", "d", "--sign", "--resume"]);
    expect(chantApproveArgs("yodel-apply", "yodel-apply-wave-1", "d", false, { sign: true, key: "/k", actor: "alice" })).toEqual(["approve", "yodel-apply", "yodel-apply-wave-1", "--plan", "d", "--actor", "alice", "--sign", "/k"]);
  });
});

describe("the plan and the comment say which approvals count", () => {
  const view = { wave: 1, gate: "always" as const, base: "a".repeat(40), baseSource: "HEAD^1", planDigest: "p", digest: "jcs1-sha256:d", promotions: [], blocked: false, destructiveSteps: [], waits: true };
  it("names a sealed or pr-review wave's mode, and says nothing new under ledger", () => {
    expect(describeWave({ ...view, approve: "chant approve yodel-apply yodel-apply-wave-1 --plan jcs1-sha256:d" })).toBe("The apply pipeline waits in wave 1 for an approval of jcs1-sha256:d (gate always at aaaaaaaaaaaa).");
    expect(describeWave({ ...view, approve: "x --sign", approval: "sealed" })).toMatch(/Approvals count only sealed \(approval sealed\): chant approve --sign or yodel approve --sign, with a key \.chant\/allowed_signers at the base commit lists/);
    expect(describeWave({ ...view, approve: "x", approval: "pr-review" }, (c) => `\`${c}\``)).toMatch(/Approval `pr-review`: an approving review of this pull request's head, by a writer other than its author/);
    expect(describeApprovalMode("ledger")).toMatch(/any chant approve/);
  });
});

// ── yodel ci ──────────────────────────────────────────────────────────────────

/** The postgres template: its ops/ declare dev's and prod's migrations Ops, which the pipelines name. */
const project = (): string => join(dirname(fileURLToPath(import.meta.url)), "..", "templates", "postgres");

const WAVES: Wave[] = [
  { env: "dev", gate: "always", approval: "pr-review" },
  { env: "prod", gate: "always", requires: "dev", approval: "sealed" },
];
const envs = { dialect: "postgres" as const, names: ["dev", "prod"], replay: false, waves: WAVES };

describe("yodel ci, for approval modes", () => {
  it("reads waves[].approval, refusing a mode that is not one", async () => {
    const dir = temp("waves");
    writeFileSync(join(dir, "yodel.config.ts"), `export default { waves: [{ env: "dev", approval: "pr-review" }, { env: "prod", approval: "ledger" }] };\n`);
    expect(await readWaves(dir, ["dev", "prod"])).toEqual([{ env: "dev", gate: "always", approval: "pr-review" }, { env: "prod", gate: "always", requires: "dev" }]);
    writeFileSync(join(dir, "yodel.config.ts"), `export default { waves: [{ env: "dev", approval: "maybe" }] };\n`);
    await expect(readWaves(dir, ["dev"])).rejects.toThrow(/approval: "maybe" is not an approval mode/);
  });

  it("writes each wave's mode into the waves spec chant reads at the base, leaving ledger out", () => {
    const spec = wavesSpec([...WAVES, { env: "qa", gate: "never", approval: "ledger" }]);
    expect(spec.waves.map((w) => w.approval)).toEqual(["pr-review", "sealed", undefined]);
  });

  it("renders the plans workflow on GitHub and Forgejo, with every environment's reader and no writer", async () => {
    const files = await applyPipelines(project(), envs);
    for (const forge of ["github", "forgejo"] as const) {
      const path = `.${forge}/workflows/yodel-apply-plans.yml`;
      const file = files.find((f) => f.path === path);
      expect(file, path).toBeDefined();
      const doc = parseYAMLDocument(file?.content ?? "") as { on: Record<string, unknown>; permissions?: Record<string, string>; jobs: Record<string, { env: Record<string, string>; steps: Array<{ run?: string }> }> };
      expect(Object.keys(doc.on)).toEqual(["pull_request"]);
      const job = doc.jobs["record-plans"];
      expect(job?.steps.some((s) => s.run === "chant run wave --spec yodel-waves.json --record-plans")).toBe(true);
      expect(job?.env[RECORD_PLANS_ENV]).toBe("1");
      expect(Object.keys(job?.env ?? {})).toEqual(expect.arrayContaining(["DEV_POSTGRES_URL", "DEV_POSTGRES_READER_USER", "PROD_POSTGRES_READER_PASSWORD"]));
      expect(Object.keys(job?.env ?? {}).filter((k) => k.includes("WRITER"))).toEqual([]);
      expect(file?.content).toMatch(/approving review of that head by a writer\n# other than its author/);
      // The pr-review wave's job reads the merged pull request's reviews with the job's token; the sealed wave's does not need it.
      const apply = parseYAMLDocument(files.find((f) => f.path === `.${forge}/workflows/yodel-apply.yml`)?.content ?? "") as { permissions?: Record<string, string>; jobs: Record<string, { env?: Record<string, string> }> };
      expect(apply.jobs["wave-1-dev"]?.env?.GITHUB_TOKEN).toBe("${{ github.token }}");
      expect(apply.jobs["wave-2-prod"]?.env?.GITHUB_TOKEN).toBeUndefined();
      if (forge === "github") expect(apply.permissions?.["pull-requests"]).toBe("read");
    }
    const spec = JSON.parse(files.find((f) => f.path === "yodel-waves.json")?.content ?? "{}") as { waves: Array<{ approval?: string }> };
    expect(spec.waves.map((w) => w.approval)).toEqual(["pr-review", "sealed"]);
  });

  it("renders GitLab's merge request job that records the plans, in a stage of its own", async () => {
    const files = await applyPipelines(project(), envs);
    const apply = parseYAMLDocument(files.find((f) => f.path === ".gitlab/yodel-apply.gitlab-ci.yml")?.content ?? "") as Record<string, { stage?: string; variables?: Record<string, string>; rules?: Array<{ if: string }>; script?: string[] }>;
    const job = apply["yodel-apply-record-plans"];
    expect(job?.stage).toBe("plans");
    expect(job?.variables?.[RECORD_PLANS_ENV]).toBe("1");
    expect(job?.rules?.[0]?.if).toBe('$CI_PIPELINE_SOURCE == "merge_request_event"');
    expect(job?.script?.at(-1)).toBe("chant run wave --spec yodel-waves.json --record-plans");
    const main = parseYAMLDocument(gitlabPipeline(envs).content) as { stages: string[] };
    expect(main.stages.slice(0, 3)).toEqual(["review", "plans", "wave-1-dev"]);
  });

  it("renders no plans job when no wave is pr-review", async () => {
    const files = await applyPipelines(project(), { ...envs, waves: WAVES.map((w) => ({ ...w, approval: "sealed" as const })) });
    expect(files.some((f) => f.path.endsWith("yodel-apply-plans.yml"))).toBe(false);
    expect(files.find((f) => f.path === ".gitlab/yodel-apply.gitlab-ci.yml")?.content).not.toContain("record-plans");
    expect((parseYAMLDocument(gitlabPipeline({ ...envs, waves: [] }).content) as { stages: string[] }).stages).not.toContain("plans");
  });
});
