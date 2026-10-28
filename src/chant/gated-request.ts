/**
 * chant's gated requests (chant#4551, #292): a request that is not a
 * migration apply, such as `yodel cleanup`'s drop or `yodel init
 * --baseline`'s record, asked for, approved, spent and finished on chant's
 * gate ledger. chant writes every line: the pending fact in
 * `_gates/<op>.jsonl` (its `gate` the request's subject, its `planDigest`
 * chant's `gatedRequestDigest` of the request), and the `applied` and
 * `finished` lines in `_gates/<op>/applied.jsonl`. `chant ledger gates` and
 * `chant query` read them.
 *
 * The installed chant has them from chant 0.124.55.
 * {@link gatedRequests} imports `@intentius/chant/lifecycle/gated-request`
 * lazily, with the specifier in a variable, so this compiles and runs on a
 * published chant without it: the callers then keep their own gate on the
 * migrations Op, as before. The types below are the parts yodel reads,
 * written out here for the same reason.
 *
 * A requester's own approval never counts (chant's rule for every gated
 * request). The requester is the user chant names an approver by:
 * `GITHUB_ACTOR`, else `GITLAB_USER_LOGIN`, else `USER`.
 */

/** One request, as chant digests it. */
export interface GatedRequest {
  kind: string;
  /** What it is asked of, and the gate it waits at. */
  subject: string;
  by: string;
  at: string;
  fields: Record<string, string>;
}

/** Which approvals count: the environment's approval mode. */
export interface GatedRequestRules {
  mode: "ledger" | "sealed" | "pr-review";
}

/** The approval a request spent, as chant's ledger holds it. */
export interface GatedApproval {
  resolvedBy: string;
  timestamp: string;
  signer?: string;
}

export type RequestGateResult =
  | { status: "approved"; digest: string; request: GatedRequest; approval: GatedApproval }
  | { status: "waiting"; digest: string; request: GatedRequest; command: string }
  | { status: "refused"; digest: string; request: GatedRequest; by: string; reason: string; command: string }
  | { status: "spent"; digest: string; request: GatedRequest };

export interface GatedRequestRead {
  op: string;
  gate: string;
  digest: string;
  request: GatedRequest;
  applied?: unknown;
}

/** The parts of chant's `lifecycle/gated-request` yodel calls. */
export interface GatedRequestApi {
  requestGate(input: { op: string; request: GatedRequest; description?: string; rules: GatedRequestRules; base?: string; cwd?: string; now?: string }): Promise<RequestGateResult>;
  spendGatedRequest(input: { op: string; gate: string; digest: string; approval: Pick<GatedApproval, "resolvedBy" | "timestamp">; runId?: string; commit?: string; cwd?: string }): Promise<{ timestamp: string }>;
  finishGatedRequest(input: { op: string; gate: string; digest: string; applied: string; result: "applied" | "failed"; detail?: Record<string, string | number | boolean>; cwd?: string }): Promise<{ pushed: boolean; pushWarning?: string }>;
  readGatedRequests(op: string, location?: { cwd?: string }): Promise<GatedRequestRead[]>;
  gatedRequestDigest(op: string, request: GatedRequest): string;
}

let api: Promise<GatedRequestApi | undefined> | undefined;

/**
 * chant's gated-request API, once, or undefined when the installed chant has
 * none. `YODEL_GATED_REQUESTS=0` turns it off, so a project can keep the old
 * gate names until every machine that approves runs a chant with them.
 */
export function gatedRequests(env: NodeJS.ProcessEnv = process.env): Promise<GatedRequestApi | undefined> {
  if (env.YODEL_GATED_REQUESTS === "0") return Promise.resolve(undefined);
  api ??= (async () => {
    const specifier = "@intentius/chant/lifecycle/gated-request";
    let m: Partial<GatedRequestApi> | undefined;
    try {
      m = (await import(specifier)) as Partial<GatedRequestApi>;
    } catch {
      return undefined;
    }
    const all: Array<keyof GatedRequestApi> = ["requestGate", "spendGatedRequest", "finishGatedRequest", "readGatedRequests", "gatedRequestDigest"];
    return all.every((k) => typeof m[k] === "function") ? (m as GatedRequestApi) : undefined;
  })();
  return api;
}

/** The requester, named as chant names an approver. */
export function requester(env: NodeJS.ProcessEnv = process.env): string {
  return env.GITHUB_ACTOR || env.GITLAB_USER_LOGIN || env.USER || "unknown";
}

const sameFields = (a: Record<string, string>, b: Record<string, string>): boolean =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k] === v);

/** What {@link askGatedRequest} asks for. */
export interface AskGatedRequest {
  op: string;
  kind: string;
  subject: string;
  fields: Record<string, string>;
  description: string;
  rules: GatedRequestRules;
  /** The commit the approval mode was read at. */
  base?: string | undefined;
  cwd: string;
  by?: string;
  now?: string;
}

/**
 * Ask for the request, or read its approval. A request with the same kind,
 * subject, requester and fields that has not applied keeps its first `at`,
 * so asking again digests the same and finds the approval recorded for it.
 */
export async function askGatedRequest(gated: GatedRequestApi, a: AskGatedRequest): Promise<RequestGateResult> {
  const by = a.by ?? requester();
  const standing = (await gated.readGatedRequests(a.op, { cwd: a.cwd }).catch(() => []))
    .filter((r) => r.applied === undefined && r.request.kind === a.kind && r.request.subject === a.subject && r.request.by === by && sameFields(r.request.fields, a.fields))
    .at(-1);
  const request: GatedRequest = { kind: a.kind, subject: a.subject, by, at: standing?.request.at ?? a.now ?? new Date().toISOString(), fields: a.fields };
  return gated.requestGate({
    op: a.op,
    request,
    rules: a.rules,
    description: a.description,
    cwd: a.cwd,
    ...(a.base ? { base: a.base } : {}),
    ...(a.now ? { now: a.now } : {}),
  });
}

/**
 * Spend the approval, run `act`, and record how it ended. The applied line
 * is pushed before `act` runs, so two runs never act on one approval; a
 * throw from `act` finishes the request `failed` and is thrown again.
 */
export async function spendAndAct<T>(
  gated: GatedRequestApi,
  approved: Extract<RequestGateResult, { status: "approved" }>,
  at: { op: string; cwd: string },
  act: () => Promise<{ result: T; detail: Record<string, string | number | boolean> }>,
): Promise<{ result: T; pushWarning?: string }> {
  const gate = approved.request.subject;
  const applied = await gated.spendGatedRequest({ op: at.op, gate, digest: approved.digest, approval: approved.approval, cwd: at.cwd });
  let done: { result: T; detail: Record<string, string | number | boolean> };
  try {
    done = await act();
  } catch (e) {
    const error = (e instanceof Error ? e.message : String(e)).slice(0, 2000);
    await gated.finishGatedRequest({ op: at.op, gate, digest: approved.digest, applied: applied.timestamp, result: "failed", detail: { error }, cwd: at.cwd }).catch(() => undefined);
    throw e;
  }
  const finished = await gated.finishGatedRequest({ op: at.op, gate, digest: approved.digest, applied: applied.timestamp, result: "applied", detail: done.detail, cwd: at.cwd });
  return { result: done.result, ...(finished.pushWarning ? { pushWarning: finished.pushWarning } : {}) };
}
