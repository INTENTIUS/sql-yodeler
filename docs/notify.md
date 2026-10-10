---
claims: [template, template-github, template-gitlab]
type: howto
draft: true
---

# Webhook events

A prod apply waiting for approval, a run refused because the plan moved or a policy rule denied it, a failed apply, and drift found by the watch are each visible in the CI run that saw them. With `notify` in `yodel.config.ts`, yodel also posts each one to a webhook, so the people who need to act hear about it when it happens.

## Configuring

`notify` names environment variables. The config never holds a URL or a key: yodel refuses a value that is not a variable name, such as a URL.

```ts
// yodel.config.ts
export default defineConfig({
  notify: {
    webhook: "YODEL_WEBHOOK_URL", // the variable holding the webhook's URL
    key: "YODEL_WEBHOOK_KEY",     // the variable holding the signing key
    slack: "SLACK_WEBHOOK_URL",   // optional: a Slack incoming webhook
    events: ["waiting", "refused", "failed", "drift"], // optional: default all four
  },
});
```

Give the jobs that run `yodel apply`, `yodel plan` and the watch's `yodel drift` those variables, from the forge's secrets. A webhook needs its key: when the key variable is not set, yodel sends nothing to the webhook rather than an unsigned event.

A delivery that fails (the receiver is down, it answers 401) is reported on stderr, `yodel apply: notify: the waiting event was not delivered to the webhook: HTTP 401`, and never changes the command's exit code. yodel retries a network error or a 5xx answer twice; a 4xx answer is not retried.

## The events

| Event | Sent by | When |
|---|---|---|
| `waiting` | `yodel apply` | the migrations Op stopped at its gate (exit 3); the event carries the approve command |
| `refused` | `yodel apply`, `yodel plan` | a refusal (exit 4: a checksum mismatch, an out-of-order migration, a failed pre-migration check) or a policy rule that denies the plan |
| `failed` | `yodel apply` | the Op's run failed: a statement, the lock, a plan that moved since approval |
| `drift` | `yodel drift` (the watch) | a declared object changed out of band or is gone (exit 2) |

The apply pipeline's wave jobs (`chant run wave`, see [approval](approval.md)) send the same events from `yodel apply`'s wave modes. `--wave-plan` makes the decision chant makes right after it, from the same sources (the wave's policy at the base commit, and the gate ledger), and sends `waiting` when the wave will wait, with the wave's set digest and its `chant approve yodel-apply yodel-apply-wave-<k>` command. `--wave-plan` and `--wave-apply` send `refused` for a refusal (an environment before this one has not applied a migration, a wave with no decision that lets it through) and `failed` for anything else that stops them. The job's exit code is chant's: 3 for a wave that waits, which is yodel's code for an approval outstanding too, and 1 when an apply failed or refused.

The body is JSON, described by [schemas/event.schema.json](../schemas/event.schema.json) (`https://intentius.io/sql-yodeler/schemas/v1/event.schema.json`):

```json
{
  "version": 1,
  "id": "6f0c2c9e-1d55-4c7e-9a43-2f7d0b8e51a2",
  "event": "waiting",
  "at": "2026-10-10T09:12:44.120Z",
  "environment": "prod",
  "command": "apply",
  "status": "gated",
  "summary": "prod is waiting for approval of jcs1-sha256:9f2c... (1 migration)",
  "migrations": ["20261010T090000Z-add-note"],
  "digest": "jcs1-sha256:9f2c...",
  "approve": "chant approve migrate-prod approve-migrate-prod --plan jcs1-sha256:9f2c...",
  "runUrl": "https://github.com/acme/db/actions/runs/123",
  "repository": "acme/db",
  "commit": "4b1d..."
}
```

`refused` and `failed` add `reason`; `drift` adds `drift: { changed: [...], missing: [...], fingerprint }` and has no migrations; the fingerprint is the same for the same drift run after run, so a receiver can tell a repeat from new drift. `runUrl`, `repository` and `commit` are there when yodel runs in GitHub Actions, Forgejo Actions or GitLab CI. Within version 1 fields are only added, so a receiver ignores fields it does not know.

Slack gets a line of text instead: `yodel waiting: prod is waiting for approval of ...`, then the approve command and the run.

## The signature

Each request carries:

| Header | Value |
|---|---|
| `x-yodel-event` | the event: `waiting`, `refused`, `failed`, `drift` |
| `x-yodel-delivery` | the event's `id`, to drop a repeat |
| `x-yodel-timestamp` | when it was sent, in seconds since the epoch |
| `x-yodel-signature` | `sha256=` and the hex HMAC-SHA256 of `<timestamp>.<body>`, keyed with the key |

The receiver checks it with `verifyWebhook` from `@intentius/sql-yodeler/webhook`, which needs only `node:crypto`. It compares the signature in constant time and refuses a delivery whose timestamp is more than five minutes from now, so a captured request cannot be replayed later:

```ts
import { createServer } from "node:http";
import { verifyWebhook } from "@intentius/sql-yodeler/webhook";

createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    // The body exactly as received: parse it only after the check.
    const checked = verifyWebhook({ body: Buffer.concat(chunks), headers: req.headers, key: process.env.YODEL_WEBHOOK_KEY });
    if (!checked.ok) return res.writeHead(401).end(checked.reason);
    console.log(checked.event);
    res.writeHead(204).end();
  });
}).listen(8080);
```

In another language, compute HMAC-SHA256 over the timestamp header, a `.`, and the raw body, and compare it with the signature header in constant time.

## What proves it

The template claims (`template`, `template-github`, `template-gitlab`) configure `notify` in the project, hold the URL and the key as the forge's secrets, and run a receiver that checks each delivery with `verifyWebhook`. The first push's apply stops at the gate, and the receiver must accept a `waiting` event for the environment that names the approve command. Under `BREAK=1` the receiver checks with another key and rejects it. The part runs once the template installs a release of `@intentius/sql-yodeler` with `notify` and its rendered apply jobs pass the two variables; until then the claims say they skipped it, and this page is a draft.
