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
 * act runs the jobs on the Docker host's network, as GitHub runs them on
 * the runner's host, so a job reaches the mock and the emulator at
 * localhost and the lint job's replay server at the port its service
 * publishes. One change to act's copy of yodel-pr.yml: the replay server's
 * port on the host. The emulator already holds 8123 and 5432 on the host,
 * so the service publishes on a free port, and the job's URL and wait step
 * follow it. The pushed workflow is untouched (the lint job's ci:check
 * reads it).
 *
 *   YODEL_CLAIMS_ACT                      the act binary, default act
 *   YODEL_CLAIMS_GITHUB_CLICKHOUSE_URL    the emulator as a job sees it, default YODEL_CLAIMS_CLICKHOUSE_URL's
 *   YODEL_CLAIMS_GITHUB_POSTGRES_URL      default YODEL_CLAIMS_POSTGRES_URL's
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { dockerSerializer } from "@intentius/chant-lexicon-docker";
import { publishedPort, uniqueContainerName } from "@intentius/chant-lexicon-sql/core/container";
import { endpoints } from "../lib/db.js";
import { run } from "../lib/exec.js";
import { NODE_IMAGE, type Forge, type ForgeRepo, type ForgeRun } from "./forge.js";
import { MOCK_PORT, MOCK_SERVICE, mockGithubEntities } from "./github.compose.js";

const USER = "yodel34";
const ACT = process.env.YODEL_CLAIMS_ACT ?? "act";
/** The actions the workflows use, which act fetches from github.com, not the mock. */
const ACTIONS = ["actions/checkout", "actions/setup-node"];

/** A port free on this host, for the replay service to publish on. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((ok) => server.listen(0, "0.0.0.0", ok));
  const { port } = server.address() as AddressInfo;
  await new Promise((ok) => server.close(ok));
  return port;
}

/** yodel-pr.yml as act runs it: the lint job's replay server published on `port` instead of the engine's own. */
export function actWorkflow(text: string, port: number): string {
  const engine = /- '(8123|5432):\1'/.exec(text)?.[1];
  if (!engine) throw new Error("yodel-pr.yml's lint job publishes no replay port (8123:8123 or 5432:5432); the template changed, so the claim's copy for act needs to follow it");
  const p = String(port);
  const out = text
    .replace(`- '${engine}:${engine}'`, `- '${p}:${engine}'`)
    .replaceAll(`localhost:${engine}`, `localhost:${p}`)
    .replaceAll(`net.connect(${engine}, "localhost"`, `net.connect(${p}, "localhost"`);
  if (!out.includes(`localhost:${p}`) || !out.includes(`net.connect(${p}, "localhost"`)) throw new Error(`yodel-pr.yml's lint job does not reach its replay server at localhost:${engine}; the claim's copy for act needs to follow the template`);
  return out;
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
      writeFileSync(secretFile, Object.entries({ ...secrets, GITHUB_TOKEN: token }).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });

      let n = 0;
      /** act on a fresh clone of `sha` (as branch `branch`), running `workflow` for `event`. */
      const act = async (event: string, workflow: string, branch: string, sha: string, payload: Record<string, unknown>): Promise<ForgeRun> => {
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
        const wfDir = join(ctx.work, `act-${String(n)}-workflows`);
        mkdirSync(wfDir, { recursive: true });
        const text = readFileSync(join(dir, ".github", "workflows", workflow), "utf8");
        writeFileSync(join(wfDir, workflow), workflow === "yodel-pr.yml" ? actWorkflow(text, await freePort()) : text);
        const eventFile = join(ctx.work, `act-${String(n)}-event.json`);
        writeFileSync(eventFile, JSON.stringify({ ...payload, repository }));
        ctx.log(`act ${event} ${workflow} on ${name}@${sha.slice(0, 8)} (${branch})`);
        const ran = await run(
          ACT,
          [
            event,
            "--workflows", wfDir,
            "--eventpath", eventFile,
            "--platform", `ubuntu-latest=${NODE_IMAGE}`,
            "--rm",
            "--github-instance", `localhost:${port}`,
            ...ACTIONS.flatMap((a) => ["--replace-ghe-action-with-github-com", a]),
            "--env", `GITHUB_API_URL=http://localhost:${port}/api/v3`,
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
      };
    },
    async close() {
      await down?.();
    },
  };
}
