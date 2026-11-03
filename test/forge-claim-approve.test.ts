/**
 * The forge claim reads wave 1's approve line from the apply job's log and
 * the plan comment (scenarios/forges/template-body.ts). From 0.12 chant
 * prints it in yodel's words; before, in chant's. Either is the same
 * approval, which the claim gives with chant approve.
 */

import { describe, expect, it } from "vitest";
import { waveApprove } from "../scenarios/forges/template-body.js";

const D = `jcs1-sha256:${"ab".repeat(32)}`;
const CHANT = `chant approve yodel-apply yodel-apply-wave-1 --plan ${D}`;

describe("the forge claim's wave approve line", () => {
  it("reads chant's words", () => {
    expect(waveApprove(`approve: ${CHANT} (with --resume)`)).toBe(CHANT);
  });
  it("reads yodel's words, with or without the environment", () => {
    expect(waveApprove(`Read the plans, then approve: yodel approve dev --plan ${D} (with --resume, ...)`)).toBe(CHANT);
    expect(waveApprove(`Read the plans, then approve: yodel approve --plan ${D} (with --resume, ...)`)).toBe(CHANT);
  });
  it("finds nothing in a log without one", () => {
    expect(waveApprove("Nothing in wave 1 or after it ran.")).toBeUndefined();
    expect(waveApprove(`yodel approve prod --plan ${D}`)).toBeUndefined();
  });
});
