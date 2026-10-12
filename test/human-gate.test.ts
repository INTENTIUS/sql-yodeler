/**
 * scenarios/lib/human-gate.ts: what a person's grant lets a coding agent start.
 */

import { describe, expect, it } from "vitest";
import { grantRefusal, grantTake, type Grant } from "../scenarios/lib/human-gate.js";

const later = Math.floor(Date.now() / 1000) + 3600;

describe("grant", () => {
  it("refuses with no grant, an expired one, a name it does not hold, or one with no runs left", () => {
    expect(grantRefusal(undefined, ["waves"], true)).toMatch(/no grant/);
    expect(grantRefusal({ expires: 1, runs: { waves: 2 } }, ["waves"], true)).toBe("the grant expired");
    expect(grantRefusal({ expires: later, runs: { waves: 2 } }, ["waves", "resume"], true)).toBe("resume is not in the grant");
    expect(grantRefusal({ expires: later, runs: { waves: 0 } }, ["waves"], true)).toMatch(/no runs left/);
  });

  it("lets through every name it holds, and claims covers any claim but not the bench", () => {
    const g: Grant = { expires: later, runs: { claims: 2, waves: 1 } };
    expect(grantRefusal(g, ["waves", "resume"], true)).toBeUndefined();
    expect(grantRefusal(g, ["bench"], false)).toBe("bench is not in the grant");
  });

  it("takes one run of each entry, once however many claims it covers", () => {
    const g: Grant = { expires: later, runs: { claims: 2, waves: 2 } };
    expect(grantTake(g, ["waves", "resume", "approval"], true).runs).toEqual({ claims: 1, waves: 1 });
  });
});
