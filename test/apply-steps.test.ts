import { describe, expect, it } from "vitest";
import { describeStep, heldSteps, runApplySteps, stepsOfNote, stepsRefusal, type StepOutcome } from "../src/apply-steps/index.js";
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

describe("running steps", () => {
  it("judges sql like a check, and a command by its exit", async () => {
    const out = await runApplySteps(
      driver({ "SELECT lag": [{ lag: 3 }], "SELECT none": [] }),
      [
        { name: "lag", sql: "SELECT lag", expect: { max: 10 } },
        { name: "none", sql: "SELECT none" },
        { name: "broken", sql: "SELECT broken", onFailure: "approve" },
        { name: "ok", command: "echo fine" },
        { name: "env", command: 'test "$YODEL_ENV/$YODEL_STEP" = prod/before' },
        { name: "no", command: "echo nope >&2; exit 2" },
      ],
      "before",
      { dir: process.cwd(), env: "prod" },
    );
    expect(out.map((o) => [o.name, o.passed, o.detail])).toEqual([
      ["lag", true, "3"],
      ["none", true, "no rows"],
      ["broken", false, "the query failed: relation does not exist"],
      ["ok", true, "exit 0: fine"],
      ["env", true, "exit 0"],
      ["no", false, "exit 2: nope"],
    ]);
    expect(heldSteps(out)).toEqual(["broken"]);
    const refusal = stepsRefusal("prod", out, "under the lock");
    expect(refusal?.exitCode).toBe(4);
    expect(refusal?.message).toMatch(/before step no failed \(exit 2: nope\)/);
    expect(refusal?.message).not.toMatch(/broken/);
  });

  it("runs the sql checks but not a command when the run is only planned (#107)", async () => {
    const out = await runApplySteps(
      driver({ "SELECT lag": [{ lag: 3 }] }),
      [
        { name: "lag", sql: "SELECT lag", onFailure: "approve" },
        { name: "notify", command: "exit 1", onFailure: "approve" },
      ],
      "before",
      { dir: process.cwd(), env: "prod", commands: "plan" },
    );
    expect(out.map((o) => [o.name, o.passed, o.deferred ?? false])).toEqual([
      ["lag", false, false],
      ["notify", true, true],
    ]);
    expect(heldSteps(out)).toEqual(["lag"]);
    expect(describeStep(out[1] as StepOutcome)).toMatch(/^before step notify will run under the lock/);
  });

  it("fails the run, exit 1, for an after step, the migrations applied", () => {
    const after: StepOutcome = { name: "smoke", when: "after", kind: "command", passed: false, detail: "exit 1", onFailure: "fail" };
    const e = stepsRefusal("prod", [after], "under the lock");
    expect(e?.exitCode).toBe(1);
    expect(e?.message).toMatch(/the migrations are applied, and an after step failed/);
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
