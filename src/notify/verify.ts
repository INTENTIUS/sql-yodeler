/**
 * Checking a yodel webhook event (#61), over chant's notify-verify (#211).
 * It needs only node:crypto and chant's compiled notify-verify, so a
 * receiver can import it alone, in plain Node:
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
 * refuses one more than five minutes from now by default. This is chant's
 * scheme under yodel's header names, so a receiver written for an earlier
 * release keeps verifying.
 */

import { verifyWebhook as chantVerify, webhookHeaderNames, type VerifyWebhookInput, type VerifyWebhookResult } from "@intentius/chant/notify-verify";

export { DEFAULT_TOLERANCE_SECONDS, signWebhook } from "@intentius/chant/notify-verify";
export type { WebhookHeaders } from "@intentius/chant/notify-verify";

/** The prefix of yodel's webhook header names. */
export const HEADER_PREFIX = "x-yodel";

const names = webhookHeaderNames(HEADER_PREFIX);
export const SIGNATURE_HEADER = names.signature;
export const TIMESTAMP_HEADER = names.timestamp;
export const EVENT_HEADER = names.event;
export const DELIVERY_HEADER = names.delivery;

export type VerifyInput = Omit<VerifyWebhookInput, "prefix">;
export type VerifyResult = VerifyWebhookResult;

/**
 * Whether a delivery was signed with `key` and is recent: the signature
 * header matches (compared in constant time) and the timestamp is within the
 * tolerance either side of now. On success, the parsed event.
 */
export function verifyWebhook(input: VerifyInput): VerifyResult {
  return chantVerify({ ...input, prefix: HEADER_PREFIX });
}
