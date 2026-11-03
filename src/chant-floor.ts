/**
 * The chant release yodel's pipelines move onto chant's product pipeline
 * with (#298, tracker #285).
 *
 * yodel 0.12 takes chant {@link CHANT_CI_FLOOR} as its floor (#303): the
 * pipelines render only through chant's product pipeline, and yodel's own
 * copies of what chant now does (its pipeline generator, plan note, cloud
 * login on GitHub and GitLab, MCP server and stand-down) are gone. A
 * project whose pipelines a yodel before 0.11 rendered runs `yodel
 * upgrade` (src/commands/upgrade.ts) to move them in one commit, and
 * docs/chant-ci.md says so, keyed to the same number. {@link chantParts}
 * still lists each part, so `yodel upgrade` says what a chant below the
 * floor lacks.
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
import { chantCheckHooks } from "./ci/check-hooks.js";
import { gatedRequests } from "./chant/gated-request.js";
import { chantConfirm } from "./chant/confirm.js";
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
 * Whether the installed `specifier` exports every one of `names`: what
 * {@link chantParts} asks of a part yodel imports without a check of its
 * own, since the floor has it. A lazy import, with the specifier in a
 * variable, so a chant below the floor is told, not crashed on.
 */
async function exportsAll(specifier: string, names: readonly string[]): Promise<boolean> {
  try {
    const m = (await import(specifier)) as Record<string, unknown>;
    return names.every((n) => m[n] !== undefined && m[n] !== null);
  } catch {
    return false;
  }
}

/**
 * The parts of chant CI yodel uses, in the order docs/chant-ci.md lists
 * them, and whether the installed chant has each, so `yodel upgrade` says
 * what a chant below the floor lacks. Variables that keep yodel's own path
 * (`YODEL_GATED_REQUESTS=0`, `YODEL_OWN_CONFIRM=1`) are not read here: the
 * list is about chant.
 */
export async function chantParts(): Promise<ChantPart[]> {
  const product = (await chantProduct()) !== undefined;
  const parts: Array<[string, string, Promise<boolean>]> = [
    ["product pipeline (words, jobs, yodel chant)", "the-pipelines", Promise.resolve(product)],
    ["exit-code table", "exit-codes", useChantExitTable().then((t) => t === "chant")],
    ["sql capability (waves with no callback)", "the-apply-waves", exportsAll("@intentius/chant-lexicon-sql/capability-plugin", ["sqlCapabilityPlugin"])],
    ["lock grain and stand-down", "locks", Promise.all([exportsAll("@intentius/chant/op", ["OP_WAVE_STAND_DOWN_FLOOR", "newerCommitOnBranch"]), exportsAll("@intentius/chant-lexicon-sql/lock-grain", ["sqlDefaultLockGrain"])]).then((both) => both.every(Boolean))],
    ["check hooks", "the-check-on-chants-check-hooks", chantCheckHooks().then((m) => m !== undefined)],
    ["cloud identity trade", "cloud-login", Promise.all([exportsAll("@intentius/chant/ci-identity", ["tradeLine", "gitlabTradeLines", "gitlabTradeIdTokens", "TRADE_SPEC_ENV", "AZURE_DATABASE_TOKEN_ENV"]), exportsAll("@intentius/chant-lexicon-sql/token-source", ["tradedToken"])]).then((both) => both.every(Boolean))],
    ["gated requests and run records", "records-on-the-ledger", gatedRequests({}).then((m) => m !== undefined)],
    ["confirmation at a terminal", "yodel-approve", chantConfirm({}).then((m) => m !== undefined)],
    ["MCP tool hook and traces", "mcp-and-traces", exportsAll("@intentius/chant/ci-product", ["runChantInProcess", "configureOtlp", "PRODUCT_MCP_HOOK_FLOOR"])],
  ];
  const out: ChantPart[] = [];
  for (const [name, section, has] of parts) out.push({ name, section, has: await has.catch(() => false) });
  return out;
}
