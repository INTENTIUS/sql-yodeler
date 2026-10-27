/**
 * The migrations Op's gate on chant 0.124.46: the run after an approval
 * resumes at the gate (chant#3947), and a renamed gate keeps its recorded
 * approvals through an alias (chant#3949).
 *
 * These run the real `chant run` and `chant approve` on the starter
 * template's Op, in a git repository of its own. The `yodel` on the Op's
 * PATH is a stand-in that prints a fixed digest for `--digest` and logs each
 * call, so no server is needed. The e2e suite (test/e2e/versioned.test.ts)
 * checks the same resume against a server through `yodel apply`.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { memoryGateLedgerPort } from "@intentius/chant/op/gate";
import { readApplyRun } from "../src/chant/apply.js";
import { runChant } from "../src/chant/process.js";
import { chantApproveArgs } from "../src/commands/approve.js";
import { projectFromConfig } from "../src/project.js";
import { gitLedger, verifyApproval } from "../src/versioned/approval.js";
import { migrateOpParts, selectMigrateOp, type MigrateOpRef } from "../src/versioned/op.js";
import { EXIT_WAITING } from "../src/exit.js";

const ROOT = resolve(import.meta.dirname, "..");
const TEMPLATE_OP = readFileSync(join(ROOT, "templates/postgres/ops/migrate-dev.op.ts"), "utf8");
const DIGEST = `jcs1-sha256:${"a".repeat(64)}`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A git repository holding the template's migrate-dev Op, a stand-in yodel, and the worktree's node_modules. */
function repo(op = TEMPLATE_OP) {
  const dir = mkdtempSync(join(tmpdir(), "yodel-gate-resume-"));
  dirs.push(dir);
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
  mkdirSync(join(dir, "ops"));
  mkdirSync(join(dir, "bin"));
  const log = join(dir, "yodel.log");
  writeFileSync(
    join(dir, "bin", "yodel"),
    `#!/bin/sh\necho "$*" >> '${log}'\ncase "$3" in --digest) echo '${DIGEST}';; --execute) echo "applied $YODEL_APPROVED_PLAN";; esac\n`,
  );
  chmodSync(join(dir, "bin", "yodel"), 0o755);
  writeFileSync(join(dir, ".gitignore"), "node_modules\nyodel.log\n");
  writeFileSync(join(dir, "ops", "migrate-dev.op.ts"), op);
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=tester", "-c", "user.email=tester@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-qm", "init");
  const env = { ...process.env, PATH: [join(dir, "bin"), process.env.PATH ?? ""].join(delimiter) };
  const run = async () => {
    const r = await runChant(["run", "migrate-dev", "--gated-exit", String(EXIT_WAITING)], { cwd: dir, env });
    return readApplyRun(r.code, `${r.stdout}\n${r.stderr}`);
  };
  const approve = async (gate: string) => {
    const r = await runChant(chantApproveArgs("migrate-dev", gate, DIGEST, false, { actor: "tester" }), { cwd: dir, env });
    expect(r.code, r.stderr).toBe(0);
    return r;
  };
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  const commit = (file: string, text: string) => {
    writeFileSync(join(dir, file), text);
    git("add", "-A");
    git("commit", "-qm", `edit ${file}`);
  };
  return { dir, run, approve, calls, commit };
}

const project = projectFromConfig("/p", "/p/chant.config.ts", { lexicons: ["sql"], sql: { dialect: "postgres" } });
const dev = { name: "dev", profile: { url: "postgres://x:5432/app" } };

/** The project's migrations Op for dev, as yodel apply finds it. */
async function findOp(dir: string): Promise<MigrateOpRef> {
  const { discoverOps } = await import("@intentius/chant/op/discover");
  const found = await discoverOps({ cwd: dir });
  return selectMigrateOp(found.ops, project, dev);
}

describe("the run after yodel approve (chant#3947)", () => {
  it("resumes at the template's gate: chant reports the gate it resumed at, the plan runs again, the apply once", async () => {
    expect(TEMPLATE_OP).toContain(`gate("approve-migrate-dev", { plan: digest, resume: true })`);
    const r = repo();

    const gated = await r.run();
    expect(gated.status).toBe("gated");
    expect(gated.planDigest).toBe(DIGEST);
    expect(gated.output).toMatch(/resume\s*: once approved, the next run starts at this gate \(checkpoint jcs1-sha256:[0-9a-f]{64}\)/);
    expect(gated.resumed).toBeUndefined();

    const approved = await r.approve("approve-migrate-dev");
    expect(approved.stderr).toMatch(/The next run resumes at this gate from run \S+'s checkpoint jcs1-sha256:[0-9a-f]{64}/);

    const second = await r.run();
    expect(second.status, second.output).toBe("applied");
    expect(second.resumed).toMatchObject({ gate: "approve-migrate-dev", checkpoint: expect.stringMatching(/^jcs1-sha256:[0-9a-f]{64}$/) as unknown });
    expect(r.calls()).toEqual(["apply dev --digest", "apply dev --digest", "apply dev --execute"]);

    // --execute's own check reads the same ledger and finds the approval.
    await expect(verifyApproval(await gitLedger(r.dir), await findOp(r.dir), DIGEST)).resolves.toMatchObject({ resolvedBy: "tester" });
  });

  it("starts at the first phase when the Op's commit moved since the gated run, and still applies on the approval", async () => {
    const r = repo();
    await r.run();
    await r.approve("approve-migrate-dev");
    r.commit("README.md", "another commit\n");
    const second = await r.run();
    expect(second.status, second.output).toBe("applied");
    expect(second.resumed).toBeUndefined();
    expect(second.output).toMatch(/\[resume\] .*commit/);
  });
});

describe("renaming the migrations Op's gate (chant#3949)", () => {
  const renamed = (aliases: string) => TEMPLATE_OP.replace(`gate("approve-migrate-dev", { plan: digest, resume: true })`, `gate("approve-dev", { plan: digest${aliases} })`);

  it("keeps the approval recorded under the old name through an alias, and --execute counts the carried line", async () => {
    const r = repo();
    expect((await r.run()).status).toBe("gated");
    await r.approve("approve-migrate-dev");

    r.commit("ops/migrate-dev.op.ts", renamed(`, aliases: [{ gate: "approve-migrate-dev" }]`));
    const op = await findOp(r.dir);
    expect(op).toMatchObject({ gate: "approve-dev", aliases: [{ op: "migrate-dev", gate: "approve-migrate-dev" }] });

    const after = await r.run();
    expect(after.status, after.output).toBe("applied");
    expect(after.output).toContain("[carried] tester's approval of migrate-dev/approve-migrate-dev");
    expect(r.calls().filter((c) => c.endsWith("--execute"))).toHaveLength(1);

    const ledger = await gitLedger(r.dir);
    await expect(verifyApproval(ledger, op, DIGEST)).resolves.toMatchObject({ resolvedBy: "tester" });
    // Drop the alias and the carried line stops counting, as it does for chant's gate.
    await expect(verifyApproval(ledger, { ...op, aliases: [] }, DIGEST)).rejects.toMatchObject({ exitCode: EXIT_WAITING });
  });

  it("without the alias, the renamed gate asks for approval again", async () => {
    const r = repo();
    await r.run();
    await r.approve("approve-migrate-dev");
    r.commit("ops/migrate-dev.op.ts", renamed(""));
    const after = await r.run();
    expect(after.status).toBe("gated");
    expect(r.calls().filter((c) => c.endsWith("--execute"))).toHaveLength(0);
  });
});

describe("the gate's parts as yodel reads them", () => {
  const plan = { kind: "activity" as const, fn: "shellCmd", id: "plan", args: { cmd: "yodel apply dev --digest" } };
  const execute = { kind: "activity" as const, fn: "shellCmd", args: { cmd: "yodel apply dev --execute", env: {} } };
  const gate = (extra: Record<string, unknown>) => ({ kind: "gate" as const, gate: "approve-dev", plan: { kind: "step-output-ref", step: "plan", path: "stdout" }, ...extra });
  const config = (g: unknown) => ({ name: "migrate-dev", overview: "", phases: [{ name: "all", steps: [plan, g, execute] }] }) as never;

  it("names each alias's Op, this one when the alias leaves it out", () => {
    expect(migrateOpParts(config(gate({ aliases: [{ gate: "old" }, { op: "migrate-dev-legacy", gate: "approve" }] })), "dev")).toEqual({
      gate: "approve-dev",
      quorum: false,
      aliases: [{ op: "migrate-dev", gate: "old" }, { op: "migrate-dev-legacy", gate: "approve" }],
    });
    expect(migrateOpParts(config(gate({})), "dev")).toEqual({ gate: "approve-dev", quorum: false });
  });

  it("reads chant's resume line off a run's output", () => {
    const out = `[resume] at gate "approve-dev", from run local-1's checkpoint jcs1-sha256:${"c".repeat(64)}\n[phase] Plan\n`;
    expect(readApplyRun(0, out).resumed).toEqual({ gate: "approve-dev", run: "local-1", checkpoint: `jcs1-sha256:${"c".repeat(64)}` });
    expect(readApplyRun(0, "[phase] Plan\n").resumed).toBeUndefined();
  });

  it("counts a carried approval only while the gate lists the alias it came from", async () => {
    const op: MigrateOpRef = { name: "migrate-dev", filePath: "/p/ops/migrate-dev.op.ts", gate: "approve-dev", quorum: false, aliases: [{ op: "migrate-dev", gate: "old" }] };
    const carried = (from: string) =>
      memoryGateLedgerPort({
        resolutions: [{ version: 1, op: op.name, gate: op.gate, resolvedBy: "alice", timestamp: "2026-10-09T12:00:00.000Z", planDigest: DIGEST, carriedFrom: { op: "migrate-dev", gate: from, timestamp: "2026-10-09T11:00:00.000Z" } }],
      });
    await expect(verifyApproval(carried("old"), op, DIGEST)).resolves.toMatchObject({ resolvedBy: "alice" });
    await expect(verifyApproval(carried("older"), op, DIGEST)).rejects.toMatchObject({ exitCode: EXIT_WAITING });
  });
});
