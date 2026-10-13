import { describe, expect, it } from "vitest";
import { opExportName } from "../src/chant/export-name.js";
import { exportedOp } from "../src/steps/backfill.js";

const op = (name: string) => ({ props: { name, phases: [] } });

describe("Op export names (#2)", () => {
  it("are the Op's name in camel case, a valid identifier", () => {
    expect(opExportName("migrate-dev")).toBe("migrateDev");
    expect(opExportName("watch-us_east.1")).toBe("watchUsEast1");
    expect(opExportName("backfill-fill-country")).toBe("backfillFillCountry");
    expect(opExportName("2024-load")).toBe("op2024Load");
    expect(opExportName("---")).toBe("op");
  });

  it("let a backfill export its Op as op, as the default, or under one name of its own", () => {
    expect(exportedOp({ op: op("a") })?.name).toBe("a");
    expect(exportedOp({ default: op("b") })?.name).toBe("b");
    expect(exportedOp({ backfillFillCountry: op("c"), months: ["202601"] })?.name).toBe("c");
    expect(exportedOp({ op: op("d"), other: op("e") })?.name).toBe("d");
    expect(exportedOp({ one: op("f"), two: op("g") })).toBeUndefined();
    expect(exportedOp({ months: [] })).toBeUndefined();
  });
});
