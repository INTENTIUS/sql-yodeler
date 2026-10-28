/**
 * #293: the lock grain from the sql lexicon and the stand-down through
 * chant. Under the sql capability with a chant that has both, the waves
 * spec sets `standDown` and the apply jobs carry no lock settings of their
 * own; otherwise yodel's YODEL_LOCK_WAIT and YODEL_STAND_DOWN stay. A held
 * lock and a superseded apply exit 5 and 6 from chant's table.
 */

import { describe, expect, it } from "vitest";
import { APPLY_LOCK, chantLocksWaves, wavesSpec, type Wave } from "../src/ci/render.js";
import { EXIT_HELD, EXIT_SUPERSEDED } from "../src/exit.js";
import { chantNewerCommit, newerCommit, ownNewerCommit } from "../src/versioned/stand-down.js";

const waves: Wave[] = [{ env: "staging", gate: "never" }, { env: "prod", gate: "always" }];

describe("the waves spec's stand-down (#293)", () => {
  it("is chant's under the capability when chant locks and stands down the waves", () => {
    expect(wavesSpec(waves, undefined, undefined, { step: true, chantLocks: true }).standDown).toBe(true);
  });

  it("is left out on yodel's callbacks or a chant without it, where the jobs keep yodel's own", () => {
    expect(wavesSpec(waves, undefined, undefined, { step: true }).standDown).toBeUndefined();
    expect(wavesSpec(waves, undefined, undefined, { step: false, chantLocks: true }).standDown).toBeUndefined();
    expect(wavesSpec(waves).standDown).toBeUndefined();
    expect(APPLY_LOCK).toEqual({ YODEL_LOCK_WAIT: "10m", YODEL_STAND_DOWN: "1" });
  });

  it("is found only with chant's stand-down and the sql lexicon's grain", async () => {
    const both = await chantLocksWaves();
    expect(both).toBe((await chantNewerCommit()) !== undefined && both);
  });
});

describe("held and superseded on chant's table (#293)", () => {
  it("are 5 and 6", () => {
    expect([EXIT_HELD, EXIT_SUPERSEDED]).toEqual([5, 6]);
  });
});

describe("the newer commit (#293)", () => {
  it("is chant's answer when chant has it, else yodel's own, and none outside a branch either way", async () => {
    const env = { GITHUB_REF_NAME: "", CI_COMMIT_BRANCH: "" };
    const dir = "/";
    expect(await ownNewerCommit(dir, env)).toBeUndefined();
    expect(await newerCommit(dir, env)).toBeUndefined();
  });
});
