/**
 * yodel.config.ts against chant's product vocabulary (the page "CI Product
 * Config Keys"): each setting has one key there, and yodel keeps reading the
 * spelling it used before. chant's `productConfigProblems` does the checking:
 * an older spelling is a warning that names the key, a spelling set beside
 * its key is an error. This file only moves an older spelling onto the key,
 * so the rest of yodel reads one shape.
 *
 * | yodel.config.ts | Accepted for |
 * |---|---|
 * | `ci.login` | `ci.identity` |
 * | `notify.key` | `notify.webhookKey` |
 * | `notify.relay` | `notify.relayKey` |
 */

import { YodelError } from "../project.js";
import { productConfigProblems, type ProductConfigProblem } from "@intentius/chant/ci-product";

/** The product name in chant's vocabulary. */
const PRODUCT = "sql-yodeler";

/** An older spelling and the key chant's vocabulary gives it, inside `ci` or `notify`. */
const SPELLINGS: ReadonlyArray<{ map: "ci" | "notify"; key: string; internal: string }> = [
  { map: "ci", key: "identity", internal: "login" },
  { map: "notify", key: "webhookKey", internal: "key" },
  { map: "notify", key: "relayKey", internal: "relay" },
];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** chant's findings for a parsed yodel.config.ts: its keys are camelCase and the vocabulary's CI keys sit under `ci`. */
export function vocabularyProblems(config: unknown): ProductConfigProblem[] {
  return productConfigProblems(config, { product: PRODUCT, case: "camel", scopes: ["ci"] });
}

/** A finding as a line: where it is, what it says, and the vocabulary's key. */
export function describeProblem(p: ProductConfigProblem): string {
  return `${p.path} ${p.message} (${p.key})`;
}

/**
 * The config with each vocabulary key moved onto the spelling the rest of
 * yodel reads (`ci.identity` as `ci.login`, `notify.webhookKey` as
 * `notify.key`, `notify.relayKey` as `notify.relay`). A key set beside its
 * older spelling is refused, since the two cannot say different things.
 * chant's check reports that pair for a key at the top level; the keys
 * inside `ci` are named here, until chant's check reads them there too.
 */
export function readVocabulary(config: Record<string, unknown>, where = "yodel.config.ts"): Record<string, unknown> {
  let out = config;
  for (const { map, key, internal } of SPELLINGS) {
    const section = out[map];
    if (!isRecord(section) || !(key in section)) continue;
    const { [key]: value, ...rest } = section;
    if (internal in rest) throw new YodelError(`${where}: ${map}.${internal} and ${map}.${key} are both set; set ${map}.${key} alone`);
    out = { ...out, [map]: { ...rest, [internal]: value } };
  }
  return out;
}
