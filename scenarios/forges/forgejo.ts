/**
 * The template claim's forge: a local Forgejo (the one terragucci's stack
 * runs at http://localhost:3300, whose runner puts job containers on the
 * network where the emulator answers as `clickhouse` and `pgdb`). Its
 * Actions run .forgejo/workflows on each push and pull request.
 *
 *   YODEL_CLAIMS_FORGEJO_URL        default http://localhost:3300
 *   YODEL_CLAIMS_FORGEJO_USER       default yodel34
 *   YODEL_CLAIMS_FORGEJO_PASSWORD   required: without it the claim fails (--skip template skips it)
 *   YODEL_CLAIMS_FORGEJO_CLICKHOUSE_URL  the emulator as a job sees it, default http://clickhouse:8123
 *   YODEL_CLAIMS_FORGEJO_POSTGRES_URL    default postgres://pgdb:5432/postgres
 */

import type { Ctx } from "../lib/claim.js";
import type { Forge, ForgeRepo, ForgeRun } from "./forge.js";

export const forgejo = {
  url: (process.env.YODEL_CLAIMS_FORGEJO_URL ?? "http://localhost:3300").replace(/\/+$/, ""),
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

/** Waits for the newest run of `event` on `sha` to finish; prints its failed jobs' logs. */
async function waitRun(ctx: Ctx, repo: string, sha: string, event: string): Promise<ForgeRun> {
  const deadline = Date.now() + 20 * 60_000;
  let last = "";
  for (;;) {
    const { json } = await api<{ workflow_runs?: RunDoc[] }>("GET", `/repos/${repo}/actions/runs?head_sha=${sha}`);
    const runs = (json.workflow_runs ?? []).filter((r) => r.event === event || (event === "workflow_dispatch" && r.event === "")).sort((a, b) => b.id - a.id);
    const r = runs[0];
    const state = r ? `run ${String(r.id)} ${r.status}` : "no run yet";
    if (state !== last) ctx.log(`${event} on ${sha.slice(0, 8)}: ${state}`);
    else process.stdout.write(".\n");
    last = state;
    if (r && ["success", "failure", "cancelled", "skipped"].includes(r.status)) {
      if (r.status !== "success") await printLogs(ctx, repo, r.id);
      let log = "";
      for (const job of await jobs(repo, r.id)) log += await jobText(repo, job.id);
      return { ok: r.status === "success", status: r.status, log };
    }
    if (Date.now() > deadline) throw new Error(`no finished ${event} run for ${sha} after 20 minutes (${state})`);
    await new Promise((res) => setTimeout(res, 5_000));
  }
}

export function forgejoForge(): Forge {
  return {
    name: "Forgejo",
    jobUrl: (d) => (d === "ch" ? (process.env.YODEL_CLAIMS_FORGEJO_CLICKHOUSE_URL ?? "http://clickhouse:8123") : (process.env.YODEL_CLAIMS_FORGEJO_POSTGRES_URL ?? "postgres://pgdb:5432/postgres")),
    async repo(ctx, name, secrets): Promise<ForgeRepo> {
      if (!forgejo.password) throw new Error("YODEL_CLAIMS_FORGEJO_PASSWORD is not set; the template claim needs the local Forgejo");
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
          const dispatched = await api("POST", `/repos/${repo}/actions/workflows/yodel-apply.yml/dispatches`, { ref: "main" });
          if (dispatched.status >= 300) throw new Error(`dispatching yodel-apply: ${String(dispatched.status)} ${JSON.stringify(dispatched.json)}`);
          return waitRun(ctx, repo, sha, "workflow_dispatch");
        },
        async openPr(head, sha, title) {
          const pr = await api<{ number: number }>("POST", `/repos/${repo}/pulls`, { title, head, base: "main" });
          if (pr.status !== 201) throw new Error(`opening the pull request: ${String(pr.status)}`);
          return { id: pr.json.number, checks: await waitRun(ctx, repo, sha, "pull_request") };
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
      };
    },
    close: () => Promise.resolve(),
  };
}
