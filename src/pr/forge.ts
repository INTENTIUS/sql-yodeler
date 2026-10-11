/**
 * Where `yodel plan <env> --comment` and `yodel drift <env> --issue` post:
 * chant's forge client (`@intentius/chant/pr-forge`, #210) for the CI job's
 * forge, repository, pull (merge) request and token, each overridden by a
 * flag. chant reads the job's environment and makes every REST call; yodel
 * keeps the flags and the bodies.
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
export const FORGES: readonly ForgeKind[] = ["github", "gitlab", "forgejo"];

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
 * The job's environment with the flags written in as the variables chant
 * reads, so a flag wins over what the job carries: `--repo`, `--pr` and
 * `--api-url` stand in for the job's repository, pull request and API.
 */
function withFlags(kind: ForgeKind, flags: ForgeFlags, env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  if (kind === "gitlab") {
    if (flags.repo !== undefined) {
      out.CI_MERGE_REQUEST_PROJECT_ID = flags.repo;
      out.CI_PROJECT_ID = flags.repo;
    }
    if (flags.pr !== undefined) out.CI_MERGE_REQUEST_IID = flags.pr;
    if (flags.apiUrl !== undefined) out.CI_API_V4_URL = flags.apiUrl;
    return out;
  }
  // A Forgejo job reads FORGEJO_* before GITHUB_*, so a flag sets both.
  const set = (name: string, value: string | undefined) => {
    out[`GITHUB_${name}`] = value;
    out[`FORGEJO_${name}`] = value;
  };
  if (flags.repo !== undefined) set("REPOSITORY", flags.repo);
  if (flags.apiUrl !== undefined) set("API_URL", flags.apiUrl);
  if (flags.pr !== undefined) {
    // The event payload names the pull request before the ref does.
    set("EVENT_PATH", undefined);
    set("REF", `refs/pull/${flags.pr}/merge`);
  }
  return out;
}

/**
 * chant's forge client for `--comment` (`withPr`: the pull request too) or
 * `--issue`, from flags and the environment, or a YodelError saying what is
 * missing. `what` names the option, for messages.
 */
export async function resolveForge(flags: ForgeFlags, env: NodeJS.ProcessEnv, what: "--comment" | "--issue", fetchImpl?: ForgeFetch): Promise<Forge> {
  const withPr = what === "--comment";
  if (flags.forge !== undefined && !FORGES.includes(flags.forge as ForgeKind)) throw new YodelError(`--forge must be one of ${FORGES.join(", ")}, got ${JSON.stringify(flags.forge)}`);
  if (flags.pr !== undefined && !/^[1-9]\d*$/.test(flags.pr)) throw new YodelError(`--pr must be a pull request number, got ${JSON.stringify(flags.pr)}`);
  const { detectForge, forgeTargetFromEnv, forgeClient, ForgeEnvironmentError } = await import("@intentius/chant/pr-forge");
  const kind = (flags.forge as ForgeKind | undefined) ?? detectForge(env);
  if (!kind) throw new YodelError(`${what} cannot tell the forge: not a GitHub Actions, GitLab CI or Forgejo Actions job; pass --forge github|gitlab|forgejo with --repo${withPr ? ", --pr" : ""} and --api-url`);
  let target: ForgeTarget;
  try {
    target = forgeTargetFromEnv(withFlags(kind, flags, env), { kind, requirePr: withPr, ...(flags.tokenEnv ? { tokenEnv: flags.tokenEnv } : {}) });
  } catch (e) {
    if (!(e instanceof ForgeEnvironmentError)) throw e;
    const token = e.missing.some((m) => m.startsWith("a token"));
    const hints = [
      ...(e.missing.some((m) => !m.startsWith("a token")) ? [`outside CI pass ${withPr ? "--repo, --pr and --api-url" : "--repo and --api-url"}`] : []),
      ...(token && !flags.tokenEnv ? ["name another token variable with --token-env"] : []),
    ];
    throw new YodelError(`${what} on ${kind} needs ${e.missing.join(", ")}${hints.length ? `; ${hints.join("; ")}` : ""}`);
  }
  return { target, client: forgeClient(target, fetchImpl) };
}

/** `github acme/db`, for messages. */
export const describeForge = (t: ForgeTarget): string => `${t.kind} ${t.repo}`;
