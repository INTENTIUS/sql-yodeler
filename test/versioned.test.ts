import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { MigrationStep } from "@intentius/chant-lexicon-sql/migration-statements";
import { projectFromConfig } from "../src/project.js";
import type { Migration } from "../src/migrations/index.js";
import { deriveState, statementSha } from "../src/history/index.js";
import {
  ApplyFailed,
  compareHistory,
  currentDigest,
  executeApply,
  inspect,
  migrateOpParts,
  openVersioned,
  outOfOrder,
  selectMigrateOp,
  selectToApply,
  statusReport,
  verifyApproval,
  type MigrateOpRef,
  type VersionedEnv,
} from "../src/versioned/index.js";
import { memoryGateLedgerPort } from "@intentius/chant/op/gate";
import { edited, FakeClickHouse, migration } from "./helpers/fake-clickhouse.js";
import { EXIT_FAILED, EXIT_MOVED, EXIT_WAITING } from "../src/exit.js";

const m1 = migration("20261009T1000-one", null, ["CREATE DATABASE yodel_8", "CREATE TABLE yodel_8.a (x UInt8) ENGINE = MergeTree ORDER BY x"]);
const m2 = migration("20261009T1100-two", m1.id, ["ALTER TABLE yodel_8.a ADD COLUMN y UInt8", "ALTER TABLE yodel_8.a ADD COLUMN z UInt8", "CREATE TABLE yodel_8.b (x UInt8) ENGINE = MergeTree ORDER BY x"]);
const m3 = migration("20261009T1200-three", m2.id, ["CREATE TABLE yodel_8.c (x UInt8) ENGINE = MergeTree ORDER BY x"]);

async function setup(ch = new FakeClickHouse()): Promise<{ ch: FakeClickHouse; venv: VersionedEnv }> {
  // A server url of its own, so each test's local lock file is its own.
  const url = `http://fake-${randomUUID()}:8123`;
  const project = projectFromConfig("/nowhere", "/nowhere/chant.config.ts", { lexicons: ["sql"], sql: { dialect: "clickhouse", profiles: { e2e: { url, databases: ["yodel_8"] } } } });
  const venv = await openVersioned(project, { name: "e2e", profile: { url } }, { YODEL_HISTORY_DATABASE: "yodel_8_history" }, ch);
  return { ch, venv };
}

const quiet = () => undefined;

const OP: MigrateOpRef = { name: "migrate-e2e", filePath: "/p/ops/migrate-e2e.op.ts", gate: "approve-migrate-e2e", quorum: false };

/** A gate ledger holding one approval of OP's gate for `digest`, as `chant approve --plan <digest>` writes it. */
const approvedLedger = (digest: string, at = "2026-10-09T12:00:00.000Z") =>
  memoryGateLedgerPort({ resolutions: [{ version: 1, op: OP.name, gate: OP.gate, resolvedBy: "alice", timestamp: at, planDigest: digest }] });

const noApproval = () => Promise.reject(new Error("approve() called"));

async function approveAndApply(venv: VersionedEnv, ordered: Migration[], options: { allowOutOfOrder?: boolean } = {}) {
  const { status } = await inspect(venv, ordered);
  const digest = await currentDigest(venv, status, selectToApply(status, options.allowOutOfOrder === true));
  const ledger = approvedLedger(digest);
  return executeApply(venv, ordered, { approvedDigest: digest, allowOutOfOrder: options.allowOutOfOrder === true, approve: (d) => verifyApproval(ledger, OP, d), log: quiet, processEnv: { USER: "tester" } });
}

describe("compareHistory", () => {
  it("has everything pending on an empty history, nothing out of order", () => {
    const s = compareHistory([m1, m2], deriveState([]));
    expect(s.applied).toEqual([]);
    expect(s.pending.map((p) => p.id)).toEqual([m1.id, m2.id]);
    expect(outOfOrder(s)).toEqual([]);
    expect(s.mismatches).toEqual([]);
  });
});

describe("executeApply", () => {
  it("applies the pending migrations in chain order, one history row per migration and per statement event", async () => {
    const { ch, venv } = await setup();
    const result = await approveAndApply(venv, [m1, m2]);
    expect(result.applied).toEqual([m1.id, m2.id]);
    expect(result.lock.kind).toBe("local");
    expect(ch.sent).toEqual([...m1.document.steps, ...m2.document.steps].map((s) => (s as { sql: string }).sql));
    // m1: started, 2 x (started, succeeded), succeeded = 6; m2: 1 + 3 x 2 + 1 = 8.
    expect(ch.rows).toHaveLength(14);
    expect(ch.rows.map((r) => r.seq)).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
    const statementRow = ch.rows.find((r) => r.kind === "statement" && r.migration_id === m2.id && r.statement_index === 2 && r.status === "succeeded");
    expect(statementRow).toMatchObject({ statement_sha: statementSha("CREATE TABLE yodel_8.b (x UInt8) ENGINE = MergeTree ORDER BY x"), parent: m1.id, checksum: m2.checksum, silences: "[]" });
    expect(String(statementRow?.applied_by)).toMatch(/^tester@/);
    expect(String(statementRow?.plan_digest)).toMatch(/^jcs1-sha256:[0-9a-f]{64}$/);

    const { status } = await inspect(venv, [m1, m2]);
    expect(status.applied.map((a) => a.id)).toEqual([m1.id, m2.id]);
    expect(status.pending).toEqual([]);
    ch.sent = [];
    expect((await approveAndApply(venv, [m1, m2])).applied).toEqual([]);
    expect(ch.sent).toEqual([]);
  });

  it("resumes a migration that failed part way at the statement that failed, and never resends one that succeeded", async () => {
    const { ch, venv } = await setup();
    ch.failWith = (sql) => (sql.includes("ADD COLUMN z") ? "Code: 44. DB::Exception: Cannot add column z: column with this name already exists. (ILLEGAL_COLUMN)" : undefined);
    const failed = approveAndApply(venv, [m1, m2]);
    await expect(failed).rejects.toBeInstanceOf(ApplyFailed);
    await expect(failed).rejects.toMatchObject({ migration: m2.id, statement: 1 });

    const report = await statusReport(venv, [m1, m2]);
    expect(report.status.applied.map((a) => a.id)).toEqual([m1.id]);
    const [pending] = report.status.pending;
    expect(pending?.id).toBe(m2.id);
    expect(pending?.partWay).toMatchObject({ status: "failed", resumeAt: 1, failedStatement: 1, done: [0], edited: false });
    expect(pending?.partWay?.error).toMatch(/statement 1: Code: 44/);

    // The server is fixed; the rerun sends statement 1 and 2 only.
    ch.failWith = () => undefined;
    ch.sent = [];
    const result = await approveAndApply(venv, [m1, m2]);
    expect(result.applied).toEqual([m2.id]);
    expect(result.skipped).toEqual([{ id: m2.id, statement: 0 }]);
    expect(ch.sent).toEqual(["ALTER TABLE yodel_8.a ADD COLUMN z UInt8", "CREATE TABLE yodel_8.b (x UInt8) ENGINE = MergeTree ORDER BY x"]);
    expect((await inspect(venv, [m1, m2])).status.pending).toEqual([]);
  });

  it("lets a part-way migration be edited before it resumes, unless a statement that already ran changed", async () => {
    const { ch, venv } = await setup();
    ch.failWith = (sql) => (sql.includes("ADD COLUMN z") ? "boom" : undefined);
    await expect(approveAndApply(venv, [m1, m2])).rejects.toBeInstanceOf(ApplyFailed);
    ch.failWith = () => undefined;

    const fixed = edited(m2, ["ALTER TABLE yodel_8.a ADD COLUMN y UInt8", "ALTER TABLE yodel_8.a ADD COLUMN zz UInt8", "CREATE TABLE yodel_8.b (x UInt8) ENGINE = MergeTree ORDER BY x"]);
    const { status } = await inspect(venv, [m1, fixed]);
    expect(status.mismatches).toEqual([]);
    expect(status.pending[0]?.partWay?.edited).toBe(true);

    const rewritten = edited(m2, ["ALTER TABLE yodel_8.a ADD COLUMN yy UInt8", "ALTER TABLE yodel_8.a ADD COLUMN z UInt8", "CREATE TABLE yodel_8.b (x UInt8) ENGINE = MergeTree ORDER BY x"]);
    const bad = (await inspect(venv, [m1, rewritten])).status;
    expect(bad.mismatches).toMatchObject([{ kind: "part-way", id: m2.id, statement: 0 }]);
    expect(() => selectToApply(bad, false)).toThrow(expect.objectContaining({ exitCode: EXIT_FAILED }));

    ch.sent = [];
    await approveAndApply(venv, [m1, fixed]);
    expect(ch.sent).toEqual(["ALTER TABLE yodel_8.a ADD COLUMN zz UInt8", "CREATE TABLE yodel_8.b (x UInt8) ENGINE = MergeTree ORDER BY x"]);
  });

  it("refuses when an applied migration's checksum no longer matches its files, naming it and yodel repair", async () => {
    const { ch, venv } = await setup();
    await approveAndApply(venv, [m1]);
    const changed = edited(m1, ["CREATE DATABASE yodel_8", "CREATE TABLE yodel_8.a (x UInt16) ENGINE = MergeTree ORDER BY x"]);
    const { status } = await inspect(venv, [changed, m2]);
    expect(status.mismatches).toMatchObject([{ kind: "applied", id: m1.id, recorded: m1.checksum, actual: changed.checksum }]);
    let refusal: unknown;
    try {
      selectToApply(status, false);
    } catch (e) {
      refusal = e;
    }
    expect(refusal).toMatchObject({ exitCode: EXIT_FAILED });
    expect((refusal as Error).message).toMatch(new RegExp(`${m1.id} was applied with checksum .*yodel repair`));
    ch.sent = [];
    await expect(executeApply(venv, [changed, m2], { approvedDigest: "jcs1-sha256:" + "0".repeat(64), allowOutOfOrder: false, approve: noApproval, log: quiet })).rejects.toMatchObject({ exitCode: EXIT_FAILED });
    expect(ch.sent).toEqual([]);
  });

  it("refuses when an applied migration is gone from the directory", async () => {
    const { venv } = await setup();
    await approveAndApply(venv, [m1, m2]);
    const alone = migration(m1.id, null, ["CREATE DATABASE yodel_8", "CREATE TABLE yodel_8.a (x UInt8) ENGINE = MergeTree ORDER BY x"]);
    const { status } = await inspect(venv, [alone]);
    expect(status.mismatches).toMatchObject([{ kind: "missing", id: m2.id }]);
  });

  it("reports an out-of-order migration, refuses it, and applies it only with --allow-out-of-order", async () => {
    const { ch, venv } = await setup();
    // Applied here: m1, then three (parent m1). Then main merged "late" before three: late follows m1, three follows late.
    const threeFirst = migration(m3.id, m1.id, ["CREATE TABLE yodel_8.c (x UInt8) ENGINE = MergeTree ORDER BY x"]);
    await approveAndApply(venv, [m1, threeFirst]);
    const late = migration("20261009T1100-late", m1.id, ["CREATE TABLE yodel_8.d (x UInt8) ENGINE = MergeTree ORDER BY x"]);
    const threeAfter = migration(m3.id, late.id, ["CREATE TABLE yodel_8.c (x UInt8) ENGINE = MergeTree ORDER BY x"]);
    const ordered = [m1, late, threeAfter];

    // three's parent is in its checksum, so the move is first a mismatch on three, until yodel repair (#15) records it.
    const before = (await inspect(venv, ordered)).status;
    expect(before.mismatches).toMatchObject([{ kind: "applied", id: m3.id }]);
    expect(outOfOrder(before).map((p) => p.id)).toEqual([late.id]);
    const { state } = await inspect(venv, ordered);
    await venv.store.append([{ seq: state.maxSeq + 1, run_id: "repair", kind: "migration", migration_id: m3.id, parent: late.id, checksum: threeAfter.checksum, statement_index: -1, statement_sha: "", status: "succeeded", error: "", applied_by: "repair", plan_digest: "", silences: "[]", note: "rebased onto late" }]);

    const { status } = await inspect(venv, ordered);
    expect(status.mismatches).toEqual([]);
    expect(outOfOrder(status).map((p) => p.id)).toEqual([late.id]);
    expect(() => selectToApply(status, false)).toThrow(/out of order.*--allow-out-of-order/s);
    expect(selectToApply(status, true).map((p) => p.id)).toEqual([late.id]);

    ch.sent = [];
    await expect(approveAndApply(venv, ordered)).rejects.toMatchObject({ exitCode: EXIT_FAILED });
    expect(ch.sent).toEqual([]);
    const result = await approveAndApply(venv, ordered, { allowOutOfOrder: true });
    expect(result.applied).toEqual([late.id]);
    expect(ch.sent).toEqual(["CREATE TABLE yodel_8.d (x UInt8) ENGINE = MergeTree ORDER BY x"]);
  });

  it("refuses when the plan moved after approval, and sends nothing", async () => {
    const { ch, venv } = await setup();
    const { status } = await inspect(venv, [m1]);
    const approved = await currentDigest(venv, status, status.pending);
    ch.tables.push({ database: "yodel_8", name: "handmade", engine: "MergeTree", create: "CREATE TABLE yodel_8.handmade (x UInt8) ENGINE = MergeTree ORDER BY x" });
    await expect(executeApply(venv, [m1], { approvedDigest: approved, allowOutOfOrder: false, approve: (d) => verifyApproval(approvedLedger(approved), OP, d), log: quiet })).rejects.toThrow(/plan moved since it was approved/);
    expect(ch.sent).toEqual([]);
    expect(ch.rows).toEqual([]);
  });

  it("refuses a manual step, and an Op step apply does not run, with exit 3, and never skips it", async () => {
    const { ch, venv } = await setup();
    const rebuild: MigrationStep = {
      kind: "op",
      object: "events",
      type: "ClickHouse::Table",
      name: "yodel_8.events",
      op: "ClickHouseRebuildOp",
      importPath: "@intentius/chant-lexicon-sql/clickhouse",
      options: { name: "rebuild-yodel_8-events", env: "<env>", table: "yodel_8.events", dualWrite: { mode: "app" } },
      declaration: "",
      changes: [{ rule: "SQLCH301", class: "rebuild", field: "orderBy" }],
      detail: "",
    };
    const manual: MigrationStep = { kind: "manual", object: "v", type: "ClickHouse::View", name: "yodel_8.v", changes: [], detail: "rebuild the view by hand" };
    const withOp = migration("20261009T1300-rebuild", null, ["CREATE DATABASE yodel_8", rebuild, manual]);
    const { status } = await inspect(venv, [withOp]);
    expect(() => selectToApply(status, false)).toThrow(
      expect.objectContaining({ exitCode: 3, message: expect.stringMatching(/step 1: ClickHouseRebuildOp .* in app mode[\s\S]*step 2: a manual step for v/) as unknown }),
    );
    expect(ch.sent).toEqual([]);
  });
});

describe("the approval --execute checks in chant's gate ledger", () => {
  it("refuses with no approval in the ledger, even with the digest handed over, and sends nothing", async () => {
    const { ch, venv } = await setup();
    const { status } = await inspect(venv, [m1]);
    const digest = await currentDigest(venv, status, status.pending);
    const empty = memoryGateLedgerPort();
    const run = executeApply(venv, [m1], { approvedDigest: digest, allowOutOfOrder: false, approve: (d) => verifyApproval(empty, OP, d), log: quiet });
    await expect(run).rejects.toMatchObject({ exitCode: EXIT_WAITING, message: expect.stringContaining("holds no approval of migrate-e2e / approve-migrate-e2e") as unknown });
    expect(ch.sent).toEqual([]);
    expect(ch.rows).toEqual([]);
  });

  it("reads the newest approval: it holds, its digest moved, or approval was asked for again after it", async () => {
    const { latestApproval, askedAgainLine } = await import("../src/versioned/explain.js");
    const digest = "jcs1-sha256:aaaa";
    const other = "jcs1-sha256:bbbb";
    await expect(latestApproval(approvedLedger(digest), OP, digest)).resolves.toEqual({ digest, by: "alice", at: "2026-10-09T12:00:00.000Z", holds: true, sameDigest: true });
    await expect(latestApproval(approvedLedger(other), OP, digest)).resolves.toEqual({ digest: other, by: "alice", at: "2026-10-09T12:00:00.000Z", holds: false, sameDigest: false });
    const pending = (at: string, planDigest: string) => ({ version: 1 as const, kind: "pending" as const, op: OP.name, gate: OP.gate, timestamp: at, expiresAt: "2026-10-11T13:00:00.000Z", planDigest });
    const superseded = memoryGateLedgerPort({
      resolutions: [{ version: 1, op: OP.name, gate: OP.gate, resolvedBy: "alice", timestamp: "2026-10-09T12:00:00.000Z", planDigest: digest }],
      // One before the approval (the one it answered), two after: the first after is the one that asked again.
      pending: [pending("2026-10-09T11:00:00.000Z", digest), pending("2026-10-09T14:00:00.000Z", digest), pending("2026-10-09T13:00:00.000Z", other)],
    });
    const latest = await latestApproval(superseded, OP, digest);
    expect(latest).toEqual({ digest, by: "alice", at: "2026-10-09T12:00:00.000Z", holds: false, sameDigest: true, askedAgain: { at: "2026-10-09T13:00:00.000Z", digest: other } });
    expect(askedAgainLine(latest ?? {})).toBe(`is for this plan's digest, but approval was asked for again after it at 2026-10-09T13:00:00.000Z (a run holding ${other}), so it does not hold; approve this plan again`);
  });

  it("counts only an approval of this gate, for this digest, newer than the gate's newest pending fact", async () => {
    const digest = `jcs1-sha256:${"a".repeat(64)}`;
    const other = `jcs1-sha256:${"b".repeat(64)}`;
    await expect(verifyApproval(approvedLedger(digest), OP, digest)).resolves.toEqual({
      resolvedBy: "alice",
      timestamp: "2026-10-09T12:00:00.000Z",
      approver: "alice",
      admission: { op: OP.name, gate: OP.gate, resolvedAt: "2026-10-09T12:00:00.000Z" },
    });
    await expect(verifyApproval(approvedLedger(other), OP, digest)).rejects.toThrow(new RegExp(`newest approval of that gate is for ${other}`));
    // The newest approval is for another digest: the plan moved since it was approved (#288).
    await expect(verifyApproval(approvedLedger(other), OP, digest)).rejects.toMatchObject({ exitCode: EXIT_MOVED });
    await expect(verifyApproval(approvedLedger(digest), { ...OP, gate: "another-gate" }, digest)).rejects.toMatchObject({ exitCode: EXIT_WAITING });
    // The gate asked again after the approval: that approval no longer answers it.
    const stale = memoryGateLedgerPort({
      resolutions: [{ version: 1, op: OP.name, gate: OP.gate, resolvedBy: "alice", timestamp: "2026-10-09T12:00:00.000Z", planDigest: digest }],
      pending: [{ version: 1, kind: "pending", op: OP.name, gate: OP.gate, timestamp: "2026-10-09T13:00:00.000Z", expiresAt: "2026-10-11T13:00:00.000Z", planDigest: digest }],
    });
    await expect(verifyApproval(stale, OP, digest)).rejects.toMatchObject({ exitCode: EXIT_WAITING });
    // An approval recorded before plan-bound gates (no digest) never counts.
    const legacy = memoryGateLedgerPort({ resolutions: [{ version: 1, op: OP.name, gate: OP.gate, resolvedBy: "alice", timestamp: "2026-10-09T12:00:00.000Z" }] });
    await expect(verifyApproval(legacy, OP, digest)).rejects.toMatchObject({ exitCode: EXIT_WAITING });
    // A quorum only the Op declares is the change's to edit: refused (the quorum at base is test/quorum-at-base.test.ts).
    await expect(verifyApproval(approvedLedger(digest), { ...OP, quorum: true }, digest)).rejects.toThrow(/quorum/);
  });
});

describe("the plan digest", () => {
  it("is stable, and changes when a pending checksum, the live schema or the history changes", async () => {
    const { ch, venv } = await setup();
    const digest = async (ordered: Migration[]) => {
      const { status } = await inspect(venv, ordered);
      return currentDigest(venv, status, status.pending);
    };
    const base = await digest([m1, m2]);
    expect(base).toMatch(/^jcs1-sha256:[0-9a-f]{64}$/);
    expect(await digest([m1, m2])).toBe(base);

    const m2edited = edited(m2, ["ALTER TABLE yodel_8.a ADD COLUMN y UInt16"]);
    expect(await digest([m1, m2edited])).not.toBe(base);

    ch.tables.push({ database: "yodel_8", name: "a", engine: "MergeTree", create: "CREATE TABLE yodel_8.a (x UInt8) ENGINE = MergeTree ORDER BY x" });
    const live = await digest([m1, m2]);
    expect(live).not.toBe(base);

    // A table outside the environment's databases (the history's own, another database) does not count.
    ch.tables.push({ database: "elsewhere", name: "z", engine: "MergeTree", create: "CREATE TABLE elsewhere.z (x UInt8) ENGINE = MergeTree ORDER BY x" });
    expect(await digest([m1, m2])).toBe(live);

    await approveAndApply(venv, [m1]);
    expect(await digest([m1, m2])).not.toBe(live);
  });
});

describe("the migrations Op", () => {
  const plan = { kind: "activity" as const, fn: "shellCmd", id: "plan", args: { cmd: "yodel apply e2e --digest" } };
  const execute = { kind: "activity" as const, fn: "shellCmd", args: { cmd: "yodel apply e2e --execute", env: {} } };
  const gate = { kind: "gate" as const, gate: "approve-migrate-e2e", plan: { kind: "step-output-ref", step: "plan", path: "stdout" } as never };
  const config = (steps: unknown[]) => ({ name: "migrate-e2e", overview: "", phases: [{ name: "all", steps }] }) as never;
  const project = projectFromConfig("/p", "/p/chant.config.ts", { lexicons: ["sql"], sql: { dialect: "clickhouse" } });
  const env = { name: "e2e", profile: { url: "http://x:8123" } };

  it("is found by its Plan and Apply steps and its plan-bound gate", () => {
    expect(migrateOpParts(config([plan, gate, execute]), "e2e")).toEqual({ gate: "approve-migrate-e2e", quorum: false });
    expect(migrateOpParts(config([plan, gate, execute]), "prod")).toBeUndefined();
    const ops = new Map([["migrate-e2e", { config: config([plan, gate, execute]), filePath: "/p/ops/migrate-e2e.op.ts" }]]);
    expect(selectMigrateOp(ops, project, env)).toEqual({ name: "migrate-e2e", filePath: "/p/ops/migrate-e2e.op.ts", gate: "approve-migrate-e2e", quorum: false });
  });

  it("is refused without a gate bound to the digest, and its absence prints the declaration to write", () => {
    const ungated = new Map([["migrate-e2e", { config: config([plan, execute]), filePath: "/p/ops/m.op.ts" }]]);
    expect(() => selectMigrateOp(ungated, project, env)).toThrow(/no approval gate bound/);
    expect(() => selectMigrateOp(new Map(), project, env)).toThrow(/shell\("yodel apply e2e --digest", \{ id: "plan" \}\)/);
  });
});
