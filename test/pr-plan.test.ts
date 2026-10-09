import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { memoryGateLedgerPort } from "@intentius/chant/op/gate";
import { projectFromConfig, type Project } from "../src/project.js";
import { writeMigration, type Migration } from "../src/migrations/index.js";
import { currentDigest, executeApply, inspect, openVersioned, verifyApproval, type MigrateOpRef, type VersionedEnv } from "../src/versioned/index.js";
import { currentSubject, decodeSubject, diffSubjects, explainMove } from "../src/versioned/explain.js";
import { collectVersionedPlan } from "../src/pr/model.js";
import { renderPlanMarkdown, subjectIn } from "../src/pr/render.js";
import { FakeClickHouse, migration } from "./helpers/fake-clickhouse.js";

const m1 = migration("20261009T1000-one", null, ["CREATE DATABASE yodel_8", "CREATE TABLE yodel_8.a (x UInt8) ENGINE = MergeTree ORDER BY x"]);
const m2 = migration("20261009T1100-two", m1.id, ["ALTER TABLE yodel_8.a ADD COLUMN y UInt8"]);
const OP: MigrateOpRef = { name: "migrate-e2e", filePath: "/p/ops/migrate-e2e.op.ts", gate: "approve-migrate-e2e", quorum: false };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function setup(migrations: Migration[], ch = new FakeClickHouse()): Promise<{ ch: FakeClickHouse; venv: VersionedEnv; project: Project }> {
  const dir = mkdtempSync(join(tmpdir(), "yodel-pr-plan-"));
  dirs.push(dir);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  for (const m of migrations) writeMigration(join(dir, "migrations"), m);
  const url = `http://fake-${randomUUID()}:8123`;
  const project = projectFromConfig(dir, join(dir, "chant.config.ts"), { lexicons: ["sql"], sql: { dialect: "clickhouse", profiles: { e2e: { url, databases: ["yodel_8"] } } } });
  const venv = await openVersioned(project, { name: "e2e", profile: { url } }, { YODEL_HISTORY_DATABASE: "yodel_8_history" }, ch);
  return { ch, venv, project };
}

const env = { name: "e2e", profile: { url: "x" } };
const ledgerWith = (digest: string, at: string) => memoryGateLedgerPort({ resolutions: [{ version: 1, op: OP.name, gate: OP.gate, resolvedBy: "alice", timestamp: at, planDigest: digest }] });

async function digestOf(venv: VersionedEnv, ordered: Migration[]): Promise<string> {
  const { status } = await inspect(venv, ordered);
  return currentDigest(venv, status, status.pending);
}

describe("the versioned plan", () => {
  it("has the digest the gate binds (the Plan step's currentDigest) and the exact approve command", async () => {
    const { venv, project } = await setup([m1, m2]);
    const plan = await collectVersionedPlan(project, env, { venv, op: OP, ledger: memoryGateLedgerPort() });
    const gate = await digestOf(venv, [m1, m2]);
    expect(plan.digest).toBe(gate);
    expect(plan.approval).toEqual({ kind: "op", op: OP.name, gate: OP.gate, command: `chant approve migrate-e2e approve-migrate-e2e --plan ${gate}` });
    expect(plan.pending.map((p) => p.id)).toEqual([m1.id, m2.id]);
    expect(plan.pending[0]?.steps.map((s) => s.step.kind)).toEqual(["statement", "statement"]);
    const carried = subjectIn(renderPlanMarkdown(plan));
    expect(carried).toBeDefined();
    const { planDigest } = await import("../src/versioned/digest.js");
    expect(await planDigest(decodeSubject(carried ?? "") as never)).toBe(gate);
  });

  it("says an approval of this digest holds", async () => {
    const { venv, project } = await setup([m1]);
    const gate = await digestOf(venv, [m1]);
    const plan = await collectVersionedPlan(project, env, { venv, op: OP, ledger: ledgerWith(gate, "2026-10-09T12:00:00.000Z") });
    expect(plan.approval).toMatchObject({ kind: "op", latest: { holds: true, sameDigest: true, by: "alice", digest: gate } });
    expect(renderPlanMarkdown(plan)).toContain("Approved by alice at 2026-10-09T12:00:00.000Z: the apply after merge runs this plan.");
  });

  it("says an approval of this digest was asked for again after it, without a move to explain", async () => {
    const { venv, project } = await setup([m1]);
    const gate = await digestOf(venv, [m1]);
    // Approved at 12:00; a run that held another plan reached the gate at 13:00, so chant asks again.
    const ledger = memoryGateLedgerPort({
      resolutions: [{ version: 1, op: OP.name, gate: OP.gate, resolvedBy: "alice", timestamp: "2026-10-09T12:00:00.000Z", planDigest: gate }],
      pending: [{ version: 1, kind: "pending", op: OP.name, gate: OP.gate, timestamp: "2026-10-09T13:00:00.000Z", expiresAt: "2026-10-11T13:00:00.000Z", planDigest: "jcs1-sha256:other" }],
    });
    const plan = await collectVersionedPlan(project, env, { venv, op: OP, ledger });
    expect(plan.approval).toMatchObject({ kind: "op", latest: { holds: false, sameDigest: true, digest: gate, askedAgain: { at: "2026-10-09T13:00:00.000Z", digest: "jcs1-sha256:other" } } });
    expect(plan.approval?.kind === "op" && plan.approval.latest?.moved).toBeFalsy();
    const md = renderPlanMarkdown(plan);
    expect(md).toContain("is for this plan's digest, but approval was asked for again after it at 2026-10-09T13:00:00.000Z (a run holding `jcs1-sha256:other`), so it does not hold; approve this plan again.");
    expect(md).not.toContain("not this plan");
    expect(md).not.toContain("nothing moved");
  });

  it("names the migration added after approval", async () => {
    const { venv, project } = await setup([m1]);
    const approved = await digestOf(venv, [m1]);
    writeMigration(join(project.dir, "migrations"), m2);
    const plan = await collectVersionedPlan(project, env, { venv, op: OP, ledger: ledgerWith(approved, "2026-10-09T11:00:00.000Z") });
    expect(plan.approval).toMatchObject({ kind: "op", latest: { holds: false, sameDigest: false, digest: approved, moved: { confirmed: true, changes: [{ part: "pending", message: `new pending migration: ${m2.id}` }] } } });
    expect(renderPlanMarkdown(plan)).toContain(`What moved: pending migrations changed: new pending migration: ${m2.id}.`);
  });

  it("names the migration another run applied since approval, from the history as it stood then", async () => {
    const { venv, project } = await setup([m1, m2]);
    const approved = await digestOf(venv, [m1, m2]);
    // Another run applies m1 (rows recorded at 12:00 by the fake), after the approval at 11:00.
    const d1 = await digestOf(venv, [m1]);
    await executeApply(venv, [m1], { approvedDigest: d1, allowOutOfOrder: false, approve: (d) => verifyApproval(ledgerWith(d1, "2026-10-09T11:30:00.000Z"), OP, d), log: () => undefined, processEnv: { USER: "bob" } });
    const plan = await collectVersionedPlan(project, env, { venv, op: OP, ledger: ledgerWith(approved, "2026-10-09T11:00:00.000Z") });
    const latest = plan.approval?.kind === "op" ? plan.approval.latest : undefined;
    expect(latest?.moved?.confirmed).toBe(true);
    expect(latest?.moved?.changes).toEqual([{ part: "history", message: expect.stringMatching(new RegExp(`^applied since: ${m1.id} \\(by bob@`)) as unknown }]);
  });

  it("says the live schema changed when nothing it can rebuild matches", async () => {
    const { ch, venv, project } = await setup([m1]);
    const approved = await digestOf(venv, [m1]);
    ch.tables.push({ database: "yodel_8", name: "handmade", engine: "MergeTree", create: "CREATE TABLE yodel_8.handmade (x UInt8) ENGINE = MergeTree ORDER BY x" });
    const plan = await collectVersionedPlan(project, env, { venv, op: OP, ledger: ledgerWith(approved, "2026-10-09T11:00:00.000Z") });
    const moved = plan.approval?.kind === "op" ? plan.approval.latest?.moved : undefined;
    expect(moved?.confirmed).toBe(false);
    expect(moved?.changes.at(-1)).toMatchObject({ part: "live" });
  });

  it("compares with the previous comment's subject exactly, the live schema included", async () => {
    const { ch, venv, project } = await setup([m1]);
    const { status } = await inspect(venv, [m1]);
    const previous = await currentSubject(venv, status, status.pending);
    ch.tables.push({ database: "yodel_8", name: "handmade", engine: "MergeTree", create: "CREATE TABLE yodel_8.handmade (x UInt8) ENGINE = MergeTree ORDER BY x" });
    writeMigration(join(project.dir, "migrations"), m2);
    const plan = await collectVersionedPlan(project, env, { venv, op: OP, ledger: memoryGateLedgerPort(), previous });
    expect(plan.sinceLast?.confirmed).toBe(true);
    expect(plan.sinceLast?.changes.map((c) => c.part)).toEqual(["pending", "live"]);
    expect(renderPlanMarkdown(plan)).toContain("Since the previous version of this comment");
  });

  it("lists checksum mismatches as integrity problems and shows apply's refusal, with no digest", async () => {
    const { venv, project } = await setup([m1]);
    const d = await digestOf(venv, [m1]);
    await executeApply(venv, [m1], { approvedDigest: d, allowOutOfOrder: false, approve: (x) => verifyApproval(ledgerWith(d, "2026-10-09T11:00:00.000Z"), OP, x), log: () => undefined });
    const changed = migration(m1.id, null, ["CREATE DATABASE yodel_8", "CREATE TABLE yodel_8.a (x UInt16) ENGINE = MergeTree ORDER BY x"]);
    rmSync(join(project.dir, "migrations", m1.id), { recursive: true });
    writeMigration(join(project.dir, "migrations"), changed);
    const plan = await collectVersionedPlan(project, env, { venv, op: OP, ledger: null });
    expect(plan.problems.join("\n")).toMatch(new RegExp(`${m1.id} was applied with checksum`));
    expect(plan.refusal?.exitCode).toBe(4);
    expect(plan.digest).toBeUndefined();
  });

  it("says how to declare the Op when there is none", async () => {
    const { venv, project } = await setup([m1]);
    const plan = await collectVersionedPlan(project, env, { venv, ledger: null });
    expect(plan.approval).toMatchObject({ kind: "no-op", message: expect.stringContaining("no Op applies the migrations to e2e") as unknown });
  });
});

describe("the Apply step's refusal of a moved digest", () => {
  it("says what moved, and sends nothing", async () => {
    const { ch, venv } = await setup([m1, m2]);
    const approved = await digestOf(venv, [m1]);
    const run = executeApply(venv, [m1, m2], { approvedDigest: approved, allowOutOfOrder: false, approve: (d) => verifyApproval(ledgerWith(d, "2026-10-09T11:00:00.000Z"), OP, d), log: () => undefined });
    await expect(run).rejects.toThrow(new RegExp(`plan moved since it was approved .*: pending migrations changed: new pending migration: ${m2.id}\\. Nothing was applied`));
    expect(ch.sent).toEqual([]);
  });
});

describe("explainMove and diffSubjects", () => {
  const base = { environment: "e2e", historyDatabase: "h", applied: [], pending: [{ id: "a", checksum: "1", done: [] }], live: "L" };

  it("says nothing moved for the same subject", async () => {
    const { planDigest } = await import("../src/versioned/digest.js");
    expect((await explainMove({ approvedDigest: await planDigest(base), now: base, ordered: [] })).changes).toEqual([]);
  });

  it("finds an edit after approval from the checksums git has held", async () => {
    const { planDigest } = await import("../src/versioned/digest.js");
    const ordered = [m1];
    const now = { ...base, pending: [{ id: m1.id, checksum: m1.checksum, done: [] }] };
    const before = { ...now, pending: [{ id: m1.id, checksum: "sha256:older", done: [] }] };
    const e = await explainMove({ approvedDigest: await planDigest(before), now, ordered, rows: [], checksums: () => ["sha256:older"] });
    expect(e).toMatchObject({ confirmed: true, changes: [{ part: "pending", message: `files changed: ${m1.id}` }] });
  });

  it("diffs each part", () => {
    const after = { ...base, historyDatabase: "h2", applied: [{ id: "a", checksum: "1" }], pending: [{ id: "b", checksum: "2", done: [] }], live: "M" };
    expect(diffSubjects(base, after).map((c) => c.part)).toEqual(["environment", "history", "pending", "live"]);
  });
});
