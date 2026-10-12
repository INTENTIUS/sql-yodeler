import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newSuite, offline } from "./helpers/new-suite.js";
import { yodel } from "./helpers/run.js";

offline();
newSuite("clickhouse");

describe("yodel new arguments", () => {
  it("needs exactly one name, and a well-formed one", async () => {
    expect((await yodel(["new"])).err).toContain("usage: yodel new <name>");
    expect((await yodel(["new", "a", "b"])).code).toBe(1);
    const bad = await yodel(["new", "Add Country", "--dir", join(import.meta.dirname, "fixtures", "clickhouse")]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('migration name "Add Country"');
  });

  it("prints its help", async () => {
    const ran = await yodel(["new", "--help"]);
    expect(ran.code).toBe(0);
    expect(ran.out).toContain("Offline: no database");
  });
});
