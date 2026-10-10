/**
 * Each starter template, made into a project the way a user makes one, with
 * the @intentius/sql-yodeler that its range resolves to on npm (#131).
 *
 *   npm run templates:check
 *
 * Inside this repository the templates are checked against ./src
 * (tsconfig.json's paths), and the template claims pack this checkout into
 * the project, so a template that needs yodel not yet released passes both
 * and still breaks `chant init --from INTENTIUS/sql-yodeler@main#templates/<dialect>`.
 * Here, for each template: `chant init --from` this checkout's template,
 * `npm install` (the range, from the registry), `git init`, `yodel ci --check`,
 * `npm run typecheck`, `yodel new init` and `yodel lint`.
 *
 * One exception: when no release on npm satisfies the range and the range's
 * lowest version is this checkout's package.json version, this checkout is
 * the release that ships it (AGENTS.md, Releasing), so the project takes
 * `npm pack` of this checkout instead. That needs `npm run build` first.
 * Once the release is on npm, the same check takes it from the registry.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = "@intentius/sql-yodeler";
const root = fileURLToPath(new URL("../", import.meta.url));
const ownVersion = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
const chant = join(root, "node_modules", ".bin", "chant");

class Failed extends Error {}

function run(cmd: string, args: string[], cwd: string, capture = false): string {
  process.stdout.write(`$ ${[cmd, ...args].join(" ")}\n`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("npm_") && k !== "INIT_CWD"));
  const ran = spawnSync(cmd, args, { cwd, env: { ...env, NO_COLOR: "1" }, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit" });
  if (ran.status !== 0) throw new Failed(`${cmd} ${args.join(" ")} exited ${String(ran.status ?? ran.signal)}`);
  return capture ? ran.stdout : "";
}

/** The released versions on npm that satisfy range; none when the registry has none. */
function released(range: string): string[] {
  const ran = spawnSync("npm", ["view", `${PKG}@${range}`, "version", "--json"], { encoding: "utf8" });
  const out = ran.stdout.trim();
  if (ran.status !== 0 || out === "") return [];
  const parsed = JSON.parse(out) as string | string[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

function check(template: string): void {
  const work = mkdtempSync(join(tmpdir(), `yodel-template-${template}-`));
  try {
    run(chant, ["init", "--from", `${root}#templates/${template}`, "project"], work);
    const dir = join(work, "project");
    const range = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { dependencies: Record<string, string | undefined> }).dependencies[PKG] ?? "";
    if (!/^\^\d+\.\d+\.\d+$/.test(range)) throw new Failed(`templates/${template}/package.json takes ${PKG} as "${range}", not a caret range of a release`);
    const versions = released(range);
    if (versions.length > 0) {
      process.stdout.write(`${PKG}@${range} resolves on npm (${versions.join(", ")})\n`);
      run("npm", ["install", "--no-audit", "--no-fund"], dir);
    } else if (range.slice(1) === ownVersion) {
      process.stdout.write(`${PKG}@${range} is not on npm yet, and this checkout is ${ownVersion}, the release that ships it: the project takes npm pack of this checkout\n`);
      run("npm", ["pack", "--ignore-scripts", "--silent", "--pack-destination", work], root, true);
      const tgz = readdirSync(work).find((f) => f.endsWith(".tgz"));
      if (tgz === undefined) throw new Failed("npm pack of this checkout wrote no .tgz");
      run("npm", ["install", "--no-audit", "--no-fund", join(work, tgz)], dir);
    } else {
      throw new Failed(`no release of ${PKG} on npm satisfies ${range}, and this checkout is ${ownVersion}, not the release that ships it`);
    }
    const installed = (JSON.parse(readFileSync(join(dir, "node_modules", "@intentius", "sql-yodeler", "package.json"), "utf8")) as { version: string }).version;
    process.stdout.write(`the project has ${PKG} ${installed}\n`);
    // chant finds Ops from the git root, so yodel ci needs a repository.
    run("git", ["init", "-q", "-b", "main"], dir);
    run("npx", ["yodel", "ci", "--check"], dir);
    run("npm", ["run", "typecheck"], dir);
    run("npx", ["yodel", "new", "init"], dir);
    run("npx", ["yodel", "lint"], dir);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const failed: string[] = [];
for (const template of ["clickhouse", "postgres"]) {
  process.stdout.write(`\n== templates/${template}\n`);
  try {
    check(template);
    process.stdout.write(`templates/${template}: works with the ${PKG} its range resolves to\n`);
  } catch (err) {
    if (!(err instanceof Failed)) throw err;
    process.stderr.write(`templates/${template}: ${err.message}\n`);
    failed.push(template);
  }
}
if (failed.length > 0) {
  process.stderr.write(
    `\n${failed.map((t) => `templates/${t}`).join(" and ")} did not work with the published ${PKG} their range resolves to.\n` +
      `A template change that needs unreleased yodel ships with the release that has it (AGENTS.md, Releasing).\n`,
  );
  process.exit(1);
}
