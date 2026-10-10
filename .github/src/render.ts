/**
 * Renders each workflow declared here to .github/workflows/<name>.yml, and
 * the CI image (image.ts) to .github/image/Dockerfile.
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

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { githubSerializer } from "@intentius/chant-lexicon-github/serializer";
import { dockerSerializer } from "@intentius/chant-lexicon-docker/serializer";
import type { Declarable } from "@intentius/chant/declarable";
import * as ci from "./ci.js";
import * as claims from "./claims.js";
import * as claimsWeekly from "./claims-weekly.js";
import * as image from "./image.js";
import * as pages from "./pages.js";
import * as publish from "./publish.js";

interface Declared {
  workflow: unknown;
  comment?: string;
}

/** Output file name (without .yml) to its declaration. publish must stay publish: npm's trusted publisher names the file. */
const declared: Record<string, Declared> = { ci, claims, "claims-weekly": claimsWeekly, pages, publish };

const repoDir = fileURLToPath(new URL("../../", import.meta.url));

/** The comment lines at the top of a rendered file, from its declaration and its own comment. */
const header = (source: string, comment?: string): string => {
  const head = [`Rendered from .github/src/${source} by \`npm run workflows\`. Edit that file, not this one.`];
  if (comment) head.push("", ...comment.split("\n"));
  return head.map((l) => (l ? `# ${l}` : "#")).join("\n");
};

/** The CI image's Dockerfile: the docker lexicon's serializer writes it as Dockerfile.<export name>. */
function renderImage(): string {
  const result = dockerSerializer.serialize(new Map([["image", image.image]]));
  const dockerfile = typeof result === "string" ? undefined : result.files?.["Dockerfile.image"];
  if (dockerfile === undefined) throw new Error("image.ts: the docker serializer wrote no Dockerfile");
  return `${header("image.ts", image.comment)}\n\n${dockerfile}`;
}

/** Each rendered file's path in the repository and its content. */
export function render(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, mod] of Object.entries(declared)) {
    const yaml = githubSerializer.serialize(new Map([["workflow", mod.workflow as Declarable]]));
    if (typeof yaml !== "string") throw new Error(`${name}: expected one workflow file, got several`);
    out.set(`.github/workflows/${name}.yml`, `${header(`${name}.ts`, mod.comment)}\n\n${yaml}`);
  }
  out.set(".github/image/Dockerfile", renderImage());
  return out;
}

/** The rendered files whose committed copy differs. */
export function stale(): string[] {
  return [...render()].filter(([file, content]) => {
    try {
      return readFileSync(repoDir + file, "utf8") !== content;
    } catch {
      return true;
    }
  }).map(([file]) => file);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check")) {
    const files = stale();
    for (const f of files) process.stderr.write(`${f} is stale: run npm run workflows\n`);
    process.exit(files.length ? 1 : 0);
  }
  for (const [file, content] of render()) {
    mkdirSync(dirname(repoDir + file), { recursive: true });
    writeFileSync(repoDir + file, content);
  }
}
