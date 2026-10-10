/**
 * The template-gitlab claim's forge: a local GitLab CE (terragucci's GitLab
 * lab answers at http://localhost:8959, as `http://gitlab:8929` on the
 * Docker network `tglab`). Each run makes its own project, with shared
 * runners off, and its own project runner (./gitlab.compose.ts) on that
 * network, so the pipelines run on nothing else's runner. The pipelines are
 * the generated .gitlab-ci.yml: a push to main runs apply-dev, a merge
 * request runs lint and plan-dev, and plan-dev comments with GITLAB_TOKEN,
 * a project access token the claim makes. The variables are set as the
 * template's .gitlab-ci.yml says: the writer's protected and scoped to the
 * environment dev. The run's project and runner are deleted after it.
 *
 *   YODEL_CLAIMS_GITLAB_URL          default http://localhost:8959
 *   YODEL_CLAIMS_GITLAB_TOKEN        required: a personal access token (api, create_runner) of the claims' user
 *   YODEL_CLAIMS_GITLAB_NETWORK      the Docker network GitLab is on, default tglab
 *   YODEL_CLAIMS_GITLAB_INTERNAL_URL GitLab on that network (its external_url), default http://gitlab:8929
 *   YODEL_CLAIMS_GITLAB_CLICKHOUSE_URL  the emulator as a job sees it, default YODEL_CLAIMS_CLICKHOUSE_URL's
 *                                    with localhost as host.docker.internal
 *   YODEL_CLAIMS_GITLAB_POSTGRES_URL    likewise
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dockerSerializer } from "@intentius/chant-lexicon-docker";
import { uniqueContainerName } from "@intentius/chant-lexicon-sql/core/container";
import type { Ctx } from "../lib/claim.js";
import { endpoints } from "../lib/db.js";
import { run } from "../lib/exec.js";
import type { Forge, ForgeRepo, ForgeRun } from "./forge.js";
import { gitlabRunnerEntities } from "./gitlab.compose.js";

export const gitlab = {
  url: (process.env.YODEL_CLAIMS_GITLAB_URL ?? "http://localhost:8959").replace(/\/+$/, ""),
  token: process.env.YODEL_CLAIMS_GITLAB_TOKEN ?? "",
  network: process.env.YODEL_CLAIMS_GITLAB_NETWORK ?? "tglab",
  internal: (process.env.YODEL_CLAIMS_GITLAB_INTERNAL_URL ?? "http://gitlab:8929").replace(/\/+$/, ""),
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names the response's shape
async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T; text: string }> {
  const res = await fetch(`${gitlab.url}/api/v4${path}`, {
    method,
    headers: { "PRIVATE-TOKEN": gitlab.token, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  const parsed = (): unknown => {
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return text;
    }
  };
  return { status: res.status, json: parsed() as T, text };
}

async function must<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await api<T>(method, path, body);
  if (r.status >= 300) throw new Error(`${method} ${path}: ${String(r.status)} ${r.text.slice(0, 300)}`);
  return r.json;
}

/** The emulator's URL with localhost as the Docker host, which a job container reaches. */
const fromJob = (url: string) => url.replace(/\/\/(localhost|127\.0\.0\.1)([:/])/, "//host.docker.internal$2");

interface Pipeline {
  id: number;
  status: string;
  source: string;
}
interface Job {
  id: number;
  name: string;
  status: string;
  failure_reason?: string;
}

const DONE = ["success", "failed", "canceled", "skipped"];

export function gitlabForge(): Forge {
  const cleanup: Array<() => Promise<unknown>> = [];
  return {
    name: "GitLab",
    jobUrl: (d) => (d === "ch" ? (process.env.YODEL_CLAIMS_GITLAB_CLICKHOUSE_URL ?? fromJob(endpoints.clickhouse)) : (process.env.YODEL_CLAIMS_GITLAB_POSTGRES_URL ?? fromJob(endpoints.postgres))),
    async repo(ctx: Ctx, name, secrets): Promise<ForgeRepo> {
      if (!gitlab.token) throw new Error("YODEL_CLAIMS_GITLAB_TOKEN is not set; the template-gitlab claim needs a local GitLab");
      const me = await must<{ username: string }>("GET", "/user");
      // A project per run: deleting one is asynchronous and holds its path a while.
      const path = `${name}-${Date.now().toString(36)}`;
      const project = await must<{ id: number }>("POST", "/projects", { name: path, path, visibility: "public", initialize_with_readme: false, default_branch: "main", shared_runners_enabled: false });
      const pid = String(project.id);
      cleanup.push(() => api("DELETE", `/projects/${pid}`));
      // main protected before its first push, so the first push's pipeline already gets the protected (writer) variables.
      await must("POST", `/projects/${pid}/protected_branches`, { name: "main", push_access_level: 40, merge_access_level: 40, allow_force_push: false });
      ctx.log(`GitLab project ${me.username}/${path} (${pid})`);

      // Its own runner, registered to the project alone.
      const runner = await must<{ id: number; token: string }>("POST", "/user/runners", { runner_type: "project_type", project_id: project.id, run_untagged: true, description: `yodel claims ${path}` });
      cleanup.push(() => api("DELETE", `/runners/${String(runner.id)}`));
      const composeName = uniqueContainerName("yodel-34-gitlab-runner");
      const compose = dockerSerializer.serialize(gitlabRunnerEntities({ url: gitlab.internal, token: runner.token, name: path, network: gitlab.network }));
      if (typeof compose !== "string") throw new Error("the GitLab runner's declaration serialized to more than a Compose file");
      const forgeDir = join(ctx.work, "forge");
      mkdirSync(forgeDir, { recursive: true });
      writeFileSync(join(forgeDir, "compose.yaml"), compose, { mode: 0o600 });
      const composeArgs = ["compose", "--project-name", composeName, "--file", join(forgeDir, "compose.yaml")];
      cleanup.unshift(() => run("docker", [...composeArgs, "down", "--volumes", "--timeout", "0"], { cwd: forgeDir }));
      const up = await run("docker", [...composeArgs, "up", "--detach", "--quiet-pull"], { cwd: forgeDir, timeoutMs: 600_000 });
      if (up.code !== 0) throw new Error("docker compose up of the GitLab runner failed");

      // The variables, as .gitlab-ci.yml's header says, and the comment's token.
      const pat = await must<{ token: string }>("POST", `/projects/${pid}/access_tokens`, {
        name: "yodel-plan-comment",
        scopes: ["api"],
        access_level: 20,
        expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
      });
      const vars: Array<{ key: string; value: string; protected?: boolean; masked?: boolean; environment_scope?: string }> = Object.entries(secrets).map(([key, value]) =>
        /_WRITER_/.test(key) ? { key, value, protected: true, environment_scope: "dev" } : { key, value },
      );
      vars.push({ key: "GITLAB_TOKEN", value: pat.token, masked: true });
      for (const v of vars) await must("POST", `/projects/${pid}/variables`, v);

      const traces = async (pipeline: number): Promise<{ jobs: Job[]; log: string }> => {
        const jobs = await must<Job[]>("GET", `/projects/${pid}/pipelines/${String(pipeline)}/jobs?per_page=100&include_retried=true`);
        let log = "";
        for (const job of jobs) log += `----- job ${job.name} (${job.status}) -----\n${job.failure_reason ? `failure reason: ${job.failure_reason}\n` : ""}${(await api("GET", `/projects/${pid}/jobs/${String(job.id)}/trace`)).text}\n`;
        return { jobs, log };
      };
      const printFailed = (jobs: Job[], log: string) => {
        for (const job of jobs.filter((j) => j.status !== "success")) {
          const part = log.split(`----- job ${job.name} (${job.status}) -----\n`)[1]?.split("\n----- job ")[0] ?? "";
          ctx.log(`job ${job.name} (${job.status}), its last lines:\n${part.trimEnd().split("\n").slice(-30).join("\n")}`);
        }
      };
      /** Waits for the newest pipeline of `source` on `sha` to finish. */
      const waitPipeline = async (sha: string, source: string): Promise<ForgeRun> => {
        const deadline = Date.now() + 30 * 60_000;
        let last = "";
        for (;;) {
          const list = await must<Pipeline[]>("GET", `/projects/${pid}/pipelines?sha=${sha}&source=${source}`);
          const p = list.sort((a, b) => b.id - a.id)[0];
          const state = p ? `pipeline ${String(p.id)} ${p.status}` : "no pipeline yet";
          if (state !== last) ctx.log(`${source} on ${sha.slice(0, 8)}: ${state}`);
          else process.stdout.write(".\n");
          last = state;
          if (p && DONE.includes(p.status)) {
            const { jobs, log } = await traces(p.id);
            if (p.status !== "success") printFailed(jobs, log);
            return { ok: p.status === "success", status: p.status, log };
          }
          if (Date.now() > deadline) throw new Error(`no finished ${source} pipeline for ${sha} after 30 minutes (${state})`);
          await sleep(5_000);
        }
      };

      return {
        remote: `${gitlab.url.replace("://", `://oauth2:${encodeURIComponent(gitlab.token)}@`)}/${me.username}/${path}.git`,
        pushed: (sha) => waitPipeline(sha, "push"),
        // What a user does after approving: retry the apply job that stopped at the gate.
        async applyAgain(sha) {
          const [p] = (await must<Pipeline[]>("GET", `/projects/${pid}/pipelines?sha=${sha}&source=push`)).sort((a, b) => b.id - a.id);
          if (!p) throw new Error(`no push pipeline on ${sha} to run the apply again in`);
          const job = (await must<Job[]>("GET", `/projects/${pid}/pipelines/${String(p.id)}/jobs`)).find((j) => j.name === "apply-dev");
          if (!job) throw new Error(`pipeline ${String(p.id)} has no apply-dev job`);
          const retried = await must<Job>("POST", `/projects/${pid}/jobs/${String(job.id)}/retry`);
          const deadline = Date.now() + 30 * 60_000;
          for (;;) {
            const j = await must<Job>("GET", `/projects/${pid}/jobs/${String(retried.id)}`);
            if (DONE.includes(j.status)) {
              const log = `----- job ${j.name} (${j.status}) -----\n${(await api("GET", `/projects/${pid}/jobs/${String(j.id)}/trace`)).text}\n`;
              if (j.status !== "success") printFailed([j], log);
              ctx.log(`apply-dev retried as job ${String(j.id)}: ${j.status}`);
              return { ok: j.status === "success", status: j.status, log };
            }
            if (Date.now() > deadline) throw new Error(`the retried apply-dev job ${String(j.id)} did not finish in 30 minutes`);
            await sleep(5_000);
          }
        },
        async openPr(head, sha, title) {
          const mr = await must<{ iid: number }>("POST", `/projects/${pid}/merge_requests`, { source_branch: head, target_branch: "main", title });
          return { id: mr.iid, checks: await waitPipeline(sha, "merge_request_event") };
        },
        async comments(id) {
          return (await must<Array<{ body: string }>>("GET", `/projects/${pid}/merge_requests/${String(id)}/notes?per_page=100&sort=asc`)).map((n) => n.body);
        },
        async merge(id) {
          // Mergeable once GitLab has checked the merge request.
          for (let i = 0; ; i++) {
            const r = await api<{ merge_commit_sha?: string; message?: unknown }>("PUT", `/projects/${pid}/merge_requests/${String(id)}/merge`);
            if (r.status < 300 && r.json.merge_commit_sha) return r.json.merge_commit_sha;
            if (i >= 40) throw new Error(`merging !${String(id)}: ${String(r.status)} ${r.text.slice(0, 300)}`);
            await sleep(3_000);
          }
        },
      };
    },
    async close() {
      for (const f of cleanup) await f().catch(() => undefined);
    },
  };
}
