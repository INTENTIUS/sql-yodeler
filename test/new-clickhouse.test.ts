import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newSuite, offline } from "./helpers/new-suite.js";
import { yodel } from "./helpers/run.js";

offline();
newSuite("clickhouse");

describe("yodel new arguments", () => {
  it("needs at most one name, and a well-formed one; with none, CHANT_COMMIT_PR", async () => {
    const pr = process.env.CHANT_COMMIT_PR;
    Reflect.deleteProperty(process.env, "CHANT_COMMIT_PR");
    try {
      const none = await yodel(["new"]);
      expect(none.code).toBe(1);
      expect(none.err).toContain("yodel new needs a name: give one, or run it in chant's commit job");
      expect(none.err).toContain("usage: yodel new [<name>]");
    } finally {
      if (pr !== undefined) process.env.CHANT_COMMIT_PR = pr;
    }
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
