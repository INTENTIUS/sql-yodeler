import { describe, expect, it } from "vitest";
import { declaredChanges, planExitCode, planJson, type Plan } from "../src/chant/plan.js";
import type { Build } from "../src/chant/build.js";

const build = {
  path: "/tmp/schema.json",
  output: { dialect: "clickhouse", objects: [{ export: "events", ddl: "CREATE TABLE ..." }] },
  dispose: () => undefined,
} satisfies Build;

const rebuild = { object: "events (yodel_6.events)", field: "orderBy", before: "(kind, ts)", after: "(ts, kind)", rule: "SQLCH220", class: "rebuild" };
const foreignDrop = { object: "yodel_6.handmade", field: "object", before: "yodel_6.handmade", rule: "SQLCH250", class: "drop", destructive: true };

const plan = (changes: Plan["diff"]["changes"], refused: Plan["refused"] = []): Plan => ({
  environment: "e2e",
  dialect: "clickhouse",
  diff: { changes, rebuilds: refused, hints: [] } as Plan["diff"],
  refused,
});

describe("plan", () => {
  it("exits 3 when a change needs its own Op, 0 otherwise", () => {
    expect(planExitCode(plan([]))).toBe(0);
    expect(planExitCode(plan([foreignDrop] as never))).toBe(0);
    expect(planExitCode(plan([rebuild] as never, [rebuild] as never))).toBe(3);
  });

  it("counts only changes to declared objects as work for apply", () => {
    expect(declaredChanges(plan([rebuild, foreignDrop] as never), build).map((c) => c.object)).toEqual(["events (yodel_6.events)"]);
  });

  it("prints chant's diff with the environment and dialect", () => {
    expect(planJson(plan([]))).toEqual({ environment: "e2e", dialect: "clickhouse", changes: [], rebuilds: [], hints: [] });
  });
});
