/**
 * Webhook events (#61), sent through chant's notify (#211). `notify` in
 * yodel.config.ts names the environment variables that hold a webhook's URL
 * and its signing key (never the values themselves); `yodel apply`,
 * `yodel plan` and `yodel drift` post an event when an environment is
 * waiting for approval, when a run was refused or failed, and when drift is
 * found:
 *
 * ```ts
 * notify: { webhook: "YODEL_WEBHOOK_URL", key: "YODEL_WEBHOOK_KEY", slack: "SLACK_WEBHOOK_URL" }
 * ```
 *
 * The event is chant's `chant.notify/v1`; yodel decides when to send one and
 * what it says. The webhook gets it as JSON, signed under yodel's header
 * names (`./verify.ts`); Slack and Teams incoming webhooks get chant's
 * message. A delivery that fails is reported on stderr and never changes the
 * command's exit code: the event is news about the run, not part of it.
 */

import { makeNotifyEvent, sendNotify, type NotifyConfig, type NotifyDelivery, type NotifyFetch, type NotifyFields } from "@intentius/chant/notify";
import type { Io } from "../command.js";
import { HEADER_PREFIX } from "./verify.js";

export * from "./verify.js";
export { NOTIFY_EVENTS, makeNotifyEvent, notifyConfigProblem, slackMessage, webhookRequest } from "@intentius/chant/notify";
export type { NotifyConfig, NotifyDelivery, NotifyEvent, NotifyEventKind, NotifyFields } from "@intentius/chant/notify";

/** The product name events carry in `source`. */
export const SOURCE = "sql-yodeler";

/** What yodel says on top of chant's event: the command that sent it, in `detail`. */
export type YodelFields = NotifyFields & { detail: { command: "apply" | "plan" | "drift" } };

const ids = (list: unknown): string[] => (Array.isArray(list) ? list.flatMap((p) => (typeof p === "object" && p !== null && typeof (p as { id?: unknown }).id === "string" ? [(p as { id: string }).id] : [])) : []);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const firstLine = (s: string): string => s.split("\n")[0] ?? s;

/**
 * The event for what `yodel apply --json` (or `yodel plan --json`) printed,
 * or undefined when the outcome is not one an event is sent for.
 */
export function eventFromRun(command: "apply" | "plan", doc: Record<string, unknown>): YodelFields | undefined {
  const status = str(doc.status) ?? (doc.refusal ? "refused" : undefined);
  const environment = str(doc.environment) ?? "";
  const targets = ids(doc.pending);
  const digest = str(doc.gatePlanDigest) ?? str(doc.planDigest);
  const base = { source: SOURCE, environment, targets, detail: { command }, ...(digest ? { digest } : {}) };
  const refusal = (doc.refusal as { message?: unknown } | undefined)?.message;
  const deniedRules = Array.isArray(doc.policy) ? (doc.policy as Array<{ id?: string; outcome?: string }>).filter((r) => r.outcome === "denied").map((r) => r.id ?? "") : [];
  if (status === "gated") {
    const approve = str(doc.approve);
    const chant = str(doc.chantApprove);
    return {
      ...base,
      event: "waiting",
      status,
      summary: `${environment} is waiting for approval of ${digest ?? "its plan"} (${String(targets.length)} migration${targets.length === 1 ? "" : "s"})`,
      ...(approve ? { approve: { command: approve, ...(chant ? { chant } : {}) } } : {}),
    };
  }
  if (status === "refused" || status === "denied" || (command === "plan" && (refusal !== undefined || deniedRules.length > 0))) {
    const reason = typeof refusal === "string" ? refusal : deniedRules.length > 0 ? `policy rule ${deniedRules.join(", ")} denies the plan` : status === "refused" ? "refused" : "denied by policy";
    return { ...base, event: "refused", status: status ?? (refusal !== undefined ? "refused" : "denied"), summary: `${command} in ${environment} was refused: ${firstLine(reason)}`, reason };
  }
  if (status === "failed" || status === "incomplete") {
    const code = typeof doc.exitCode === "number" ? doc.exitCode : undefined;
    const reason = `${command} ${status}${code !== undefined ? ` (exit ${String(code)})` : ""}`;
    return {
      ...base,
      event: "failed",
      status,
      summary: `${command} in ${environment} ${status}${code !== undefined ? ` with exit ${String(code)}` : ""}`,
      reason,
      ...(code !== undefined ? { exitCode: code } : {}),
    };
  }
  return undefined;
}

/** The event for what `yodel drift --json` printed, or undefined when nothing drifted. */
export function eventFromDrift(doc: { environment?: string; drifted?: boolean; changed?: Array<{ name: string }>; missing?: string[]; fingerprint?: string }): YodelFields | undefined {
  if (!doc.drifted) return undefined;
  const changed = (doc.changed ?? []).map((c) => c.name);
  const missing = doc.missing ?? [];
  const environment = doc.environment ?? "";
  return {
    source: SOURCE,
    event: "drift",
    environment,
    status: "drifted",
    detail: { command: "drift" },
    summary: `${environment} drifted: ${[changed.length > 0 ? `${changed.join(", ")} changed` : "", missing.length > 0 ? `${missing.join(", ")} missing` : ""].filter(Boolean).join("; ")}`,
    drift: { changed, missing, ...(doc.fingerprint ? { fingerprint: doc.fingerprint } : {}) },
  };
}

/**
 * Sends the event to what `config` names, through chant's notify under
 * yodel's header names. Reads the URLs and the key from `env` at send time.
 * Never throws: each delivery's outcome is returned and a failed one is
 * written to `io.err`.
 */
export async function sendEvent(
  config: NotifyConfig | undefined,
  fields: YodelFields | undefined,
  options: { io: Io; verb: string; env?: NodeJS.ProcessEnv; fetch?: NotifyFetch; attempts?: number },
): Promise<NotifyDelivery[]> {
  if (!config || !fields) return [];
  const env = options.env ?? process.env;
  return sendNotify(config, makeNotifyEvent(fields, { env }), {
    env,
    prefix: HEADER_PREFIX,
    userAgent: SOURCE,
    log: (line) => {
      options.io.err(`yodel ${options.verb}: ${line}\n`);
    },
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.attempts !== undefined ? { attempts: options.attempts } : {}),
  });
}
