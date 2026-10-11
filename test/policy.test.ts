import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { MigrationStep } from "@intentius/chant-lexicon-sql/migration-statements";
import { projectFromConfig } from "../src/project.js";
import { checkYodelConfig } from "../src/config/load.js";
import type { PolicyConfig } from "../src/config/define.js";
import type { Migration } from "../src/migrations/index.js";
import {
  compareHistory,
  currentDigest,
  evaluatePolicy,
  executeApply,
  inspect,
  judgePlan,
  openVersioned,
  overrideSubject,
  policyPlan,
  policyRefusal,
  REFUSED,
  selectToApply,
  type MigrateOpRef,
  type OverrideSource,
  type VersionedEnv,
} from "../src/versioned/index.js";
import { appliedOverride, overrideDigest, type StandingOverride } from "@intentius/chant/override-gate";
import { OVERRIDDEN_AT, overrideSource } from "./helpers/overrides.js";
import { deriveState } from "../src/history/index.js";
import { renderPlanMarkdown, renderPlanText } from "../src/pr/render.js";
import type { VersionedPlan } from "../src/pr/model.js";
import { FakeClickHouse, migration } from "./helpers/fake-clickhouse.js";

const OP: MigrateOpRef = { name: "migrate-prod", filePath: "/p/ops/migrate-prod.op.ts", gate: "approve-migrate-prod", quorum: false };
const SUBJECT = overrideSubject(OP.name);

const drop: MigrationStep = {
  kind: "statement",
  object: "old",
  type: "ClickHouse::Table",
  name: "yodel_8.old",
  sql: "DROP TABLE yodel_8.old",
  rule: "SQLCH300",
  class: "drop",
  destructive: true,
  transactional: false,
};
const m1 = migration("20261009T1000-one", null, ["CREATE TABLE yodel_8.a (x UInt8) ENGINE = MergeTree ORDER BY x"]);
const m2 = migration("20261009T1100-drop-old", m1.id, [drop]);

const policy: PolicyConfig = {
  overriders: ["alice"],
  rules: [
    { id: "no-drops", environments: ["prod"], description: "no drops in prod", refuse: { classes: ["drop"] } },
    { id: "no-destructive-dev", environments: ["dev"], refuse: { destructive: true } },
    { id: "silences-cite-a-ticket", silences: { reason: /\b[A-Z]+-\d+\b/ } },
    { id: "small-runs", check: (plan) => (plan.pending.length > 1 ? `${String(plan.pending.length)} migrations in one run` : undefined) },
  ],
};

const pending = (ordered: Migration[]) => compareHistory(ordered, deriveState([])).pending;

describe("policy over the plan (#53)", () => {
  it("judges each rule for the environment: classes, destructive steps, silences' reasons, a predicate", () => {
    const prod = evaluatePolicy(policy, policyPlan("prod", "clickhouse", pending([m1, m2]), new Date("2026-10-10T12:00:00Z")));
    expect(prod.map((r) => [r.id, r.outcome])).toEqual([
      ["no-drops", "denied"],
      ["silences-cite-a-ticket", "allowed"],
      ["small-runs", "denied"],
    ]);
    expect(prod[0]?.reasons).toEqual([`${m2.id} step 0 (yodel_8.old) is drop`]);
    expect(prod[2]?.reasons).toEqual(["2 migrations in one run"]);
    const dev = evaluatePolicy(policy, policyPlan("dev", "clickhouse", pending([m1]).slice(0, 1)));
    expect(dev.map((r) => [r.id, r.outcome])).toEqual([
      ["no-destructive-dev", "allowed"],
      ["silences-cite-a-ticket", "allowed"],
      ["small-runs", "allowed"],
    ]);

    const silenced = { ...m2, files: { ...m2.files, sql: `-- yodel migration ${m2.id}\n\n-- yodel:allow destructive nobody uses it\nDROP TABLE yodel_8.old;\n` } };
    const s = evaluatePolicy({ rules: [policy.rules[2] as PolicyConfig["rules"][number]] }, policyPlan("prod", "clickhouse", pending([m1, silenced]).slice(1)));
    expect(s[0]).toMatchObject({ outcome: "denied", reasons: [expect.stringMatching(/silences destructive with a reason that does not match/) as unknown] });

    const refusal = policyRefusal(prod, "prod", "jcs1-sha256:x", "before the gate");
    expect(refusal?.exitCode).toBe(REFUSED);
    expect(refusal?.message).toMatch(/rules no-drops, small-runs deny this plan/);
    expect(refusal?.message).toContain('yodel override prod --rule no-drops --rule small-runs --reason "<why>"');
  });

  it("counts an override, on chant's override gate, only for exactly that digest and its rules, with a reason, by someone overriders lists, once", async () => {
    const AA = "jcs1-sha256:aa";
    const toApply = pending([m1, m2]);
    const denied = ["no-drops", "small-runs"];
    const spent: StandingOverride[] = [];
    const judge = (source: OverrideSource, spend = false) =>
      judgePlan({
        policy,
        environment: "prod",
        dialect: "clickhouse",
        toApply,
        digest: AA,
        ledger: () => Promise.resolve(source),
        ...(spend ? { spend: (o: StandingOverride) => { spent.push(o); return Promise.resolve(); } } : {}),
      });
    const overridden = async (source: OverrideSource) => (await judge(source)).flatMap((r) => (r.override ? [r.override] : []));
    const counts = overrideSource(SUBJECT, AA, denied, [{ by: "alice", note: "the table was emptied in TICKET-1" }]);
    expect(await overridden(counts)).toEqual(denied.map((rule) => ({ rule, by: "alice", at: OVERRIDDEN_AT, reason: "the table was emptied in TICKET-1", digest: AA })));
    expect(policyRefusal(await judge(counts), "prod", AA, "under the lock")).toBeUndefined();
    // Someone overriders does not list, no reason, another plan, a part of the rules, older than the denial: none counts.
    expect(await overridden(overrideSource(SUBJECT, AA, denied, [{ by: "mallory", note: "trust me" }]))).toEqual([]);
    expect(await overridden(overrideSource(SUBJECT, AA, denied, [{ by: "alice" }]))).toEqual([]);
    expect(await overridden(overrideSource(SUBJECT, AA, denied, [{ by: "alice", note: "x", digest: "jcs1-sha256:bb" }]))).toEqual([]);
    expect(await overridden(overrideSource(SUBJECT, AA, denied, [{ by: "alice", note: "x", rules: ["no-drops"] }]))).toEqual([]);
    expect(await overridden(overrideSource(SUBJECT, AA, denied, [{ by: "alice", note: "x" }], { deniedAt: "2026-10-10T13:00:00.000Z" }))).toEqual([]);
    // Under the lock the run spends it, and once spent it counts no more.
    await judge(counts, true);
    expect(spent.map((o) => [o.by, o.digest])).toEqual([["alice", overrideDigest(SUBJECT, AA, denied)]]);
    const applied = appliedOverride(spent[0] as StandingOverride, { timestamp: "2026-10-10T12:30:00.000Z" });
    expect(await overridden(overrideSource(SUBJECT, AA, denied, [{ by: "alice", note: "x" }], { applied: [applied] }))).toEqual([]);
  });

  it("is checked in yodel.config.ts", () => {
    const check = (p: unknown) => () => checkYodelConfig({ policy: p }, "yodel.config.ts", ["prod"]);
    expect(check(policy)).toThrow(/environments: dev is not an environment/);
    expect(check({ rules: [{ id: "x" }] })).toThrow(/needs refuse, silences or check/);
    expect(check({ rules: [{ id: "X y", refuse: {} }] })).toThrow(/lowercase/);
    expect(check({ rules: [{ id: "x", silences: { reason: "TICKET" } }] })).toThrow(/reason: \/pattern\//);
    expect(check({ rules: [{ id: "x", refuse: { classes: ["drop"] } }], overriders: "alice" })).toThrow(/overriders/);
    expect(check({ rules: [{ id: "x", refuse: { classes: ["drop"] } }], overriders: ["alice"] })).not.toThrow();
  });

  it("is refused under the lock when a rule denies with no override, and the history records an override the run relied on", async () => {
    const ch = new FakeClickHouse();
    const url = `http://fake-${randomUUID()}:8123`;
    const project = projectFromConfig("/nowhere", "/nowhere/chant.config.ts", { lexicons: ["sql"], sql: { dialect: "clickhouse", profiles: { prod: { url, databases: ["yodel_8"] } } } });
    const venv: VersionedEnv = await openVersioned(project, { name: "prod", profile: { url } }, { YODEL_HISTORY_DATABASE: "yodel_8_history" }, ch);
    const { status } = await inspect(venv, [m1, m2]);
    const toApply = selectToApply(status, false);
    const digest = await currentDigest(venv, status, toApply);
    const rules: PolicyConfig = { overriders: ["alice"], rules: [policy.rules[0] as PolicyConfig["rules"][number]] };
    const run = (source: OverrideSource | undefined) =>
      executeApply(venv, [m1, m2], {
        approvedDigest: digest,
        allowOutOfOrder: false,
        approve: () => Promise.resolve(),
        log: () => undefined,
        processEnv: { USER: "tester" },
        policy: async (d, pend) => {
          const results = await judgePlan({ policy: rules, environment: "prod", dialect: "clickhouse", toApply: pend, digest: d, ledger: () => Promise.resolve(source) });
          const refusal = policyRefusal(results, "prod", d, "under the lock");
          if (refusal) throw refusal;
          return results.flatMap((r) => (r.override ? [r.override] : []));
        },
      });
    await expect(run(undefined)).rejects.toMatchObject({ exitCode: REFUSED, message: expect.stringMatching(/refused by policy under the lock: rule no-drops denies/) as unknown });
    expect(ch.sent).toEqual([]);
    expect(ch.rows).toEqual([]);

    expect((await run(overrideSource(SUBJECT, digest, ["no-drops"], [{ by: "alice", note: "emptied in TICKET-1" }]))).applied).toEqual([m1.id, m2.id]);
    const started = ch.rows.filter((r) => r.kind === "migration" && r.status === "started");
    expect(started).toHaveLength(2);
    for (const r of started) expect(JSON.parse(String(r.note))).toEqual({ policy: { overrides: [{ rule: "no-drops", by: "alice", at: "2026-10-10T12:00:00.000Z", reason: "emptied in TICKET-1", digest }] } });
  });

  it("shows in the plan text and the pull request comment", () => {
    const plan: VersionedPlan = {
      environment: "prod",
      dialect: "clickhouse",
      appliedCount: 1,
      pending: [],
      problems: [],
      notes: [],
      digest: "jcs1-sha256:aa",
      policy: [
        { id: "no-drops", description: "no drops in prod", outcome: "denied", reasons: ["x step 0 (yodel_8.old) is drop"] },
        { id: "small-runs", outcome: "overridden", reasons: ["2 migrations in one run"], override: { rule: "small-runs", by: "alice", at: "2026-10-10T12:00:00.000Z", reason: "one release", digest: "jcs1-sha256:aa" } },
      ],
    };
    const text = renderPlanText(plan);
    expect(text).toContain("Policy:\n  no-drops: denied: x step 0 (yodel_8.old) is drop\n  small-runs: denied, overridden by alice at 2026-10-10T12:00:00.000Z: one release");
    const md = renderPlanMarkdown(plan);
    expect(md).toContain("#### Policy");
    expect(md).toContain("| `no-drops` no drops in prod | **denied** | x step 0 (yodel_8.old) is drop |");
    expect(md).toContain("| `small-runs` | overridden by alice | 2 migrations in one run; override: one release |");
    expect(md).toContain('yodel override prod --rule no-drops --reason "<why>"');
  });
});
