/**
 * Webhook events (#61). `notify` in yodel.config.ts names the environment
 * variables that hold a webhook's URL and its signing key (never the values
 * themselves); `yodel apply`, `yodel plan` and `yodel drift` post an event
 * when an environment is waiting for approval, when a run was refused or
 * failed, and when drift is found:
 *
 * ```ts
 * notify: { webhook: "YODEL_WEBHOOK_URL", key: "YODEL_WEBHOOK_KEY", slack: "SLACK_WEBHOOK_URL" }
 * ```
 *
 * The webhook gets the event as JSON, signed (`./verify.ts`); a Slack
 * incoming webhook, when `slack` names one, gets a line of text. A delivery
 * that fails is reported on stderr and never changes the command's exit
 * code: the event is news about the run, not part of it.
 */

import { randomUUID } from "node:crypto";
import type { Io } from "../command.js";
import { DELIVERY_HEADER, EVENT_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER, signWebhook } from "./verify.js";

export * from "./verify.js";

export const NOTIFY_EVENTS = ["waiting", "refused", "failed", "drift"] as const;
export type NotifyEventKind = (typeof NOTIFY_EVENTS)[number];

/** `notify` in yodel.config.ts. Each value is the NAME of an environment variable; the config never holds a URL or a key. */
export interface NotifyConfig {
  /** The variable holding the webhook's URL. */
  webhook?: string;
  /** The variable holding the key the webhook's events are signed with (HMAC-SHA256). Required with `webhook`. */
  key?: string;
  /** The variable holding a Slack incoming webhook's URL. Its messages are text and unsigned (Slack does not check a signature). */
  slack?: string;
  /** The events to send. Default: all of them. */
  events?: NotifyEventKind[];
}

/** What an event says. The JSON Schema is schemas/event.schema.json. */
export interface NotifyEvent {
  version: 1;
  /** Unique per event; the `x-yodel-delivery` header carries it too, so a receiver can drop a repeat. */
  id: string;
  event: NotifyEventKind;
  /** When yodel sent it, ISO 8601 UTC. */
  at: string;
  environment: string;
  /** The command that sent it. */
  command: "apply" | "plan" | "drift";
  /** The command's own word for the outcome (`gated`, `refused`, `denied`, `failed`, `drifted`). */
  status: string;
  /** One line a person can read. */
  summary: string;
  /** The migrations concerned: the pending ones for apply and plan. */
  migrations: string[];
  /** The plan digest the run computed, when it computed one. */
  digest?: string;
  /** The command that approves the plan, on `waiting`. */
  approve?: string;
  /** Why it was refused or failed: the refusal's message, the failing exit code. */
  reason?: string;
  /** drift: the objects changed and missing, and the drift's fingerprint (the same drift, the same fingerprint, run after run). */
  drift?: { changed: string[]; missing: string[]; fingerprint?: string };
  /** The CI run, when yodel runs in one (GitHub Actions, Forgejo Actions, GitLab CI). */
  runUrl?: string;
  /** The repository and commit, when CI says. */
  repository?: string;
  commit?: string;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Checks `notify` in yodel.config.ts; returns a message for the first problem, or undefined. */
export function notifyConfigProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "notify: expected { webhook, key, slack?, events? }";
  const v = value as Record<string, unknown>;
  for (const k of Object.keys(v)) if (!["webhook", "key", "slack", "events"].includes(k)) return `notify.${k}: unknown setting (expected webhook, key, slack, events)`;
  for (const k of ["webhook", "key", "slack"] as const) {
    const n = v[k];
    if (n === undefined) continue;
    if (typeof n !== "string" || n.includes("://") || !NAME.test(n)) {
      return `notify.${k}: the name of the environment variable that holds the ${k === "key" ? "signing key" : "URL"} (such as ${k === "key" ? "YODEL_WEBHOOK_KEY" : k === "slack" ? "SLACK_WEBHOOK_URL" : "YODEL_WEBHOOK_URL"}), never the ${k === "key" ? "key" : "URL"} itself`;
    }
  }
  if (v.webhook !== undefined && v.key === undefined) return "notify.key: a webhook needs a signing key; name the variable that holds it";
  if (v.key !== undefined && v.webhook === undefined) return "notify.webhook: a key is for a webhook; name the variable that holds its URL";
  if (v.webhook === undefined && v.slack === undefined) return "notify: name a webhook (with its key) or a slack URL variable";
  if (v.events !== undefined && !(Array.isArray(v.events) && v.events.every((e) => (NOTIFY_EVENTS as readonly unknown[]).includes(e)))) {
    return `notify.events: a list of ${NOTIFY_EVENTS.join(", ")}`;
  }
  return undefined;
}

/** Where the CI run is, when yodel runs in one. */
export function ciContext(env: NodeJS.ProcessEnv): Pick<NotifyEvent, "runUrl" | "repository" | "commit"> {
  const out: Pick<NotifyEvent, "runUrl" | "repository" | "commit"> = {};
  if (env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID) out.runUrl = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  else if (env.CI_JOB_URL) out.runUrl = env.CI_JOB_URL;
  else if (env.CI_PIPELINE_URL) out.runUrl = env.CI_PIPELINE_URL;
  const repository = env.GITHUB_REPOSITORY ?? env.CI_PROJECT_PATH;
  if (repository) out.repository = repository;
  const commit = env.GITHUB_SHA ?? env.CI_COMMIT_SHA;
  if (commit) out.commit = commit;
  return out;
}

const ids = (list: unknown): string[] => (Array.isArray(list) ? list.flatMap((p) => (typeof p === "object" && p !== null && typeof (p as { id?: unknown }).id === "string" ? [(p as { id: string }).id] : [])) : []);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const firstLine = (s: string): string => s.split("\n")[0] ?? s;

type Fields = Omit<NotifyEvent, "version" | "id" | "at" | "runUrl" | "repository" | "commit">;

/**
 * The event for what `yodel apply --json` (or `yodel plan --json`) printed,
 * or undefined when the outcome is not one an event is sent for.
 */
export function eventFromRun(command: "apply" | "plan", doc: Record<string, unknown>): Fields | undefined {
  const status = str(doc.status) ?? (doc.refusal ? "refused" : undefined);
  const environment = str(doc.environment) ?? "";
  const migrations = ids(doc.pending);
  const digest = str(doc.gatePlanDigest) ?? str(doc.planDigest);
  const base = { environment, command, migrations, ...(digest ? { digest } : {}) };
  const refusal = (doc.refusal as { message?: unknown } | undefined)?.message;
  const deniedRules = Array.isArray(doc.policy) ? (doc.policy as Array<{ id?: string; outcome?: string }>).filter((r) => r.outcome === "denied").map((r) => r.id ?? "") : [];
  if (status === "gated") {
    const approve = str(doc.approve);
    return { ...base, event: "waiting", status, summary: `${environment} is waiting for approval of ${digest ?? "its plan"} (${String(migrations.length)} migration${migrations.length === 1 ? "" : "s"})`, ...(approve ? { approve } : {}) };
  }
  if (status === "refused" || status === "denied" || (command === "plan" && (refusal !== undefined || deniedRules.length > 0))) {
    const reason = typeof refusal === "string" ? refusal : deniedRules.length > 0 ? `policy rule ${deniedRules.join(", ")} denies the plan` : status === "refused" ? "refused" : "denied by policy";
    return { ...base, event: "refused", status: status ?? (refusal !== undefined ? "refused" : "denied"), summary: `${command} in ${environment} was refused: ${firstLine(reason)}`, reason };
  }
  if (status === "failed" || status === "incomplete") {
    const code = typeof doc.exitCode === "number" ? doc.exitCode : undefined;
    const reason = `${command} ${status}${code !== undefined ? ` (exit ${String(code)})` : ""}`;
    return { ...base, event: "failed", status, summary: `${command} in ${environment} ${status}${code !== undefined ? ` with exit ${String(code)}` : ""}`, reason };
  }
  return undefined;
}

/** The event for what `yodel drift --json` printed, or undefined when nothing drifted. */
export function eventFromDrift(doc: { environment?: string; drifted?: boolean; changed?: Array<{ name: string }>; missing?: string[]; fingerprint?: string }): Fields | undefined {
  if (!doc.drifted) return undefined;
  const changed = (doc.changed ?? []).map((c) => c.name);
  const missing = doc.missing ?? [];
  const environment = doc.environment ?? "";
  return {
    event: "drift",
    environment,
    command: "drift",
    status: "drifted",
    migrations: [],
    summary: `${environment} drifted: ${[changed.length > 0 ? `${changed.join(", ")} changed` : "", missing.length > 0 ? `${missing.join(", ")} missing` : ""].filter(Boolean).join("; ")}`,
    drift: { changed, missing, ...(doc.fingerprint ? { fingerprint: doc.fingerprint } : {}) },
  };
}

/** A whole event: the fields, with its id, time and the CI run. */
export function makeEvent(fields: Fields, env: NodeJS.ProcessEnv = process.env, now = new Date()): NotifyEvent {
  return { version: 1, id: randomUUID(), at: now.toISOString(), ...fields, ...ciContext(env) };
}

/** The Slack message for an event: one line of text, with the approve command and the run on `waiting`. */
export function slackMessage(e: NotifyEvent): { text: string } {
  const lines = [`yodel ${e.event}: ${e.summary}`];
  if (e.approve) lines.push(`Approve with: \`${e.approve}\``);
  if (e.runUrl) lines.push(`Run: ${e.runUrl}`);
  return { text: lines.join("\n") };
}

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

export interface Delivery {
  target: "webhook" | "slack";
  ok: boolean;
  /** The HTTP status, or why there was none. */
  detail: string;
}

/** The request that delivers `event` to the webhook, signed with `key`. */
export function webhookRequest(event: NotifyEvent, key: string, now = Math.floor(Date.now() / 1000)): { headers: Record<string, string>; body: string } {
  const body = JSON.stringify(event);
  return {
    body,
    headers: {
      "content-type": "application/json",
      "user-agent": "sql-yodeler",
      [EVENT_HEADER]: event.event,
      [DELIVERY_HEADER]: event.id,
      [TIMESTAMP_HEADER]: String(now),
      [SIGNATURE_HEADER]: signWebhook(key, now, body),
    },
  };
}

async function post(fetchFn: Fetch, url: string, request: { headers: Record<string, string>; body: string }, attempts: number): Promise<string | undefined> {
  let last = "";
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 500 * i));
    try {
      const res = await fetchFn(url, { method: "POST", ...request, signal: AbortSignal.timeout(10_000) });
      if (res.ok) return undefined;
      last = `HTTP ${String(res.status)}`;
      // A 4xx will not change on a retry: the receiver refused the event (a signature it does not accept, say).
      if (res.status < 500) return last;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
  }
  return last;
}

/**
 * Sends the event to what `config` names. Reads the URLs and the key from
 * `env` at send time. Never throws: each delivery's outcome is returned and
 * a failed one is written to `io.err`.
 */
export async function sendEvent(
  config: NotifyConfig | undefined,
  fields: Fields | undefined,
  options: { io: Io; verb: string; env?: NodeJS.ProcessEnv; fetch?: Fetch; attempts?: number },
): Promise<Delivery[]> {
  if (!config || !fields) return [];
  if (config.events && !config.events.includes(fields.event)) return [];
  const env = options.env ?? process.env;
  const fetchFn = options.fetch ?? globalThis.fetch;
  const attempts = options.attempts ?? 3;
  const event = makeEvent(fields, env);
  const out: Delivery[] = [];
  const warn = (d: Delivery) => {
    options.io.err(`yodel ${options.verb}: notify: the ${fields.event} event was not delivered to the ${d.target}: ${d.detail}\n`);
  };
  if (config.webhook) {
    const url = env[config.webhook];
    const key = config.key ? env[config.key] : undefined;
    let d: Delivery;
    if (!url) d = { target: "webhook", ok: false, detail: `${config.webhook} is not set` };
    else if (!key) d = { target: "webhook", ok: false, detail: `${config.key ?? "the key variable"} is not set, and yodel does not send an unsigned event` };
    else {
      const failed = await post(fetchFn, url, webhookRequest(event, key), attempts);
      d = { target: "webhook", ok: failed === undefined, detail: failed ?? "delivered" };
    }
    if (!d.ok) warn(d);
    out.push(d);
  }
  if (config.slack) {
    const url = env[config.slack];
    let d: Delivery;
    if (!url) d = { target: "slack", ok: false, detail: `${config.slack} is not set` };
    else {
      const failed = await post(fetchFn, url, { headers: { "content-type": "application/json" }, body: JSON.stringify(slackMessage(event)) }, attempts);
      d = { target: "slack", ok: failed === undefined, detail: failed ?? "delivered" };
    }
    if (!d.ok) warn(d);
    out.push(d);
  }
  return out;
}
