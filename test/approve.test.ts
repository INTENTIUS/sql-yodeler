import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import type { GateResolutionRecord, PendingGateRecord } from "@intentius/chant/lifecycle/gate-ledger";
import { gitGateLedgerPort } from "@intentius/chant/op/gate";
import { approveDeclarative, approveOther, chantApproveArgs, standingGate, type OtherContext } from "../src/commands/approve.js";
import type { Io } from "../src/command.js";
import { approveCommand } from "../src/approval-mode/index.js";
import { findApplyOp } from "../src/chant/apply.js";
import { findMigrateOp } from "../src/versioned/index.js";
import { loadProject, resolveEnvironment, type Environment, type Project } from "../src/project.js";
import { installedLocally, onPath, runnable } from "../src/chant/runnable.js";
import { renderPlanText } from "../src/pr/render.js";
import type { VersionedPlan } from "../src/pr/model.js";
import { fixture, projectFrom } from "./helpers/run.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A project directory with `node_modules/.bin/<tools>`, and a PATH directory with `<global>`. */
function layout(tools: string[], global: string[] = []): { project: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "yodel-runnable-"));
  dirs.push(root);
  const bin = join(root, "project", "node_modules", ".bin");
  const path = join(root, "global");
  mkdirSync(bin, { recursive: true });
  mkdirSync(path);
  for (const [dir, names] of [[bin, tools], [path, global]] as const) {
    for (const t of names) {
      writeFileSync(join(dir, t), "#!/bin/sh\n");
      chmodSync(join(dir, t), 0o755);
    }
  }
  return { project: join(root, "project"), path };
}

describe("the approve command yodel prints runs as printed (#14)", () => {
  it("is npx chant ... when chant is installed in the project but not on PATH", () => {
    const { project, path } = layout(["chant", "yodel"]);
    const env = { PATH: path };
    expect(installedLocally("chant", join(project, "sub"))).toBe(true);
    expect(runnable("chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:00", project, env)).toBe("npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:00");
    expect(runnable("yodel apply dev", project, env)).toBe("npx yodel apply dev");
  });

  it("counts npx's node_modules/.bin on yodel's own PATH as not on the person's", () => {
    const { project, path } = layout(["chant"]);
    const env = { PATH: [join(project, "node_modules", ".bin"), path].join(":") };
    expect(onPath("chant", env)).toBe(false);
    expect(runnable("chant approve a b --plan d", project, env)).toBe("npx chant approve a b --plan d");
  });

  it("is left as it is when chant is on PATH, or not installed in the project", () => {
    const onBoth = layout(["chant"], ["chant"]);
    expect(runnable("chant approve a b --plan d", onBoth.project, { PATH: onBoth.path })).toBe("chant approve a b --plan d");
    const nowhere = layout([]);
    expect(runnable("chant approve a b --plan d", nowhere.project, { PATH: nowhere.path })).toBe("chant approve a b --plan d");
  });

  it("plan's text names yodel approve with the digest, never chant approve (#202)", () => {
    const plan: VersionedPlan = {
      environment: "dev",
      dialect: "clickhouse",
      appliedCount: 0,
      pending: [],
      problems: [],
      notes: [],
      digest: "jcs1-sha256:00",
      approval: { kind: "op", op: "migrate-dev", gate: "approve-migrate-dev", command: approveCommand("dev", "jcs1-sha256:00"), chantCommand: "chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:00" },
    };
    const text = renderPlanText(plan, { runnable: (c) => `npx ${c}` });
    expect(text).toContain("Approve it at a terminal with:\n  npx yodel approve dev --plan jcs1-sha256:00\nwhich shows the plan and asks you first.");
    expect(text).not.toContain("chant approve");
  });

  it("is yodel approve <env> --plan <digest>, with --sign where the gate is sealed", () => {
    expect(approveCommand("prod", "jcs1-sha256:00")).toBe("yodel approve prod --plan jcs1-sha256:00");
    expect(approveCommand("prod", "jcs1-sha256:00", "sealed")).toBe("yodel approve prod --plan jcs1-sha256:00 --sign");
    expect(approveCommand("prod", "jcs1-sha256:00", "pr-review")).toBe("yodel approve prod --plan jcs1-sha256:00");
    expect(approveCommand("prod/acme", undefined)).toBe("yodel approve prod/acme");
  });
});

describe("yodel approve", () => {
  const capture = (ask?: Io["ask"]) => {
    let out = "";
    let err = "";
    const io: Io = { out: (t) => (out += t), err: (t) => (err += t), ...(ask ? { ask } : {}) };
    return { io, text: () => ({ out, err }) };
  };

  it("approves nothing without a terminal to ask, before reading the server, and has no flag that skips the question", async () => {
    const c = capture();
    const code = await main(["approve", "e2e", "--dir", fixture("lint-clickhouse")], c.io);
    expect(code).toBe(4);
    expect(c.text().err).toContain("there is no terminal to ask, so nothing was approved");
    const forced = capture();
    expect(await main(["approve", "e2e", "--yes", "--dir", fixture("lint-clickhouse")], forced.io)).toBe(1);
    expect(forced.text().err).toContain("Unknown option '--yes'");
  });

  it("approves nothing in a declarative project without a terminal either", async () => {
    const c = capture();
    expect(await main(["approve", "e2e", "--dir", fixture("clickhouse")], c.io)).toBe(4);
    expect(c.text().err).toContain("there is no terminal to ask, so nothing was approved");
  });
});

describe("standingGate: the plan a gate waits on (#202)", () => {
  const at = (m: number) => new Date(Date.UTC(2026, 9, 10, 9, m)).toISOString();
  const pending = (gate: string, digest: string | undefined, m: number, expires = 60): PendingGateRecord => ({
    version: 1, kind: "pending", op: "o", gate, timestamp: at(m), expiresAt: at(m + expires), ...(digest ? { planDigest: digest } : {}),
  });
  const resolution = (gate: string, digest: string, m: number): GateResolutionRecord => ({ version: 1, kind: "resolution", op: "o", gate, resolvedBy: "alice", timestamp: at(m), planDigest: digest });

  it("is the newest live pending fact of the gate", () => {
    const ledger = { pending: [pending("g", "d1", 0), pending("g", "d2", 5), pending("other", "d3", 6)], resolutions: [] };
    expect(standingGate(ledger, "o", "g", at(10))).toEqual({ op: "o", gate: "g", digest: "d2", at: at(5) });
  });

  it("is nothing once it expired, binds no plan, or an approval of its plan came after it", () => {
    expect(standingGate({ pending: [pending("g", "d1", 0, 5)], resolutions: [] }, "o", "g", at(10))).toBeUndefined();
    expect(standingGate({ pending: [pending("g", undefined, 0)], resolutions: [] }, "o", "g", at(10))).toBeUndefined();
    expect(standingGate({ pending: [pending("g", "d1", 0)], resolutions: [resolution("g", "d1", 1)] }, "o", "g", at(10))).toBeUndefined();
    // An approval of another plan, or one from before the gate asked, does not answer it.
    expect(standingGate({ pending: [pending("g", "d1", 2)], resolutions: [resolution("g", "d0", 3), resolution("g", "d1", 1)] }, "o", "g", at(10))?.digest).toBe("d1");
  });
});

describe("yodel approve in a declarative project (#202)", () => {
  const disposers: Array<() => void> = [];
  afterEach(() => {
    for (const d of disposers.splice(0)) d();
  });

  /** The clickhouse fixture with its ApplyOp's gate waiting on `digest`, as yodel apply leaves it. */
  async function waiting(digest?: string) {
    const { dir, dispose } = projectFrom("clickhouse");
    disposers.push(dispose);
    const project = await loadProject(dir);
    const env = resolveEnvironment(project, "e2e");
    const op = await findApplyOp(project, env);
    if (digest) {
      const now = Date.now();
      await gitGateLedgerPort({ cwd: dir }).appendPending({ op: op.name, gate: op.gate, timestamp: new Date(now).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString(), planDigest: digest });
    }
    return { project, env, op };
  }

  const context = (w: Awaited<ReturnType<typeof waiting>>, answer: string, expected?: string) => {
    let out = "";
    let err = "";
    const ran: string[][] = [];
    const asked: string[] = [];
    const c: OtherContext = {
      project: w.project,
      env: w.env,
      expected,
      ask: (q) => {
        asked.push(q);
        return Promise.resolve(answer);
      },
      io: { out: (t) => (out += t), err: (t) => (err += t) },
      resuming: () => Promise.resolve(false),
      signing: () => ({}),
      run: (args) => {
        ran.push([...args]);
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
    };
    return { c, ran, asked, text: () => ({ out, err }) };
  };
  const shown = (project: Project, env: Environment, io: Io) => {
    io.out(`(the plan for ${env.name})\n`);
    return Promise.resolve();
  };
  const digest = `jcs1-sha256:${"a".repeat(64)}`;

  it("shows the plan, asks, and approves the digest the ApplyOp's gate waits on", async () => {
    const w = await waiting(digest);
    const t = context(w, "e2e");
    expect(await approveDeclarative(t.c, undefined, shown)).toBe(0);
    expect(t.text().out).toContain("(the plan for e2e)");
    expect(t.text().out).toContain(`${w.op.name} is waiting at gate "${w.op.gate}" for approval of ${digest}`);
    expect(t.asked[0]).toContain("Type e2e to approve");
    expect(t.ran).toEqual([["approve", w.op.name, w.op.gate, "--plan", digest]]);
    expect(t.text().out).toContain(`Approved ${digest} for ${w.op.name} / ${w.op.gate}`);
  });

  it("takes --plan when it is the plan that waits, and refuses another, naming the one that waits", async () => {
    const w = await waiting(digest);
    const same = context(w, "e2e", digest);
    expect(await approveDeclarative(same.c, undefined, shown)).toBe(0);
    expect(same.ran).toHaveLength(1);
    const other = context(w, "e2e", "jcs1-sha256:other");
    expect(await approveDeclarative(other.c, undefined, shown)).toBe(4);
    expect(other.text().err).toContain(`--plan jcs1-sha256:other is not the plan waiting for e2e, which is ${digest}. Nothing was approved.`);
    expect(other.ran).toEqual([]);
  });

  it("approves nothing on a wrong answer", async () => {
    const w = await waiting(digest);
    const t = context(w, "prod");
    expect(await approveDeclarative(t.c, undefined, shown)).toBe(4);
    expect(t.text().err).toContain("Not approved: the answer was not e2e.");
    expect(t.ran).toEqual([]);
  });

  it("says there is nothing to approve when no run waits at the gate", async () => {
    const w = await waiting();
    const t = context(w, "e2e");
    expect(await approveDeclarative(t.c, undefined, shown)).toBe(0);
    expect(t.text().out).toMatch(/Nothing waits at apply-e2e \/ .*: there is nothing to approve/);
    const meant = context(w, "e2e", digest);
    expect(await approveDeclarative(meant.c, undefined, shown)).toBe(4);
    expect(t.ran).toEqual([]);
  });
});

describe("yodel approve <env> --plan for a plan the migrations Op stopped for (#202)", () => {
  it("approves a revert or a baseline record waiting at the gate, by its digest", async () => {
    const { dir, dispose } = projectFrom("lint-clickhouse");
    try {
      const project = await loadProject(dir);
      const env = resolveEnvironment(project, "e2e");
      const op = await findMigrateOp(project, env);
      const digest = `jcs1-sha256:${"b".repeat(64)}`;
      const now = Date.now();
      await gitGateLedgerPort({ cwd: dir }).appendPending({ op: op.name, gate: op.gate, timestamp: new Date(now).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString(), planDigest: digest });
      const ran: string[][] = [];
      let out = "";
      const c: OtherContext = {
        project, env, expected: digest, ask: () => Promise.resolve("e2e"), io: { out: (t) => (out += t), err: () => undefined },
        resuming: () => Promise.resolve(false), signing: (mode) => (mode === "sealed" ? { sign: true } : {}),
        run: (args) => {
          ran.push([...args]);
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        },
      };
      expect(await approveOther(c)).toBe(0);
      expect(ran).toEqual([["approve", op.name, op.gate, "--plan", digest]]);
      expect(out).toContain(`${op.name} is waiting at gate "${op.gate}" for approval of ${digest}`);
      expect(await approveOther({ ...c, expected: "jcs1-sha256:nothing" })).toBeUndefined();
    } finally {
      dispose();
    }
  });
});

describe("yodel approve resumes the waiting job (#47)", () => {
  const digest = `jcs1-sha256:${"0".repeat(64)}`;

  it("asks chant to resume the job by default, for the migrations Op's gate and for a wave's gate", () => {
    expect(chantApproveArgs("migrate-dev", "approve-migrate-dev", digest, true)).toEqual(["approve", "migrate-dev", "approve-migrate-dev", "--plan", digest, "--resume"]);
    expect(chantApproveArgs("yodel-apply", "yodel-apply-wave-2", digest, true)).toEqual(["approve", "yodel-apply", "yodel-apply-wave-2", "--plan", digest, "--resume"]);
  });

  it("records only with --no-resume", () => {
    expect(chantApproveArgs("migrate-dev", "approve-migrate-dev", digest, false)).toEqual(["approve", "migrate-dev", "approve-migrate-dev", "--plan", digest]);
    expect(chantApproveArgs("yodel-apply", "yodel-apply-wave-1", digest, false)).not.toContain("--resume");
  });

  it("takes --plan and --no-resume, and its help names each forge's token", async () => {
    let out = "";
    expect(await main(["approve", "--help"], { out: (t) => (out += t), err: () => undefined })).toBe(0);
    expect(out).toContain("--no-resume");
    expect(out).toContain("--plan <digest>");
    expect(out).toMatch(/GitHub needs actions: write, GitLab the api scope with the Developer role,\s+Forgejo write:repository/);
  });
});
