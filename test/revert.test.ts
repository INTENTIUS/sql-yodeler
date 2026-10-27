/**
 * yodel revert (#55): the reverse planned from the recorded schemas, the
 * refusals, the hand-written step for a data step, the rows the history
 * gets, and the migration pending again after it.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { memoryGateLedgerPort } from "@intentius/chant/op/gate";
import type { BuildOutput } from "../src/chant/build.js";
import { deriveState, type HistoryRow } from "../src/history/index.js";
import { createMigration, type Migration } from "../src/migrations/index.js";
import { projectFromConfig, YodelError } from "../src/project.js";
import {
  compareHistory,
  currentDigest,
  currentRevert,
  executeApply,
  executeRevert,
  inspect,
  judgeRevert,
  overrideSubject,
  policyRefusal,
  openVersioned,
  planRevert,
  selectToApply,
  splitStatements,
  statusJson,
  verifyApproval,
  type MigrateOpRef,
  type OverrideSource,
  type RevertStepFile,
  type VersionedEnv,
} from "../src/versioned/index.js";
import { FakeClickHouse } from "./helpers/fake-clickhouse.js";
import { overrideSource } from "./helpers/overrides.js";
import type { PolicyConfig } from "../src/config/define.js";
import { revertWaveOf } from "../src/commands/revert.js";

const build = (columns: string): BuildOutput => ({
  dialect: "clickhouse",
  objects: [
    { export: "db", type: "ClickHouse::Database", ddl: "CREATE DATABASE yodel_8 ENGINE = Atomic", dependsOn: [] },
    { export: "a", type: "ClickHouse::Table", ddl: `CREATE TABLE yodel_8.a (${columns}) ENGINE = MergeTree ORDER BY id`, dependsOn: ["db"] },
  ],
});

const asMigration = (made: ReturnType<typeof createMigration>): Migration => {
  if (made.id === undefined) throw new Error("no change");
  return { id: made.id, dir: `/x/${made.id}`, parent: made.document.parent, checksum: made.document.checksum, document: made.document, files: made.files };
};

const at = (i: number) => new Date(Date.UTC(2026, 9, 10, 9, i));
const m0 = asMigration(createMigration({ name: "create", build: build("id UInt64"), now: at(0) }));
const m1 = asMigration(createMigration({ name: "add-note", build: build("id UInt64, note String"), previous: m0, now: at(1) }));
const m2 = asMigration(createMigration({ name: "fill-note", build: build("id UInt64, note String, label String"), previous: m1, now: at(2), backfill: { text: "export const op = {};\n" } }));

const row = (seq: number, m: Migration, status: HistoryRow["status"] = "succeeded", kind: HistoryRow["kind"] = "migration", index = -1, sha = ""): HistoryRow => ({
  seq,
  run_id: "r",
  kind,
  migration_id: m.id,
  parent: m.parent ?? "",
  checksum: m.checksum,
  statement_index: index,
  statement_sha: sha,
  status,
  error: "",
  applied_by: "t",
  plan_digest: "",
  silences: "[]",
  note: "",
});

const plan = (rows: HistoryRow[], id: string, step?: RevertStepFile) => {
  const ordered = [m0, m1, m2];
  const state = deriveState(rows);
  return planRevert({ environment: "e2e", ordered, status: compareHistory(ordered, state), state, id, step });
};

const refusal = (f: () => unknown): YodelError => {
  try {
    f();
  } catch (e) {
    if (e instanceof YodelError) return e;
    throw e;
  }
  throw new Error("no refusal");
};

describe("planRevert", () => {
  it("diffs the migration's recorded schema back to its parent's", () => {
    const p = plan([row(1, m0), row(2, m1)], m1.id);
    expect(p.to).toBe(m0.id);
    expect(p.statements.map((s) => s.source)).toEqual(["reverse"]);
    expect(p.statements[0]?.step.sql).toMatch(/DROP COLUMN.*note/);
    expect(p.statements[0]?.step.destructive).toBe(true);
  });

  it("goes back to an empty schema from the first migration", () => {
    const p = plan([row(1, m0)], m0.id);
    expect(p.to).toBeNull();
    expect(p.statements.map((s) => s.step.sql).join("\n")).toMatch(/DROP DATABASE/);
  });

  it("refuses a migration that is not applied, or one with a later migration applied", () => {
    expect(refusal(() => plan([row(1, m0)], m1.id)).exitCode).toBe(1);
    const later = refusal(() => plan([row(1, m0), row(2, m1)], m0.id));
    expect(later.exitCode).toBe(1);
    expect(later.message).toContain(`${m1.id} is applied in e2e after ${m0.id}`);
    expect(refusal(() => plan([], "20261010T0900-nope")).exitCode).toBe(1);
  });

  it("refuses a data step without a hand-written revert step, and runs the step first with one", () => {
    const rows = [row(1, m0), row(2, m1), row(3, m2)];
    const refused = refusal(() => plan(rows, m2.id));
    expect(refused.exitCode).toBe(3);
    expect(refused.message).toMatch(/data step .*backfill.*--step <file>/);
    const step: RevertStepFile = { file: "revert.sql", sha: "sha256:x", statements: ["ALTER TABLE yodel_8.a UPDATE label = '' WHERE 1"] };
    const p = plan(rows, m2.id, step);
    expect(p.statements.map((s) => s.source)).toEqual(["step", "reverse"]);
    expect(p.statements[0]?.step.waitsForMutation).toBe(true);
    expect(p.statements[1]?.step.sql).toMatch(/DROP COLUMN.*label/);
    expect(p.dataSteps).toHaveLength(1);
  });
});

describe("splitStatements", () => {
  it("splits at a ; ending a line and drops comment and blank lines between", () => {
    expect(splitStatements("-- undo the fill\n\nUPDATE t SET a = NULL\n  WHERE b;\n\nDELETE FROM u;\nSELECT 1")).toEqual(["UPDATE t SET a = NULL\n  WHERE b", "DELETE FROM u", "SELECT 1"]);
  });
});

describe("the history after a revert", () => {
  it("has the migration pending again, reverted, with none of its statements done", () => {
    const rows = [row(1, m0), row(2, m1, "started"), row(3, m1, "succeeded", "statement", 0, "sha"), row(4, m1), row(5, m1, "succeeded", "revert", 0, "x"), row(6, m1, "reverted")];
    const state = deriveState(rows);
    const s = compareHistory([m0, m1], state);
    expect(s.applied.map((a) => a.id)).toEqual([m0.id]);
    expect(s.pending.map((p) => [p.id, p.partWay, p.reverted?.by])).toEqual([[m1.id, undefined, "t"]]);
    expect(state.byId.get(m1.id)?.statements.size).toBe(0);
    expect(statusJson({ environment: "e2e", location: { database: "h", topology: { kind: "single" } }, status: s }).pending).toMatchObject([{ id: m1.id, reverted: { by: "t" } }]);
  });
});

const OP: MigrateOpRef = { name: "migrate-e2e", filePath: "/p/ops/migrate-e2e.op.ts", gate: "approve-migrate-e2e", quorum: false };
const REVERT_SUBJECT = overrideSubject(OP.name, m1.id);
const ledgerFor = (digest: string) => memoryGateLedgerPort({ resolutions: [{ version: 1, op: OP.name, gate: OP.gate, resolvedBy: "alice", timestamp: "2026-10-10T12:00:00.000Z", planDigest: digest }] });
const quiet = () => undefined;

async function setup(): Promise<{ ch: FakeClickHouse; venv: VersionedEnv }> {
  const ch = new FakeClickHouse();
  const url = `http://fake-${randomUUID()}:8123`;
  const project = projectFromConfig("/nowhere", "/nowhere/chant.config.ts", { lexicons: ["sql"], sql: { dialect: "clickhouse", profiles: { e2e: { url, databases: ["yodel_8"] } } } });
  const venv = await openVersioned(project, { name: "e2e", profile: { url } }, { YODEL_HISTORY_DATABASE: "yodel_8_history" }, ch);
  return { ch, venv };
}

describe("executeRevert", () => {
  it("runs the reverse behind the approval of its digest, records revert rows and a reverted row, and the next apply runs every statement again", async () => {
    const { ch, venv } = await setup();
    const ordered = [m0, m1];
    const { status } = await inspect(venv, ordered);
    const applyDigest = await currentDigest(venv, status, selectToApply(status, false));
    await executeApply(venv, ordered, { approvedDigest: applyDigest, allowOutOfOrder: false, approve: (d) => verifyApproval(ledgerFor(applyDigest), OP, d), log: quiet, processEnv: { USER: "tester" } });
    const sentBefore = ch.sent.length;

    const { digest } = await currentRevert(venv, ordered, m1.id);
    expect(digest).not.toBe(applyDigest);
    await expect(executeRevert(venv, ordered, { id: m1.id, approvedDigest: digest, approve: (d) => verifyApproval(ledgerFor("jcs1-sha256:" + "0".repeat(64)), OP, d), log: quiet })).rejects.toThrow();
    const done = await executeRevert(venv, ordered, { id: m1.id, approvedDigest: digest, approve: (d) => verifyApproval(ledgerFor(digest), OP, d), log: quiet, processEnv: { USER: "tester" } });
    expect(done.to).toBe(m0.id);
    expect(ch.sent.slice(sentBefore)).toEqual([expect.stringMatching(/DROP COLUMN.*note/)]);
    const last = ch.rows.slice(-3).map((r) => [r.kind, r.status, r.migration_id]);
    expect(last).toEqual([
      ["revert", "started", m1.id],
      ["revert", "succeeded", m1.id],
      ["migration", "reverted", m1.id],
    ]);

    const after = await inspect(venv, ordered);
    expect(after.status.pending.map((p) => p.id)).toEqual([m1.id]);
    expect(after.status.pending[0]?.reverted).toBeDefined();
    const again = await currentDigest(venv, after.status, selectToApply(after.status, false));
    const sentRevert = ch.sent.length;
    await executeApply(venv, ordered, { approvedDigest: again, allowOutOfOrder: false, approve: (d) => verifyApproval(ledgerFor(again), OP, d), log: quiet, processEnv: { USER: "tester" } });
    expect(ch.sent.slice(sentRevert)).toEqual([expect.stringMatching(/ADD COLUMN.*note/)]);
    expect((await inspect(venv, ordered)).status.applied.map((a) => a.id)).toEqual([m0.id, m1.id]);
  });
});

describe("the policy over a revert (#97)", () => {
  const policy: PolicyConfig = { overriders: ["alice"], rules: [{ id: "no-drops", environments: ["e2e"], refuse: { classes: ["drop"], destructive: true } }] };

  it("denies a revert that drops what the migration added, unless an override is recorded for the revert's digest", async () => {
    const p = plan([row(1, m0), row(2, m1)], m1.id);
    const none = await judgeRevert({ policy, environment: "e2e", dialect: "clickhouse", plan: p, digest: "jcs1-sha256:aa", ledger: () => Promise.resolve(undefined) });
    expect(none).toMatchObject([{ id: "no-drops", outcome: "denied", reasons: [expect.stringMatching(/step 0 .* is destructive/) as unknown] }]);
    const refused = policyRefusal(none, "e2e", "jcs1-sha256:aa", "before the gate", { id: m1.id });
    expect(refused?.exitCode).toBe(7);
    expect(refused?.message).toContain(`denies the revert of ${m1.id}`);
    expect(refused?.message).toContain(`yodel override e2e --revert ${m1.id} --rule no-drops`);

    const source = overrideSource(REVERT_SUBJECT, "jcs1-sha256:aa", ["no-drops"], [{ by: "alice", note: "nothing reads it" }]);
    const over = await judgeRevert({ policy, environment: "e2e", dialect: "clickhouse", plan: p, digest: "jcs1-sha256:aa", ledger: () => Promise.resolve(source) });
    expect(over).toMatchObject([{ id: "no-drops", outcome: "overridden", override: { by: "alice", reason: "nothing reads it" } }]);
    // An override of another digest (the apply's, or the revert before it moved) does not count.
    const other = await judgeRevert({ policy, environment: "e2e", dialect: "clickhouse", plan: p, digest: "jcs1-sha256:bb", ledger: () => Promise.resolve(source) });
    expect(other[0]?.outcome).toBe("denied");
    // A rule's check sees that the plan is a revert.
    const seen = await judgeRevert({ policy: { rules: [{ id: "no-reverts", check: (pl) => (pl.revert ? `reverts ${pl.revert.id} to ${String(pl.revert.to)}` : undefined) }] }, environment: "e2e", dialect: "clickhouse", plan: p, digest: undefined, ledger: () => Promise.resolve(undefined) });
    expect(seen[0]?.reasons).toEqual([`reverts ${m1.id} to ${m0.id}`]);
  });

  it("refuses under the lock when a rule denies with no override, and records the override it relied on in the reverted row", async () => {
    const { ch, venv } = await setup();
    const ordered = [m0, m1];
    const { status } = await inspect(venv, ordered);
    const applyDigest = await currentDigest(venv, status, selectToApply(status, false));
    await executeApply(venv, ordered, { approvedDigest: applyDigest, allowOutOfOrder: false, approve: (d) => verifyApproval(ledgerFor(applyDigest), OP, d), log: quiet, processEnv: { USER: "tester" } });
    const { digest } = await currentRevert(venv, ordered, m1.id);
    const judge = (source?: OverrideSource) => async (d: string, planned: Parameters<typeof judgeRevert>[0]["plan"]) => {
      const results = await judgeRevert({ policy, environment: "e2e", dialect: "clickhouse", plan: planned, digest: d, ledger: () => Promise.resolve(source) });
      const refusal = policyRefusal(results, "e2e", d, "under the lock", { id: m1.id });
      if (refusal) throw refusal;
      return results.flatMap((r) => (r.override ? [r.override] : []));
    };
    const sent = ch.sent.length;
    await expect(executeRevert(venv, ordered, { id: m1.id, approvedDigest: digest, approve: (d) => verifyApproval(ledgerFor(digest), OP, d), policy: judge(), log: quiet })).rejects.toThrow(/refused by policy under the lock/);
    expect(ch.sent.length).toBe(sent);
    const source = overrideSource(REVERT_SUBJECT, digest, ["no-drops"], [{ by: "alice", note: "TICKET-9" }]);
    await executeRevert(venv, ordered, { id: m1.id, approvedDigest: digest, approve: (d) => verifyApproval(ledgerFor(digest), OP, d), policy: judge(source), log: quiet, processEnv: { USER: "tester" } });
    const reverted = ch.rows.at(-1);
    expect(reverted?.status).toBe("reverted");
    expect(JSON.parse(reverted?.note as string) as unknown).toMatchObject({ policy: { overrides: [{ rule: "no-drops", by: "alice", reason: "TICKET-9", digest }] } });
  });

  it("says what a wave's gate policy makes of the revert: under on-destructive, a destructive revert waits", () => {
    const dropping = plan([row(1, m0), row(2, m1)], m1.id);
    const wave = revertWaveOf("on-destructive", "abc", "clickhouse", dropping);
    expect(wave.destructiveSteps).toEqual([expect.objectContaining({ migration: m1.id, step: 0, why: expect.stringMatching(/destructive/) as unknown })]);
    expect(wave.policyWaits).toBe(true);
    expect(revertWaveOf("never", "abc", "clickhouse", dropping).policyWaits).toBe(false);
    expect(revertWaveOf("always", "abc", "clickhouse", dropping).policyWaits).toBe(true);
  });
});

describe("pgWidenChecks", () => {
  it("widens an older Postgres history's CHECK constraints for revert rows, and leaves a new one", async () => {
    const { pgWidenChecks } = await import("../src/history/postgres/ddl.js");
    const old = [
      { name: "history_kind_check", def: "CHECK ((kind = ANY (ARRAY['migration'::text, 'statement'::text, 'step'::text])))" },
      { name: "history_status_check", def: "CHECK ((status = ANY (ARRAY['started'::text, 'succeeded'::text, 'failed'::text])))" },
    ];
    expect(pgWidenChecks("yodeler", old)).toEqual([
      `ALTER TABLE "yodeler"."history" DROP CONSTRAINT "history_kind_check", ADD CONSTRAINT "history_kind_check" CHECK (kind IN ('migration', 'statement', 'step', 'revert'))`,
      `ALTER TABLE "yodeler"."history" DROP CONSTRAINT "history_status_check", ADD CONSTRAINT "history_status_check" CHECK (status IN ('started', 'succeeded', 'failed', 'reverted'))`,
    ]);
    const now = [
      { name: "history_kind_check", def: "CHECK ((kind = ANY (ARRAY['migration'::text, 'statement'::text, 'step'::text, 'revert'::text])))" },
      { name: "history_status_check", def: "CHECK ((status = ANY (ARRAY['started'::text, 'succeeded'::text, 'failed'::text, 'reverted'::text])))" },
    ];
    expect(pgWidenChecks("yodeler", now)).toEqual([]);
  });
});

describe("planRevert with a checkpoint", () => {
  it("refuses the checkpoint an environment started from, and a migration before it", async () => {
    const { createCheckpoint } = await import("../src/migrations/index.js");
    const made = createCheckpoint({ name: "base", parent: m1, now: at(3) });
    const cp: Migration = { id: made.id, dir: "/x", parent: m1.id, checksum: made.document.checksum, document: made.document, files: made.files };
    const ordered = [m0, m1, cp];
    const state = deriveState([row(1, cp)]);
    const status = compareHistory(ordered, state);
    const own = refusal(() => planRevert({ environment: "e2e", ordered, status, state, id: cp.id }));
    expect([own.exitCode, own.message]).toEqual([4, expect.stringContaining(`${cp.id} is the checkpoint e2e started from`)]);
    const past = refusal(() => planRevert({ environment: "e2e", ordered, status, state, id: m1.id }));
    expect([past.exitCode, past.message]).toEqual([4, expect.stringContaining(`comes before the checkpoint ${cp.id}`)]);
  });
});
