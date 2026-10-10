/**
 * The template claim's forge: a local Forgejo (the one terragucci's stack
 * runs at http://localhost:3300, whose runner puts job containers on the
 * network where the emulator answers as `clickhouse` and `pgdb`). Its
 * Actions run .forgejo/workflows on each push and pull request.
 *
 *   YODEL_CLAIMS_FORGEJO_URL        default http://localhost:3300
 *   YODEL_CLAIMS_FORGEJO_USER       default yodel34
 *   YODEL_CLAIMS_FORGEJO_PASSWORD   required: without it the claim fails (--skip template skips it)
 *   YODEL_CLAIMS_FORGEJO_REVIEWER   the second writer who reviews pull requests (#48), default <user>-reviewer;
 *                                   made (or its password reset) through the admin API when
 *   YODEL_CLAIMS_FORGEJO_REVIEWER_PASSWORD is not set
 *   YODEL_CLAIMS_FORGEJO_CLICKHOUSE_URL  the emulator as a job sees it, default http://clickhouse:8123
 *   YODEL_CLAIMS_FORGEJO_POSTGRES_URL    default postgres://pgdb:5432/postgres
 */

import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Ctx } from "../lib/claim.js";
import type { Forge, ForgeIssue, ForgeRepo, ForgeRun } from "./forge.js";

export const forgejo = {
  url: (process.env.YODEL_CLAIMS_FORGEJO_URL ?? "http://localhost:3300").replace(/\/+$/, ""),
  user: process.env.YODEL_CLAIMS_FORGEJO_USER ?? "yodel34",
  password: process.env.YODEL_CLAIMS_FORGEJO_PASSWORD ?? "",
};

const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
const auth = () => basic(forgejo.user, forgejo.password);

/** The second writer (#48): approves the pull requests the claim's user opens. */
const reviewer = {
  user: process.env.YODEL_CLAIMS_FORGEJO_REVIEWER ?? `${forgejo.user}-reviewer`,
  password: process.env.YODEL_CLAIMS_FORGEJO_REVIEWER_PASSWORD ?? `Rv-${randomBytes(12).toString("hex")}`,
  given: process.env.YODEL_CLAIMS_FORGEJO_REVIEWER_PASSWORD !== undefined,
};

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names the response's shape
async function api<T = unknown>(method: string, path: string, body?: unknown, as = auth()): Promise<{ status: number; json: T }> {
  const res = await fetch(`${forgejo.url}/api/v1${path}`, {
    method,
    headers: { Authorization: as, "Content-Type": "application/json" },
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
      if (r.status !== "success") await printLogs(ctx, repo, r.id);
      let log = "";
      for (const job of await jobs(repo, r.id)) log += await jobText(repo, job.id);
      return { ok: r.status === "success", status: r.status, log, id: r.id };
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
      for (const r of runs) {
        if (r.status !== "success") await printLogs(ctx, repo, r.id);
        for (const job of await jobs(repo, r.id)) log += await jobText(repo, job.id);
      }
      const failed = runs.filter((r) => r.status !== "success");
      return { ok: failed.length === 0, status: failed.length === 0 ? "success" : failed.map((r) => `run ${String(r.id)} ${r.status}`).join(", "), log };
    }
    if (Date.now() > deadline) throw new Error(`the ${event} runs on ${sha} did not all finish in 20 minutes`);
    await new Promise((res) => setTimeout(res, 5_000));
  }
}

/** The reviewer (#48) as a user of the forge: made, or its password set, through the admin API unless its password is given. */
async function ensureReviewer(): Promise<void> {
  if (reviewer.given) return;
  const made = await api("POST", "/admin/users", { username: reviewer.user, email: `${reviewer.user}@example.invalid`, password: reviewer.password, must_change_password: false });
  if (made.status === 201) return;
  if (made.status === 422) {
    const reset = await api("PATCH", `/admin/users/${encodeURIComponent(reviewer.user)}`, { login_name: reviewer.user, source_id: 0, password: reviewer.password, must_change_password: false });
    if (reset.status < 300) return;
  }
  throw new Error(`the pr-review part needs a second Forgejo user: ${forgejo.user} could not make ${reviewer.user} (${String(made.status)}); set YODEL_CLAIMS_FORGEJO_REVIEWER and YODEL_CLAIMS_FORGEJO_REVIEWER_PASSWORD`);
}

/**
 * A module for node's --import that sends fetches of the forge's own URL (the
 * ROOT_URL its jobs see, such as http://forgejo:3000, which names the
 * forge's API in the pending record a waiting job writes) to the URL this
 * host reaches it at: what a hosts entry would do on an approver's machine.
 */
function hostsPreload(work: string, from: string, to: string): string {
  const file = join(work, "forgejo-hosts.mjs");
  writeFileSync(
    file,
    `const [from, to] = ${JSON.stringify([from, to])};
const fetch0 = globalThis.fetch;
globalThis.fetch = (input, init) => fetch0(typeof input === "string" && input.startsWith(from) ? to + input.slice(from.length) : input, init);
`,
  );
  return pathToFileURL(file).href;
}

export function forgejoForge(): Forge {
  /** The tokens made for a resume, removed on close. */
  const tokens: string[] = [];
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
        /** A token with write:repository alone, which a dispatch needs (#47). */
        async resumeEnv() {
          const tokenName = `yodel-47-resume-${randomBytes(4).toString("hex")}`;
          const made = await api<{ sha1?: string }>("POST", `/users/${encodeURIComponent(forgejo.user)}/tokens`, { name: tokenName, scopes: ["write:repository"] });
          if (made.status !== 201 || !made.json.sha1) throw new Error(`making a write:repository token: ${String(made.status)} ${JSON.stringify(made.json)}`);
          tokens.push(tokenName);
          // The jobs see the forge at its ROOT_URL, which this host may not resolve.
          const { json: info } = await api<{ html_url?: string }>("GET", `/repos/${repo}`);
          const root = info.html_url?.slice(0, info.html_url.length - repo.length - 1) ?? forgejo.url;
          const env: Record<string, string> = { CHANT_FORGE_TOKEN: made.json.sha1 };
          if (root.replace(/\/+$/, "") !== forgejo.url) env.NODE_OPTIONS = `--import ${hostsPreload(ctx.work, root.replace(/\/+$/, ""), forgejo.url)}`;
          return env;
        },
        async resumed(sha, waited, withinMs) {
          return waitRun(ctx, repo, sha, "workflow_dispatch", waited.id ?? (await lastRunId(repo, sha)), withinMs);
        },
        async applyAgain(sha) {
          // A dispatch again on the same commit (#48): wait for the run after the ones already there.
          const after = await lastRunId(repo, sha);
          const dispatched = await api("POST", `/repos/${repo}/actions/workflows/yodel-apply.yml/dispatches`, { ref: "main" });
          if (dispatched.status >= 300) throw new Error(`dispatching yodel-apply: ${String(dispatched.status)} ${JSON.stringify(dispatched.json)}`);
          return waitRun(ctx, repo, sha, "workflow_dispatch", after);
        },
        async openPr(head, sha, title) {
          const pr = await api<{ number: number }>("POST", `/repos/${repo}/pulls`, { title, head, base: "main" });
          if (pr.status !== 201) throw new Error(`opening the pull request: ${String(pr.status)}`);
          // Every pull request workflow: yodel-pr, and a pr-review wave's yodel-apply-plans (#48).
          return { id: pr.json.number, checks: await waitAll(ctx, repo, sha, "pull_request") };
        },
        async review(id, sha, as) {
          if (as === "reviewer") {
            await ensureReviewer();
            const added = await api("PUT", `/repos/${repo}/collaborators/${encodeURIComponent(reviewer.user)}`, { permission: "write" });
            if (added.status >= 300) throw new Error(`adding ${reviewer.user} as a writer: ${String(added.status)} ${JSON.stringify(added.json)}`);
          }
          const by = as === "author" ? auth() : basic(reviewer.user, reviewer.password);
          const done = await api("POST", `/repos/${repo}/pulls/${String(id)}/reviews`, { event: "APPROVED", commit_id: sha, body: "" }, by);
          if (done.status >= 300) {
            // Forgejo refuses an author's approval of their own pull request.
            if (as === "author") {
              ctx.log(`Forgejo refused ${forgejo.user}'s approval of their own pull request #${String(id)}: ${String(done.status)} ${JSON.stringify(done.json)}`);
              return;
            }
            throw new Error(`${reviewer.user}'s review of #${String(id)}: ${String(done.status)} ${JSON.stringify(done.json)}`);
          }
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
    async close() {
      for (const name of tokens.splice(0)) await api("DELETE", `/users/${encodeURIComponent(forgejo.user)}/tokens/${encodeURIComponent(name)}`);
    },
  };
}
