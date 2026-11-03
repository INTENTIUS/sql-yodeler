/**
 * scenarios/lib/gates.ts: how a claim tells a gate from a refusal that also
 * exits 3, and approves a gated request as someone other than the requester.
 */

import { describe, expect, it } from "vitest";
import { atGate, chantApproveArgs, ownApprovalRefused, REVIEWER } from "../scenarios/lib/gates.js";
import type { Ran } from "../scenarios/lib/exec.js";

const ran = (code: number, out: string, err = ""): Ran => ({ code, out, err, timedOut: false });

const approve = "chant approve migrate-prod approve-migrate-prod-cleanup --plan sha256:abc";

describe("chantApproveArgs", () => {
  it("runs the printed command as is, or approved by the approver named", () => {
    expect(chantApproveArgs(approve)).toEqual(["approve", "migrate-prod", "approve-migrate-prod-cleanup", "--plan", "sha256:abc"]);
    expect(chantApproveArgs(approve, REVIEWER)).toEqual(["approve", "migrate-prod", "approve-migrate-prod-cleanup", "--plan", "sha256:abc", "--approver", REVIEWER]);
  });

  it("refuses a missing command, and a command that already names its approver", () => {
    expect(() => chantApproveArgs(undefined)).toThrow(/no chant approve command/);
    expect(() => chantApproveArgs("yodel approve prod --plan sha256:abc")).toThrow(/no chant approve command/);
    expect(() => chantApproveArgs(`${approve} --actor alex`, REVIEWER)).toThrow(/already names its approver/);
  });
});

describe("atGate", () => {
  it("takes a run that stopped at its gate: exit 3, status gated, a chant approve command", () => {
    const doc = { status: "gated", approve: "yodel approve prod --plan jcs1-sha256:1", chantApprove: "chant approve migrate-prod approve-migrate-prod --plan jcs1-sha256:1" };
    const r = atGate(ran(3, `[Plan] plan | jcs1-sha256:1\n${JSON.stringify(doc, null, 2)}\n`), "revert");
    expect("doc" in r && r.doc.chantApprove).toBe(doc.chantApprove);
  });

  it("does not take yodel revert's refusal of a data step without --step, which exits 3 with no JSON (#288)", () => {
    const refused = ran(3, "", "yodel revert: refused: 20261102T2114-label has a data step the recorded schemas cannot undo (step 1: backfill backfill.ts). Nothing was reverted.\n");
    const r = atGate(refused, "revert");
    expect("why" in r && r.why).toMatch(/^exit 3, no JSON on stdout: yodel revert: refused: .*data step/);
  });

  it("does not take exit 3 with a document that is not at the gate, nor a gated document on another exit code", () => {
    expect(atGate(ran(3, JSON.stringify({ status: "planned" })), "revert")).toEqual({ why: "exit 3, status planned" });
    expect("why" in atGate(ran(0, JSON.stringify({ status: "gated", chantApprove: approve })), "revert")).toBe(true);
    expect("why" in atGate(ran(3, JSON.stringify({ status: "gated" })), "revert")).toBe(true);
  });
});

describe("ownApprovalRefused", () => {
  // chant's reason (lifecycle/gated-request.ts), in yodel cleanup's and yodel init --baseline's line.
  const line = "The approval by alex does not count: alex made the request, and a requester's own approval does not count.";

  it("is a run that still waits and says the requester's own approval does not count", () => {
    expect(ownApprovalRefused(ran(3, `Kept by steps in prod:\n\nRequest digest: sha256:1\n${line}\n1 due; nothing dropped\n`))).toBe(true);
  });

  it("is not a run that waits for another reason, or that went on", () => {
    expect(ownApprovalRefused(ran(3, "1 due; nothing dropped without an approval"))).toBe(false);
    expect(ownApprovalRefused(ran(3, "The approval by alex does not count: it is not sealed by a signer."))).toBe(false);
    expect(ownApprovalRefused(ran(0, line))).toBe(false);
  });
});
