/**
 * The installed chant (#298, tracker #285). yodel 0.12 took chant 0.124.67
 * as its floor (#303), and yodel's own chant pin has been above it since,
 * so yodel imports each part of chant CI it uses without a check
 * (chant issue 4792). `yodel upgrade` prints the installed versions.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export { CHANT_PACKAGES } from "./chant-floor-version.js";

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
