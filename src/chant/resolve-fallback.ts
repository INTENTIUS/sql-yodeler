/**
 * Packages for a project with no `node_modules` of its own (#312).
 *
 * chant's commit job runs `yodel new` in a git worktree of the pull
 * request's head, outside the checkout the job installed, so the worktree
 * has no `node_modules` and nothing above it does either (chant pull
 * request 4798). Its `chant.config.ts` and `src/` import chant, the sql
 * lexicon and `@intentius/sql-yodeler` by name, and Node finds a package by
 * walking up from the importing file, so every such import fails there.
 *
 * yodel itself runs from the checkout's install (`node_modules/.bin/yodel`
 * on the job's PATH), or from the CI image's global one, and that install
 * holds every package the project's files import. This module registers a
 * Node resolve hook that retries a bare specifier from yodel's own
 * `node_modules` when it was not found, and only for an importing file with
 * no `node_modules` directory in itself or any directory above it, where
 * the import could never resolve. A project that has its own install
 * resolves as before: the hook only ever sees imports that already failed.
 *
 * yodel's bin registers it in its own process (`chant.config.ts` and the
 * Ops are loaded there), and {@link fallbackImportArgs} gives the
 * `--import` the chant children run with (`chant build`, `chant sql
 * types`). The hooks are a `data:` module, so they load the same from
 * `src/` under tsx and from `dist/`.
 */

import { createRequire, register } from "node:module";
import { dirname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";

/** The resolve hook, run on Node's hooks thread. `data.parent` is a file URL in the directory that holds yodel's `node_modules`. */
const HOOKS = `
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
let parent;
export function initialize(data) { parent = data && data.parent; }
const bare = (s) => !/^(\\.{0,2}\\/|[a-zA-Z][a-zA-Z0-9+.-]*:)/.test(s) && !s.startsWith("#");
function installed(url) {
  if (!url || !url.startsWith("file:")) return true;
  let d = dirname(fileURLToPath(url));
  for (;;) {
    if (existsSync(join(d, "node_modules"))) return true;
    const up = dirname(d);
    if (up === d) return false;
    d = up;
  }
}
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (e) {
    if (!parent || !e || e.code !== "ERR_MODULE_NOT_FOUND" || !bare(specifier) || installed(context.parentURL)) throw e;
    return next(specifier, { ...context, parentURL: parent });
  }
}
`;

const HOOKS_URL = `data:text/javascript,${encodeURIComponent(HOOKS)}`;

/** The `node_modules` directory yodel's own packages are installed in, found from chant's place in it. */
export function ownModules(from: string = import.meta.url): string | undefined {
  try {
    const entry = createRequire(from).resolve("@intentius/chant");
    const at = entry.lastIndexOf(`${sep}node_modules${sep}`);
    return at < 0 ? undefined : entry.slice(0, at + `${sep}node_modules`.length);
  } catch {
    return undefined;
  }
}

/** A file URL in the directory holding `modules`, from which a bare specifier resolves into it. */
const parentOf = (modules: string): string => pathToFileURL(join(dirname(modules), "yodel-resolve-fallback.js")).href;

let registered = false;

/** Registers the hook in this process, once. */
export function registerResolveFallback(modules: string | undefined = ownModules()): void {
  if (registered || modules === undefined) return;
  registered = true;
  register(HOOKS_URL, { data: { parent: parentOf(modules) } });
}

/**
 * The `--import` a chant child runs with, before tsx's, so its own imports
 * of the project's files get the same hook; none when yodel's install is
 * not found.
 */
export function fallbackImportArgs(modules: string | undefined = ownModules()): string[] {
  if (modules === undefined) return [];
  const registerIt = `import { register } from "node:module"; register(${JSON.stringify(HOOKS_URL)}, { data: { parent: ${JSON.stringify(parentOf(modules))} } });`;
  return ["--import", `data:text/javascript,${encodeURIComponent(registerIt)}`];
}
