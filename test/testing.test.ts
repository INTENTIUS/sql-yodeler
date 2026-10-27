/**
 * yodel test (#54): loading test files, judging expectations, and the
 * report as JSON and JUnit. The runs against a server are in the migrations claim.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { expectError, expectRows, expectValue } from "../src/testing/define.js";
import { asText, expectationFailure, loadTests, memoryReceipts, testFiles } from "../src/testing/run.js";
import { testExitCode, testJunit } from "../src/testing/report.js";
import type { TestRun } from "../src/testing/run.js";

describe("expectations", () => {
  it("compares rows and values as text, in order", () => {
    const rows = { rows: [{ id: "1", country: "FR" }, { id: 2, country: "US" }] };
    expect(expectationFailure(expectRows("SELECT id, country FROM t ORDER BY id", [[1, "FR"], ["2", "US"]]), rows)).toBeUndefined();
    expect(expectationFailure(expectRows("SELECT id, country FROM t ORDER BY id", [[2, "US"], [1, "FR"]]), rows)).toMatch(/returned \[\["1","FR"\],\["2","US"\]\]; expected \[\["2","US"\],\["1","FR"\]\]/);
    expect(expectationFailure(expectValue("SELECT count() FROM t", 2), { rows: [{ n: "2" }] })).toBeUndefined();
    expect(expectationFailure(expectValue("SELECT count() FROM t", 3), { rows: [{ n: "2" }] })).toMatch(/returned 2; expected 3/);
    expect(expectationFailure(expectValue("SELECT x FROM t", 1), { rows: [] })).toMatch(/returned no row/);
    expect(expectationFailure(expectValue("SELECT x FROM t", 1), { error: "no such table" })).toMatch(/failed: no such table/);
    expect(asText(null)).toBe("NULL");
    expect(asText(false)).toBe("false");
    expect(asText(new Date("2026-10-10T00:00:00Z"))).toBe("2026-10-10T00:00:00.000Z");
  });

  it("expects an error, by text or pattern", () => {
    const err = { error: 'new row for relation "orders" violates check constraint "orders_amount_positive"' };
    expect(expectationFailure(expectError("INSERT ...", "orders_amount_positive"), err)).toBeUndefined();
    expect(expectationFailure(expectError("INSERT ...", /violates check constraint/g), err)).toBeUndefined();
    expect(expectationFailure(expectError("INSERT ..."), err)).toBeUndefined();
    expect(expectationFailure(expectError("INSERT ...", "not null"), err)).toMatch(/failed, but not with not null/);
    expect(expectationFailure(expectError("INSERT ..."), { rows: [] })).toMatch(/expected an error .* and it succeeded/);
  });
});

describe("test files", () => {
  it("loads tests/*.test.ts, and names what is wrong with one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yodel-test-files-"));
    try {
      expect(testFiles(dir)).toEqual([]);
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests", "a.test.ts"), `export default [{ name: "one", seed: ["INSERT 1"], expect: [{ kind: "value", sql: "SELECT 1", value: 1 }] }];\n`);
      writeFileSync(join(dir, "tests", "notes.md"), "not a test\n");
      const [file] = await loadTests(dir);
      expect(file?.file).toBe(join("tests", "a.test.ts"));
      expect(file?.cases.map((c) => c.name)).toEqual(["one"]);
      writeFileSync(join(dir, "tests", "b.test.ts"), `export default [{ expect: [] }];\n`);
      await expect(loadTests(dir)).rejects.toThrow(/b\.test\.ts: case 0 has no name; case 0: expect lists at least one expectation/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a backfill's receipts in memory, for one case", async () => {
    const store = memoryReceipts();
    const r = { name: "fill-1", effect: "fill/1", flavor: "existence" as const, inputs: {} };
    expect(await store.read(r)).toBeUndefined();
    await store.write(r, "done");
    expect(await store.read(r)).toBe("done");
    expect(await memoryReceipts().read(r)).toBeUndefined();
  });

  it("gives a rebuild its partitions' receipts under the addresses it asks for (#112)", async () => {
    const store = memoryReceipts();
    const part = (p: string) => ({ name: `rebuild/shop.events/${p}`, effect: `rebuild/shop.events/${p}`, flavor: "hash" as const, inputs: {} });
    await store.write(part("202609"), "h1");
    await store.write(part("202610"), "h2");
    await store.write({ name: "x", effect: "rebuild/shop.other/202610", flavor: "hash", inputs: {} }, "h3");
    // chant's addresses are <stack>/<env>/<effect>.
    expect(await store.readAll("app/staging/rebuild/shop.events/")).toEqual(new Map([["app/staging/rebuild/shop.events/202609", "h1"], ["app/staging/rebuild/shop.events/202610", "h2"]]));
    expect(await store.readAll("-/-/rebuild/shop.events/")).toEqual(new Map([["-/-/rebuild/shop.events/202609", "h1"], ["-/-/rebuild/shop.events/202610", "h2"]]));
    expect((await memoryReceipts().readAll("-/-/rebuild/shop.events/")).size).toBe(0);
  });
});

describe("the report", () => {
  const run: TestRun = {
    environment: "replay",
    dialect: "clickhouse",
    where: "http://127.0.0.1:8123 (sql.profiles.replay)",
    scope: ["shop"],
    reset: false,
    files: ["tests/events.test.ts"],
    cases: [
      { file: "tests/events.test.ts", name: "fills <country>", status: "passed", ms: 1200, failures: [], before: ["a"], after: ["b"] },
      { file: "tests/events.test.ts", name: "keeps & sorts", status: "failed", ms: 10, failures: ['SELECT 1 returned 2; expected "3"'], before: ["a"], after: [] },
      { file: "tests/events.test.ts", name: "seeds", status: "error", ms: 5, failures: [], error: "seed statement 0 failed", before: [], after: [] },
    ],
  };

  it("writes JUnit XML, one testsuite per file, escaped", () => {
    const xml = testJunit(run);
    expect(xml).toContain('<testsuite name="tests/events.test.ts" tests="3" failures="1" errors="1" time="1.215">');
    expect(xml).toContain('<testcase classname="tests/events.test.ts" name="fills &lt;country&gt;" time="1.200"/>');
    expect(xml).toContain('<failure message="SELECT 1 returned 2; expected &quot;3&quot;">');
    expect(xml).toContain('<error message="seed statement 0 failed">');
    expect(testExitCode(run)).toBe(1);
    expect(testExitCode({ ...run, cases: run.cases.slice(0, 1) })).toBe(0);
  });
});
