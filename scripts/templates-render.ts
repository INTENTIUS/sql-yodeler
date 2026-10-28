/**
 * Renders both starter templates onto chant's product pipeline (#298), for
 * the release that moves yodel's chant floor to chant's CI (#299).
 *
 *   npm run templates:render
 *
 * The template changes are staged in code: this script is the whole of the
 * template work the release does. For each template it pins chant and the
 * sql lexicon in package.json at the versions this checkout has installed,
 * runs what `yodel upgrade` writes (the workspace declaration named
 * `{{chant:name}}`, with yodel's check hooks, and every file `yodel ci`
 * renders through the product pipeline), and adds the declaration to
 * chant.template.json, whose name parameter it holds to chant's rule for a
 * workspace name. Run it again and it writes nothing.
 *
 * It refuses a chant without the product pipeline, and a chant npm does not
 * serve: main's templates must work with what is published (AGENTS.md,
 * Releasing), so they are never rendered against a packed or linked chant.
 * The release pull request then moves the templates' yodel range and runs
 * `npm run templates:check`.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHANT_CI_FLOOR, CHANT_PACKAGES, installedVersion } from "../src/chant-floor.js";
import { chantProduct } from "../src/ci-words.js";
import { TEMPLATE_DECLARATION_NAME, upgradeFiles, writeRendered } from "../src/commands/upgrade.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const TEMPLATES = ["clickhouse", "postgres"] as const;

/** chant's rule for a workspace name, as the name parameter's pattern (chant's workspace/declaration.ts). */
export const WORKSPACE_NAME_PATTERN = "^[a-z0-9][a-z0-9-]{0,39}$";

const fail = (message: string): never => {
  process.stderr.write(`templates:render: ${message}\n`);
  process.exit(1);
};

const published = (pkg: string, version: string): boolean => {
  const ran = spawnSync("npm", ["view", `${pkg}@${version}`, "version"], { encoding: "utf8" });
  return ran.status === 0 && ran.stdout.trim() === version;
};

const versions = Object.fromEntries(CHANT_PACKAGES.map((p) => [p, installedVersion(p, join(root, "package.json"))])) as Record<string, string | undefined>;
for (const [pkg, v] of Object.entries(versions)) {
  if (v === undefined) fail(`${pkg} is not installed; run npm ci first`);
  else if (!published(pkg, v)) fail(`${pkg} ${v} is not on npm: the templates are rendered only against a published chant`);
}
if ((await chantProduct()) === undefined) fail(`the installed chant has no product pipeline; the templates move onto it from chant ${CHANT_CI_FLOOR}`);

const io = { out: (t: string) => process.stdout.write(t), err: (t: string) => process.stderr.write(t) };

for (const t of TEMPLATES) {
  const dir = join(root, "templates", t);
  process.stdout.write(`\n== templates/${t}\n`);

  const pkgFile = join(dir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgFile, "utf8")) as { dependencies: Record<string, string> };
  for (const p of CHANT_PACKAGES) pkg.dependencies[p] = versions[p] ?? pkg.dependencies[p] ?? "";
  const pkgText = `${JSON.stringify(pkg, null, 2)}\n`;
  if (pkgText !== readFileSync(pkgFile, "utf8")) {
    writeFileSync(pkgFile, pkgText);
    io.out("wrote package.json\n");
  }

  const { files, notes } = await upgradeFiles(dir, { declarationName: TEMPLATE_DECLARATION_NAME });
  for (const n of notes) io.out(`note: ${n}\n`);
  writeRendered(dir, files, io, false);

  const declaration = files.find((f) => f.path.startsWith("chant.workspace."));
  if (declaration === undefined) fail(`templates/${t}: the render gave no workspace declaration; the installed chant has no check hooks`);
  const manifestFile = join(dir, "chant.template.json");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as { parameters: { name: { pattern?: string } }; files: string[] };
  if (declaration && !manifest.files.includes(declaration.path)) manifest.files.push(declaration.path);
  manifest.parameters.name.pattern = WORKSPACE_NAME_PATTERN;
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  if (manifestText !== readFileSync(manifestFile, "utf8")) {
    writeFileSync(manifestFile, manifestText);
    io.out("wrote chant.template.json\n");
  }
}
process.stdout.write("\nNext, in the release pull request: move the templates' @intentius/sql-yodeler range to the release, then npm run templates:check.\n");
