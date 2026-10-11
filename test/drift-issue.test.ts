import { describe, expect, it } from "vitest";
import { driftFingerprint, renderDriftMarkdown, type Drift } from "../src/chant/drift.js";
import type { ForgeFetch, PrForge } from "@intentius/chant/pr-forge";
import { resolveForge } from "../src/pr/forge.js";
import { driftIssueMarker, trackDrift } from "../src/pr/issue.js";

const drift = (over: Partial<Drift> = {}): Drift => ({
  environment: "dev",
  changed: [{ name: "events", type: "ClickHouse::Table", changes: [{ path: "ttl", kind: "changed", declared: "ts + 90", live: "ts + 30" }] }] as Drift["changed"],
  missing: ["daily"],
  unobserved: [],
  ...over,
});

/**
 * chant's GitHub client over an in-memory forge's issues: what yodel asks of
 * chant's trackIssue lands here, and every write is counted.
 */
async function memoryIssues(): Promise<{ forge: PrForge; all: Array<{ number: number; title: string; body: string; state: string; comments: string[] }>; writes: string[] }> {
  const all: Array<{ number: number; title: string; body: string; state: string; comments: string[] }> = [];
  const writes: string[] = [];
  const fetch: ForgeFetch = (url, init) => {
    const send = (v: unknown) => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(v)) });
    const path = url.replace(/^https:\/\/api\.github\.com\/repos\/o\/r/, "").replace(/\?.*$/, "");
    const b = init.body ? (JSON.parse(init.body) as { title?: string; body?: string; state?: string }) : {};
    if (init.method === "GET" && path === "/issues") return send(all.filter((i) => i.state === "open").map((i) => ({ ...i, html_url: `https://gh/i/${String(i.number)}` })));
    writes.push(`${init.method} ${path}`);
    if (init.method === "POST" && path === "/issues") {
      const issue = { number: all.length + 1, title: b.title ?? "", body: b.body ?? "", state: "open", comments: [] };
      all.push(issue);
      return send({ ...issue, html_url: `https://gh/i/${String(issue.number)}` });
    }
    const m = /^\/issues\/(\d+)(\/comments)?$/.exec(path);
    const issue = all.find((i) => i.number === Number(m?.[1]));
    if (!issue) throw new Error(`no route ${init.method} ${path}`);
    if (m?.[2]) issue.comments.push(b.body ?? "");
    else Object.assign(issue, b.state ? { state: b.state } : { title: b.title, body: b.body });
    return send({ ...issue, html_url: `https://gh/i/${String(issue.number)}` });
  };
  const { client } = await resolveForge({}, { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: "t" }, "--issue", fetch);
  return { forge: client, all, writes };
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
    const c = await memoryIssues();
    const one = drift({ missing: [] });
    expect((await trackDrift(c.forge, marker, found(one))).action).toBe("opened");
    expect(c.all[0]?.body).toContain(marker);
    expect(c.all[0]?.body).toContain("`events` (ClickHouse::Table)");
    expect((await trackDrift(c.forge, marker, found(one))).action).toBe("unchanged");
    const two = drift();
    expect(await trackDrift(c.forge, marker, found(two))).toMatchObject({ action: "updated", issue: { number: 1 } });
    expect(c.all).toHaveLength(1);
    expect(c.all[0]?.title).toBe("Drift in dev: events, daily");
    expect(c.all[0]?.body).toContain("`daily`");
    expect(await trackDrift(c.forge, marker, { kind: "clean", comment: "gone" })).toMatchObject({ action: "closed", issue: { number: 1 } });
    expect(c.all[0]).toMatchObject({ state: "closed", comments: ["gone"] });
    expect((await trackDrift(c.forge, marker, { kind: "clean", comment: "gone" })).action).toBe("none");
    // Drift again after the close: a new issue, the closed one left closed.
    expect(await trackDrift(c.forge, marker, found(one))).toMatchObject({ action: "opened", issue: { number: 2 } });
  });

  it("leaves the issue as it is when the drift could not be read", async () => {
    const c = await memoryIssues();
    await trackDrift(c.forge, marker, found(drift()));
    expect(await trackDrift(c.forge, marker, { kind: "unknown", why: "no grant" })).toMatchObject({ action: "left", why: "no grant", issue: { number: 1 } });
    expect(c.all[0]?.state).toBe("open");
  });

  it("does not edit the issue when only the run it names has changed", async () => {
    const c = await memoryIssues();
    const d = drift();
    const run = (n: number) => ({ ...found(d), body: renderDriftMarkdown(d, undefined, { fingerprint: driftFingerprint(d), run: `https://ci/run/${String(n)}` }) });
    expect((await trackDrift(c.forge, marker, run(1))).action).toBe("opened");
    expect(await trackDrift(c.forge, marker, run(2))).toMatchObject({ action: "unchanged", issue: { number: 1, url: "https://gh/i/1" } });
    expect(c.writes).toEqual(["POST /issues"]);
  });

  it("keeps another environment's and another project's issues apart", async () => {
    const c = await memoryIssues();
    await trackDrift(c.forge, marker, found(drift()));
    expect((await trackDrift(c.forge, driftIssueMarker(".", "prod"), { kind: "clean", comment: "x" })).action).toBe("none");
    expect((await trackDrift(c.forge, driftIssueMarker("db", "dev"), { kind: "clean", comment: "x" })).action).toBe("none");
    expect(c.all[0]?.state).toBe("open");
  });
});
