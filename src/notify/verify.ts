/**
 * Signing and checking a yodel webhook event (#61). This module needs only
 * node:crypto, so a receiver can import it alone:
 *
 * ```ts
 * import { verifyWebhook } from "@intentius/sql-yodeler/webhook";
 *
 * const checked = verifyWebhook({ body, headers: req.headers, key: process.env.YODEL_WEBHOOK_KEY });
 * if (!checked.ok) return reply(401, checked.reason);
 * handle(checked.event);
 * ```
 *
 * The signature is HMAC-SHA256, keyed with the secret, over
 * `<timestamp>.<body>`: the `x-yodel-timestamp` header (seconds since the
 * epoch), a dot, and the request body exactly as sent. It travels as
 * `x-yodel-signature: sha256=<hex>`. Signing the timestamp with the body
 * lets a receiver refuse a delivery replayed later; {@link verifyWebhook}
 * refuses one older than five minutes by default.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-yodel-signature";
export const TIMESTAMP_HEADER = "x-yodel-timestamp";
export const EVENT_HEADER = "x-yodel-event";
export const DELIVERY_HEADER = "x-yodel-delivery";

/** How old a delivery {@link verifyWebhook} still accepts, in seconds. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/** `sha256=<hex>` of `<timestamp>.<body>`, keyed with `key`. */
export function signWebhook(key: string, timestamp: number | string, body: string): string {
  return `sha256=${createHmac("sha256", key).update(`${String(timestamp)}.${body}`, "utf8").digest("hex")}`;
}

export type WebhookHeaders = Record<string, string | readonly string[] | undefined> | Headers;

export interface VerifyInput {
  /** The request body exactly as received, before any JSON parsing. */
  body: string | Uint8Array;
  /** The request's headers; names are matched without regard to case. */
  headers: WebhookHeaders;
  /** The shared secret. An empty or missing key never verifies. */
  key: string | undefined;
  /** Now, in seconds since the epoch. Default: the clock. */
  now?: number;
  /** How old a delivery may be, in seconds. Default {@link DEFAULT_TOLERANCE_SECONDS}. */
  toleranceSeconds?: number;
}

export type VerifyResult = { ok: true; event: unknown } | { ok: false; reason: string };

function header(headers: WebhookHeaders, name: string): string | undefined {
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined;
  for (const [k, v] of Object.entries(headers as Record<string, string | readonly string[] | undefined>)) {
    if (k.toLowerCase() !== name) continue;
    return Array.isArray(v) ? (v[0] as string | undefined) : (v as string | undefined);
  }
  return undefined;
}

/**
 * Whether a delivery was signed with `key` and is recent: the signature
 * header matches (compared in constant time) and the timestamp is within the
 * tolerance either side of now. On success, the parsed event.
 */
export function verifyWebhook(input: VerifyInput): VerifyResult {
  if (!input.key) return { ok: false, reason: "no key to verify with" };
  const body = typeof input.body === "string" ? input.body : Buffer.from(input.body).toString("utf8");
  const signature = header(input.headers, SIGNATURE_HEADER);
  const timestamp = header(input.headers, TIMESTAMP_HEADER);
  if (!signature) return { ok: false, reason: `no ${SIGNATURE_HEADER} header` };
  if (!timestamp || !/^\d+$/.test(timestamp)) return { ok: false, reason: `no ${TIMESTAMP_HEADER} header, or not a number of seconds` };
  const expected = Buffer.from(signWebhook(input.key, timestamp, body));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "the signature does not match" };
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(now - Number(timestamp)) > tolerance) return { ok: false, reason: `the timestamp is more than ${String(tolerance)}s from now` };
  try {
    return { ok: true, event: JSON.parse(body) as unknown };
  } catch {
    return { ok: false, reason: "the body is not JSON" };
  }
}
