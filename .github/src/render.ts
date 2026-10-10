/**
 * Renders each workflow declared here to .github/workflows/<name>.yml.
 *
 *   npm run workflows             write the files
 *   npm run workflows -- --check  exit 1 naming each file that differs
 *
 * test/workflows.test.ts runs the same comparison in `npm run check`, so a
 * hand edit to a rendered file, or a declaration changed without rendering,
 * fails the check.
 *
 * The comment at the top of each file is added here, not by chant: the
 * github lexicon's serializer writes no YAML comments (INTENTIUS/chant#3667),
 * so a declaration exports the file's comment as `comment`, and comments on
 * steps stay in the declarations.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { githubSerializer } from "@intentius/chant-lexicon-github/serializer";
import type { Declarable } from "@intentius/chant/declarable";
import * as ci from "./ci.js";
import * as claims from "./claims.js";
import * as claimsWeekly from "./claims-weekly.js";
import * as publish from "./publish.js";

interface Declared {
  workflow: unknown;
  comment?: string;
}

/** Output file name (without .yml) to its declaration. publish must stay publish: npm's trusted publisher names the file. */
const declared: Record<string, Declared> = { ci, claims, "claims-weekly": claimsWeekly, publish };

export const workflowsDir = fileURLToPath(new URL("../workflows/", import.meta.url));

/** Each workflow's file name and the YAML it renders to. */
export function render(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, mod] of Object.entries(declared)) {
    const yaml = githubSerializer.serialize(new Map([["workflow", mod.workflow as Declarable]]));
    if (typeof yaml !== "string") throw new Error(`${name}: expected one workflow file, got several`);
    const head = [`Rendered from .github/src/${name}.ts by \`npm run workflows\`. Edit that file, not this one.`];
    if (mod.comment) head.push("", ...mod.comment.split("\n"));
    out.set(`${name}.yml`, `${head.map((l) => (l ? `# ${l}` : "#")).join("\n")}\n\n${yaml}`);
  }
  return out;
}

/** The rendered files whose committed copy differs. */
export function stale(): string[] {
  return [...render()].filter(([file, yaml]) => {
    try {
      return readFileSync(workflowsDir + file, "utf8") !== yaml;
    } catch {
      return true;
    }
  }).map(([file]) => file);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check")) {
    const files = stale();
    for (const f of files) process.stderr.write(`.github/workflows/${f} is stale: run npm run workflows\n`);
    process.exit(files.length ? 1 : 0);
  }
  for (const [file, yaml] of render()) writeFileSync(workflowsDir + file, yaml);
}
