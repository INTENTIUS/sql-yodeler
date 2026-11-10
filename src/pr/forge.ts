/**
 * Where `yodel drift <env> --issue` posts (the plan note is chant's note job's since sql-yodeler issue 345):
 * chant's forge client (`@intentius/chant/pr-forge`, #210) for the CI job's
 * forge, repository, pull (merge) request and token, each overridden by a
 * flag. chant reads the job's environment and the flags
 * (`@intentius/chant/forge-flags`, chant issue 4800) and makes every REST
 * call; yodel keeps the bodies.
 *
 * - GitHub Actions: `GITHUB_ACTIONS=true`. `GITHUB_REPOSITORY`, the PR number
 *   from the event payload (`GITHUB_EVENT_PATH`) or `refs/pull/<n>/merge` in
 *   `GITHUB_REF`, `GITHUB_API_URL` (default https://api.github.com).
 * - GitLab CI: `GITLAB_CI=true`. `CI_API_V4_URL`, `CI_PROJECT_ID`,
 *   `CI_MERGE_REQUEST_IID` (a merge request pipeline).
 * - Forgejo Actions: `FORGEJO_ACTIONS=true` (runner 7 and later), or
 *   `GITEA_ACTIONS=true`, or a GitHub-style job whose API URL ends in
 *   `/api/v1`. The `FORGEJO_*` variables before the `GITHUB_*` ones, and
 *   `<server>/api/v1` when no API URL is set.
 *
 * The token is the first set of chant's `FORGE_TOKEN_ORDER`:
 * `CHANT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN` on GitHub;
 * `CHANT_FORGEJO_TOKEN`, `FORGEJO_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN` on
 * Forgejo; `CHANT_GITLAB_TOKEN`, `GITLAB_TOKEN`, `CI_JOB_TOKEN` on GitLab
 * (`CI_JOB_TOKEN` cannot write merge request notes or issues: name a project
 * access token with `api` scope). `--token-env <NAME>` names the one
 * variable to read instead; the token itself is never a flag, never printed
 * and never put in an error.
 */

import type { ForgeFetch, ForgeKind, ForgeTarget, PrForge } from "@intentius/chant/pr-forge";
import { YodelError } from "../project.js";

export type { ForgeKind, ForgeTarget, PrForge };

export interface ForgeFlags {
  forge?: string | undefined;
  repo?: string | undefined;
  pr?: string | undefined;
  apiUrl?: string | undefined;
  tokenEnv?: string | undefined;
}

/** A forge to post to: chant's client, and the target it was made for. */
export interface Forge {
  target: ForgeTarget;
  client: PrForge;
}

/**
 * chant's forge client for `--comment` (`requirePr`: the pull request too)
 * or `--issue`, from flags and the environment by chant's
 * `forgeTargetFromFlags`, or a YodelError saying what is missing and which
 * flags supply it (`forgeFlagHints`). `what` names the option, for messages.
 */
export async function resolveForge(flags: ForgeFlags, env: NodeJS.ProcessEnv, what: "--comment" | "--issue", fetchImpl?: ForgeFetch): Promise<Forge> {
  const requirePr = what === "--comment";
  const { forgeClient, ForgeEnvironmentError } = await import("@intentius/chant/pr-forge");
  const { forgeTargetFromFlags, forgeFlagHints, ForgeFlagError } = await import("@intentius/chant/forge-flags");
  let target: ForgeTarget;
  try {
    target = forgeTargetFromFlags(chantFlags(flags), env, { requirePr });
  } catch (e) {
    if (e instanceof ForgeFlagError) throw new YodelError(e.message);
    if (!(e instanceof ForgeEnvironmentError)) throw e;
    if (e.kind === undefined) throw new YodelError(`${what} cannot tell the forge: not a GitHub Actions, GitLab CI or Forgejo Actions job; pass --forge github|gitlab|forgejo with --repo${requirePr ? ", --pr" : ""} and --api-url`);
    const hints = forgeFlagHints(e, { requirePr, tokenEnv: flags.tokenEnv !== undefined });
    throw new YodelError(`${what} on ${e.kind} needs ${e.missing.join(", ")}${hints.length ? `; ${hints.join("; ")}` : ""}`);
  }
  return { target, client: forgeClient(target, fetchImpl) };
}

/** The flags as chant's `ForgeFlags`, leaving out each one not given. */
const chantFlags = (flags: ForgeFlags): Record<string, string> =>
  Object.fromEntries(Object.entries(flags).filter((e): e is [string, string] => typeof e[1] === "string"));

/** `github acme/db`, for messages. */
export const describeForge = (t: ForgeTarget): string => `${t.kind} ${t.repo}`;
