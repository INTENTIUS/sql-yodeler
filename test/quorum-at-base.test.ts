/**
 * `yodel apply --execute` counts a gate's quorum (#278, chant#4324) by the
 * rules `identity.gates.<gate>.quorum` sets in chant.workspace.json at the
 * base commit, through chant's own tally. A quorum only the Op declares, and
 * a change that lowers it, count for nothing.
 *
 * The port reads its rule from a real git repository: `main` is the base, a
 * branch checked out on top is the change being run.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { GateResolutionRecord } from "@intentius/chant/lifecycle/gate-ledger";
import { gitGateLedgerPort, memoryGateLedgerPort, type GateLedgerPort } from "@intentius/chant/op/gate";
import { sealGateApproval } from "@intentius/chant/workspace/trust/seal";
import { NOT_APPROVED, verifyApproval } from "../src/versioned/approval.js";
import type { MigrateOpRef } from "../src/versioned/op.js";

const DIGEST = `jcs1-sha256:${"a".repeat(64)}`;
const GATE = "approve-migrate-prod";
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const hasSshKeygen = spawnSync("ssh-keygen", ["-Y"], { stdio: "ignore" }).error === undefined;

const keyDir = mkdtempSync(join(tmpdir(), "yodel-quorum-keys-"));
dirs.push(keyDir);
const key = (name: string) => {
  if (!hasSshKeygen) return { file: "", pub: "" };
  const file = join(keyDir, name);
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", name, "-f", file]);
  return { file, pub: readFileSync(`${file}.pub`, "utf8").trim().split(" ").slice(0, 2).join(" ") };
};
const keys: Record<string, { file: string; pub: string }> = { alice: key("alice"), bob: key("bob") };

/** chant.workspace.json declaring the gate's quorum (none: the gate has no entry). The gate is then sealed-only, as any `identity.gates` gate is. */
const declaration = (quorum?: unknown) =>
  `${JSON.stringify({ name: "acme", schema: 1, members: [], identity: { gates: quorum ? { [GATE]: { quorum } } : {} } }, null, 2)}\n`;

/** A repository whose `main` declares `atBase` as the gate's quorum, signed by alice and bob, checked out on a branch whose own declaration has `inChange`. */
function repo(atBase: unknown, inChange: unknown = atBase) {
  const dir = mkdtempSync(join(tmpdir(), "yodel-quorum-base-"));
  dirs.push(dir);
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  mkdirSync(join(dir, ".chant"));
  writeFileSync(join(dir, ".chant", "allowed_signers"), Object.entries(keys).map(([n, k]) => `${n} ${k.pub}\n`).join(""));
  writeFileSync(join(dir, "chant.workspace.json"), declaration(atBase));
  git("add", "-A");
  git("commit", "-qm", "base");
  git("checkout", "-q", "-b", "change");
  writeFileSync(join(dir, "chant.workspace.json"), declaration(inChange));
  git("commit", "-qam", "the change", "--allow-empty");
  return dir;
}

const approval = (resolvedBy: string, timestamp: string, sealed: boolean): GateResolutionRecord => {
  const a = { op: "migrate-prod", gate: GATE, resolvedBy, timestamp, planDigest: DIGEST, approver: { kind: "human" as const } };
  return { version: 1, ...a, ...(sealed ? { seal: sealGateApproval(keys[resolvedBy]?.file ?? "", a) } : {}) };
};

/** The ledger of `by`, with the gate's rule read from `dir` as chant's gate step reads it (at main). Sealed when the gate is in the declaration. */
const portFor = (dir: string, sealed: boolean, ...by: string[]): GateLedgerPort => ({
  ...memoryGateLedgerPort({ resolutions: by.map((b, i) => approval(b, `2026-10-10T09:0${String(i)}:00.000Z`, sealed)) }),
  approvalRule: (gate, at) => gitGateLedgerPort({ cwd: dir }).approvalRule?.(gate, at) ?? Promise.resolve(null),
  quorumJudge: (gate, at) => (gitGateLedgerPort({ cwd: dir }).quorumJudge as NonNullable<GateLedgerPort["quorumJudge"]>)(gate, at),
});

const op = (quorum: boolean): MigrateOpRef => ({ name: "migrate-prod", filePath: "ops/migrate-prod.op.ts", gate: GATE, quorum });

describe.skipIf(!hasSshKeygen)("a quorum at base, counted by --execute", () => {
  it("passes when the quorum at base is met, and names every approver", async () => {
    const dir = repo({ count: 2 });
    const by = await verifyApproval(portFor(dir, true, "alice", "bob"), op(false), DIGEST);
    expect(by.approver.split(", ").sort()).toEqual(["alice", "bob"]);
    expect(by).toMatchObject({ resolvedBy: "bob", admission: { op: "migrate-prod", gate: GATE, resolvedAt: "2026-10-10T09:01:00.000Z" } });
  });

  it("refuses, saying what is missing, when the quorum at base is not met", async () => {
    const dir = repo({ count: 2 });
    await expect(verifyApproval(portFor(dir, true, "alice"), op(false), DIGEST)).rejects.toMatchObject({ exitCode: NOT_APPROVED, message: expect.stringMatching(/quorum at base is not met/) as unknown });
    // One person approving twice is one approver.
    await expect(verifyApproval(portFor(dir, true, "alice", "alice"), op(false), DIGEST)).rejects.toThrow(/quorum at base is not met/);
  });

  it("counts the quorum at base when a change lowers the Op's own", async () => {
    // The Op in the change asks for one approver; the base asks for two.
    const dir = repo({ count: 2 });
    await expect(verifyApproval(portFor(dir, true, "alice"), op(true), DIGEST)).rejects.toThrow(/quorum at base is not met/);
    await expect(verifyApproval(portFor(dir, true, "alice", "bob"), op(true), DIGEST)).resolves.toMatchObject({ resolvedBy: "bob" });
  });

  it("counts the quorum at base when the change lowers the declaration itself", async () => {
    const dir = repo({ count: 2 }, { count: 1 });
    await expect(verifyApproval(portFor(dir, true, "alice"), op(true), DIGEST)).rejects.toThrow(/quorum at base is not met/);
    await expect(verifyApproval(portFor(dir, true, "alice", "bob"), op(true), DIGEST)).resolves.toMatchObject({ resolvedBy: "bob" });
  });

  it("counts nothing from a quorum declared only in the Op, with none at base", async () => {
    const dir = repo(undefined);
    await expect(verifyApproval(portFor(dir, false, "alice", "bob"), op(true), DIGEST)).rejects.toMatchObject({
      exitCode: NOT_APPROVED,
      message: expect.stringMatching(/declared only in the Op.*identity\.gates\.approve-migrate-prod\.quorum/s) as unknown,
    });
    // And one the change adds to the declaration is no quorum at base.
    const added = repo(undefined, { count: 1 });
    await expect(verifyApproval(portFor(added, false, "alice"), op(true), DIGEST)).rejects.toThrow(/declared only in the Op/);
  });

  it("still takes one approval for a gate with no quorum anywhere", async () => {
    const dir = repo(undefined);
    await expect(verifyApproval(portFor(dir, false, "alice"), op(false), DIGEST)).resolves.toMatchObject({ resolvedBy: "alice" });
  });

  it("refuses a gate policy, which only the gate step evaluates", async () => {
    const dir = repo({ count: 1 });
    await expect(verifyApproval(portFor(dir, true, "alice"), { ...op(true), policy: true }, DIGEST)).rejects.toThrow(/policy/);
  });
});
