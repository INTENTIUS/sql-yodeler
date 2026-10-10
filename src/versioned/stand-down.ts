/**
 * `yodel apply --stand-down` (`YODEL_STAND_DOWN=1`): an apply that a newer
 * commit will make anyway steps aside instead of queueing for the lock.
 *
 * The branch is the one the run is for: `GITHUB_REF_NAME` (GitHub and
 * Forgejo Actions), `CI_COMMIT_BRANCH` (GitLab CI), else the checked-out
 * branch. Its tip is fetched from `origin`; when that tip is a different
 * commit that contains this one, a newer commit is on the branch, and its
 * own apply job applies the same environment, this run included. Anything
 * that cannot be told (no branch, no origin, a fetch that fails, a tip that
 * does not contain this commit, as after a force-push) is not a newer
 * commit: the apply goes ahead.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const STAND_DOWN_ENV = "YODEL_STAND_DOWN";

/** Whether the environment asks for stand-down: `YODEL_STAND_DOWN=1` (or `true`). */
export const standDownFromEnv = (env: NodeJS.ProcessEnv): boolean => env[STAND_DOWN_ENV] === "1" || env[STAND_DOWN_ENV] === "true";

/** A newer commit on the run's branch, which will apply the environment itself. */
export interface NewerCommit {
  branch: string;
  /** This run's commit. */
  head: string;
  /** The branch's tip on origin. */
  tip: string;
}

async function git(dir: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await exec("git", args, { cwd: dir, timeout: 60_000 });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

/** The branch a run is for; see the module comment. */
export async function runBranch(dir: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const named = env.GITHUB_REF_NAME || env.CI_COMMIT_BRANCH;
  if (named) return named;
  return (await git(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"])) || undefined;
}

/** The newer commit on the run's branch, or `undefined` when there is none or it cannot be told. */
export async function newerCommit(dir: string, env: NodeJS.ProcessEnv = process.env): Promise<NewerCommit | undefined> {
  const branch = await runBranch(dir, env);
  if (!branch) return undefined;
  const head = await git(dir, ["rev-parse", "HEAD"]);
  if (!head) return undefined;
  if ((await git(dir, ["fetch", "--quiet", "--no-tags", "origin", `refs/heads/${branch}`])) === undefined) return undefined;
  const tip = await git(dir, ["rev-parse", "FETCH_HEAD"]);
  if (!tip || tip === head) return undefined;
  // A tip that contains this commit is newer; one that does not (a force-push, another line) is not.
  if ((await git(dir, ["merge-base", "--is-ancestor", head, tip])) === undefined) return undefined;
  return { branch, head, tip };
}

/** What a run that stands down says. */
export const standDownLine = (env: string, n: NewerCommit): string =>
  `standing down: ${n.branch} on origin is at ${n.tip.slice(0, 12)}, newer than this run's ${n.head.slice(0, 12)}, and its own apply applies ${env}. Nothing was applied by this run.`;
