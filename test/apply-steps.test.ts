import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { describeStep, heldSteps, runStepHooks, sqlStepOfArgv, STEP_SQL_FLAG, stepHooks, stepsHooksFile, stepsOfNote, stepsRefusal, type StepOutcome } from "../src/apply-steps/index.js";
import { wavesSpec } from "../src/ci/render.js";
import type { ApplySteps } from "../src/config/define.js";
import { checkYodelConfig } from "../src/config/load.js";
import type { HistoryRow } from "../src/history/index.js";
import { deriveAudit } from "../src/report/audit.js";

const driver = (rows: Record<string, Array<Record<string, unknown>>>) => ({
  readCheck: (sql: string) => {
    const r = rows[sql];
    return r ? Promise.resolve(r) : Promise.reject(new Error(`relation does not exist\nLINE 1`));
  },
});

describe("steps config", () => {
  const env = (steps: unknown) => ({ environments: { prod: { steps } } });
  it("takes sql or command steps, before and after", () => {
    expect(() => checkYodelConfig(env({ before: [{ name: "lag", sql: "SELECT 1", expect: "true", onFailure: "approve" }], after: [{ name: "smoke", command: "true" }] }), "y")).not.toThrow();
  });
  it("refuses what it cannot run", () => {
    expect(() => checkYodelConfig(env({ before: [{ name: "x", sql: "SELECT 1", command: "true" }] }), "y")).toThrow(/give sql or command, one of them/);
    expect(() => checkYodelConfig(env({ before: [{ name: "x" }] }), "y")).toThrow(/give sql or command/);
    expect(() => checkYodelConfig(env({ before: [{ name: "X", sql: "s" }] }), "y")).toThrow(/lowercase letters/);
    expect(() => checkYodelConfig(env({ before: [{ name: "x", sql: "s" }], after: [{ name: "x", command: "c" }] }), "y")).toThrow(/two steps are named x/);
    expect(() => checkYodelConfig(env({ after: [{ name: "x", command: "c", onFailure: "approve" }] }), "y")).toThrow(/nothing left to hold/);
    expect(() => checkYodelConfig(env({ before: [{ name: "x", command: "c", expect: "true" }] }), "y")).toThrow(/only a sql step has an expect/);
    expect(() => checkYodelConfig(env({ before: [{ name: "x", sql: "s", expect: { least: 1 } }] }), "y")).toThrow(/expect/);
    expect(() => checkYodelConfig(env({ during: [] }), "y")).toThrow(/unknown setting \(expected before, after\)/);
  });
});

describe("steps as stage hooks (#206)", () => {
  const steps: ApplySteps = {
    before: [
      { name: "lag", sql: "SELECT lag", expect: { max: 10 }, onFailure: "approve" },
      { name: "notify", command: "./notify.sh" },
    ],
    after: [{ name: "smoke", sql: "SELECT none" }],
  };

  it("makes the SQL checks before-plan hooks, and every step an apply-stage hook the apply runs", () => {
    const hooks = stepHooks(steps);
    expect(hooks?.apply).toEqual({ runBy: "apply" });
    expect(hooks?.before?.plan?.map((h) => h.name)).toEqual(["lag"]);
    expect(hooks?.before?.apply?.map((h) => [h.name, h.onFailure ?? "fail", h.perRun])).toEqual([
      ["lag", "approve", true],
      ["notify", "fail", true],
    ]);
    expect(hooks?.after?.apply?.map((h) => h.name)).toEqual(["smoke"]);
    expect(hooks?.before?.apply?.[1]?.command).toEqual(["sh", "-c", "./notify.sh"]);
    expect(stepHooks(undefined)).toBeUndefined();
    expect(stepHooks({ before: [], after: [] })).toBeUndefined();
  });

  it("reads a SQL step back from its hook's argv", () => {
    const argv = stepHooks(steps)?.before?.plan?.[0]?.command ?? [];
    expect(argv.slice(0, 4)).toEqual(["yodel", "apply", "{target}", STEP_SQL_FLAG]);
    expect(sqlStepOfArgv(argv)).toEqual({ name: "lag", sql: "SELECT lag", when: "before", expect: { max: 10 }, onFailure: "approve" });
    expect(sqlStepOfArgv(["sh", "-c", "true"])).toBeUndefined();
  });

  it("renders into the waves spec, by wave, and chant takes them", async () => {
    const spec = wavesSpec([{ env: "staging", gate: "never", steps }, { env: "prod", gate: "always" }]);
    expect(spec.waves[0]?.hooks?.before?.plan?.[0]?.name).toBe("lag");
    expect(spec.waves[1]?.hooks).toBeUndefined();
    const { assertOpWavesSpec } = await import("@intentius/chant/op");
    expect(() => { assertOpWavesSpec(spec); }).not.toThrow();
  });
});

describe("running steps through chant's runner", () => {
  const dir = mkdtempSync(join(tmpdir(), "yodel-steps-"));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const ctx = (rows: Record<string, Array<Record<string, unknown>>>) => ({ driver: driver(rows), dir, env: "prod" });

  it("judges sql like a check, and a command by its exit, in order", async () => {
    const file = stepsHooksFile(
      {
        before: [
          { name: "lag", sql: "SELECT lag", expect: { max: 10 } },
          { name: "none", sql: "SELECT none" },
          { name: "broken", sql: "SELECT broken", onFailure: "approve" },
          { name: "ok", command: "echo fine" },
          { name: "env", command: 'test "$YODEL_ENV/$YODEL_STEP" = prod/before' },
          { name: "no", command: "echo nope >&2; exit 2" },
          { name: "never", command: "echo never" },
        ],
      },
      "prod",
      { approved: true },
    );
    const got = await runStepHooks(file, "before-apply", ctx({ "SELECT lag": [{ lag: 3 }], "SELECT none": [] }));
    // chant's order: a step that fails stops the ones after it, unless its onFailure is approve.
    expect(got.outcomes.map((o) => [o.name, o.kind, o.passed, o.detail])).toEqual([
      ["lag", "sql", true, "3"],
      ["none", "sql", true, "no rows"],
      ["broken", "sql", false, "the query failed: relation does not exist"],
      ["ok", "command", true, "exit 0: fine"],
      ["env", "command", true, "exit 0"],
      ["no", "command", false, "exit 2: nope"],
    ]);
    expect(heldSteps(got.outcomes)).toEqual(["broken"]);
    const refusal = stepsRefusal("prod", got, "under the lock");
    expect(refusal?.exitCode).toBe(1);
    expect(refusal?.message).toMatch(/before step no failed \(exit 2: nope\)/);
    expect(refusal?.message).not.toMatch(/broken/);
  });

  it("stops at a held step with no approval standing, exit 3; with one, goes on", async () => {
    const held: ApplySteps = { before: [{ name: "lag", sql: "SELECT lag", onFailure: "approve" }] };
    const rows = { "SELECT lag": [{ lag: 3 }] };
    const waits = await runStepHooks(stepsHooksFile(held, "prod", { approved: false }), "before-apply", ctx(rows));
    expect(waits.run.proceed).toBe(false);
    expect(stepsRefusal("prod", waits, "under the lock")?.exitCode).toBe(3);
    const approved = await runStepHooks(stepsHooksFile(held, "prod", { approved: true }), "before-apply", ctx(rows));
    expect(approved.run.proceed).toBe(true);
    expect(stepsRefusal("prod", approved, "under the lock")).toBeUndefined();
  });

  it("runs only the SQL checks before the plan (#107)", async () => {
    const file = stepsHooksFile({ before: [{ name: "lag", sql: "SELECT lag" }, { name: "notify", command: "exit 1" }] }, "prod", { approved: true });
    const got = await runStepHooks(file, "before-plan", ctx({ "SELECT lag": [] }));
    expect(got.outcomes.map((o) => o.name)).toEqual(["lag"]);
  });

  it("fails the run, exit 1, for an after step, the migrations applied", async () => {
    const got = await runStepHooks(stepsHooksFile({ after: [{ name: "smoke", command: "exit 1" }] }, "prod", { approved: true }), "after-apply", ctx({}));
    const e = stepsRefusal("prod", got, "under the lock");
    expect(e?.exitCode).toBe(1);
    expect(e?.message).toMatch(/the migrations are applied, and an after step failed/);
  });

  it("skips a moment with a reason, running nothing, where chant reads it back", async () => {
    const file = { ...stepsHooksFile({ before: [{ name: "notify", command: "exit 1" }] }, "prod", { approved: true }), result: "hooks-result.json" };
    const got = await runStepHooks(file, "before-apply", { ...ctx({}), skip: "nothing to apply" });
    expect(got.run.proceed).toBe(true);
    expect(got.outcomes).toEqual([]);
    const back = JSON.parse(readFileSync(join(dir, "hooks-result.json"), "utf8")) as { moments: string[]; outcomes: Array<{ outcome: string }> };
    expect(back.moments).toEqual(["before-apply"]);
    expect(back.outcomes.map((o) => o.outcome)).toEqual(["skipped"]);
  });

  it("describes a command the plan defers", () => {
    const o: StepOutcome = { name: "notify", when: "before", kind: "command", passed: true, detail: "a command", onFailure: "fail", deferred: true };
    expect(describeStep(o)).toMatch(/^before step notify will run under the lock/);
  });
});

describe("steps in the history and the audit", () => {
  const before: StepOutcome = { name: "lag", when: "before", kind: "sql", passed: false, detail: "1 row", onFailure: "approve" };
  const after: StepOutcome = { name: "smoke", when: "after", kind: "command", passed: true, detail: "exit 0", onFailure: "fail" };
  let seq = 0;
  const row = (r: Partial<HistoryRow> & Pick<HistoryRow, "migration_id" | "status">): HistoryRow => ({
    seq: ++seq, run_id: "run-1", kind: "migration", parent: "", checksum: "c", statement_index: -1, statement_sha: "", error: "", applied_by: "ci", plan_digest: "d", silences: "[]", note: "",
    recorded_at: `2026-10-10 09:00:${String(seq).padStart(2, "0")}.000000`, ...r,
  });

  it("reads them from a note, and lists each step once per run", () => {
    expect(stepsOfNote(JSON.stringify({ wave: {}, steps: [before] }))).toEqual([before]);
    expect(stepsOfNote("")).toEqual([]);
    const rows = [
      row({ migration_id: "m1", status: "started", note: JSON.stringify({ steps: [before] }) }),
      row({ migration_id: "m1", status: "succeeded" }),
      row({ migration_id: "m2", status: "started", note: JSON.stringify({ steps: [before] }) }),
      row({ migration_id: "m2", status: "succeeded", note: JSON.stringify({ steps: [after] }) }),
    ];
    const { entries } = deriveAudit({ environment: "prod", history: "h", rows, sameDigest: (a, b) => a === b });
    const steps = entries.filter((e) => e.kind === "step");
    expect(steps.map((e) => [e.migration ?? "", e.detail])).toEqual([
      ["", "before step lag failed, held for approval (1 row)"],
      ["m2", "after step smoke passed (exit 0)"],
    ]);
    expect(entries.find((e) => e.kind === "applied" && e.migration === "m2")?.detail).toBeUndefined();
  });
});
