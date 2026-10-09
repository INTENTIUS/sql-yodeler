import { describe, expect, it } from "vitest";
import { driftExitCode, driftFromLifecycle, renderDrift } from "../src/chant/drift.js";
import { lastJsonLine } from "../src/chant/process.js";

// The shape of `chant lifecycle diff <env> --live --json` (chant 0.112.0), trimmed.
const doc = (sql: Record<string, unknown>) => ({ environment: "e2e", lexicons: { sql } });
const resources = (over: Record<string, unknown> = {}) => ({
  missing: [],
  orphan: [],
  runtimeChildren: [],
  disappeared: [],
  newlyObserved: [],
  driftedSinceSnapshot: [],
  unchanged: [],
  unobserved: [],
  ...over,
});
const deep = (over: Record<string, unknown> = {}) => ({
  drifted: [],
  accepted: [],
  unclaimed: [],
  held: [],
  unchanged: [],
  unobserved: [],
  undeclaredEntities: [],
  ...over,
});

describe("drift", () => {
  it("is clean when every declared object matches", () => {
    const drift = driftFromLifecycle("e2e", doc({ resources: resources(), deep: deep({ unchanged: ["events"] }) }));
    expect(drift).toEqual({ environment: "e2e", changed: [], missing: [], unobserved: [] });
    expect(driftExitCode(drift)).toBe(0);
    expect(renderDrift(drift)).toContain("No drift");
  });

  it("reports a property changed out of band and an object gone, and exits 2", () => {
    const drift = driftFromLifecycle(
      "e2e",
      doc({
        resources: resources({ missing: ["ordersStatus"], orphan: ["handmade"] }),
        deep: deep({
          drifted: [{ name: "events", type: "ClickHouse::Table", changes: [{ path: "ttl", kind: "changed", declared: "ts + INTERVAL 90 DAY", live: "ts + toIntervalDay(30)" }] }],
        }),
      }),
    );
    expect(drift.changed.map((c) => c.name)).toEqual(["events"]);
    expect(drift.missing).toEqual(["ordersStatus"]);
    expect(driftExitCode(drift)).toBe(2);
    const text = renderDrift(drift);
    expect(text).toContain("ttl: declared ts + INTERVAL 90 DAY, live ts + toIntervalDay(30)");
    expect(text).toContain("Gone (declared, not on the server):\n  ordersStatus");
    // An object the project does not declare is not drift.
    expect(text).not.toContain("handmade");
  });

  it("exits 1 when nothing drifted but a declared object could not be read", () => {
    const drift = driftFromLifecycle(
      "e2e",
      doc({ resources: resources({ unobserved: [{ name: "events", reason: "no-credentials", detail: "CH_PASSWORD is not set" }] }), deep: deep() }),
    );
    expect(drift.unobserved).toHaveLength(1);
    expect(driftExitCode(drift)).toBe(1);
    expect(renderDrift(drift)).toContain("events: no-credentials (CH_PASSWORD is not set)");
  });

  it("refuses a document with no lexicons", () => {
    expect(() => driftFromLifecycle("e2e", { environment: "e2e", stacks: {} })).toThrow(/per stack/);
    expect(() => driftFromLifecycle("e2e", undefined)).toThrow(/no lexicons/);
  });
});

describe("lastJsonLine", () => {
  it("reads the JSON document after chant's log lines", () => {
    expect(lastJsonLine('fold: 1 file folded\n{"a":1}\n')).toEqual({ a: 1 });
    expect(lastJsonLine('{\n  "a": 2\n}\n')).toEqual({ a: 2 });
    expect(lastJsonLine("no json here")).toBeUndefined();
  });
});
