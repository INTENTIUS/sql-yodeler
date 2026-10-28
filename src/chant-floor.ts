/**
 * The chant release yodel's pipelines move onto chant's product pipeline
 * with (#298, tracker #285).
 *
 * Every part of chant CI yodel uses is feature-detected (src/ci-words.ts,
 * src/ci/render.ts, src/ci/check-hooks.ts, src/ci/login.ts,
 * src/chant/gated-request.ts, src/chant/confirm.ts, src/mcp/chant-hook.ts,
 * src/exit.ts), so a project keeps the pipelines it has until its chant is
 * at least {@link CHANT_CI_FLOOR}. `yodel upgrade` (src/commands/upgrade.ts)
 * then moves it in one commit, and docs/chant-ci.md says so, keyed to the
 * same number.
 *
 * chant names that release `NEXT_RELEASE` until the maintainer cuts it
 * (chant's packages/core/src/release-floors.ts, `CI_PRODUCT_FLOOR`). The
 * release of yodel that takes it as its floor (#299) sets CHANT_CI_FLOOR
 * (src/chant-floor-version.ts, re-exported here) to
 * the version chant published, and test/upgrade.test.ts checks that the
 * docs name the same one.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { chantProduct } from "./ci-words.js";
import { chantLocksWaves, hasSqlCapability } from "./ci/render.js";
import { chantCheckHooks } from "./ci/check-hooks.js";
import { chantTrade } from "./ci/login.js";
import { gatedRequests } from "./chant/gated-request.js";
import { chantConfirm } from "./chant/confirm.js";
import { chantHooks } from "./mcp/chant-hook.js";
import { useChantExitTable } from "./exit.js";

export { CHANT_CI_FLOOR, CHANT_PACKAGES, installLine } from "./chant-floor-version.js";

/**
 * The version of `pkg` that yodel's own imports resolve to, or undefined
 * when it is not installed. The package's entry is resolved and its
 * package.json found above it, since chant exports no `./package.json`.
 */
export function installedVersion(pkg: string, from: string = import.meta.url): string | undefined {
  let at: string;
  try {
    at = createRequire(from).resolve(pkg);
  } catch {
    return undefined;
  }
  for (let dir = dirname(at); dir !== dirname(dir); dir = dirname(dir)) {
    try {
      const json = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
      if (json.name === pkg && typeof json.version === "string") return json.version;
    } catch {
      // no package.json here; keep going up
    }
  }
  return undefined;
}

/** One part of chant CI yodel uses, and whether the installed chant has it. */
export interface ChantPart {
  /** What a person reads in `yodel upgrade`'s list. */
  name: string;
  /** The page section of docs/chant-ci.md that describes it. */
  section: string;
  has: boolean;
}

/**
 * The parts of chant CI yodel feature-detects, in the order docs/chant-ci.md
 * lists them. Each check is the one the command that uses it makes, so the
 * list says what `yodel ci` and the other commands will do with this chant.
 * Variables that keep yodel's own path (`YODEL_GATED_REQUESTS=0`,
 * `YODEL_OWN_CONFIRM=1`) are not read here: the list is about chant.
 */
export async function chantParts(): Promise<ChantPart[]> {
  const product = (await chantProduct()) !== undefined;
  const parts: Array<[string, string, Promise<boolean>]> = [
    ["product pipeline (words, jobs, yodel chant)", "the-pipelines", Promise.resolve(product)],
    ["exit-code table", "exit-codes", useChantExitTable().then((t) => t === "chant")],
    ["sql capability (waves with no callback)", "the-apply-waves", hasSqlCapability()],
    ["lock grain and stand-down", "locks", chantLocksWaves()],
    ["check hooks", "the-check-on-chants-check-hooks", chantCheckHooks().then((m) => m !== undefined)],
    ["cloud identity trade", "cloud-login", chantTrade().then((m) => m !== undefined)],
    ["gated requests and run records", "records-on-the-ledger", gatedRequests({}).then((m) => m !== undefined)],
    ["confirmation at a terminal", "yodel-approve", chantConfirm({}).then((m) => m !== undefined)],
    ["MCP tool hook and traces", "mcp-and-traces", chantHooks().then((m) => m !== undefined)],
  ];
  const out: ChantPart[] = [];
  for (const [name, section, has] of parts) out.push({ name, section, has: await has.catch(() => false) });
  return out;
}
