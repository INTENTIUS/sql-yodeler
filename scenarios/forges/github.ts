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
 * and the emulator at localhost. The lint job runs in a job container on
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
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dockerSerializer } from "@intentius/chant-lexicon-docker";
import { publishedPort, uniqueContainerName } from "@intentius/chant-lexicon-sql/core/container";
import { endpoints } from "../lib/db.js";
import { run } from "../lib/exec.js";
import { NODE_IMAGE, type Forge, type ForgeIssue, type ForgeRepo, type ForgeRun } from "./forge.js";
import { MOCK_PORT, MOCK_SERVICE, mockGithubEntities } from "./github.compose.js";

const USER = "yodel34";
const ACT = process.env.YODEL_CLAIMS_ACT ?? "act";
/** The actions the workflows use, which act fetches from github.com, not the mock. */
const ACTIONS = ["actions/checkout", "actions/setup-node"];

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
      writeFileSync(secretFile, Object.entries({ ...secrets, GITHUB_TOKEN: token }).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });

      let n = 0;
      /**
       * act on a fresh clone of `sha` (as branch `branch`), running `workflow` for `event`.
       * `apiHost`: how the job reaches the mock's API; a job in a container (the watch) is not on the host's localhost.
       */
      const act = async (event: string, workflow: string, branch: string, sha: string, payload: Record<string, unknown>, apiHost = "localhost"): Promise<ForgeRun> => {
        n += 1;
        const dir = join(ctx.work, `act-${String(n)}`);
        const git = async (...args: string[]) => {
          const ran = await run("git", args, { cwd: ctx.work });
          if (ran.code !== 0) throw new Error(`git ${args.join(" ")} exited ${String(ran.code)}`);
        };
        await git("clone", "-q", remote, dir);
        await git("-C", dir, "checkout", "-q", "-B", branch, sha);
        // The job's git (the approvals on chant/lifecycle) reads from the mock as the job sees it.
        await git("-C", dir, "remote", "set-url", "origin", `http://localhost:${port}/${USER}/${name}.git`);
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
            "--env", `GITHUB_API_URL=http://${apiHost}:${port}/api/v3`,
            "--env", "GITHUB_SERVER_URL=https://github.com",
            "--secret-file", secretFile,
          ],
          { cwd: dir, timeoutMs: 20 * 60_000 },
        );
        const status = ran.code === 0 ? "success" : ran.timedOut ? "timed out" : `failure (act exited ${String(ran.code)})`;
        ctx.log(`act ${event} on ${sha.slice(0, 8)}: ${status}`);
        return { ok: ran.code === 0, status, log: ran.out + ran.err };
      };

      return {
        remote,
        pushed: (sha) => act("push", "yodel-apply.yml", "main", sha, { ref: "refs/heads/main", before: "0".repeat(40), after: sha }),
        applyAgain: (sha) => act("workflow_dispatch", "yodel-apply.yml", "main", sha, { ref: "refs/heads/main", inputs: {} }),
        async openPr(head, sha, title) {
          const pr = await api<{ number: number; base: { sha: string } }>("POST", `/repos/${USER}/${name}/pulls`, { title, head, base: "main" });
          const checks = await act("pull_request", "yodel-pr.yml", head, sha, {
            action: "opened",
            number: pr.number,
            pull_request: { number: pr.number, title, head: { ref: head, sha }, base: { ref: "main", sha: pr.base.sha } },
          });
          return { id: pr.number, checks };
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
