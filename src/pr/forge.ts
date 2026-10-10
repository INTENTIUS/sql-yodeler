/**
 * Where `yodel plan <env> --comment` posts: the forge, the repository, the
 * pull (merge) request and the token, from the CI job's environment, each
 * overridden by a flag.
 *
 * - GitHub Actions: `GITHUB_ACTIONS=true`. `GITHUB_REPOSITORY`, the PR number
 *   from the event payload (`GITHUB_EVENT_PATH`: `pull_request.number`, or
 *   `refs/pull/<n>/merge` in `GITHUB_REF`), `GITHUB_API_URL` (default
 *   https://api.github.com), token `GITHUB_TOKEN`.
 * - GitLab CI: `GITLAB_CI=true`. `CI_API_V4_URL`, `CI_PROJECT_ID`,
 *   `CI_MERGE_REQUEST_IID` (a merge request pipeline), token `GITLAB_TOKEN`
 *   (a project or personal access token with `api` scope: `CI_JOB_TOKEN`
 *   cannot write merge request notes).
 * - Forgejo Actions: `FORGEJO_ACTIONS=true` (runner 7 and later), or
 *   `GITEA_ACTIONS=true`, or a GitHub-style job whose API URL ends in
 *   `/api/v1`. `FORGEJO_REPOSITORY` / `GITHUB_REPOSITORY`, the PR number from
 *   `FORGEJO_EVENT_PATH` / `GITHUB_EVENT_PATH` or the ref, `FORGEJO_API_URL` /
 *   `GITHUB_API_URL` (else `<server>/api/v1`), token `FORGEJO_TOKEN` /
 *   `GITHUB_TOKEN`.
 *
 * `--token-env <NAME>` names the variable the token is read from; the token
 * itself is never a flag, never printed and never put in an error.
 */

import { readFileSync } from "node:fs";
import { YodelError } from "../project.js";

export type ForgeKind = "github" | "gitlab" | "forgejo";
export const FORGES: readonly ForgeKind[] = ["github", "gitlab", "forgejo"];

export interface ForgeTarget {
  forge: ForgeKind;
  /** `owner/name` (GitHub, Forgejo), or the project id or path (GitLab). */
  repo: string;
  /** The PR number (GitHub, Forgejo) or MR iid (GitLab). */
  pr: number;
  /** The REST API's base, e.g. https://api.github.com, https://gitlab.com/api/v4, https://codeberg.org/api/v1. */
  apiUrl: string;
  token: string;
  /** The variable the token came from, for messages. */
  tokenEnv: string;
}

export interface ForgeFlags {
  forge?: string | undefined;
  repo?: string | undefined;
  pr?: string | undefined;
  apiUrl?: string | undefined;
  tokenEnv?: string | undefined;
}

const truthy = (v: string | undefined) => v === "true" || v === "1";

/** Which forge the job runs on, from its environment; `undefined` outside a known CI. */
export function detectForge(env: NodeJS.ProcessEnv): ForgeKind | undefined {
  if (truthy(env.GITLAB_CI)) return "gitlab";
  if (truthy(env.FORGEJO_ACTIONS) || truthy(env.GITEA_ACTIONS)) return "forgejo";
  if (truthy(env.GITHUB_ACTIONS)) return /\/api\/v1\/?$/.test(env.GITHUB_API_URL ?? "") ? "forgejo" : "github";
  return undefined;
}

/** The PR number from a GitHub-style event payload, or from the ref. */
export function prFromEvent(eventPath: string | undefined, ref: string | undefined): number | undefined {
  if (eventPath) {
    try {
      const event = JSON.parse(readFileSync(eventPath, "utf8")) as { pull_request?: { number?: unknown }; number?: unknown; issue?: { number?: unknown; pull_request?: unknown } };
      const n = event.pull_request?.number ?? (event.issue?.pull_request ? event.issue.number : undefined) ?? (event.pull_request ? event.number : undefined);
      if (typeof n === "number" && Number.isInteger(n) && n > 0) return n;
    } catch {
      // Unreadable payload: fall back to the ref.
    }
  }
  const m = /^refs\/pull\/(\d+)\/(?:merge|head)$/.exec(ref ?? "");
  return m ? Number(m[1]) : undefined;
}

const DEFAULT_TOKEN_ENV: Record<ForgeKind, string[]> = {
  github: ["GITHUB_TOKEN"],
  gitlab: ["GITLAB_TOKEN"],
  forgejo: ["FORGEJO_TOKEN", "GITHUB_TOKEN"],
};

/** Where a job writes on its forge, without a pull request: the repository, the API and the token. */
export type ForgeRepo = Omit<ForgeTarget, "pr">;

/**
 * Resolves the repository, API and token from flags and the environment;
 * `pr` also the pull (merge) request. `what` names the option that needs
 * them, for messages (`--comment`, `--issue`).
 */
function resolve(flags: ForgeFlags, env: NodeJS.ProcessEnv, what: string, withPr: boolean): ForgeTarget | ForgeRepo {
  if (flags.forge !== undefined && !FORGES.includes(flags.forge as ForgeKind)) throw new YodelError(`--forge must be one of ${FORGES.join(", ")}, got ${JSON.stringify(flags.forge)}`);
  const forge = (flags.forge as ForgeKind | undefined) ?? detectForge(env);
  if (!forge) throw new YodelError(`${what} cannot tell the forge: not a GitHub Actions, GitLab CI or Forgejo Actions job; pass --forge github|gitlab|forgejo with --repo${withPr ? ", --pr" : ""} and --api-url`);

  const pick = (...names: string[]) => names.map((n) => env[n]).find((v) => v !== undefined && v !== "");
  let repo = flags.repo;
  let pr = flags.pr !== undefined ? Number(flags.pr) : undefined;
  let apiUrl = flags.apiUrl;
  if (forge === "gitlab") {
    repo ??= pick("CI_PROJECT_ID", "CI_PROJECT_PATH");
    pr ??= pick("CI_MERGE_REQUEST_IID") !== undefined ? Number(pick("CI_MERGE_REQUEST_IID")) : undefined;
    apiUrl ??= pick("CI_API_V4_URL");
  } else {
    const p = forge === "forgejo" ? "FORGEJO_" : "GITHUB_";
    repo ??= pick(`${p}REPOSITORY`, "GITHUB_REPOSITORY");
    if (withPr) pr ??= prFromEvent(pick(`${p}EVENT_PATH`, "GITHUB_EVENT_PATH"), pick(`${p}REF`, "GITHUB_REF"));
    apiUrl ??= pick(`${p}API_URL`, "GITHUB_API_URL");
    if (!apiUrl && forge === "forgejo") {
      const server = pick("FORGEJO_SERVER_URL", "GITHUB_SERVER_URL");
      if (server) apiUrl = `${server.replace(/\/+$/, "")}/api/v1`;
    }
    if (!apiUrl && forge === "github") apiUrl = "https://api.github.com";
  }

  const missing: string[] = [];
  if (!repo) missing.push(forge === "gitlab" ? "the project (--repo, or CI_PROJECT_ID)" : "the repository (--repo owner/name, or GITHUB_REPOSITORY)");
  if (withPr && (pr === undefined || !Number.isInteger(pr) || pr <= 0)) {
    missing.push(forge === "gitlab" ? "the merge request (--pr, or CI_MERGE_REQUEST_IID in a merge request pipeline)" : "the pull request (--pr, or a pull_request event)");
  }
  if (!apiUrl) missing.push(forge === "gitlab" ? "the API URL (--api-url, or CI_API_V4_URL)" : "the API URL (--api-url, or FORGEJO_API_URL / GITHUB_API_URL)");
  const names = flags.tokenEnv ? [flags.tokenEnv] : DEFAULT_TOKEN_ENV[forge];
  const tokenEnv = names.find((n) => env[n]) ?? names[0] ?? "";
  const token = env[tokenEnv] ?? "";
  if (!token) missing.push(`a token (${names.join(" or ")} is not set${flags.tokenEnv ? "" : "; name another variable with --token-env"})`);
  if (missing.length > 0) throw new YodelError(`${what} on ${forge} needs ${missing.join(", ")}`);
  const base = { forge, repo: repo as string, apiUrl: (apiUrl as string).replace(/\/+$/, ""), token, tokenEnv };
  return withPr ? { ...base, pr: pr as number } : base;
}

/** Resolves the target from flags and the environment, or says what is missing. */
export function resolveForgeTarget(flags: ForgeFlags, env: NodeJS.ProcessEnv): ForgeTarget {
  return resolve(flags, env, "--comment", true) as ForgeTarget;
}

/** The repository a job writes to (`yodel drift --issue`), from flags and the environment, or says what is missing. */
export function resolveForgeRepo(flags: Omit<ForgeFlags, "pr">, env: NodeJS.ProcessEnv, what = "--issue"): ForgeRepo {
  return resolve(flags, env, what, false);
}
