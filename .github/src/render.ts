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
 * Each workflow's comment at the top of its file is the Workflow's `comment`
 * (rendered() in shared.ts). The Dockerfile is chant's product image
 * (`productImageDockerfile`), and its comment is added here, from image.ts's
 * `comment`.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { githubSerializer } from "@intentius/chant-lexicon-github/serializer";
import { productImageDockerfile } from "@intentius/chant/ci-image";
import type { Declarable } from "@intentius/chant/declarable";
import * as ci from "./ci.js";
import * as claims from "./claims.js";
import * as claimsWeekly from "./claims-weekly.js";
import * as image from "./image.js";
import * as pages from "./pages.js";
import * as templates from "./templates.js";
import { rendered } from "./shared.js";

interface Declared {
  workflow: unknown;
}

/**
 * Output file name (without .yml) to its declaration. publish.yml is not one:
 * `chant release workflow` writes it from chant.config.ts's release block
 * (#319), and test/release-config.test.ts checks it.
 */
const declared: Record<string, Declared> = { ci, claims, "claims-weekly": claimsWeekly, pages, templates };

const repoDir = fileURLToPath(new URL("../../", import.meta.url));

/** The Dockerfile's comment lines, from image.ts's `comment`. */
const header = (comment: string): string =>
  rendered("image.ts", comment).split("\n").map((l) => (l ? `# ${l}` : "#")).join("\n");

/** The CI image's Dockerfile: chant's product image from image.ts's spec. */
function renderImage(): string {
  return `${header(image.comment)}\n\n${productImageDockerfile(image.spec)}`;
}

/** Each rendered file's path in the repository and its content. */
export function render(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, mod] of Object.entries(declared)) {
    const yaml = githubSerializer.serialize(new Map([["workflow", mod.workflow as Declarable]]));
    if (typeof yaml !== "string") throw new Error(`${name}: expected one workflow file, got several`);
    out.set(`.github/workflows/${name}.yml`, yaml);
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
