/**
 * Webhook events (#61), through chant's notify (#211): the signature under
 * yodel's header names, the receiver's check (also of an event 0.7.0 sent),
 * delivery to a receiver over HTTP, the Slack message, which outcomes send
 * an event, and the config refusing a URL or key written into it.
 */

import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readSchema } from "../src/schemas.js";
import { checkYodelConfig } from "../src/config/load.js";
import { waveFailure } from "../src/commands/apply.js";
import { YodelError } from "../src/project.js";
import { repoRoot } from "./helpers/run.js";
import {
  eventFromDrift,
  eventFromRun,
  makeNotifyEvent,
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
  makeNotifyEvent(
    {
      source: "sql-yodeler",
      event: "waiting",
      environment: "prod",
      detail: { command: "apply" },
      status: "gated",
      summary: "prod is waiting",
      targets: ["20261010T000000Z-a"],
      digest: "jcs1-sha256:ab",
      approve: { command: "chant approve migrate-prod approve-migrate-prod --plan jcs1-sha256:ab" },
    },
    { env: { GITHUB_SERVER_URL: "https://github.example", GITHUB_REPOSITORY: "acme/db", GITHUB_RUN_ID: "42", GITHUB_SHA: "abc123" } },
  );

describe("the signature and the receiver's check", () => {
  const event = waiting();
  const { headers, body } = webhookRequest(event, KEY, { now: NOW, prefix: "x-yodel" });

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
    expect(event).toMatchObject({ schema: "chant.notify/v1", source: "sql-yodeler", run: { url: "https://github.example/acme/db/actions/runs/42", repository: "acme/db", commit: "abc123" } });
    const fields = eventFromRun("apply", { environment: "prod", status: "failed", exitCode: 1 }) ?? fail();
    expect(makeNotifyEvent(fields, { env: { CI_JOB_URL: "https://gitlab.example/j/1", CI_PROJECT_PATH: "acme/db", CI_COMMIT_SHA: "def" } })).toMatchObject({ run: { url: "https://gitlab.example/j/1", repository: "acme/db", commit: "def" } });
  });

  // An event as 0.7.0 sent it: its own body (version 1), signed by 0.7.0's signWebhook. Frozen, so a receiver on this release still verifies one.
  it("verifies an event 0.7.0 signed", () => {
    const old =
      '{"version":1,"id":"6f0c2c9e-1d55-4c7e-9a43-2f7d0b8e51a2","event":"waiting","at":"2026-10-10T09:12:44.120Z","environment":"prod","command":"apply","status":"gated","summary":"prod is waiting for approval of jcs1-sha256:9f2c (1 migration)","migrations":["20261010T090000Z-add-note"],"digest":"jcs1-sha256:9f2c","approve":"yodel approve prod --plan jcs1-sha256:9f2c","runUrl":"https://github.com/acme/db/actions/runs/123","repository":"acme/db","commit":"4b1d"}';
    const at = 1_791_623_564;
    const oldHeaders = {
      "x-yodel-event": "waiting",
      "x-yodel-delivery": "6f0c2c9e-1d55-4c7e-9a43-2f7d0b8e51a2",
      "x-yodel-timestamp": String(at),
      "x-yodel-signature": "sha256=85ef12c48714e97541edc4fec1548c292148f13b57a10ea19ca6836db8343bb8",
    };
    expect(verifyWebhook({ body: old, headers: oldHeaders, key: KEY, now: at + 5 })).toEqual({ ok: true, event: JSON.parse(old) as unknown });
    expect(verifyWebhook({ body: old, headers: oldHeaders, key: "another-key", now: at + 5 }).ok).toBe(false);
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
    expect(hook?.event).toMatchObject({ schema: "chant.notify/v1", source: "sql-yodeler", event: "waiting", environment: "prod", targets: ["m1"], digest: "jcs1-sha256:cd", approve: { command: "chant approve x y --plan jcs1-sha256:cd" }, detail: { command: "apply" } });
    expect((r.got.find((g) => g.path === "/slack")?.event as unknown as { text: string }).text).toContain("Approve: `chant approve x y --plan jcs1-sha256:cd`");
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
    expect(err.join("")).toMatch(/yodel apply: notify: the waiting event was not delivered to the webhook: HOOK_KEY is not set, and an event is never sent unsigned/);
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
    expect(eventFromRun("apply", { environment: "prod", status: "gated", pending: [{ id: "a" }, { id: "b" }], planDigest: "d1" })).toMatchObject({ event: "waiting", digest: "d1", targets: ["a", "b"], summary: "prod is waiting for approval of d1 (2 migrations)" });
    expect(eventFromRun("apply", { environment: "prod", status: "refused", refusal: { exitCode: 1, message: "a checksum mismatch\nmore" } })).toMatchObject({ event: "refused", reason: "a checksum mismatch\nmore", summary: "apply in prod was refused: a checksum mismatch" });
    expect(eventFromRun("apply", { environment: "prod", status: "denied", policy: [{ id: "no-drops", outcome: "denied" }] })).toMatchObject({ event: "refused", status: "denied", reason: "policy rule no-drops denies the plan" });
    expect(eventFromRun("apply", { environment: "prod", status: "failed", exitCode: 5 })).toMatchObject({ event: "failed", reason: "apply failed (exit 5)", exitCode: 5 });
    expect(eventFromRun("apply", { environment: "prod", status: "applied" })).toBeUndefined();
    expect(eventFromRun("apply", { environment: "prod", status: "unchanged" })).toBeUndefined();
  });

  it("apply's wave modes (#87): a wave that will wait, a refusal, a failure", () => {
    const approve = "chant approve yodel-apply yodel-apply-wave-2 --plan jcs1-sha256:w";
    expect(eventFromRun("apply", { environment: "prod", status: "gated", pending: [{ id: "a" }], gatePlanDigest: "jcs1-sha256:w", approve })).toMatchObject({ event: "waiting", digest: "jcs1-sha256:w", approve: { command: approve }, targets: ["a"] });
    expect(eventFromRun("apply", waveFailure("prod", new YodelError("refused: prod applies only migrations staging applied first", 4)))).toMatchObject({ event: "refused", reason: "refused: prod applies only migrations staging applied first" });
    expect(eventFromRun("apply", waveFailure("prod", new YodelError("refused: wave 2 (prod) needs an approval", 3)))).toMatchObject({ event: "refused" });
    expect(eventFromRun("apply", waveFailure("prod", new YodelError("a statement failed", 1)))).toMatchObject({ event: "failed", reason: "apply failed (exit 1)" });
  });

  it("plan: a refusal or a denying rule is refused; a plan that would run sends none", () => {
    expect(eventFromRun("plan", { environment: "dev", refusal: { exitCode: 1, message: "out of order" } })).toMatchObject({ event: "refused", detail: { command: "plan" }, status: "refused" });
    expect(eventFromRun("plan", { environment: "dev", policy: [{ id: "r", outcome: "denied" }] })).toMatchObject({ event: "refused", status: "denied" });
    expect(eventFromRun("plan", { environment: "dev", pending: [{ id: "a" }], policy: [{ id: "r", outcome: "allowed" }] })).toBeUndefined();
  });

  it("drift: what changed and what is missing; no drift sends none", () => {
    expect(eventFromDrift({ environment: "prod", drifted: true, changed: [{ name: "events" }], missing: ["users"] })).toMatchObject({ event: "drift", drift: { changed: ["events"], missing: ["users"] }, summary: "prod drifted: events changed; users missing" });
    expect(eventFromDrift({ environment: "prod", drifted: false, changed: [], missing: [] })).toBeUndefined();
  });

  it("Slack gets chant's message: the summary, the approve command and the run", () => {
    expect(slackMessage(waiting()).text).toBe(
      "*sql-yodeler: prod is waiting*\nTargets: 20261010T000000Z-a\nDigest: `jcs1-sha256:ab`\nApprove: `chant approve migrate-prod approve-migrate-prod --plan jcs1-sha256:ab`\nRun: <https://github.example/acme/db/actions/runs/42>",
    );
  });
});

describe("notify in yodel.config.ts", () => {
  it("takes the names of the variables", () => {
    expect(notifyConfigProblem({ webhook: "YODEL_WEBHOOK_URL", key: "YODEL_WEBHOOK_KEY" })).toBeUndefined();
    expect(notifyConfigProblem({ slack: "SLACK_WEBHOOK_URL", events: ["waiting", "drift"] })).toBeUndefined();
    expect(checkYodelConfig({ notify: { webhook: "A", key: "B" } }, "yodel.config.ts").notify).toEqual({ webhook: "A", key: "B" });
  });

  it("refuses a URL or a key written into the config, a webhook without a key, and unknown settings or events", () => {
    expect(() => checkYodelConfig({ notify: { webhook: "https://hooks.example/x", key: "K" } }, "yodel.config.ts")).toThrow(/notify.webhook: the name of the environment variable that holds the URL, never the URL itself/);
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
      makeNotifyEvent(eventFromRun("apply", { environment: "p", status: "gated", pending: [{ id: "a" }], planDigest: "d", approve: "yodel approve p --plan d", chantApprove: "chant approve o g --plan d" }) ?? fail(), { env: {} }),
      makeNotifyEvent(eventFromRun("apply", { environment: "p", status: "refused", refusal: { exitCode: 1, message: "m" } }) ?? fail(), { env: {} }),
      makeNotifyEvent(eventFromRun("apply", { environment: "p", status: "failed", exitCode: 1 }) ?? fail(), { env: {} }),
      makeNotifyEvent(eventFromDrift({ environment: "p", drifted: true, changed: [{ name: "t" }], missing: [], fingerprint: "f" }) ?? fail(), { env: {} }),
    ];
    for (const e of events) expect(validate(e), JSON.stringify(validate.errors)).toBe(true);
  });

  it("is chant's notify event, from sql-yodeler, with the command in detail", () => {
    const chant = ajv.compile(JSON.parse(readFileSync(join(repoRoot, "node_modules", "@intentius", "chant", "src", "notify.schema.json"), "utf8")) as object);
    expect(chant(waiting()), JSON.stringify(chant.errors)).toBe(true);
    expect(validate({ ...waiting(), source: "terragucci" })).toBe(false);
    expect(validate({ ...waiting(), detail: {} })).toBe(false);
  });
});

function fail(): never {
  throw new Error("no event");
}
