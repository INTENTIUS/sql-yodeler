/**
 * src/pr/forge.ts: yodel's flags and the CI job's environment, read through
 * chant's forge client (#210). The REST calls are chant's and tested there;
 * these pin what yodel decides: which forge, repository, pull request and
 * token, which flag wins, and what a job missing one is told.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ForgeFetch } from "@intentius/chant/pr-forge";
import { resolveForge } from "../src/pr/forge.js";
import { commentMarker, subjectIn } from "../src/pr/render.js";

const dir = mkdtempSync(join(tmpdir(), "yodel-forge-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
const event = (payload: unknown) => {
  const path = join(dir, `event-${String(Math.random()).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(payload));
  return path;
};

const target = async (flags: Parameters<typeof resolveForge>[0], env: NodeJS.ProcessEnv, what: "--comment" | "--issue" = "--comment") => {
  const t = (await resolveForge(flags, env, what)).target;
  return { kind: t.kind, repo: t.repo, pr: t.pr, apiBase: t.apiBase, tokenSource: t.tokenSource };
};

describe("the forge and the pull request from CI", () => {
  it("GitHub Actions: repository, PR from the event payload, API URL, the job's token", async () => {
    const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "acme/db", GITHUB_EVENT_PATH: event({ pull_request: { number: 42 } }), GITHUB_API_URL: "https://api.github.com", GITHUB_TOKEN: "ghs_x" };
    expect(await target({}, env)).toEqual({ kind: "github", repo: "acme/db", pr: 42, apiBase: "https://api.github.com", tokenSource: "GITHUB_TOKEN" });
  });

  it("GitHub Actions: falls back to refs/pull/<n>/merge and api.github.com, and reads GH_TOKEN before GITHUB_TOKEN", async () => {
    const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "acme/db", GITHUB_REF: "refs/pull/7/merge", GITHUB_TOKEN: "t", GH_TOKEN: "g" };
    expect(await target({}, env)).toMatchObject({ pr: 7, apiBase: "https://api.github.com", tokenSource: "GH_TOKEN" });
  });

  it("GitLab CI: project id, merge request iid, CI_API_V4_URL, GITLAB_TOKEN", async () => {
    const env = { GITLAB_CI: "true", CI_API_V4_URL: "https://gitlab.example/api/v4", CI_PROJECT_ID: "123", CI_MERGE_REQUEST_IID: "9", GITLAB_TOKEN: "glpat" };
    expect(await target({}, env)).toEqual({ kind: "gitlab", repo: "123", pr: 9, apiBase: "https://gitlab.example/api/v4", tokenSource: "GITLAB_TOKEN" });
  });

  it("GitLab CI outside a merge request pipeline says what is missing", async () => {
    await expect(resolveForge({}, { GITLAB_CI: "true", CI_API_V4_URL: "u", CI_PROJECT_ID: "1", GITLAB_TOKEN: "t" }, "--comment")).rejects.toThrow(/--comment on gitlab needs CI_MERGE_REQUEST_IID/);
  });

  it("Forgejo Actions: FORGEJO_* variables before GITHUB_*, FORGEJO_TOKEN before GITHUB_TOKEN", async () => {
    const env = { FORGEJO_ACTIONS: "true", GITHUB_ACTIONS: "true", FORGEJO_REPOSITORY: "me/db", FORGEJO_EVENT_PATH: event({ number: 3, pull_request: { number: 3 } }), FORGEJO_API_URL: "http://forgejo:3000/api/v1", FORGEJO_TOKEN: "fj", GITHUB_TOKEN: "fj" };
    expect(await target({}, env)).toEqual({ kind: "forgejo", repo: "me/db", pr: 3, apiBase: "http://forgejo:3000/api/v1", tokenSource: "FORGEJO_TOKEN" });
  });

  it("Forgejo with an older runner (GitHub names only): told apart by its /api/v1 API URL", async () => {
    const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "me/db", GITHUB_REF: "refs/pull/5/head", GITHUB_API_URL: "https://codeberg.org/api/v1", GITHUB_TOKEN: "t" };
    expect(await target({}, env)).toMatchObject({ kind: "forgejo", pr: 5, apiBase: "https://codeberg.org/api/v1", tokenSource: "GITHUB_TOKEN" });
  });

  it("flags win over the job's environment, and --token-env names the one token variable", async () => {
    const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "acme/db", GITHUB_EVENT_PATH: event({ pull_request: { number: 8 } }), GITHUB_TOKEN: "t", MY_TOKEN: "mine" };
    expect(await target({ forge: "forgejo", repo: "x/y", pr: "11", apiUrl: "http://f/api/v1/", tokenEnv: "MY_TOKEN" }, env)).toEqual({ kind: "forgejo", repo: "x/y", pr: 11, apiBase: "http://f/api/v1", tokenSource: "MY_TOKEN" });
    expect(await target({ forge: "gitlab", repo: "group/db", pr: "4", apiUrl: "https://gl/api/v4", tokenEnv: "MY_TOKEN" }, env)).toEqual({ kind: "gitlab", repo: "group/db", pr: 4, apiBase: "https://gl/api/v4", tokenSource: "MY_TOKEN" });
  });

  it("--issue needs no pull request", async () => {
    expect(await target({}, { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: "t" }, "--issue")).toMatchObject({ kind: "github", repo: "o/r", pr: undefined });
    expect(await target({}, { FORGEJO_ACTIONS: "true", GITHUB_REPOSITORY: "o/r", GITHUB_SERVER_URL: "https://fj", GITHUB_TOKEN: "t" }, "--issue")).toMatchObject({ kind: "forgejo", apiBase: "https://fj/api/v1" });
  });

  it("outside CI it needs --forge; a missing token is named, never shown", async () => {
    await expect(resolveForge({}, {}, "--comment")).rejects.toThrow(/--comment cannot tell the forge.*pass --forge/);
    await expect(resolveForge({ forge: "bitbucket" }, {}, "--comment")).rejects.toThrow(/--forge must be one of github, gitlab, forgejo/);
    await expect(resolveForge({ forge: "github", pr: "x" }, {}, "--comment")).rejects.toThrow(/--pr must be a pull request number/);
    await expect(resolveForge({ forge: "github" }, { GITHUB_REPOSITORY: "o/r", GITHUB_REF: "refs/pull/1/merge" }, "--comment")).rejects.toThrow(/needs a token \(CHANT_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN\).*--token-env/);
    await expect(resolveForge({ forge: "github", tokenEnv: "MINE" }, { GITHUB_REPOSITORY: "o/r", GITHUB_REF: "refs/pull/1/merge", MINE: "" }, "--issue")).rejects.toThrow(/needs a token \(MINE\)/);
  });
});

describe("the plan comment through chant's client", () => {
  /** A GitHub-shaped fake: the comments of acme/db#42, and every request made. */
  function fake(comments: Array<{ id: number; body: string; user?: { login: string } }>): { fetch: ForgeFetch; calls: string[] } {
    const calls: string[] = [];
    const fetch: ForgeFetch = (url, init) => {
      calls.push(`${init.method} ${url.replace(/\?.*$/, "")}`);
      const send = (status: number, v: unknown) => Promise.resolve({ ok: status < 400, status, text: () => Promise.resolve(JSON.stringify(v)) });
      if (init.headers.Authorization !== "Bearer secret") return send(401, {});
      if (init.method === "GET") return send(200, comments.map((c) => ({ ...c, html_url: `https://gh/c/${String(c.id)}` })));
      const body = (JSON.parse(init.body ?? "{}") as { body: string }).body;
      if (init.method === "POST") {
        const c = { id: comments.length + 100, body };
        comments.push(c);
        return send(201, c);
      }
      const c = comments.find((x) => url.endsWith(`/comments/${String(x.id)}`));
      if (c) c.body = body;
      return send(c ? 200 : 404, c ?? {});
    };
    return { fetch, calls };
  }
  const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "acme/db", GITHUB_REF: "refs/pull/42/merge", GITHUB_TOKEN: "secret" };
  const marker = commentMarker("prod");

  it("reads back the subject the last plan comment carries, and updates that comment", async () => {
    const f = fake([{ id: 1, body: "LGTM" }, { id: 7, body: `${marker}\n<!-- yodel:subject abc_1 -->\nplan one` }]);
    const { client, target } = await resolveForge({}, env, "--comment", f.fetch);
    const found = await client.findComment(target.pr ?? 0, marker);
    expect(found?.id).toBe(7);
    expect(subjectIn(found?.body ?? "")).toBe("abc_1");
    expect(await client.upsertComment(target.pr ?? 0, marker, `${marker}\nplan two`)).toMatchObject({ action: "updated", id: 7 });
    expect(f.calls.filter((c) => !c.startsWith("GET"))).toEqual(["PATCH https://api.github.com/repos/acme/db/issues/comments/7"]);
  });

  it("finds none on a pull request without one, and posts one", async () => {
    const f = fake([{ id: 1, body: `quoting ${marker}` }]);
    const { client, target } = await resolveForge({}, env, "--comment", f.fetch);
    expect(await client.findComment(target.pr ?? 0, marker)).toBeUndefined();
    expect((await client.upsertComment(target.pr ?? 0, marker, `${marker}\nplan`)).action).toBe("created");
  });

  it("never puts the token in an error", async () => {
    const f = fake([]);
    const { client, target } = await resolveForge({}, { ...env, GITHUB_TOKEN: "wrong-token" }, "--comment", f.fetch);
    const err = await client.findComment(target.pr ?? 0, marker).then(
      () => new Error("not refused"),
      (e: unknown) => e as Error,
    );
    expect(err.message).toMatch(/401/);
    expect(err.message).not.toContain("wrong-token");
  });
});
