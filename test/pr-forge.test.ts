import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { detectForge, prFromEvent, resolveForgeTarget, type ForgeKind, type ForgeTarget } from "../src/pr/forge.js";
import { commentClient, findComment, upsertComment } from "../src/pr/comment.js";

const dir = mkdtempSync(join(tmpdir(), "yodel-forge-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
const event = (payload: unknown) => {
  const path = join(dir, `event-${String(Math.random()).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(payload));
  return path;
};

describe("detecting the forge and the pull request from CI", () => {
  it("GitHub Actions: repository, PR from the event payload, API URL, GITHUB_TOKEN", () => {
    const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "acme/db", GITHUB_EVENT_PATH: event({ pull_request: { number: 42 } }), GITHUB_API_URL: "https://api.github.com", GITHUB_TOKEN: "ghs_x" };
    expect(detectForge(env)).toBe("github");
    expect(resolveForgeTarget({}, env)).toEqual({ forge: "github", repo: "acme/db", pr: 42, apiUrl: "https://api.github.com", token: "ghs_x", tokenEnv: "GITHUB_TOKEN" });
  });

  it("GitHub Actions: falls back to refs/pull/<n>/merge, and to api.github.com", () => {
    const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "acme/db", GITHUB_REF: "refs/pull/7/merge", GITHUB_TOKEN: "t" };
    expect(resolveForgeTarget({}, env)).toMatchObject({ pr: 7, apiUrl: "https://api.github.com" });
  });

  it("GitLab CI: project id, merge request iid, CI_API_V4_URL, GITLAB_TOKEN", () => {
    const env = { GITLAB_CI: "true", CI_API_V4_URL: "https://gitlab.example/api/v4", CI_PROJECT_ID: "123", CI_MERGE_REQUEST_IID: "9", GITLAB_TOKEN: "glpat" };
    expect(detectForge(env)).toBe("gitlab");
    expect(resolveForgeTarget({}, env)).toEqual({ forge: "gitlab", repo: "123", pr: 9, apiUrl: "https://gitlab.example/api/v4", token: "glpat", tokenEnv: "GITLAB_TOKEN" });
  });

  it("GitLab CI outside a merge request pipeline says what is missing", () => {
    expect(() => resolveForgeTarget({}, { GITLAB_CI: "true", CI_API_V4_URL: "u", CI_PROJECT_ID: "1", GITLAB_TOKEN: "t" })).toThrow(/CI_MERGE_REQUEST_IID/);
  });

  it("Forgejo Actions: FORGEJO_* variables, FORGEJO_TOKEN", () => {
    const env = { FORGEJO_ACTIONS: "true", GITHUB_ACTIONS: "true", FORGEJO_REPOSITORY: "me/db", FORGEJO_EVENT_PATH: event({ number: 3, pull_request: { number: 3 } }), FORGEJO_API_URL: "http://forgejo:3000/api/v1", FORGEJO_TOKEN: "fj", GITHUB_TOKEN: "fj" };
    expect(detectForge(env)).toBe("forgejo");
    expect(resolveForgeTarget({}, env)).toEqual({ forge: "forgejo", repo: "me/db", pr: 3, apiUrl: "http://forgejo:3000/api/v1", token: "fj", tokenEnv: "FORGEJO_TOKEN" });
  });

  it("Forgejo with an older runner (GitHub names only): told apart by its /api/v1 API URL", () => {
    const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "me/db", GITHUB_REF: "refs/pull/5/head", GITHUB_API_URL: "https://codeberg.org/api/v1", GITHUB_TOKEN: "t" };
    expect(detectForge(env)).toBe("forgejo");
    expect(resolveForgeTarget({}, env)).toMatchObject({ forge: "forgejo", pr: 5, apiUrl: "https://codeberg.org/api/v1", tokenEnv: "GITHUB_TOKEN" });
  });

  it("flags override the environment, and --token-env names the token's variable", () => {
    const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "acme/db", GITHUB_REF: "refs/pull/7/merge", GITHUB_TOKEN: "t", MY_TOKEN: "mine" };
    expect(resolveForgeTarget({ forge: "forgejo", repo: "x/y", pr: "11", apiUrl: "http://f/api/v1/", tokenEnv: "MY_TOKEN" }, env)).toEqual({ forge: "forgejo", repo: "x/y", pr: 11, apiUrl: "http://f/api/v1", token: "mine", tokenEnv: "MY_TOKEN" });
  });

  it("outside CI it needs --forge; a missing token is named, never shown", () => {
    expect(detectForge({})).toBeUndefined();
    expect(() => resolveForgeTarget({}, {})).toThrow(/pass --forge/);
    expect(() => resolveForgeTarget({ forge: "gitlab" }, {})).toThrow(/needs the project .*CI_MERGE_REQUEST_IID.*CI_API_V4_URL.*GITLAB_TOKEN is not set/);
    expect(() => resolveForgeTarget({ forge: "bitbucket" }, {})).toThrow(/--forge must be one of github, gitlab, forgejo/);
  });

  it("reads a PR number off pull_request and issue_comment payloads only", () => {
    expect(prFromEvent(event({ pull_request: { number: 8 } }), undefined)).toBe(8);
    expect(prFromEvent(event({ issue: { number: 4, pull_request: {} } }), undefined)).toBe(4);
    expect(prFromEvent(event({ ref: "refs/heads/main" }), "refs/heads/main")).toBeUndefined();
    expect(prFromEvent(join(dir, "missing.json"), "refs/pull/2/merge")).toBe(2);
  });
});

/** A local fake of one forge's comment API, holding comments in memory. */
interface Fake {
  server: Server;
  url: string;
  comments: Array<{ id: number; body: string; system?: boolean }>;
  requests: Array<{ method: string; path: string; auth: string | undefined; body: unknown }>;
}

async function body(req: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of req) text += String(chunk);
  return text ? JSON.parse(text) : undefined;
}

async function fakeForge(forge: ForgeKind): Promise<Fake> {
  const fake: Fake = { server: undefined as never, url: "", comments: [], requests: [] };
  let next = 100;
  const routes =
    forge === "gitlab"
      ? { list: /^\/api\/v4\/projects\/group%2Fdb\/merge_requests\/9\/notes$/, one: /^\/api\/v4\/projects\/group%2Fdb\/merge_requests\/9\/notes\/(\d+)$/, update: "PUT" }
      : forge === "forgejo"
        ? { list: /^\/api\/v1\/repos\/me\/db\/issues\/3\/comments$/, one: /^\/api\/v1\/repos\/me\/db\/issues\/comments\/(\d+)$/, update: "PATCH" }
        : { list: /^\/repos\/acme\/db\/issues\/42\/comments$/, one: /^\/repos\/acme\/db\/issues\/comments\/(\d+)$/, update: "PATCH" };
  fake.server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://x");
      const auth = req.headers.authorization ?? (req.headers["private-token"] as string | undefined);
      const b = await body(req);
      fake.requests.push({ method: req.method ?? "", path: url.pathname, auth, body: b });
      const send = (status: number, value: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(value));
      };
      const expected = forge === "gitlab" ? "secret" : forge === "forgejo" ? "token secret" : "Bearer secret";
      if (auth !== expected) { send(401, { message: "bad credentials" }); return; }
      const view = (c: { id: number; body: string; system?: boolean }) => ({ ...c, html_url: `http://forge/c/${String(c.id)}` });
      if (routes.list.test(url.pathname) && req.method === "GET") {
        const per = Number(url.searchParams.get("per_page") ?? url.searchParams.get("limit") ?? 30);
        const page = Number(url.searchParams.get("page") ?? 1);
        send(200, fake.comments.slice((page - 1) * per, page * per).map(view)); return;
      }
      if (routes.list.test(url.pathname) && req.method === "POST") {
        const c = { id: next++, body: (b as { body: string }).body };
        fake.comments.push(c);
        send(201, view(c)); return;
      }
      const one = routes.one.exec(url.pathname);
      if (one && req.method === routes.update) {
        const c = fake.comments.find((x) => x.id === Number(one[1]));
        if (!c) { send(404, {}); return; }
        c.body = (b as { body: string }).body;
        send(200, view(c)); return;
      }
      send(404, { message: `no route ${req.method ?? ""} ${url.pathname}` });
    })();
  });
  await new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
  const port = (fake.server.address() as AddressInfo).port;
  fake.url = forge === "gitlab" ? `http://127.0.0.1:${String(port)}/api/v4` : forge === "forgejo" ? `http://127.0.0.1:${String(port)}/api/v1` : `http://127.0.0.1:${String(port)}`;
  return fake;
}

const MARKER = "<!-- yodel:plan env=prod -->";

describe.each(["github", "gitlab", "forgejo"] as const)("the %s comment client against a local fake", (forge) => {
  let fake: Fake;
  let target: ForgeTarget;
  beforeAll(async () => {
    fake = await fakeForge(forge);
    target = {
      forge,
      repo: forge === "gitlab" ? "group/db" : forge === "forgejo" ? "me/db" : "acme/db",
      pr: forge === "gitlab" ? 9 : forge === "forgejo" ? 3 : 42,
      apiUrl: fake.url,
      token: "secret",
      tokenEnv: "T",
    };
  });
  afterAll(() => {
    fake.server.close();
  });
  afterEach(() => {
    fake.comments = [];
    fake.requests = [];
  });

  it("creates the comment when none carries the marker", async () => {
    fake.comments.push({ id: 1, body: "LGTM" }, { id: 2, body: "<!-- yodel:plan env=staging -->\nother env" });
    const c = commentClient(target);
    const r = await upsertComment(c, MARKER, `${MARKER}\nplan one`);
    expect(r.action).toBe("created");
    expect(fake.comments.map((x) => x.body)).toEqual(["LGTM", "<!-- yodel:plan env=staging -->\nother env", `${MARKER}\nplan one`]);
  });

  it("finds the comment by its marker and updates it in place, leaving the others", async () => {
    fake.comments.push({ id: 1, body: "LGTM" }, { id: 7, body: `${MARKER}\nplan one` });
    const c = commentClient(target);
    const found = await findComment(c, MARKER);
    expect(found?.id).toBe(7);
    const r = await upsertComment(c, MARKER, `${MARKER}\nplan two`, found);
    expect(r).toMatchObject({ action: "updated", comment: { id: 7 } });
    expect(fake.comments).toEqual([{ id: 1, body: "LGTM" }, { id: 7, body: `${MARKER}\nplan two` }]);
    expect(fake.requests.map((q) => q.method)).toEqual(["GET", forge === "gitlab" ? "PUT" : "PATCH"]);
  });

  it("sends nothing when the body is the same", async () => {
    fake.comments.push({ id: 7, body: `${MARKER}\nsame` });
    const r = await upsertComment(commentClient(target), MARKER, `${MARKER}\nsame`);
    expect(r.action).toBe("unchanged");
    expect(fake.requests.map((q) => q.method)).toEqual(["GET"]);
  });

  it("pages through a long thread to find it", async () => {
    for (let i = 0; i < 150; i++) fake.comments.push({ id: i + 1, body: `comment ${String(i)}` });
    fake.comments.push({ id: 999, body: `${MARKER}\nold` });
    const r = await upsertComment(commentClient(target), MARKER, `${MARKER}\nnew`);
    expect(r).toMatchObject({ action: "updated", comment: { id: 999 } });
    expect(fake.requests.filter((q) => q.method === "GET")).toHaveLength(2);
  });

  it("reports a refusal without the token", async () => {
    const c = commentClient({ ...target, token: "wrong-token" });
    const err = (await upsertComment(c, MARKER, `${MARKER}\nx`).then(
      () => new Error("not refused"),
      (e: unknown) => e,
    )) as Error;
    expect(err.message).toMatch(/answered 401/);
    expect(err.message).not.toContain("wrong-token");
  });
});

describe("upsertComment", () => {
  it("refuses a body without the marker", async () => {
    const c = { list: () => Promise.resolve([]), create: () => Promise.reject(new Error("no")), update: () => Promise.reject(new Error("no")) };
    await expect(upsertComment(c, MARKER, "no marker")).rejects.toThrow(/no marker/);
  });
});
