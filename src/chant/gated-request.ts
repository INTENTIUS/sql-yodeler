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
 * {@link gatedRequests} imports `@intentius/chant/lifecycle/gated-request`
 * on first use. The types below are the parts yodel reads.
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
  applied?: { approvedBy?: string; approvedAt?: string; timestamp?: string };
}

/** The parts of chant's `lifecycle/gated-request` yodel calls. */
export interface GatedRequestApi {
  requestGate(input: { op: string; request: GatedRequest; description?: string; rules: GatedRequestRules; base?: string; cwd?: string; now?: string }): Promise<RequestGateResult>;
  spendGatedRequest(input: { op: string; gate: string; digest: string; approval: Pick<GatedApproval, "resolvedBy" | "timestamp">; runId?: string; commit?: string; cwd?: string }): Promise<{ timestamp: string }>;
  finishGatedRequest(input: { op: string; gate: string; digest: string; applied: string; result: "applied" | "failed"; detail?: Record<string, string | number | boolean>; cwd?: string }): Promise<{ pushed: boolean; pushWarning?: string }>;
  readGatedRequests(op: string, location?: { cwd?: string }): Promise<GatedRequestRead[]>;
  gatedRequestDigest(op: string, request: GatedRequest): string;
}

let api: Promise<GatedRequestApi> | undefined;

/**
 * chant's gated-request API, once, or undefined when
 * `YODEL_GATED_REQUESTS=0` turns it off: the callers then keep their own
 * gate on the migrations Op, which a person working alone can approve.
 */
export function gatedRequests(env: NodeJS.ProcessEnv = process.env): Promise<GatedRequestApi | undefined> {
  if (env.YODEL_GATED_REQUESTS === "0") return Promise.resolve(undefined);
  api ??= import("@intentius/chant/lifecycle/gated-request").then((m) => m as unknown as GatedRequestApi);
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
  let applied: { timestamp: string };
  try {
    applied = await gated.spendGatedRequest({ op: at.op, gate, digest: approved.digest, approval: approved.approval, cwd: at.cwd });
  } catch (e) {
    const local = await spentWithoutRemote(gated, approved, at);
    if (!local) throw e;
    applied = local;
  }
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

/** The ledger's remote, as chant chooses it: a name, none at all, or unknown (git failed, or the setting names a remote the repository lacks). */
export type LedgerRemote = { remote: string } | null | "unknown";

/** {@link LedgerRemote} for the repository at `cwd`, without fetching or pushing. */
export async function ledgerRemoteOf(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<LedgerRemote> {
  const { execFile } = await import("node:child_process");
  const names = await new Promise<string[] | undefined>((resolve) => {
    execFile("git", ["remote"], { cwd, env: { ...env, LC_ALL: "C", LANGUAGE: "" } }, (err, stdout) => {
      resolve(err ? undefined : stdout.split("\n").map((n) => n.trim()).filter(Boolean));
    });
  });
  if (names === undefined) return "unknown";
  const specifier = "@intentius/chant/lifecycle/ledger-remote";
  let choose: ((names: readonly string[], env?: NodeJS.ProcessEnv) => { remote: string } | { failed: true } | null) | undefined;
  try {
    choose = ((await import(specifier)) as { chooseLedgerRemote?: typeof choose }).chooseLedgerRemote;
  } catch {
    choose = undefined;
  }
  if (!choose) return "unknown";
  const found = choose(names, env);
  if (found === null) return null;
  return "failed" in found ? "unknown" : found;
}

/**
 * The applied line chant wrote for `approved` when its spend threw only
 * because the ledger has no remote, else undefined.
 *
 * chant's `spendGatedRequest` (lifecycle/gated-request.ts, 0.124.67) throws
 * whenever the push did not land, and a checkout with no remote never
 * pushes, so a single-machine project could not apply under any gated
 * request. With no remote the local chant/lifecycle branch is the whole
 * ledger, and the spend recorded on it is complete. A push that failed or
 * that another writer beat still refuses: the remote is there, so this
 * answers undefined and the caller throws chant's error.
 */
export async function spentWithoutRemote(
  gated: GatedRequestApi,
  approved: Extract<RequestGateResult, { status: "approved" }>,
  at: { op: string; cwd: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ timestamp: string } | undefined> {
  if ((await ledgerRemoteOf(at.cwd, env)) !== null) return undefined;
  const gate = approved.request.subject;
  const read = await gated.readGatedRequests(at.op, { cwd: at.cwd }).catch(() => []);
  const line = read.find((r) => r.gate === gate && r.digest === approved.digest)?.applied;
  if (!line?.timestamp || line.approvedBy !== approved.approval.resolvedBy || line.approvedAt !== approved.approval.timestamp) return undefined;
  return { timestamp: line.timestamp };
}
