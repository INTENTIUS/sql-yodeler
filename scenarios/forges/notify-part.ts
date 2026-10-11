/**
 * The template claims' webhook part (#61): the project's yodel.config.ts
 * names a webhook and its key by their variables, the forge holds both as
 * secrets, and a receiver on this host checks every delivery's signature
 * with verifyWebhook. The first push's apply stops at the gate, so the
 * receiver must get a `waiting` event for dev, signed with the key, naming
 * the approve command.
 * BREAK: the receiver checks with another key, so it rejects the delivery
 * and has no event it accepted.
 *
 * The forge's jobs reach the receiver at YODEL_CLAIMS_RECEIVER_HOST
 * (default host.docker.internal).
 *
 * The part runs only once the project can send an event: the yodel the
 * template installs from npm has notify, and the rendered apply jobs pass
 * the two variables (yodel ci, src/ci/render.ts). Until both are true it
 * says why and is skipped, plain and under BREAK.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { verifyWebhook } from "../../src/notify/verify.js";
import { Violation, type Ctx } from "../lib/claim.js";

export const WEBHOOK_URL_VAR = "YODEL_WEBHOOK_URL";
export const WEBHOOK_KEY_VAR = "YODEL_WEBHOOK_KEY";

interface Delivery {
  ok: boolean;
  reason?: string;
  event?: { event?: string; environment?: string; approve?: { command?: string }; digest?: string } | undefined;
}

export interface NotifyPart {
  /** The secrets the forge's repository holds for it. */
  secrets: Record<string, string>;
  /** After the pipelines are rendered again: why the part is skipped, when the jobs do not pass the variables. */
  rendered(): string | undefined;
  /** After the first push: a Violation's message when the part does not hold, else undefined. */
  check(): string | undefined;
  close(): Promise<void>;
}

/** Why the installed yodel cannot send an event, or undefined when it can. */
function notInstalled(dir: string): string | undefined {
  const installed = join(dir, "node_modules", "@intentius", "sql-yodeler", "dist", "notify", "verify.js");
  return existsSync(installed) ? undefined : "the @intentius/sql-yodeler the template installs has no notify (#61) yet";
}

/** Why the rendered apply jobs cannot send an event, or undefined when they pass both variables. */
function notRendered(dir: string): string | undefined {
  const rendered = [".github/workflows", ".forgejo/workflows", ".gitlab"].flatMap((d) => {
    const at = join(dir, d);
    return existsSync(at) ? readdirSync(at, { recursive: true }).map((f) => join(at, String(f))).filter((f) => /apply/.test(f) && /\.ya?ml$/.test(f)) : [];
  });
  if (!rendered.some((f) => readFileSync(f, "utf8").includes(WEBHOOK_KEY_VAR))) return `the rendered apply jobs do not pass ${WEBHOOK_KEY_VAR} (yodel ci, src/ci/render.ts)`;
  return undefined;
}

/** Starts the receiver and writes notify into the project's yodel.config.ts. Call before the pipelines are rendered again. */
export async function startNotifyPart(ctx: Ctx, dir: string): Promise<NotifyPart | undefined> {
  const why = notInstalled(dir);
  if (why) {
    ctx.log(`the webhook part is skipped: ${why}`);
    return undefined;
  }
  const key = `yodel-61-${ctx.claim}-${ctx.dialect}`;
  const checkWith = ctx.broken ? `${key}-not-this-one` : key;
  const got: Delivery[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const checked = verifyWebhook({ body: Buffer.concat(chunks), headers: req.headers, key: checkWith });
      got.push(checked.ok ? { ok: true, event: checked.event as Delivery["event"] } : { ok: false, reason: checked.reason });
      res.writeHead(checked.ok ? 204 : 401).end();
    });
  });
  await new Promise<void>((done) => server.listen(0, "0.0.0.0", done));
  const port = (server.address() as AddressInfo).port;
  const host = process.env.YODEL_CLAIMS_RECEIVER_HOST ?? "host.docker.internal";

  const config = join(dir, "yodel.config.ts");
  const text = readFileSync(config, "utf8");
  const next = text.replace(/^export default \{\n/m, `export default {\n  notify: { webhook: "${WEBHOOK_URL_VAR}", key: "${WEBHOOK_KEY_VAR}" },\n`);
  if (next === text) throw new Error("yodel.config.ts has no `export default {` to add notify to");
  writeFileSync(config, next);

  return {
    rendered: () => notRendered(dir),
    secrets: { [WEBHOOK_URL_VAR]: `http://${host}:${String(port)}/yodel`, [WEBHOOK_KEY_VAR]: key },
    check: () => {
      const accepted = got.filter((d) => d.ok && d.event?.event === "waiting" && d.event.environment === "dev");
      if (accepted.length === 0) {
        return `the receiver accepted no waiting event for dev (${String(got.length)} deliveries${got.length > 0 ? `: ${got.map((d) => (d.ok ? String(d.event?.event) : `rejected, ${d.reason ?? ""}`)).join("; ")}` : ""})`;
      }
      const e = accepted[accepted.length - 1]?.event;
      if (!e?.approve?.command?.startsWith("chant approve ") || !e.digest) return `the waiting event names no approve command or digest: ${JSON.stringify(e)}`;
      return undefined;
    },
    close: () => new Promise<void>((done) => server.close(() => { done(); })),
  };
}

/**
 * Runs the part's check the way an approval part runs: plain, a
 * check that does not hold is a Violation; under BREAK it must not hold
 * (the receiver rejects), and the flow goes on to its own break.
 */
export function judgeNotify(ctx: Ctx, part: NotifyPart | undefined): void {
  if (!part) return;
  const skipped = part.rendered();
  if (skipped) {
    ctx.log(`the webhook part is skipped: ${skipped}`);
    return;
  }
  const problem = part.check();
  if (!ctx.broken) {
    if (problem) throw new Violation(problem);
    return;
  }
  if (!problem) throw new Error("under BREAK the receiver checked with another key, yet it accepted the event: the webhook part did not catch the break");
  ctx.log(`the webhook part caught: ${problem}`);
}
