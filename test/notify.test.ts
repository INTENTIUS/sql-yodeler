/**
 * Webhook events (#61): the signature, the receiver's check, delivery to a
 * receiver over HTTP, the Slack message, which outcomes send an event, and
 * the config refusing a URL or key written into it.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readSchema } from "../src/schemas.js";
import { checkYodelConfig } from "../src/config/load.js";
import {
  eventFromDrift,
  eventFromRun,
  makeEvent,
  notifyConfigProblem,
  sendEvent,
  signWebhook,
  slackMessage,
  verifyWebhook,
  webhookRequest,
  type NotifyEvent,
} from "../src/notify/index.js";

const KEY = "s3cret-key";
const NOW = 1_800_000_000;

const waiting = () =>
  makeEvent(
    { event: "waiting", environment: "prod", command: "apply", status: "gated", summary: "prod is waiting", migrations: ["20261010T000000Z-a"], digest: "jcs1-sha256:ab", approve: "chant approve migrate-prod approve-migrate-prod --plan jcs1-sha256:ab" },
    { GITHUB_SERVER_URL: "https://github.example", GITHUB_REPOSITORY: "acme/db", GITHUB_RUN_ID: "42", GITHUB_SHA: "abc123" },
  );

describe("the signature and the receiver's check", () => {
  const event = waiting();
  const { headers, body } = webhookRequest(event, KEY, NOW);

  it("signs <timestamp>.<body> with HMAC-SHA256", () => {
    expect(headers["x-yodel-signature"]).toBe(signWebhook(KEY, NOW, body));
    expect(headers["x-yodel-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(headers["x-yodel-event"]).toBe("waiting");
    expect(headers["x-yodel-delivery"]).toBe(event.id);
  });

  it("accepts the delivery with the right key and returns the event", () => {
    const checked = verifyWebhook({ body, headers, key: KEY, now: NOW + 10 });
    expect(checked).toEqual({ ok: true, event: JSON.parse(body) as unknown });
    // A fetch Headers object, with names in any case, works the same.
    const h = new Headers(Object.entries(headers).map(([k, v]) => [k.toUpperCase(), v]));
    expect(verifyWebhook({ body: Buffer.from(body), headers: h, key: KEY, now: NOW }).ok).toBe(true);
  });

  it("refuses a wrong key, a changed body, a changed timestamp, a stale delivery and a missing signature", () => {
    expect(verifyWebhook({ body, headers, key: "another-key", now: NOW })).toEqual({ ok: false, reason: "the signature does not match" });
    expect(verifyWebhook({ body: body.replace("prod", "dev"), headers, key: KEY, now: NOW }).ok).toBe(false);
    expect(verifyWebhook({ body, headers: { ...headers, "x-yodel-timestamp": String(NOW + 1) }, key: KEY, now: NOW }).ok).toBe(false);
    expect(verifyWebhook({ body, headers, key: KEY, now: NOW + 301 })).toEqual({ ok: false, reason: "the timestamp is more than 300s from now" });
    expect(verifyWebhook({ body, headers: { ...headers, "x-yodel-signature": undefined }, key: KEY, now: NOW }).ok).toBe(false);
    expect(verifyWebhook({ body, headers, key: "", now: NOW }).ok).toBe(false);
    expect(verifyWebhook({ body, headers, key: undefined, now: NOW }).ok).toBe(false);
  });

  it("carries the CI run, the repository and the commit", () => {
    expect(event).toMatchObject({ version: 1, runUrl: "https://github.example/acme/db/actions/runs/42", repository: "acme/db", commit: "abc123" });
    expect(makeEvent({ ...event, event: "failed" }, { CI_JOB_URL: "https://gitlab.example/j/1", CI_PROJECT_PATH: "acme/db", CI_COMMIT_SHA: "def" })).toMatchObject({ runUrl: "https://gitlab.example/j/1", repository: "acme/db", commit: "def" });
  });
});

/** A receiver that checks each delivery with verifyWebhook, as docs/notify.md shows one. */
function receiver(key: string) {
  const got: Array<{ ok: boolean; event?: NotifyEvent; reason?: string; path: string }> = [];
  const server: Server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (req.url === "/slack") {
        got.push({ ok: true, path: "/slack", event: JSON.parse(body) as NotifyEvent });
        res.writeHead(200).end("ok");
        return;
      }
      const checked = verifyWebhook({ body, headers: req.headers, key });
      got.push(checked.ok ? { ok: true, event: checked.event as NotifyEvent, path: req.url ?? "" } : { ok: false, reason: checked.reason, path: req.url ?? "" });
      res.writeHead(checked.ok ? 204 : 401).end();
    });
  });
  return { server, got, url: () => `http://127.0.0.1:${String((server.address() as AddressInfo).port)}` };
}

describe("delivery", () => {
  const r = receiver(KEY);
  beforeAll(() => new Promise<void>((done) => r.server.listen(0, "127.0.0.1", done)));
  afterAll(() => new Promise<void>((done) => r.server.close(() => { done(); })));

  const io = () => {
    const err: string[] = [];
    return { io: { out: () => undefined, err: (t: string) => err.push(t) }, err };
  };
  const fields = eventFromRun("apply", { environment: "prod", status: "gated", pending: [{ id: "m1" }], gatePlanDigest: "jcs1-sha256:cd", approve: "chant approve x y --plan jcs1-sha256:cd" });
  const config = { webhook: "HOOK_URL", key: "HOOK_KEY", slack: "SLACK_URL" };

  it("posts the signed event to the webhook and a text line to Slack; the receiver accepts it", async () => {
    r.got.length = 0;
    const { io: out, err } = io();
    const env = { HOOK_URL: `${r.url()}/hook`, HOOK_KEY: KEY, SLACK_URL: `${r.url()}/slack` };
    const sent = await sendEvent(config, fields, { io: out, verb: "apply", env });
    expect(sent).toEqual([{ target: "webhook", ok: true, detail: "delivered" }, { target: "slack", ok: true, detail: "delivered" }]);
    expect(err).toEqual([]);
    const hook = r.got.find((g) => g.path === "/hook");
    expect(hook?.ok).toBe(true);
    expect(hook?.event).toMatchObject({ event: "waiting", environment: "prod", migrations: ["m1"], digest: "jcs1-sha256:cd", approve: "chant approve x y --plan jcs1-sha256:cd" });
    expect((r.got.find((g) => g.path === "/slack")?.event as unknown as { text: string }).text).toContain("Approve with: `chant approve x y --plan jcs1-sha256:cd`");
  });

  it("signed with another key, the receiver rejects it, and yodel says so without failing", async () => {
    r.got.length = 0;
    const { io: out, err } = io();
    const sent = await sendEvent({ webhook: "HOOK_URL", key: "HOOK_KEY" }, fields, { io: out, verb: "apply", env: { HOOK_URL: `${r.url()}/hook`, HOOK_KEY: "wrong" }, attempts: 1 });
    expect(sent).toEqual([{ target: "webhook", ok: false, detail: "HTTP 401" }]);
    expect(r.got).toEqual([{ ok: false, reason: "the signature does not match", path: "/hook" }]);
    expect(err.join("")).toMatch(/notify: the waiting event was not delivered to the webhook: HTTP 401/);
  });

  it("sends nothing unsigned: no key in the environment, no request", async () => {
    r.got.length = 0;
    const { io: out, err } = io();
    const sent = await sendEvent({ webhook: "HOOK_URL", key: "HOOK_KEY" }, fields, { io: out, verb: "apply", env: { HOOK_URL: `${r.url()}/hook` } });
    expect(sent[0]?.ok).toBe(false);
    expect(r.got).toEqual([]);
    expect(err.join("")).toMatch(/HOOK_KEY is not set, and yodel does not send an unsigned event/);
  });

  it("sends only the events the config lists, and nothing without a config or an event", async () => {
    const { io: out } = io();
    expect(await sendEvent({ ...config, events: ["drift"] }, fields, { io: out, verb: "apply", env: {} })).toEqual([]);
    expect(await sendEvent(undefined, fields, { io: out, verb: "apply" })).toEqual([]);
    expect(await sendEvent(config, undefined, { io: out, verb: "apply" })).toEqual([]);
  });
});

describe("which outcomes send an event", () => {
  it("apply: gated waits, refused and denied are refused, failed fails; applied and unchanged send none", () => {
    expect(eventFromRun("apply", { environment: "prod", status: "gated", pending: [{ id: "a" }, { id: "b" }], planDigest: "d1" })).toMatchObject({ event: "waiting", digest: "d1", migrations: ["a", "b"], summary: "prod is waiting for approval of d1 (2 migrations)" });
    expect(eventFromRun("apply", { environment: "prod", status: "refused", refusal: { exitCode: 4, message: "a checksum mismatch\nmore" } })).toMatchObject({ event: "refused", reason: "a checksum mismatch\nmore", summary: "apply in prod was refused: a checksum mismatch" });
    expect(eventFromRun("apply", { environment: "prod", status: "denied", policy: [{ id: "no-drops", outcome: "denied" }] })).toMatchObject({ event: "refused", status: "denied", reason: "policy rule no-drops denies the plan" });
    expect(eventFromRun("apply", { environment: "prod", status: "failed", exitCode: 5 })).toMatchObject({ event: "failed", reason: "apply failed (exit 5)" });
    expect(eventFromRun("apply", { environment: "prod", status: "applied" })).toBeUndefined();
    expect(eventFromRun("apply", { environment: "prod", status: "unchanged" })).toBeUndefined();
  });

  it("plan: a refusal or a denying rule is refused; a plan that would run sends none", () => {
    expect(eventFromRun("plan", { environment: "dev", refusal: { exitCode: 4, message: "out of order" } })).toMatchObject({ event: "refused", command: "plan", status: "refused" });
    expect(eventFromRun("plan", { environment: "dev", policy: [{ id: "r", outcome: "denied" }] })).toMatchObject({ event: "refused", status: "denied" });
    expect(eventFromRun("plan", { environment: "dev", pending: [{ id: "a" }], policy: [{ id: "r", outcome: "allowed" }] })).toBeUndefined();
  });

  it("drift: what changed and what is missing; no drift sends none", () => {
    expect(eventFromDrift({ environment: "prod", drifted: true, changed: [{ name: "events" }], missing: ["users"] })).toMatchObject({ event: "drift", drift: { changed: ["events"], missing: ["users"] }, summary: "prod drifted: events changed; users missing" });
    expect(eventFromDrift({ environment: "prod", drifted: false, changed: [], missing: [] })).toBeUndefined();
  });

  it("Slack gets one line, the approve command and the run", () => {
    expect(slackMessage(waiting()).text).toBe("yodel waiting: prod is waiting\nApprove with: `chant approve migrate-prod approve-migrate-prod --plan jcs1-sha256:ab`\nRun: https://github.example/acme/db/actions/runs/42");
  });
});

describe("notify in yodel.config.ts", () => {
  it("takes the names of the variables", () => {
    expect(notifyConfigProblem({ webhook: "YODEL_WEBHOOK_URL", key: "YODEL_WEBHOOK_KEY" })).toBeUndefined();
    expect(notifyConfigProblem({ slack: "SLACK_WEBHOOK_URL", events: ["waiting", "drift"] })).toBeUndefined();
    expect(checkYodelConfig({ notify: { webhook: "A", key: "B" } }, "yodel.config.ts").notify).toEqual({ webhook: "A", key: "B" });
  });

  it("refuses a URL or a key written into the config, a webhook without a key, and unknown settings or events", () => {
    expect(() => checkYodelConfig({ notify: { webhook: "https://hooks.example/x", key: "K" } }, "yodel.config.ts")).toThrow(/notify.webhook: the name of the environment variable that holds the URL \(such as YODEL_WEBHOOK_URL\), never the URL itself/);
    expect(notifyConfigProblem({ webhook: "U", key: "not a name!" })).toMatch(/^notify.key: .*never the key itself/);
    expect(notifyConfigProblem({ webhook: "U" })).toMatch(/^notify.key: a webhook needs a signing key/);
    expect(notifyConfigProblem({ key: "K" })).toMatch(/^notify.webhook:/);
    expect(notifyConfigProblem({})).toMatch(/name a webhook/);
    expect(notifyConfigProblem({ slack: "S", url: "x" })).toMatch(/^notify.url: unknown setting/);
    expect(notifyConfigProblem({ slack: "S", events: ["applied"] })).toMatch(/^notify.events:/);
  });
});

describe("the event schema", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
  ajv.addFormat("date-time", (v: string) => !Number.isNaN(Date.parse(v)));
  const validate = ajv.compile(readSchema("event"));

  it("describes every event yodel sends", () => {
    const events = [
      waiting(),
      makeEvent(eventFromRun("apply", { environment: "p", status: "refused", refusal: { exitCode: 4, message: "m" } }) ?? fail(), {}),
      makeEvent(eventFromRun("apply", { environment: "p", status: "failed", exitCode: 1 }) ?? fail(), {}),
      makeEvent(eventFromDrift({ environment: "p", drifted: true, changed: [{ name: "t" }], missing: [], fingerprint: "f" }) ?? fail(), {}),
    ];
    for (const e of events) expect(validate(e), JSON.stringify(validate.errors)).toBe(true);
  });

  it("refuses a field it does not describe", () => {
    expect(validate({ ...waiting(), extra: 1 })).toBe(false);
  });
});

function fail(): never {
  throw new Error("no event");
}
