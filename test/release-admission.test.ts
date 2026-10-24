/**
 * What a release record carries beyond the schema (#277): the admission and
 * approver of a gated apply, the digest of the chant release an apply was
 * made from; and readers that take every such field as optional.
 */

import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { persistRelease, makeRelease } from "@intentius/chant/lifecycle/release-store";
import { appendReleaseRecord, readReleaseLedger } from "@intentius/chant/lifecycle/release-ledger";
import { memoryGateLedgerPort } from "@intentius/chant/op/gate";
import type { BuildOutput } from "../src/chant/build.js";
import { loadProject, type Environment, type SqlProfile } from "../src/project.js";
import { recordRelease, releaseToApply } from "../src/release/index.js";
import { deriveAudit } from "../src/report/audit.js";
import { verifyApproval } from "../src/versioned/approval.js";
import type { MigrateOpRef } from "../src/versioned/op.js";
import { projectFrom } from "./helpers/run.js";

const DIGEST = `jcs1-sha256:${"a".repeat(64)}`;
const op = { name: "migrate-dev", gate: "approve-migrate-dev" } as MigrateOpRef;
const resolution = (resolvedBy: string, timestamp: string, planDigest = DIGEST) => ({ version: 1 as const, op: op.name, gate: op.gate, resolvedBy, timestamp, planDigest });

describe("verifyApproval names the admission", () => {
  it("gives the approver and the resolution that admitted the apply, from chant's admissionOf", async () => {
    const port = memoryGateLedgerPort({ resolutions: [resolution("alice", "2026-10-10T09:00:00.000Z")] });
    expect(await verifyApproval(port, op, DIGEST)).toMatchObject({
      resolvedBy: "alice",
      approver: "alice",
      admission: { op: "migrate-dev", gate: "approve-migrate-dev", resolvedAt: "2026-10-10T09:00:00.000Z" },
    });
  });

  it("joins every approver of the plan, and takes the newest resolution's time", async () => {
    const port = memoryGateLedgerPort({ resolutions: [resolution("alice", "2026-10-10T09:00:00.000Z"), resolution("bob", "2026-10-10T09:05:00.000Z")] });
    const by = await verifyApproval(port, op, DIGEST);
    expect(by.approver.split(", ").sort()).toEqual(["alice", "bob"]);
    expect(by.admission.resolvedAt).toBe("2026-10-10T09:05:00.000Z");
  });
});

describe("the release record", () => {
  const p = projectFrom("clickhouse-versioned");
  afterAll(() => {
    p.dispose();
  });
  const env = (name: string): Environment => ({ name, profile: {} as SqlProfile });
  const schema = { dialect: "clickhouse", objects: { a: 1 } } as unknown as BuildOutput;
  const admission = { op: "migrate-dev", gate: "approve-migrate-dev", resolvedAt: "2026-10-10T09:00:00.000Z" };

  it("carries admission and approver of a gated apply, and releaseDigest of one made from a release; an ungated apply carries none", async () => {
    const project = await loadProject(p.dir);
    await recordRelease(project, env("plain"), schema);
    await recordRelease(project, env("gated"), schema, { approver: "alice", admission });
    await recordRelease(project, env("released"), schema, { approver: "alice", admission, releaseDigest: "sha256:rel" });
    const read = async (e: string) => (await readReleaseLedger(e, { cwd: p.dir })).records[0] as unknown as Record<string, unknown>;
    const plain = await read("plain");
    expect(plain).not.toHaveProperty("admission");
    expect(plain).not.toHaveProperty("approver");
    expect(plain).not.toHaveProperty("releaseDigest");
    const gated = await read("gated");
    expect(gated).toMatchObject({ approver: "alice", admission });
    expect(gated).not.toHaveProperty("releaseDigest");
    expect(await read("released")).toMatchObject({ approver: "alice", admission, releaseDigest: "sha256:rel" });
  }, 60_000);

  it("reads a ledger of old and new lines mixed, without rewriting the old ones", async () => {
    const project = await loadProject(p.dir);
    const gitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: p.dir, encoding: "utf8" }).trim();
    const old = { component: "schema", env: "mixed", digest: "sha256:old", gitSha, runId: "r0", timestamp: "2026-10-01T00:00:00.000Z", actor: "ci" };
    await appendReleaseRecord({ ...old, unknownFromLater: { x: 1 } } as never, { cwd: p.dir });
    const before = (await readReleaseLedger("mixed", { cwd: p.dir })).records.length;
    await recordRelease(project, env("mixed"), schema, { approver: "alice", admission });
    const { records } = await readReleaseLedger("mixed", { cwd: p.dir });
    expect(before).toBe(1);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ digest: "sha256:old", runId: "r0" });
    expect(records[0]).not.toHaveProperty("admission");
    expect(records[1]).toMatchObject({ approver: "alice", admission });
  }, 60_000);

  it("applies from a release only at the commit it was cut at, and refuses a ref no release answers to", async () => {
    const gitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: p.dir, encoding: "utf8" }).trim();
    await expect(releaseToApply(p.dir, "v9")).rejects.toThrow(/no chant release/);
    const here = makeRelease({ member: null, commit: gitSha, artifactDigests: [], targets: [] });
    await persistRelease(here, [], { cwd: p.dir });
    expect(await releaseToApply(p.dir, here.releaseDigest)).toBe(here.releaseDigest);
    const elsewhere = makeRelease({ member: null, commit: "0".repeat(40), artifactDigests: [], targets: [] });
    await persistRelease(elsewhere, [], { cwd: p.dir });
    await expect(releaseToApply(p.dir, elsewhere.releaseDigest)).rejects.toThrow(/was cut at 000000000000/);
  }, 60_000);
});

describe("the audit log over a gate ledger of old and new lines", () => {
  it("shows a pending fact without gitSha or runId as it is, ignores unknown keys, and reads the new fields", () => {
    const pending = (timestamp: string, extra: Record<string, unknown>) => ({ record: { version: 1, kind: "pending", op: op.name, gate: op.gate, expiresAt: "", timestamp, planDigest: DIGEST, ...extra } });
    const lines = [
      pending("2026-10-10T08:00:00.000Z", {}),
      pending("2026-10-10T08:30:00.000Z", { gitSha: "abc", runId: "run-9", runOrigin: { forge: "github" }, later: true }),
      { record: { ...resolution("alice", "2026-10-10T08:40:00.000Z"), gitSha: "abc", runId: "run-9", carriedFrom: undefined, later: [1] } },
    ];
    const { entries } = deriveAudit({ environment: "dev", history: "h", rows: [], ledger: { op: op.name, gate: op.gate, path: "_gates/migrate-dev.jsonl", lines } });
    const asked = entries.filter((e) => e.kind === "approval-requested");
    expect(asked).toHaveLength(2);
    expect(asked[0]?.detail).toBeUndefined();
    expect(asked[1]?.detail).toBe("run run-9");
    expect(entries.filter((e) => e.kind === "approved").map((e) => e.by)).toEqual(["alice"]);
  });
});
