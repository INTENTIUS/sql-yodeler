/**
 * The template-github claim's forge. GitHub has no edition to run locally,
 * so, as terragucci's github profile does, the forge is a mock GitHub
 * (./mock-github.ts: repositories, pull requests, comments, git over HTTP),
 * started per run as a Compose project declared in ./github.compose.ts, and
 * the runner is act on this host. A push is a git push to the mock; its run
 * is act on a fresh clone of the pushed commit, with the event GitHub would
 * send, running the generated .github/workflows file. `yodel plan
 * --comment` in the job posts to the mock (GITHUB_API_URL).
 *
 * act runs the generated workflow file as it was pushed, with no changes.
 * A job without a container runs on the Docker host's network, as GitHub
 * runs it on the runner's host, so the plan and apply jobs reach the mock
 * and the emulator at localhost. Each run has an id (GITHUB_RUN_ID) the
 * mock is told of when it ends, and a job's push (a pending record on
 * chant/lifecycle) carries the token, as GitHub's checkout gives a job with
 * contents: write. A re-run the mock is asked for (#47: yodel approve
 * resuming a waiting wave) is act again on the same commit, with the same
 * run id and the next attempt. The lint job runs in a job container on
 * the network act makes for its replay service, and reaches that server by
 * the service's name, so it never meets the emulator's 8123 or 5432 on the
 * host. From there the mock is not on localhost, so the lint job's fetch of
 * chant/lifecycle fails and says nothing is approved, which lint does not need.
 *
 *   YODEL_CLAIMS_ACT                      the act binary, default act
 *   YODEL_CLAIMS_GITHUB_CLICKHOUSE_URL    the emulator as a job sees it, default YODEL_CLAIMS_CLICKHOUSE_URL's
 *   YODEL_CLAIMS_GITHUB_POSTGRES_URL      default YODEL_CLAIMS_POSTGRES_URL's
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { dockerSerializer } from "@intentius/chant-lexicon-docker";
import { publishedPort, uniqueContainerName } from "@intentius/chant-lexicon-sql/core/container";
import { endpoints } from "../lib/db.js";
import { run } from "../lib/exec.js";
import { NODE_IMAGE, type Forge, type ForgeIssue, type ForgeRepo, type ForgeRun } from "./forge.js";
import { MOCK_PORT, MOCK_SERVICE, mockGithubEntities } from "./github.compose.js";

const USER = "yodel34";
/** The mock's second writer, who reviews (#48). */
const REVIEWER = "yodel34-reviewer";
const ACT = process.env.YODEL_CLAIMS_ACT ?? "act";
/** The actions the workflows use, which act fetches from github.com, not the mock. */
const ACTIONS = ["actions/checkout", "actions/setup-node", "actions/upload-artifact"];

/** A port free on this host, for the artifact server act starts per run. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

export function githubForge(): Forge {
  let down: (() => Promise<void>) | undefined;
  return {
    name: "GitHub (act)",
    jobUrl: (d) => (d === "ch" ? (process.env.YODEL_CLAIMS_GITHUB_CLICKHOUSE_URL ?? endpoints.clickhouse) : (process.env.YODEL_CLAIMS_GITHUB_POSTGRES_URL ?? endpoints.postgres)),
    async repo(ctx, name, secrets): Promise<ForgeRepo> {
      // The mock, as its own Compose project.
      const token = randomBytes(16).toString("hex");
      const project = uniqueContainerName("yodel-34-github");
      const compose = dockerSerializer.serialize(mockGithubEntities({ token, user: USER }));
      if (typeof compose !== "string") throw new Error("the mock GitHub's declaration serialized to more than a Compose file");
      const forgeDir = join(ctx.work, "forge");
      mkdirSync(forgeDir, { recursive: true });
      writeFileSync(join(forgeDir, "compose.yaml"), compose);
      const composeArgs = ["compose", "--project-name", project, "--file", join(forgeDir, "compose.yaml")];
      down = async () => {
        await run("docker", [...composeArgs, "down", "--volumes", "--timeout", "0"], { cwd: forgeDir });
      };
      const up = await run("docker", [...composeArgs, "up", "--detach", "--quiet-pull"], { cwd: forgeDir, timeoutMs: 600_000 });
      if (up.code !== 0) throw new Error("docker compose up of the mock GitHub failed");
      const port = await publishedPort(`${project}-${MOCK_SERVICE}-1`, MOCK_PORT);
      const host = `http://127.0.0.1:${port}`;
      for (let i = 0; ; i++) {
        const ok = await fetch(`${host}/__mock/health`).then((r) => r.ok, () => false);
        if (ok) break;
        if (i > 60) throw new Error(`the mock GitHub at ${host} did not answer`);
        await new Promise((r) => setTimeout(r, 500));
      }
      const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
        const res = await fetch(`${host}/api/v3${path}`, {
          method,
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(60_000),
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`${method} ${path}: ${String(res.status)} ${text}`);
        return (text ? JSON.parse(text) : null) as T;
      };
      await api("POST", "/user/repos", { name });
      const remote = `http://x-access-token:${token}@127.0.0.1:${port}/${USER}/${name}.git`;
      const repository = { name, full_name: `${USER}/${name}`, owner: { login: USER }, default_branch: "main" };
      const secretFile = join(forgeDir, "secrets.env");
      const held: Record<string, string> = { ...secrets, GITHUB_TOKEN: token };
      // act reads the file on each run, so a secret set again holds from the next run on.
      const writeSecrets = () => {
        writeFileSync(secretFile, Object.entries(held).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
      };
      writeSecrets();

      let n = 0;
      /**
       * act on a fresh clone of `sha` (as branch `branch`), running `workflow` for `event`.
       * `apiHost`: how the job reaches the mock's API; a job in a container (the watch) is not on the host's localhost.
       * `rerun`: the run id and attempt of a re-run; a new run takes the next id.
       */
      const act = async (event: string, workflow: string, branch: string, sha: string, payload: Record<string, unknown>, apiHost = "localhost", rerun?: { id: number; attempt: number }): Promise<ForgeRun> => {
        n += 1;
        const runId = rerun?.id ?? 1000 + n;
        const attempt = rerun?.attempt ?? 1;
        const dir = join(ctx.work, `act-${String(n)}`);
        const git = async (...args: string[]) => {
          const ran = await run("git", args, { cwd: ctx.work });
          if (ran.code !== 0) throw new Error(`git ${args.join(" ")} exited ${String(ran.code)}`);
        };
        await git("clone", "-q", remote, dir);
        await git("-C", dir, "checkout", "-q", "-B", branch, sha);
        // The job's git (the approvals on chant/lifecycle) reads from the mock as the job sees it.
        await git("-C", dir, "remote", "set-url", "origin", `http://localhost:${port}/${USER}/${name}.git`);
        // A push from the job (a wave's pending record) carries the token, as checkout's credentials do on GitHub.
        await git("-C", dir, "config", `http.http://localhost:${port}/.extraHeader`, `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`);
        // Jobs in the CI image (yodel.config.ts ci.image, #66) run in containers, which reach the mock on the Docker host.
        const apiAt = apiHost === "localhost" && readFileSync(join(dir, ".github", "workflows", workflow), "utf8").includes("container: ghcr.io/intentius/sql-yodeler") ? "host.docker.internal" : apiHost;
        const eventFile = join(ctx.work, `act-${String(n)}-event.json`);
        writeFileSync(eventFile, JSON.stringify({ ...payload, repository }));
        ctx.log(`act ${event} ${workflow} on ${name}@${sha.slice(0, 8)} (${branch})`);
        const ran = await run(
          ACT,
          [
            event,
            "--workflows", join(dir, ".github", "workflows", workflow),
            "--eventpath", eventFile,
            "--platform", `ubuntu-latest=${NODE_IMAGE}`,
            "--rm",
            "--github-instance", `localhost:${port}`,
            ...ACTIONS.flatMap((a) => ["--replace-ghe-action-with-github-com", a]),
            "--env", `GITHUB_API_URL=http://${apiAt}:${port}/api/v3`,
            "--env", "GITHUB_SERVER_URL=https://github.com",
            "--env", `GITHUB_RUN_ID=${String(runId)}`,
            "--env", `GITHUB_RUN_ATTEMPT=${String(attempt)}`,
            "--secret-file", secretFile,
            // The apply and watch jobs keep their report with upload-artifact, which needs act's artifact server.
            "--artifact-server-path", join(ctx.work, "artifacts"),
            "--artifact-server-port", String(await freePort()),
          ],
          { cwd: dir, timeoutMs: 20 * 60_000 },
        );
        const status = ran.code === 0 ? "success" : ran.timedOut ? "timed out" : `failure (act exited ${String(ran.code)})`;
        ctx.log(`act ${event} on ${sha.slice(0, 8)} (run ${String(runId)}, attempt ${String(attempt)}): ${status}`);
        await api("PUT", `/repos/${USER}/${name}/actions/runs/${String(runId)}`, { status: "completed", conclusion: ran.code === 0 ? "success" : "failure", run_attempt: attempt });
        const log = ran.out + ran.err;
        // act ends each job's lines with "[<workflow>/<job>] 🏁  Job failed" (or succeeded).
        const failed = [...new Set([...log.matchAll(/\[[^/\]]+\/([^\]]+?)\s*\] 🏁 {2}Job failed/g)].map((m) => m[1] ?? ""))];
        return { ok: ran.code === 0, status, log, failed, id: runId };
      };
      const pushRun = (sha: string, rerun?: { id: number; attempt: number }) =>
        act("push", "yodel-apply.yml", "main", sha, { ref: "refs/heads/main", before: "0".repeat(40), after: sha }, "localhost", rerun);

      return {
        remote,
        pushed: (sha) => pushRun(sha),
        // The mock's token: on GitHub, one with Actions: read and write.
        resumeEnv: () => Promise.resolve({ GITHUB_TOKEN: token }),
        async resumed(sha, waited, withinMs) {
          if (waited.id === undefined) throw new Error("the waiting run has no id");
          const deadline = Date.now() + withinMs;
          for (;;) {
            const run = await api<{ status: string; run_attempt: number }>("GET", `/repos/${USER}/${name}/actions/runs/${String(waited.id)}`);
            if (run.status === "queued") {
              ctx.log(`the mock GitHub was asked to re-run run ${String(waited.id)}: act runs it again, attempt ${String(run.run_attempt)}`);
              return pushRun(sha, { id: waited.id, attempt: run.run_attempt });
            }
            if (Date.now() > deadline) return undefined;
            await new Promise((r) => setTimeout(r, 2_000));
          }
        },
        applyAgain: (sha) => act("workflow_dispatch", "yodel-apply.yml", "main", sha, { ref: "refs/heads/main", inputs: {} }),
        async openPr(head, sha, title) {
          const pr = await api<{ number: number; base: { sha: string } }>("POST", `/repos/${USER}/${name}/pulls`, { title, head, base: "main" });
          const event = {
            action: "opened",
            number: pr.number,
            pull_request: { number: pr.number, title, head: { ref: head, sha }, base: { ref: "main", sha: pr.base.sha } },
          };
          const checks = await act("pull_request", "yodel-pr.yml", head, sha, event);
          // A pr-review wave (#48) adds the workflow that records the plans the head makes.
          if (!existsSync(join(ctx.work, `act-${String(n)}`, ".github", "workflows", "yodel-apply-plans.yml"))) return { id: pr.number, checks };
          const plans = await act("pull_request", "yodel-apply-plans.yml", head, sha, event);
          return { id: pr.number, checks: { ok: checks.ok && plans.ok, status: plans.ok ? checks.status : `${checks.status}; plans ${plans.status}`, log: `${checks.log}\n${plans.log}`, failed: [...(checks.failed ?? []), ...(plans.failed ?? [])] } };
        },
        async review(id, sha, as) {
          await api("POST", `/repos/${USER}/${name}/pulls/${String(id)}/reviews`, { event: "APPROVE", commit_id: sha, user: as === "author" ? USER : REVIEWER });
        },
        setSecrets(values) {
          Object.assign(held, values);
          writeSecrets();
          return Promise.resolve();
        },
        async comments(id) {
          return (await api<Array<{ body: string }>>("GET", `/repos/${USER}/${name}/issues/${String(id)}/comments?per_page=100`)).map((c) => c.body);
        },
        async merge(id) {
          return (await api<{ sha: string }>("PUT", `/repos/${USER}/${name}/pulls/${String(id)}/merge`, {})).sha;
        },
        // The watch job runs in a container, which reaches the mock on the Docker host.
        watch: (sha) => act("workflow_dispatch", "watch-dev.yml", "main", sha, { ref: "refs/heads/main", inputs: {} }, "host.docker.internal"),
        async issues(): Promise<ForgeIssue[]> {
          const list = await api<Array<{ number: number; title: string; body: string; state: string }>>("GET", `/repos/${USER}/${name}/issues?state=all&per_page=100`);
          return list.map((i) => ({ number: i.number, title: i.title, body: i.body, open: i.state === "open" }));
        },
      };
    },
    async close() {
      await down?.();
    },
  };
}
