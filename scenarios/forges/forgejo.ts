/**
 * The forge claim's forge: the Forgejo of chant's e2e harness
 * (INTENTIUS/chant#4587; its compose project with the sql profile), whose
 * runner puts job containers on the project network, where the sql
 * emulator answers as `clickhouse` and `postgres`. Its Actions run
 * .forgejo/workflows on each push and pull request. The defaults are the
 * harness's own (HARNESS_PORTS and HARNESS_HOSTS in
 * @intentius/chant/e2e-harness), written here so the claim runs on a chant
 * without the harness too.
 *
 *   YODEL_CLAIMS_FORGEJO_URL        default http://localhost:3391
 *   YODEL_CLAIMS_FORGEJO_USER       default yodel34
 *   YODEL_CLAIMS_FORGEJO_PASSWORD   required: without it the claim fails (--skip forge skips it)
 *   YODEL_CLAIMS_FORGEJO_CLICKHOUSE_URL  the emulator as a job sees it, default http://clickhouse:8123
 *   YODEL_CLAIMS_FORGEJO_POSTGRES_URL    default postgres://postgres:chant@postgres:5432/postgres
 *
 * With chant's harness installed, the forge, waves and approval claims also
 * run as the scenarios in scenarios/harness/, which record the rows
 * docs/claims.md cites.
 */

import type { Ctx } from "../lib/claim.js";
import type { Forge, ForgeIssue, ForgeRepo, ForgeRun } from "./forge.js";

/** chant's harness: Forgejo's host port, and the servers as a job on the project network reaches them. */
const HARNESS_FORGEJO = "http://localhost:3391";
const HARNESS_JOB_CLICKHOUSE = "http://clickhouse:8123";
const HARNESS_JOB_POSTGRES = "postgres://postgres:chant@postgres:5432/postgres";

export const forgejo = {
  url: (process.env.YODEL_CLAIMS_FORGEJO_URL ?? HARNESS_FORGEJO).replace(/\/+$/, ""),
  user: process.env.YODEL_CLAIMS_FORGEJO_USER ?? "yodel34",
  password: process.env.YODEL_CLAIMS_FORGEJO_PASSWORD ?? "",
};

const auth = () => `Basic ${Buffer.from(`${forgejo.user}:${forgejo.password}`).toString("base64")}`;

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names the response's shape
async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`${forgejo.url}/api/v1${path}`, {
    method,
    headers: { Authorization: auth(), "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  const parsed = (): unknown => {
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return text;
    }
  };
  return { status: res.status, json: parsed() as T };
}

interface RunDoc {
  id: number;
  event: string;
  status: string;
  head_sha: string;
}

type Job = { id: number; name: string; status: string };

async function jobs(repo: string, runId: number): Promise<Job[]> {
  const { json } = await api<Job[] | { jobs?: Job[] }>("GET", `/repos/${repo}/actions/runs/${String(runId)}/jobs`);
  return Array.isArray(json) ? json : (json.jobs ?? []);
}

const FINISHED = ["success", "failure", "cancelled", "skipped"];

/**
 * A run's jobs once every one has finished. Forgejo marks a run failed as
 * soon as one job fails, while the others may still be running, so a log
 * read then misses their ends.
 */
async function finishedJobs(repo: string, runId: number): Promise<Job[]> {
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    const all = await jobs(repo, runId);
    if (all.every((j) => FINISHED.includes(j.status)) || Date.now() > deadline) return all;
    await new Promise((res) => setTimeout(res, 3_000));
  }
}

async function jobText(repo: string, jobId: number): Promise<string> {
  const res = await fetch(`${forgejo.url}/api/v1/repos/${repo}/actions/jobs/${String(jobId)}/logs`, { headers: { Authorization: auth() } });
  return res.text();
}

/** Prints the failed jobs' last lines: the steps' output, without the checkout's clean-up after them. */
async function printLogs(ctx: Ctx, repo: string, runId: number): Promise<void> {
  for (const job of await jobs(repo, runId)) {
    if (job.status === "success") continue;
    const lines = (await jobText(repo, job.id)).trimEnd().split("\n");
    const cut = lines.findIndex((l) => /Post https:\/\/code\.forgejo\.org\/actions\/checkout/.test(l) || /Post actions\/checkout/.test(l));
    ctx.log(`job ${job.name} (${job.status}), its last lines:\n${lines.slice(0, cut > 0 ? cut : undefined).slice(-30).join("\n")}`);
  }
}

/** The highest run id on `sha` so far, so a wait for the next run of a workflow already run there skips the old ones. */
async function lastRunId(repo: string, sha: string): Promise<number> {
  const { json } = await api<{ workflow_runs?: RunDoc[] }>("GET", `/repos/${repo}/actions/runs?head_sha=${sha}`);
  return Math.max(0, ...(json.workflow_runs ?? []).map((r) => r.id));
}

/**
 * Waits for the newest run of `event` on `sha` (with an id above `after`) to
 * finish; prints its failed jobs' logs. With `startWithinMs`, undefined when
 * no such run has started by then.
 */
async function waitRun(ctx: Ctx, repo: string, sha: string, event: string, after?: number): Promise<ForgeRun>;
async function waitRun(ctx: Ctx, repo: string, sha: string, event: string, after: number, startWithinMs: number): Promise<ForgeRun | undefined>;
async function waitRun(ctx: Ctx, repo: string, sha: string, event: string, after = 0, startWithinMs?: number): Promise<ForgeRun | undefined> {
  const deadline = Date.now() + 20 * 60_000;
  const startBy = startWithinMs === undefined ? undefined : Date.now() + startWithinMs;
  let last = "";
  for (;;) {
    const { json } = await api<{ workflow_runs?: RunDoc[] }>("GET", `/repos/${repo}/actions/runs?head_sha=${sha}`);
    const runs = (json.workflow_runs ?? []).filter((r) => r.id > after && (r.event === event || (event === "workflow_dispatch" && r.event === ""))).sort((a, b) => b.id - a.id);
    const r = runs[0];
    const state = r ? `run ${String(r.id)} ${r.status}` : "no run yet";
    if (state !== last) ctx.log(`${event} on ${sha.slice(0, 8)}: ${state}`);
    else process.stdout.write(".\n");
    last = state;
    if (!r && startBy !== undefined && Date.now() > startBy) return undefined;
    if (r && ["success", "failure", "cancelled", "skipped"].includes(r.status)) {
      const all = await finishedJobs(repo, r.id);
      if (r.status !== "success") await printLogs(ctx, repo, r.id);
      let log = "";
      for (const job of all) log += await jobText(repo, job.id);
      return { ok: r.status === "success", status: r.status, log, failed: all.filter((j) => j.status !== "success").map((j) => j.name), id: r.id };
    }
    if (Date.now() > deadline) throw new Error(`no finished ${event} run for ${sha} after 20 minutes (${state})`);
    await new Promise((res) => setTimeout(res, 5_000));
  }
}

/**
 * Waits for every run of `event` on `sha` (a pull request's workflows) to
 * finish, and joins them: ok when every one succeeded.
 */
async function waitAll(ctx: Ctx, repo: string, sha: string, event: string): Promise<ForgeRun> {
  const first = await waitRun(ctx, repo, sha, event);
  const deadline = Date.now() + 20 * 60_000;
  for (;;) {
    const { json } = await api<{ workflow_runs?: RunDoc[] }>("GET", `/repos/${repo}/actions/runs?head_sha=${sha}`);
    const runs = (json.workflow_runs ?? []).filter((r) => r.event === event);
    if (runs.every((r) => ["success", "failure", "cancelled", "skipped"].includes(r.status))) {
      if (runs.length <= 1) return first;
      let log = "";
      const failedJobs: string[] = [];
      for (const r of runs) {
        const all = await finishedJobs(repo, r.id);
        if (r.status !== "success") await printLogs(ctx, repo, r.id);
        for (const job of all) {
          log += await jobText(repo, job.id);
          if (job.status !== "success") failedJobs.push(job.name);
        }
      }
      const failed = runs.filter((r) => r.status !== "success");
      return { ok: failed.length === 0, status: failed.length === 0 ? "success" : failed.map((r) => `run ${String(r.id)} ${r.status}`).join(", "), log, failed: failedJobs };
    }
    if (Date.now() > deadline) throw new Error(`the ${event} runs on ${sha} did not all finish in 20 minutes`);
    await new Promise((res) => setTimeout(res, 5_000));
  }
}

export function forgejoForge(): Forge {
  return {
    name: "Forgejo",
    jobUrl: (d) => (d === "ch" ? (process.env.YODEL_CLAIMS_FORGEJO_CLICKHOUSE_URL ?? HARNESS_JOB_CLICKHOUSE) : (process.env.YODEL_CLAIMS_FORGEJO_POSTGRES_URL ?? HARNESS_JOB_POSTGRES)),
    async repo(ctx, name, secrets): Promise<ForgeRepo> {
      if (!forgejo.password) throw new Error("YODEL_CLAIMS_FORGEJO_PASSWORD is not set; the forge claim needs the local Forgejo");
      const repo = `${forgejo.user}/${name}`;
      await api("DELETE", `/repos/${repo}`);
      const made = await api("POST", "/user/repos", { name, private: false, auto_init: false });
      if (made.status !== 201) throw new Error(`creating ${repo}: ${String(made.status)} ${JSON.stringify(made.json)}`);
      await api("PATCH", `/repos/${repo}`, { has_actions: true });
      for (const [k, v] of Object.entries(secrets)) {
        const put = await api("PUT", `/repos/${repo}/actions/secrets/${k}`, { data: v });
        if (put.status >= 300) throw new Error(`setting secret ${k}: ${String(put.status)}`);
      }
      return {
        remote: `${forgejo.url.replace("://", `://${encodeURIComponent(forgejo.user)}:${encodeURIComponent(forgejo.password)}@`)}/${repo}.git`,
        pushed: (sha) => waitRun(ctx, repo, sha, "push"),
        async applyAgain(sha) {
          // A dispatch again on the same commit: wait for the run after the ones already there.
          const after = await lastRunId(repo, sha);
          const dispatched = await api("POST", `/repos/${repo}/actions/workflows/yodel-apply.yml/dispatches`, { ref: "main" });
          if (dispatched.status >= 300) throw new Error(`dispatching yodel-apply: ${String(dispatched.status)} ${JSON.stringify(dispatched.json)}`);
          return waitRun(ctx, repo, sha, "workflow_dispatch", after);
        },
        async openPr(head, sha, title) {
          const pr = await api<{ number: number }>("POST", `/repos/${repo}/pulls`, { title, head, base: "main" });
          if (pr.status !== 201) throw new Error(`opening the pull request: ${String(pr.status)}`);
          // Every pull request workflow.
          return { id: pr.json.number, checks: await waitAll(ctx, repo, sha, "pull_request") };
        },
        async comments(id) {
          const { json } = await api<Array<{ body: string }>>("GET", `/repos/${repo}/issues/${String(id)}/comments`);
          return json.map((c) => c.body);
        },
        async merge(id) {
          const merged = await api("POST", `/repos/${repo}/pulls/${String(id)}/merge`, { Do: "merge" });
          if (merged.status >= 300) throw new Error(`merging: ${String(merged.status)} ${JSON.stringify(merged.json)}`);
          const { json: branch } = await api<{ commit: { id: string } }>("GET", `/repos/${repo}/branches/main`);
          return branch.commit.id;
        },
        async watch(sha) {
          const after = await lastRunId(repo, sha);
          const dispatched = await api("POST", `/repos/${repo}/actions/workflows/watch-dev.yml/dispatches`, { ref: "main" });
          if (dispatched.status >= 300) throw new Error(`dispatching watch-dev: ${String(dispatched.status)} ${JSON.stringify(dispatched.json)}`);
          return waitRun(ctx, repo, sha, "workflow_dispatch", after);
        },
        async issues(): Promise<ForgeIssue[]> {
          const { json } = await api<Array<{ number: number; title: string; body: string; state: string }>>("GET", `/repos/${repo}/issues?state=all&type=issues&limit=50`);
          return json.map((i) => ({ number: i.number, title: i.title, body: i.body, open: i.state === "open" }));
        },
      };
    },
    close: () => Promise.resolve(),
  };
}
