import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { Command, Io } from "../command.js";
import { guarded } from "../env-args.js";
import { EXIT_FAILED, EXIT_OK } from "../exit.js";
import { loadProject, YodelError } from "../project.js";
import { CHANT_CI_FLOOR, chantParts, installedVersion, installLine } from "../chant-floor.js";
import type { RenderedFile } from "../ci/render.js";

const usage = "usage: yodel upgrade [--check] [--dir <project>]";

const help = `${usage}

Moves the project's pipelines onto chant's product pipeline, once the
installed chant is ${CHANT_CI_FLOOR} or later. Install chant first:

  ${installLine()}

then run yodel upgrade, and commit what it writes with package.json and
package-lock.json in one commit. It lists the parts of chant CI the
installed chant has, then:

  - adds chant.workspace.json when the project has no workspace
    declaration, for the check hooks the pull request's lint job runs
  - renders every file yodel ci renders, through chant's product pipeline

From then on yodel ci renders the same files. With a chant before
${CHANT_CI_FLOOR} it writes nothing and exits 1.

Options:
  --check          write nothing; exit 1 naming each file the upgrade would
                   write
  -C, --dir <dir>  the project directory (default: the working directory)

Exit codes:
  0  upgraded, or (--check) nothing left to write
  1  the installed chant has no product pipeline; (--check) a file would
     change; anything else failed
`;

interface UpgradeArgs {
  dir: string;
  check: boolean;
}

function parseUpgradeArgs(args: readonly string[]): UpgradeArgs {
  const out: UpgradeArgs = { dir: process.cwd(), check: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--check") out.check = true;
    else if (a === "--dir" || a === "-C") {
      const v = args[++i];
      if (v === undefined) throw new YodelError(`${a} needs a directory\n${usage}`);
      out.dir = v;
    } else if (a?.startsWith("--dir=")) out.dir = a.slice("--dir=".length);
    else throw new YodelError(`unknown argument ${String(a)}\n${usage}`);
  }
  return out;
}

/**
 * The workspace name in the starter templates' declaration: the package
 * name parameter, which `chant init --from` substitutes, so chant.template.json
 * lists the declaration and holds the name to chant's rule.
 */
export const TEMPLATE_DECLARATION_NAME = "{{chant:name}}";

/** The names chant keeps for itself (chant's workspace/declaration.ts `RESERVED_NAMES`). */
const RESERVED = new Set(["_workspace", "_members"]);

/**
 * A workspace name chant takes (lowercase letters, digits and hyphens,
 * starting with a letter or digit, at most 40 characters), from the
 * project's package name, else its directory's.
 */
export function workspaceName(dir: string): string {
  let pkg: string | undefined;
  try {
    const json = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: unknown };
    if (typeof json.name === "string") pkg = json.name;
  } catch {
    // no package.json: the directory's name
  }
  const raw = (pkg ?? basename(dir)).replace(/^@[^/]+\//, "").toLowerCase();
  const name = raw.replace(/[^a-z0-9-]+/g, "-").replace(/^-+/, "").slice(0, 40).replace(/-+$/, "");
  return name !== "" && !RESERVED.has(name) ? name : "yodel";
}

/** A workspace declaration above `dir`, up to the repository's root, or undefined. chant reads one per repository. */
export function declarationAbove(dir: string): string | undefined {
  if (existsSync(join(dir, ".git"))) return undefined;
  for (let at = dirname(dir); ; at = dirname(at)) {
    for (const f of ["chant.workspace.json", "chant.workspace.jsonc"]) if (existsSync(join(at, f))) return join(at, f);
    if (existsSync(join(at, ".git")) || at === dirname(at)) return undefined;
  }
}

/**
 * The workspace declaration `yodel upgrade` adds: the project as the
 * workspace, no members, and the check hooks `yodel ci` then writes into
 * it. `minReader` is chant's check-hook floor, so a chant too old to run the
 * hooks refuses the file rather than skipping them. `name` overrides the
 * name (the templates pass `{{chant:name}}`).
 */
export async function newDeclaration(dir: string, name: string = workspaceName(dir)): Promise<RenderedFile> {
  const specifier = "@intentius/chant/components/check-hooks";
  let floor: string | undefined;
  try {
    const m = (await import(specifier)) as { CI_CHECK_HOOK_FLOOR?: unknown };
    if (typeof m.CI_CHECK_HOOK_FLOOR === "string") floor = m.CI_CHECK_HOOK_FLOOR;
  } catch {
    // no check hooks: render() leaves the declaration out
  }
  const doc = { name, schema: 1, ...(floor ? { minReader: floor } : {}), members: [] as unknown[] };
  return { path: "chant.workspace.json", content: `${JSON.stringify(doc, null, 2)}\n` };
}

/**
 * Every file the upgrade writes: the declaration it adds, when the project
 * has none and chant has the check hooks to put in it, then every file
 * `yodel ci` renders through chant's product pipeline.
 */
export async function upgradeFiles(dir: string, options: { declarationName?: string } = {}): Promise<{ files: RenderedFile[]; notes: string[] }> {
  const { declarationFile } = await import("../ci/check-hooks.js");
  const { render } = await import("../ci/render.js");
  const notes: string[] = [];
  let declaration: RenderedFile | undefined;
  if (declarationFile(dir) === undefined) {
    const above = declarationAbove(dir);
    if (above) notes.push(`${relative(dir, above)} is the repository's workspace declaration, above the project: yodel ci writes check hooks only into one in the project's directory, so the lint job keeps its own steps`);
    else declaration = await newDeclaration(dir, options.declarationName);
  }
  const files = await render(dir, declaration ? { declaration } : {});
  // render() returns the declaration with the hooks in it; one it left out (no check hooks) is not added.
  return { files, notes };
}

/** Writes `files` under dir (or, with `check`, names those that differ); resolves to the paths that differ. */
export function writeRendered(dir: string, files: readonly RenderedFile[], io: Io, check: boolean): string[] {
  const differ: string[] = [];
  for (const file of files) {
    const abs = join(dir, file.path);
    const current = existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
    if (current === file.content) continue;
    differ.push(file.path);
    if (check) continue;
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, file.content);
    io.out(`wrote ${file.path}${current === undefined ? " (new)" : ""}\n`);
  }
  return differ;
}

/** `yodel upgrade`; the exit codes are in `help`. */
export const upgrade: Command = {
  name: "upgrade",
  summary: "move the pipelines onto chant's product pipeline",
  implemented: true,
  run: (args, io) =>
    guarded("upgrade", io, args, help, async () => {
      const a = parseUpgradeArgs(args);
      const dir = (await loadProject(resolve(a.dir))).dir;
      const chant = installedVersion("@intentius/chant");
      const lexicon = installedVersion("@intentius/chant-lexicon-sql");
      io.out(`chant ${chant ?? "(not found)"}, sql lexicon ${lexicon ?? "(not found)"}\n`);
      const parts = await chantParts();
      for (const p of parts) io.out(`  ${p.has ? "has" : "no "}  ${p.name}\n`);
      if (!parts[0]?.has) {
        io.err(`yodel upgrade: this chant has no product pipeline; yodel's pipelines move onto it from chant ${CHANT_CI_FLOOR}. Install it, then run yodel upgrade again:\n  ${installLine()}\n`);
        return EXIT_FAILED;
      }
      let rendered;
      try {
        rendered = await upgradeFiles(dir);
      } catch (e) {
        throw new YodelError(e instanceof Error ? e.message : String(e));
      }
      for (const n of rendered.notes) io.out(`note: ${n}\n`);
      const differ = writeRendered(dir, rendered.files, io, a.check);
      if (a.check) {
        if (differ.length > 0) {
          io.err(`the upgrade would write: ${differ.join(", ")}\n`);
          return EXIT_FAILED;
        }
        io.out(`${String(rendered.files.length)} CI files are on chant's product pipeline\n`);
        return EXIT_OK;
      }
      if (differ.length === 0) io.out("nothing to write: the pipelines are on chant's product pipeline\n");
      else io.out("commit these with package.json and package-lock.json in one commit; the check hooks run on pull requests once the declaration is on main\n");
      return EXIT_OK;
    }),
};
