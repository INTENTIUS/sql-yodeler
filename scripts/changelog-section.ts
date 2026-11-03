/**
 * Prints the `## <version>` section of CHANGELOG.md, the notes of the GitHub
 * release publish.yml's release job makes for the tag.
 *
 *   node scripts/changelog-section.ts <version> [CHANGELOG.md]
 *
 * The section runs from its heading to the next `## ` heading, without
 * either. A version with no section, or an empty one, exits 1 naming it: the
 * release pull request adds the section (AGENTS.md, Releasing). The job runs
 * this with Node 24, which strips the types itself, so it imports nothing
 * but Node's own modules.
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The body of `## <version>` in `changelog`, trimmed, or undefined when there is no such section or it is empty. */
export function changelogSection(changelog: string, version: string): string | undefined {
  const lines = changelog.split("\n");
  const heading = new RegExp(`^## v?${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);
  const start = lines.findIndex((l) => heading.test(l));
  if (start === -1) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  const body = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
  return body || undefined;
}

function main(argv: string[]): number {
  const [version, file = "CHANGELOG.md"] = argv;
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    process.stderr.write("usage: node scripts/changelog-section.ts <X.Y.Z> [CHANGELOG.md]\n");
    return 1;
  }
  const body = changelogSection(readFileSync(file, "utf8"), version);
  if (body === undefined) {
    process.stderr.write(`::error::${file} has no "## ${version}" section, or it is empty. The release pull request adds it (AGENTS.md, Releasing).\n`);
    return 1;
  }
  process.stdout.write(`${body}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
