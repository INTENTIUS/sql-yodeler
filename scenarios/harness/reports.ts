/**
 * The harness's report bucket for yodel's pipelines (INTENTIUS/sql-yodeler#302).
 *
 * chant's harness reads a step's outcome from chant's pull request reports,
 * `pr-plan.json` and `pr-apply.json` under the scenario's report URL, and
 * from the run ledger. yodel's pipelines write neither report yet: the plan
 * job posts yodel's plan comment, and the apply waves record their runs on
 * chant/lifecycle (op `yodel-apply`, each record's `wave` field, chant#4551).
 * Until the plan job's note goes through chant's renderer (#290) and the
 * jobs write chant's reports, this bucket answers the two reports from what
 * yodel's jobs do write, so the driver's plan, approve and apply steps work
 * unchanged:
 *
 * - pr-plan.json of pull request N at commit C: once every commit status
 *   on C is final and the plan comment is there, a report whose members are
 *   the pull request's jobs (lint, plan-dev, the project's own), each
 *   passed or failed, with status planned when all passed and failed
 *   otherwise. op, gate and digest come from the comment: the digest after
 *   "Plan digest the apply gate binds:", the gate from the approve command
 *   it gives (wave 1 when it gives yodel's own line).
 * - pr-apply.json at merge commit C: the newest `yodel-apply` wave run of
 *   each wave on C, applied, gated or failed; a wave after a gated or failed
 *   one is blocked. The status is failed when a wave failed, gated when one
 *   waits, applied when every wave applied. Nothing is answered before the
 *   first wave has a run on C.
 *
 * Each read is the forge's or the ledger's own record, never a job's log.
 */

import type { ReportView, RunRecordView } from "./harness.js";

/** A commit status on the forge: its context (`<workflow> / <job> (<event>)` on Forgejo) and state. */
export interface CommitStatus {
  context: string;
  state: string;
}

/** What the bucket reads, behind ports so tests use fakes. */
export interface ReportSources {
  /** The bodies of the pull request's comments, oldest first. */
  comments(pull: number): Promise<string[]>;
  /** The commit statuses on `sha`. */
  statuses(sha: string): Promise<CommitStatus[]>;
  /** The run ledger's `op` records under `env`. */
  runs(env: string, op: string): Promise<RunRecordView[]>;
}

/** The op yodel's apply waves record their runs under, and its gates (`yodel-apply-wave-<k>`). */
export const WAVES_OP = "yodel-apply";
/** The environment the waves' run records are under: the spec names no labels.Env (src/report/model.ts WAVE_RUNS_ENV). */
export const WAVES_ENV = "local";

const PENDING = new Set(["pending", "running", "waiting", "queued", "blocked"]);

/** The job a Forgejo status context names: `yodel-pr / lint (pull_request)` is lint. */
export function jobOf(context: string): string {
  const m = /\/\s*([^/]+?)\s*\([^)]*\)\s*$/.exec(context) ?? /\/\s*([^/]+?)\s*$/.exec(context);
  return (m?.[1] ?? context).trim();
}

/** The digest and the gate a plan comment gives. */
export function readPlanComment(body: string): { digest: string; op: string; gate: string } | undefined {
  const digest = /Plan digest the apply gate binds: `(jcs1-sha256:[0-9a-f]{64})`/.exec(body)?.[1];
  if (!digest) return undefined;
  const chantLine = /chant approve (\S+) (\S+) --plan jcs1-sha256:[0-9a-f]{64}/.exec(body);
  return { digest, op: chantLine?.[1] ?? WAVES_OP, gate: chantLine?.[2] ?? `${WAVES_OP}-wave-1` };
}

/** The plan comment of `env` among a pull request's comments: the newest that starts with its marker. */
export function planComment(bodies: readonly string[], env: string): string | undefined {
  return [...bodies].reverse().find((b) => b.startsWith(`<!-- yodel:plan env=${env} -->`));
}

/** pr-plan.json for pull request `pr` at `head`, or null while a status is not final or the comment is not there. */
export function planReport(pr: number, head: string, statuses: readonly CommitStatus[], comment: string | undefined): ReportView | null {
  if (statuses.length === 0 || statuses.some((s) => PENDING.has(s.state))) return null;
  const members = statuses.map((s) => {
    const job = jobOf(s.context);
    return { member: job, component: job, status: s.state === "success" ? "passed" : "failed" };
  });
  const failed = members.some((m) => m.status === "failed");
  const read = comment === undefined ? undefined : readPlanComment(comment);
  // A plan job that passed always comments; with every job passed and no comment yet, the comment is still on its way.
  if (!failed && !read) return null;
  return {
    stage: "plan",
    pr,
    head,
    op: read?.op ?? WAVES_OP,
    gate: read?.gate ?? `${WAVES_OP}-wave-1`,
    digest: read?.digest ?? "",
    status: failed ? "failed" : "planned",
    selection: { waves: [] },
    members,
  };
}

const waveStatus = (r: RunRecordView): string => (r.status === "ok" ? "applied" : r.status === "fail" ? "failed" : "gated");

/** pr-apply.json for the merge of pull request `pr` at `commit`, from the waves' run records; null before wave 1 has a run on it. */
export function applyReport(pr: number | null, commit: string, waves: readonly string[], records: readonly RunRecordView[]): ReportView | null {
  const newest = new Map<string, RunRecordView>();
  for (const r of records) {
    if (r.op !== WAVES_OP || r.gitSha !== commit || !r.wave) continue;
    const had = newest.get(r.wave.name);
    if (!had || had.ended < r.ended) newest.set(r.wave.name, r);
  }
  const first = waves[0];
  if (first === undefined || !newest.has(first)) return null;
  let stopped = false;
  const members = waves.map((w) => {
    const r = newest.get(w);
    const status = stopped || !r ? "blocked" : waveStatus(r);
    if (status !== "applied") stopped = true;
    return { member: w, component: w, status };
  });
  const status = members.some((m) => m.status === "failed") ? "failed" : members.some((m) => m.status === "gated") ? "gated" : members.every((m) => m.status === "applied") ? "applied" : "blocked";
  const waiting = members.findIndex((m) => m.status === "gated");
  return {
    stage: "apply",
    pr,
    head: commit,
    op: WAVES_OP,
    gate: `${WAVES_OP}-wave-${String(waiting >= 0 ? waiting + 1 : 1)}`,
    digest: "",
    status,
    selection: { waves: waves.map((w) => [w]) },
    members,
  };
}

/** `<prefix>/<pr>/<commit>/pr-<stage>.json`, as chant's reportKey writes it ("main" for a run with no pull request). */
export function parseReportKey(key: string): { pr: number | null; commit: string; stage: "plan" | "apply" } | undefined {
  const m = /(?:^|\/)([^/]+)\/([0-9a-f]{7,64})\/pr-(plan|apply)\.json$/.exec(key);
  if (!m?.[1] || !m[2]) return undefined;
  const pr = /^\d+$/.test(m[1]) ? Number(m[1]) : null;
  return { pr, commit: m[2], stage: m[3] === "plan" ? "plan" : "apply" };
}

/**
 * The bucket port the harness's driver reads reports from (chant ports.ts
 * Bucket), answering from {@link ReportSources}. It is read only: nothing
 * in a yodel scenario puts reports.
 */
export class YodelReports {
  /** `waves` in order, as yodel.config.ts gives them; the first one's plan comment carries the digest. */
  constructor(
    private readonly sources: ReportSources,
    private readonly waves: readonly string[],
  ) {}

  async get(key: string): Promise<string | null> {
    const k = parseReportKey(key);
    if (!k) return null;
    let report: ReportView | null;
    if (k.stage === "plan") {
      if (k.pr === null) return null;
      const comment = planComment(await this.sources.comments(k.pr), this.waves[0] ?? "dev");
      report = planReport(k.pr, k.commit, await this.sources.statuses(k.commit), comment);
    } else {
      report = applyReport(k.pr, k.commit, this.waves, await this.sources.runs(WAVES_ENV, WAVES_OP));
    }
    return report === null ? null : JSON.stringify(report);
  }

  put(): Promise<void> {
    return Promise.reject(new Error("a yodel scenario's report bucket is read only"));
  }

  list(): Promise<string[]> {
    return Promise.resolve([]);
  }

  delete(): Promise<void> {
    return Promise.resolve();
  }
}
