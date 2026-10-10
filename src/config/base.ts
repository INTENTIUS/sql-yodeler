/**
 * Reading the project's config as it is at the base commit: the commit a
 * change merges onto. A setting that decides how a change is gated (a
 * wave's gate policy) is read there, never from the change itself, so a
 * pull request cannot loosen the rule that gates its own merge.
 *
 * The base is, first one that applies:
 *
 * 1. `YODEL_BASE`, a commit-ish;
 * 2. on a pull request, the merge base of `HEAD` and the target branch
 *    (`GITHUB_BASE_REF` on GitHub and Forgejo,
 *    `CI_MERGE_REQUEST_TARGET_BRANCH_NAME` on GitLab), on `origin`;
 * 3. `HEAD^1`, the first parent: after a merge or a squash onto the
 *    branch, the branch as it was before the change.
 *
 * chant's wave runner reads its spec file at the first parent too
 * (`chant run wave`), so the two agree on a push to the branch.
 */

import { execFileSync } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { YodelError } from "../project.js";
import type { PolicyConfig, YodelConfig } from "./define.js";
import { checkYodelConfig, CONFIG_FILE } from "./load.js";

export const BASE_ENV = "YODEL_BASE";

/** Where the base was taken from, for messages. */
export interface BaseRef {
  /** What `git rev-parse` resolves. */
  ref: string;
  /** How it was chosen. */
  source: string;
}

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** The base commit to read at, by the rule at the top. */
export function baseRef(cwd: string, env: NodeJS.ProcessEnv = process.env): BaseRef {
  const set = env[BASE_ENV];
  if (set) return { ref: set, source: BASE_ENV };
  const target = env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME || env.GITHUB_BASE_REF;
  if (target) {
    try {
      return { ref: git(cwd, ["merge-base", "HEAD", `origin/${target}`]), source: `the merge base with origin/${target}` };
    } catch {
      // A shallow or partial checkout: fall through to the first parent.
    }
  }
  return { ref: "HEAD^1", source: "HEAD^1, the commit the change merged onto" };
}

/** The file at `path` (relative to `cwd`) at commit `ref`; text null when that commit has no such file. */
export function fileAtBase(cwd: string, path: string, ref: string): { sha: string; text: string | null } {
  let sha: string;
  try {
    sha = git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
  } catch {
    throw new YodelError(
      `the config is read at the base commit ${ref}, which this checkout does not have. ` +
        `Check out the full history (fetch-depth: 0 on GitHub and Forgejo, GIT_DEPTH: "0" on GitLab), or set ${BASE_ENV}.`,
    );
  }
  try {
    return { sha, text: execFileSync("git", ["show", `${sha}:./${path.split("\\").join("/")}`], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch {
    return { sha, text: null };
  }
}

/** yodel.config.ts as the base commit has it. */
export interface ConfigAtBase {
  base: BaseRef;
  sha: string;
  /** Undefined when the base has no yodel.config.ts. */
  config: YodelConfig | undefined;
}

/**
 * Loads `<dir>/yodel.config.ts` as it is at the base. The file is
 * evaluated from a copy beside the project's own, so its imports resolve
 * as they do there, and the copy is removed after.
 */
export async function loadYodelConfigAtBase(dir: string, env: NodeJS.ProcessEnv = process.env): Promise<ConfigAtBase> {
  const base = baseRef(dir, env);
  const { sha, text } = fileAtBase(dir, CONFIG_FILE, base.ref);
  if (text === null) return { base, sha, config: undefined };
  const copy = join(dir, `.yodel.config.base-${sha.slice(0, 12)}-${String(process.pid)}.ts`);
  writeFileSync(copy, text);
  try {
    let mod: { default?: unknown };
    try {
      mod = (await import(`${pathToFileURL(copy).href}?base=${sha}`)) as { default?: unknown };
    } catch (e) {
      throw new YodelError(`${CONFIG_FILE} at ${sha.slice(0, 12)} (${base.source}): ${e instanceof Error ? e.message : String(e)}`);
    }
    // Not checked against the profiles: the base may name an environment the change removes.
    return { base, sha, config: checkYodelConfig(mod.default, `${CONFIG_FILE} at ${sha.slice(0, 12)}`) };
  } finally {
    if (existsSync(copy)) unlinkSync(copy);
  }
}

/** The plan policy (#53) as the base commit has it (#73). */
export interface PolicyAtBase {
  policy: PolicyConfig | undefined;
  /** The base commit read, when one could be. */
  sha?: string;
  /** Why the working tree's policy is not the one that applies, when it differs; for the plan and apply to say. */
  note?: string;
}

/**
 * `policy` from yodel.config.ts at the base commit, never the working
 * tree's: a pull request that weakens or deletes a rule is judged by the
 * rule the branch had. A base with no policy (or no yodel.config.ts) applies
 * none, whatever the working tree adds, and the note says so. A checkout
 * with no base to read (no git, a repository's first commit) applies none
 * either.
 */
export async function policyAtBase(project: { dir: string; yodel?: { config: YodelConfig } | undefined }, env: NodeJS.ProcessEnv = process.env): Promise<PolicyAtBase> {
  const tree = project.yodel?.config.policy;
  let at: ConfigAtBase;
  try {
    at = await loadYodelConfigAtBase(project.dir, env);
  } catch (e) {
    const why = e instanceof Error ? (e.message.split("\n")[0] ?? "") : String(e);
    return { policy: undefined, ...(tree ? { note: `The policy is read at the base commit, and there is none to read (${why}), so no policy applies.` } : {}) };
  }
  const policy = at.config?.policy;
  const short = at.sha.slice(0, 12);
  if (tree && !policy) {
    return { policy: undefined, sha: at.sha, note: `yodel.config.ts at ${short} (${at.base.source}) declares no policy, so none applies; the working tree's applies once it is on the branch.` };
  }
  if (policy && !samePolicy(tree, policy)) {
    return { policy, sha: at.sha, note: `The policy applied is yodel.config.ts's at ${short} (${at.base.source}), not the working tree's, which applies once it is on the branch.` };
  }
  return { policy, sha: at.sha };
}

/** Whether two policies say the same: their rules by id and what each declares (a check by its source), and their overriders. */
function samePolicy(a: PolicyConfig | undefined, b: PolicyConfig | undefined): boolean {
  const canon = (p: PolicyConfig | undefined) =>
    JSON.stringify(p, (_k, v: unknown) => (v instanceof RegExp ? v.toString() : typeof v === "function" ? v.toString() : v));
  return canon(a) === canon(b);
}
