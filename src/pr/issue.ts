/**
 * The drift watch's tracking issue (#49): one open issue per project and
 * environment, found by its marker, opened when drift is found, updated
 * while it lasts, and closed, with a comment, when it is gone. The three
 * forges' REST APIs:
 *
 *   GitHub   GET/POST {api}/repos/{owner}/{repo}/issues            (open ones; pull requests left out)
 *            PATCH    {api}/repos/{owner}/{repo}/issues/{n}         body, or state closed
 *            POST     {api}/repos/{owner}/{repo}/issues/{n}/comments
 *   GitLab   GET/POST {api}/projects/{id}/issues                   (state opened)
 *            PUT      {api}/projects/{id}/issues/{iid}              description, or state_event close
 *            POST     {api}/projects/{id}/issues/{iid}/notes
 *   Forgejo  as GitHub, under /api/v1, with type=issues and limit
 *
 * The client lists only open issues, so a closed one is never reopened:
 * drift found again after a close opens a new issue.
 */

import { YodelError } from "../project.js";
import type { ForgeRepo } from "./forge.js";

export interface ForgeIssue {
  number: number;
  title: string;
  body: string;
  url?: string | undefined;
}

export interface IssueClient {
  /** The open issues (not pull requests). */
  open(): Promise<ForgeIssue[]>;
  create(title: string, body: string): Promise<ForgeIssue>;
  update(n: number, title: string, body: string): Promise<ForgeIssue>;
  /** Comments `comment` on the issue, then closes it. */
  close(n: number, comment: string): Promise<void>;
}

type Fetch = typeof fetch;

interface Raw {
  number?: unknown;
  iid?: unknown;
  title?: unknown;
  body?: unknown;
  description?: unknown;
  html_url?: unknown;
  web_url?: unknown;
  pull_request?: unknown;
}

const PAGE = 100;
const MAX_PAGES = 20;
const repoPath = (repo: string) => repo.split("/").map(encodeURIComponent).join("/");

export function issueClient(t: ForgeRepo, f: Fetch = fetch): IssueClient {
  const gitlab = t.forge === "gitlab";
  const headers: Record<string, string> = gitlab
    ? { "PRIVATE-TOKEN": t.token, Accept: "application/json" }
    : t.forge === "forgejo"
      ? { Authorization: `token ${t.token}`, Accept: "application/json" }
      : { Authorization: `Bearer ${t.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  const base = gitlab ? `${t.apiUrl}/projects/${encodeURIComponent(t.repo)}/issues` : `${t.apiUrl}/repos/${repoPath(t.repo)}/issues`;
  const call = async (method: string, url: string, body?: unknown): Promise<unknown> => {
    let res: Response;
    try {
      res = await f(url, { method, headers: { ...headers, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch (e) {
      throw new YodelError(`${t.forge}: ${method} ${url} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const text = await res.text();
    if (!res.ok) throw new YodelError(`${t.forge}: ${method} ${url} answered ${String(res.status)}: ${text.slice(0, 300).replaceAll(t.token, "[token]")}`);
    return text ? (JSON.parse(text) as unknown) : {};
  };
  const toIssue = (r: Raw): ForgeIssue => ({
    number: Number(gitlab ? r.iid : r.number),
    title: typeof r.title === "string" ? r.title : "",
    body: typeof (gitlab ? r.description : r.body) === "string" ? String(gitlab ? r.description : r.body) : "",
    url: typeof r.html_url === "string" ? r.html_url : typeof r.web_url === "string" ? r.web_url : undefined,
  });
  const list = (page: number) =>
    gitlab
      ? `${base}?state=opened&per_page=${String(PAGE)}&page=${String(page)}`
      : t.forge === "forgejo"
        ? `${base}?state=open&type=issues&limit=${String(PAGE)}&page=${String(page)}`
        : `${base}?state=open&per_page=${String(PAGE)}&page=${String(page)}`;
  return {
    async open() {
      const all: ForgeIssue[] = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const got = (await call("GET", list(page))) as Raw[];
        if (!Array.isArray(got)) throw new YodelError(`${t.forge}: listing issues did not return a list`);
        all.push(...got.filter((r) => r.pull_request === undefined || r.pull_request === null).map(toIssue));
        if (got.length < PAGE) break;
      }
      return all;
    },
    async create(title, body) {
      return toIssue((await call("POST", base, gitlab ? { title, description: body } : { title, body })) as Raw);
    },
    async update(n, title, body) {
      return toIssue((await call(gitlab ? "PUT" : "PATCH", `${base}/${String(n)}`, gitlab ? { title, description: body } : { title, body })) as Raw);
    },
    async close(n, comment) {
      await call("POST", `${base}/${String(n)}/${gitlab ? "notes" : "comments"}`, { body: comment });
      await call(gitlab ? "PUT" : "PATCH", `${base}/${String(n)}`, gitlab ? { state_event: "close" } : { state: "closed" });
    },
  };
}

/**
 * The marker an environment's tracking issue carries, so the next run finds
 * it. Keyed by the project's directory in its repository (`.` at the root),
 * so two projects in one repository keep their own issues.
 */
export function driftIssueMarker(project: string, environment: string): string {
  const clean = (s: string) => s.replace(/\s+/g, "_").replace(/-->/g, "");
  return `<!-- yodel:drift project=${clean(project || ".")} env=${clean(environment)} -->`;
}

/** What the run found, as the tracking issue needs it. */
export type DriftOutcome =
  | { kind: "drift"; title: string; body: string; fingerprint: string }
  | { kind: "clean"; comment: string }
  /** The drift could not be read, or part of the environment could not: the issue is left as it is. */
  | { kind: "unknown"; why: string };

export type IssueAction =
  | { action: "opened" | "updated" | "unchanged" | "closed"; issue: ForgeIssue }
  | { action: "none" }
  | { action: "left"; why: string; issue?: ForgeIssue };

/** Brings the environment's tracking issue in line with the outcome; see the module comment. */
export async function trackDrift(client: IssueClient, marker: string, outcome: DriftOutcome): Promise<IssueAction> {
  const found = (await client.open()).filter((i) => i.body.includes(marker)).sort((a, b) => a.number - b.number);
  const issue = found[0];
  if (outcome.kind === "unknown") return { action: "left", why: outcome.why, ...(issue ? { issue } : {}) };
  if (outcome.kind === "clean") {
    if (!issue) return { action: "none" };
    await client.close(issue.number, outcome.comment);
    return { action: "closed", issue };
  }
  const body = `${marker}\n${outcome.body}`;
  if (!issue) return { action: "opened", issue: await client.create(outcome.title, body) };
  if (issue.body.includes(outcome.fingerprint) && issue.title === outcome.title) return { action: "unchanged", issue };
  return { action: "updated", issue: await client.update(issue.number, outcome.title, body) };
}
