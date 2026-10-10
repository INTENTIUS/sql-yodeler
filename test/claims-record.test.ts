/** The claims record: merging a run's rows into the record already in the file. */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { mergeRecord, readRecord, type RecordRow, type Stamp } from "../scenarios/record.js";

const early: Stamp = { recorded: "2026-10-01T00:00:00.000Z", commit: "aaaaaaa", dirty: false };
const late: Stamp = { recorded: "2026-10-09T00:00:00.000Z", commit: "bbbbbbb", dirty: true };
const row = (claim: string, dialect: "ch" | "pg", plain: string, stamp: Stamp): RecordRow => ({
  claim,
  dialect,
  says: `${claim} says`,
  needs: null,
  plain,
  break: plain === "pass" ? "caught" : plain,
  seconds: { plain: 1, break: 1 },
  ...stamp,
});
const order = [
  { name: "lint", dialects: ["ch", "pg"] as const },
  { name: "new", dialects: ["ch", "pg"] as const },
  { name: "lock", dialects: ["pg"] as const },
];

describe("mergeRecord", () => {
  const full = mergeRecord(undefined, [row("lint", "ch", "pass", early), row("lint", "pg", "pass", early), row("new", "ch", "pass", early), row("new", "pg", "pass", early), row("lock", "pg", "pass", early)], order, early);

  it("writes a whole record when there is none", () => {
    expect(full.format).toBe(1);
    expect(full.rows.map((r) => `${r.claim}:${r.dialect}`)).toEqual(["lint:ch", "lint:pg", "new:ch", "new:pg", "lock:pg"]);
  });

  it("replaces the rows a run ran, keeps the others with their own stamps, in claim order", () => {
    const merged = mergeRecord(full, [row("new", "pg", "fail", late), row("new", "ch", "fail", late)], order, late);
    expect(merged.rows.map((r) => [r.claim, r.dialect, r.plain, r.commit])).toEqual([
      ["lint", "ch", "pass", "aaaaaaa"],
      ["lint", "pg", "pass", "aaaaaaa"],
      ["new", "ch", "fail", "bbbbbbb"],
      ["new", "pg", "fail", "bbbbbbb"],
      ["lock", "pg", "pass", "aaaaaaa"],
    ]);
    expect([merged.recorded, merged.commit, merged.dirty]).toEqual([late.recorded, late.commit, true]);
  });

  it("replaces only the dialect a run ran", () => {
    const merged = mergeRecord(full, [row("lint", "pg", "fail", late)], order, late);
    expect(merged.rows.find((r) => r.claim === "lint" && r.dialect === "ch")?.plain).toBe("pass");
    expect(merged.rows.find((r) => r.claim === "lint" && r.dialect === "pg")?.plain).toBe("fail");
  });

  it("drops rows whose claim or dialect is no longer listed", () => {
    const merged = mergeRecord(full, [], [{ name: "lint", dialects: ["ch"] }], late);
    expect(merged.rows.map((r) => `${r.claim}:${r.dialect}`)).toEqual(["lint:ch"]);
  });
});

describe("readRecord", () => {
  const dir = mkdtempSync(join(tmpdir(), "yodel-record-"));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads none from a missing file, a record from a record, and refuses anything else", () => {
    expect(readRecord(join(dir, "none.json"))).toBeUndefined();
    const good = join(dir, "good.json");
    const rec = mergeRecord(undefined, [row("lint", "ch", "pass", early)], order, early);
    writeFileSync(good, JSON.stringify(rec));
    expect(readRecord(good)).toEqual(rec);
    const old = join(dir, "old.json");
    writeFileSync(old, JSON.stringify({ recorded: early.recorded, commit: "aaaaaaa", claims: [] }));
    expect(() => readRecord(old)).toThrow(/not a claims record of format 1/);
    const junk = join(dir, "junk.json");
    writeFileSync(junk, "{");
    expect(() => readRecord(junk)).toThrow(/not JSON/);
  });
});
