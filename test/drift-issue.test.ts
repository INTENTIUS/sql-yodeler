import { describe, expect, it } from "vitest";
import { driftFingerprint, renderDriftMarkdown, type Drift } from "../src/chant/drift.js";
import { resolveForgeRepo } from "../src/pr/forge.js";
import { driftIssueMarker, issueClient, trackDrift, type ForgeIssue, type IssueClient } from "../src/pr/issue.js";

const drift = (over: Partial<Drift> = {}): Drift => ({
  environment: "dev",
  changed: [{ name: "events", type: "ClickHouse::Table", changes: [{ path: "ttl", kind: "changed", declared: "ts + 90", live: "ts + 30" }] }] as Drift["changed"],
  missing: ["daily"],
  unobserved: [],
  ...over,
});

/** An in-memory forge's issues. */
function memoryIssues(): IssueClient & { all: Array<ForgeIssue & { state: string; comments: string[] }> } {
  const all: Array<ForgeIssue & { state: string; comments: string[] }> = [];
  return {
    all,
    open: () => Promise.resolve(all.filter((i) => i.state === "open")),
    create: (title, body) => {
      const issue = { number: all.length + 1, title, body, state: "open", comments: [] };
      all.push(issue);
      return Promise.resolve(issue);
    },
    update: (n, title, body) => {
      const issue = all.find((i) => i.number === n);
      if (!issue) throw new Error("no issue");
      Object.assign(issue, { title, body });
      return Promise.resolve(issue);
    },
    close: (n, comment) => {
      const issue = all.find((i) => i.number === n);
      if (!issue) throw new Error("no issue");
      issue.comments.push(comment);
      issue.state = "closed";
      return Promise.resolve();
    },
  };
}

describe("driftFingerprint", () => {
  it("is the same for the same drift in any order, and moves when the drift does", () => {
    const a = drift();
    const b = drift({ missing: ["daily"], changed: [...a.changed] });
    expect(driftFingerprint(a)).toBe(driftFingerprint(b));
    expect(driftFingerprint(a)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(driftFingerprint(drift({ missing: [] }))).not.toBe(driftFingerprint(a));
    expect(driftFingerprint(drift({ environment: "prod" }))).not.toBe(driftFingerprint(a));
    // What could not be read is not drift.
    expect(driftFingerprint(drift({ unobserved: [{ name: "x", reason: "no grant" }] as unknown as Drift["unobserved"] }))).toBe(driftFingerprint(a));
  });
});

describe("trackDrift", () => {
  const marker = driftIssueMarker(".", "dev");
  const found = (d: Drift) => ({ kind: "drift" as const, title: `Drift in dev: ${[...d.changed.map((c) => c.name), ...d.missing].join(", ")}`, body: renderDriftMarkdown(d, undefined, { fingerprint: driftFingerprint(d) }), fingerprint: driftFingerprint(d) });

  it("opens one issue on drift, updates it when the drift changes, and closes it when it is gone", async () => {
    const c = memoryIssues();
    const one = drift({ missing: [] });
    expect((await trackDrift(c, marker, found(one))).action).toBe("opened");
    expect(c.all[0]?.body).toContain(marker);
    expect(c.all[0]?.body).toContain("`events` (ClickHouse::Table)");
    expect((await trackDrift(c, marker, found(one))).action).toBe("unchanged");
    const two = drift();
    expect(await trackDrift(c, marker, found(two))).toMatchObject({ action: "updated", issue: { number: 1 } });
    expect(c.all).toHaveLength(1);
    expect(c.all[0]?.title).toBe("Drift in dev: events, daily");
    expect(c.all[0]?.body).toContain("`daily`");
    expect(await trackDrift(c, marker, { kind: "clean", comment: "gone" })).toMatchObject({ action: "closed", issue: { number: 1 } });
    expect(c.all[0]).toMatchObject({ state: "closed", comments: ["gone"] });
    expect((await trackDrift(c, marker, { kind: "clean", comment: "gone" })).action).toBe("none");
    // Drift again after the close: a new issue, the closed one left closed.
    expect(await trackDrift(c, marker, found(one))).toMatchObject({ action: "opened", issue: { number: 2 } });
  });

  it("leaves the issue as it is when the drift could not be read", async () => {
    const c = memoryIssues();
    await trackDrift(c, marker, found(drift()));
    expect(await trackDrift(c, marker, { kind: "unknown", why: "no grant" })).toMatchObject({ action: "left", why: "no grant", issue: { number: 1 } });
    expect(c.all[0]?.state).toBe("open");
  });

  it("keeps another environment's and another project's issues apart", async () => {
    const c = memoryIssues();
    await trackDrift(c, marker, found(drift()));
    expect((await trackDrift(c, driftIssueMarker(".", "prod"), { kind: "clean", comment: "x" })).action).toBe("none");
    expect((await trackDrift(c, driftIssueMarker("db", "dev"), { kind: "clean", comment: "x" })).action).toBe("none");
    expect(c.all[0]?.state).toBe("open");
  });
});

describe("issueClient", () => {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const fake = (answers: unknown[]) =>
    ((url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url, ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}) });
      return Promise.resolve(new Response(JSON.stringify(answers.shift() ?? {}), { status: 200 }));
    }) as typeof fetch;

  it("speaks GitHub's issues API, leaving pull requests out", async () => {
    calls.length = 0;
    const c = issueClient(resolveForgeRepo({}, { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: "t" }), fake([[{ number: 3, title: "a", body: "b", html_url: "u" }, { number: 4, title: "pr", body: "", pull_request: {} }]]));
    expect(await c.open()).toEqual([{ number: 3, title: "a", body: "b", url: "u" }]);
    await c.close(3, "gone");
    expect(calls.map((x) => `${x.method} ${x.url}`)).toEqual([
      "GET https://api.github.com/repos/o/r/issues?state=open&per_page=100&page=1",
      "POST https://api.github.com/repos/o/r/issues/3/comments",
      "PATCH https://api.github.com/repos/o/r/issues/3",
    ]);
    expect(calls[2]?.body).toEqual({ state: "closed" });
  });

  it("speaks GitLab's: iid, description, state_event", async () => {
    calls.length = 0;
    const c = issueClient(resolveForgeRepo({}, { GITLAB_CI: "true", CI_PROJECT_ID: "7", CI_API_V4_URL: "https://gl/api/v4", GITLAB_TOKEN: "t" }), fake([{ iid: 5, title: "x", description: "d", web_url: "w" }, {}, {}]));
    expect(await c.create("x", "d")).toEqual({ number: 5, title: "x", body: "d", url: "w" });
    await c.close(5, "gone");
    expect(calls.map((x) => `${x.method} ${x.url}`)).toEqual(["POST https://gl/api/v4/projects/7/issues", "POST https://gl/api/v4/projects/7/issues/5/notes", "PUT https://gl/api/v4/projects/7/issues/5"]);
    expect(calls[0]?.body).toEqual({ title: "x", description: "d" });
    expect(calls[2]?.body).toEqual({ state_event: "close" });
  });

  it("needs no pull request, but a repository and a token", () => {
    expect(() => resolveForgeRepo({}, { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "o/r" })).toThrow(/--issue on github needs a token/);
    expect(resolveForgeRepo({}, { FORGEJO_ACTIONS: "true", GITHUB_REPOSITORY: "o/r", GITHUB_SERVER_URL: "https://fj", GITHUB_TOKEN: "t" })).toMatchObject({ forge: "forgejo", apiUrl: "https://fj/api/v1" });
  });
});
