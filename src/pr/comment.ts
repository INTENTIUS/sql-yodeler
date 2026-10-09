/**
 * One comment per environment on the pull request: found by its marker and
 * updated, else created. The three forges' REST APIs:
 *
 *   GitHub   GET/POST {api}/repos/{owner}/{repo}/issues/{n}/comments
 *            PATCH    {api}/repos/{owner}/{repo}/issues/comments/{id}
 *   GitLab   GET/POST {api}/projects/{id}/merge_requests/{iid}/notes
 *            PUT      {api}/projects/{id}/merge_requests/{iid}/notes/{note_id}
 *   Forgejo  GET/POST {api}/repos/{owner}/{repo}/issues/{n}/comments   (Gitea's API, /api/v1)
 *            PATCH    {api}/repos/{owner}/{repo}/issues/comments/{id}
 */

import { YodelError } from "../project.js";
import type { ForgeTarget } from "./forge.js";

export interface ForgeComment {
  id: number;
  body: string;
  url?: string | undefined;
}

export interface CommentClient {
  list(): Promise<ForgeComment[]>;
  create(body: string): Promise<ForgeComment>;
  update(id: number, body: string): Promise<ForgeComment>;
}

type Fetch = typeof fetch;

interface Raw {
  id?: unknown;
  body?: unknown;
  html_url?: unknown;
  system?: unknown;
}

const PAGE = 100;
const MAX_PAGES = 50;

function client(t: ForgeTarget, f: Fetch, shape: {
  headers: Record<string, string>;
  list: (page: number) => string;
  create: string;
  update: (id: number) => string;
  updateMethod: "PATCH" | "PUT";
  webUrl?: (c: Raw) => string | undefined;
  keep?: (c: Raw) => boolean;
}): CommentClient {
  const call = async (method: string, url: string, body?: unknown): Promise<unknown> => {
    let res: Response;
    try {
      res = await f(url, { method, headers: { ...shape.headers, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch (e) {
      throw new YodelError(`${t.forge}: ${method} ${url} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const text = await res.text();
    if (!res.ok) throw new YodelError(`${t.forge}: ${method} ${url} answered ${String(res.status)}: ${text.slice(0, 300).replaceAll(t.token, "[token]")}`);
    return text ? (JSON.parse(text) as unknown) : {};
  };
  const toComment = (c: Raw): ForgeComment => ({ id: Number(c.id), body: typeof c.body === "string" ? c.body : "", url: shape.webUrl?.(c) ?? (typeof c.html_url === "string" ? c.html_url : undefined) });
  return {
    async list() {
      const all: ForgeComment[] = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const got = (await call("GET", shape.list(page))) as Raw[];
        if (!Array.isArray(got)) throw new YodelError(`${t.forge}: listing comments did not return a list`);
        all.push(...got.filter((c) => shape.keep?.(c) ?? true).map(toComment));
        if (got.length < PAGE) break;
      }
      return all;
    },
    async create(body) {
      return toComment((await call("POST", shape.create, { body })) as Raw);
    },
    async update(id, body) {
      return toComment((await call(shape.updateMethod, shape.update(id), { body })) as Raw);
    },
  };
}

const repoPath = (repo: string) => repo.split("/").map(encodeURIComponent).join("/");

export function commentClient(t: ForgeTarget, f: Fetch = fetch): CommentClient {
  if (t.forge === "gitlab") {
    const base = `${t.apiUrl}/projects/${encodeURIComponent(t.repo)}/merge_requests/${String(t.pr)}/notes`;
    return client(t, f, {
      headers: { "PRIVATE-TOKEN": t.token, Accept: "application/json" },
      list: (page) => `${base}?per_page=${String(PAGE)}&page=${String(page)}&sort=asc&order_by=created_at`,
      create: base,
      update: (id) => `${base}/${String(id)}`,
      updateMethod: "PUT",
      // System notes ("added 1 commit") are the forge's own, never ours.
      keep: (c) => c.system !== true,
    });
  }
  if (t.forge === "forgejo") {
    const base = `${t.apiUrl}/repos/${repoPath(t.repo)}/issues`;
    return client(t, f, {
      headers: { Authorization: `token ${t.token}`, Accept: "application/json" },
      list: (page) => `${base}/${String(t.pr)}/comments?limit=${String(PAGE)}&page=${String(page)}`,
      create: `${base}/${String(t.pr)}/comments`,
      update: (id) => `${base}/comments/${String(id)}`,
      updateMethod: "PATCH",
    });
  }
  const base = `${t.apiUrl}/repos/${repoPath(t.repo)}/issues`;
  return client(t, f, {
    headers: { Authorization: `Bearer ${t.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    list: (page) => `${base}/${String(t.pr)}/comments?per_page=${String(PAGE)}&page=${String(page)}`,
    create: `${base}/${String(t.pr)}/comments`,
    update: (id) => `${base}/comments/${String(id)}`,
    updateMethod: "PATCH",
  });
}

/** The comment carrying `marker`, the newest when several do. */
export async function findComment(c: CommentClient, marker: string): Promise<ForgeComment | undefined> {
  return (await c.list()).filter((x) => x.body.includes(marker)).at(-1);
}

/** Updates the comment carrying `marker`, or creates one. */
export async function upsertComment(c: CommentClient, marker: string, body: string, existing?: ForgeComment): Promise<{ action: "created" | "updated" | "unchanged"; comment: ForgeComment }> {
  if (!body.includes(marker)) throw new YodelError("the comment body has no marker; it could never be found again to update");
  const found = existing ?? (await findComment(c, marker));
  if (!found) return { action: "created", comment: await c.create(body) };
  if (found.body === body) return { action: "unchanged", comment: found };
  return { action: "updated", comment: await c.update(found.id, body) };
}
