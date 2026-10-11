/**
 * scenarios/lib/claim.ts rollup: one claim run of several members, their
 * parts named after them, and BREAK reaching the member that owns a part.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { hold, NotCaught, rollup, runParts, Violation, type Body, type Claim, type Ctx, type Dialect } from "../scenarios/lib/claim.js";

const work = mkdtempSync(join(tmpdir(), "yodel-rollup-"));
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/** A member whose parts each hold plain and violate when broken, logging who ran how. */
function member(name: string, parts: string[] | undefined, seen: string[], dialects: Dialect[] = ["ch", "pg"]): Claim {
  const body: Body = async (ctx) => {
    if (!parts) {
      seen.push(`${ctx.claim}${ctx.broken ? " broken" : ""}`);
      hold(!ctx.broken, `${name} broken`);
      return;
    }
    await runParts(
      ctx,
      undefined,
      parts.map((p) => [p, (c: Ctx) => {
        seen.push(`${c.claim}/${p}${c.broken ? " broken" : ""}`);
        hold(!c.broken, `${p} broken`);
        return Promise.resolve();
      }] as const),
    );
  };
  return { name, says: `${name} says`, dialects: Object.fromEntries(dialects.map((d) => [d, body])), ...(parts ? { parts } : {}) };
}

function ctxFor(claim: Claim, broken: boolean, breaking?: string): Ctx {
  return {
    claim: claim.name,
    dialect: "ch",
    broken,
    ...(breaking !== undefined ? { breaking } : {}),
    db: { name: "db", history: "h", reset: () => Promise.resolve() } as unknown as Ctx["db"],
    env: claim.name,
    work,
    log: () => undefined,
  };
}

async function outcome(claim: Claim, broken: boolean, breaking?: string): Promise<string> {
  const run = claim.dialects.ch as Body;
  try {
    await run(ctxFor(claim, broken, breaking));
    return "held";
  } catch (e) {
    if (e instanceof NotCaught) return `not-caught: ${e.message}`;
    if (e instanceof Violation) return `violated: ${e.message}`;
    return `error: ${(e as Error).message}`;
  }
}

describe("rollup", () => {
  it("names the parts after their members, keeping the claim's own member's names and a prefix when given", () => {
    const seen: string[] = [];
    const c = rollup("resume", [member("resume", ["backfill"], seen), ["lock", member("lock-retry", ["retry", "serial"], seen)], member("out-of-order", undefined, seen)]);
    expect(c.parts).toEqual(["backfill", "lock-retry", "lock-serial", "out-of-order"]);
    expect(c.says).toBe("resume says; lock-retry says; out-of-order says");
  });

  it("refuses two parts of one name", () => {
    const seen: string[] = [];
    expect(() => rollup("x", [member("a", ["p"], seen), ["a", member("b", ["p"], seen)]])).toThrow("two members have a part named a-p");
  });

  it("runs every member plain, each as itself", async () => {
    const seen: string[] = [];
    const c = rollup("m", [member("a", ["p", "q"], seen), member("b", undefined, seen)]);
    expect(await outcome(c, false)).toBe("held");
    expect(seen).toEqual(["a/p", "a/q", "b"]);
  });

  it("under BREAK=1 breaks every member, and is caught when each caught its own", async () => {
    const seen: string[] = [];
    const c = rollup("m", [member("a", ["p"], seen), member("b", undefined, seen)]);
    expect(await outcome(c, true)).toBe("violated: a: p: p broken; b: b broken");
  });

  it("under BREAK=<part> breaks that member's part alone, the others plain", async () => {
    const seen: string[] = [];
    const c = rollup("m", [member("a", ["p", "q"], seen), member("b", undefined, seen)]);
    expect(await outcome(c, true, "a-q")).toBe("violated: a: q: q broken");
    expect(seen).toEqual(["a/p", "a/q broken", "b"]);
  });

  it("fails a broken run in which a member held with its property broken", async () => {
    const seen: string[] = [];
    const deaf: Claim = { name: "deaf", says: "", dialects: { ch: () => Promise.resolve() } };
    const c = rollup("m", [member("a", undefined, seen), deaf]);
    expect(await outcome(c, true)).toBe("not-caught: deaf held with the property broken");
  });

  it("runs a member on its own dialects only, and says which parts are limited", () => {
    const seen: string[] = [];
    const c = rollup("m", [member("a", ["p"], seen), member("b", ["q"], seen, ["pg"])]);
    expect(Object.keys(c.dialects)).toEqual(["ch", "pg"]);
    expect(c.partDialects).toEqual({ "b-q": ["pg"] });
  });
});
