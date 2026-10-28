/**
 * yodel approve's confirmation in chant core (#295, ruling F on #285,
 * chant#4575): with chant's confirmApproval, chant asks for the target's
 * name with the digest yodel names, and yodel's own question is not asked;
 * a wrong answer or a moved plan comes back as chant's exit code; with no
 * such chant, or when chant has nothing to show, yodel asks as before.
 */

import { describe, expect, it } from "vitest";
import { confirmApproval, type ChantConfirm, type Confirmation } from "../src/chant/confirm.js";
import { standingGate } from "../src/commands/approve.js";
import { EXIT_DECLINED, EXIT_MOVED } from "../src/exit.js";

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) } };
}

const confirmation = (answers: string[], over: Partial<Confirmation> = {}) => {
  const asked: string[] = [];
  const streams = io();
  const c: Confirmation = {
    io: streams.io,
    ask: (q) => {
      asked.push(q);
      return Promise.resolve(answers.shift() ?? "");
    },
    dir: process.cwd(),
    op: "migrate-prod",
    gate: "approve-migrate-prod",
    digest: "jcs1-sha256:abc",
    target: "prod",
    question: "Type prod to approve: ",
    ...over,
  };
  return { c, asked, ...streams };
};

describe("yodel approve's confirmation (#295)", () => {
  it("is chant's when chant has it: the digest and the environment go to chant, and yodel asks nothing of its own", async () => {
    const calls: unknown[] = [];
    const chant: ChantConfirm = {
      async confirmApproval(op, gate, opts) {
        calls.push({ op, gate, plan: opts.plan, environment: opts.environment });
        const answer = await opts.ask?.(`Type ${opts.environment ?? gate} to approve: `);
        return answer === opts.environment ? { status: "confirmed", plan: opts.plan ?? "", target: opts.environment ?? gate } : { status: "refused", code: EXIT_DECLINED };
      },
    };
    const { c, asked } = confirmation(["prod"]);
    expect(await confirmApproval(c, chant)).toBeUndefined();
    expect(calls).toEqual([{ op: "migrate-prod", gate: "approve-migrate-prod", plan: "jcs1-sha256:abc", environment: "prod" }]);
    expect(asked).toEqual(["Type prod to approve: "]);
    expect((await confirmApproval(confirmation(["staging"]).c, chant))).toBe(EXIT_DECLINED);
  });

  it("passes on chant's code for a plan that moved while the person was asked", async () => {
    const chant: ChantConfirm = { confirmApproval: () => Promise.resolve({ status: "refused", code: EXIT_MOVED }) };
    expect(await confirmApproval(confirmation(["prod"]).c, chant)).toBe(EXIT_MOVED);
  });

  it("asks yodel's own question when chant had nothing to show", async () => {
    const chant: ChantConfirm = { confirmApproval: () => Promise.resolve({ status: "skipped" }) };
    const { c, asked } = confirmation(["prod"]);
    expect(await confirmApproval(c, chant)).toBeUndefined();
    expect(asked).toEqual(["Type prod to approve: "]);
  });

  it("restores the working directory chant read the ledger from", async () => {
    const before = process.cwd();
    const chant: ChantConfirm = { confirmApproval: () => Promise.reject(new Error("boom")) };
    await expect(confirmApproval(confirmation(["prod"], { dir: "/" }).c, chant)).rejects.toThrow("boom");
    expect(process.cwd()).toBe(before);
  });

  it("refuses a wrong answer to yodel's own question with 8", async () => {
    const chant: ChantConfirm = { confirmApproval: () => Promise.resolve({ status: "skipped" }) };
    const { c, err } = confirmation(["dev"]);
    expect(await confirmApproval(c, chant)).toBe(EXIT_DECLINED);
    expect(err.join("")).toContain("the answer was not prod");
  });
});

describe("the plan waiting at a gate, by chant's selectors (#295)", () => {
  const pending = (gate: string, digest: string, at: string, expiresAt = "2999-01-01T00:00:00.000Z") => ({ gate, planDigest: digest, timestamp: at, expiresAt }) as never;
  const resolution = (gate: string, digest: string, at: string) => ({ gate, planDigest: digest, timestamp: at }) as never;

  it("is the newest pending fact, until an approval of its plan is recorded after it", () => {
    const ledger = { pending: [pending("g", "jcs1-sha256:a", "2026-10-27T09:00:00.000Z"), pending("g", "jcs1-sha256:b", "2026-10-27T10:00:00.000Z")], resolutions: [] };
    expect(standingGate(ledger, "op", "g", "2026-10-27T11:00:00.000Z")?.digest).toBe("jcs1-sha256:b");
    expect(standingGate({ ...ledger, resolutions: [resolution("g", "jcs1-sha256:b", "2026-10-27T10:30:00.000Z")] }, "op", "g", "2026-10-27T11:00:00.000Z")).toBeUndefined();
    expect(standingGate({ ...ledger, resolutions: [resolution("g", "jcs1-sha256:a", "2026-10-27T10:30:00.000Z")] }, "op", "g", "2026-10-27T11:00:00.000Z")?.digest).toBe("jcs1-sha256:b");
  });

  it("is none once the fact expired", () => {
    expect(standingGate({ pending: [pending("g", "jcs1-sha256:a", "2026-10-27T09:00:00.000Z", "2026-10-27T09:30:00.000Z")], resolutions: [] }, "op", "g", "2026-10-27T10:00:00.000Z")).toBeUndefined();
  });
});
