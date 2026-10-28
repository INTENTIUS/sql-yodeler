/**
 * The project and the repository a yodel scenario runs on, made fresh for
 * each arm (INTENTIUS/sql-yodeler#302), and the yodel commands the driver's
 * ports and the out-of-band steps run in it.
 *
 * Each arm starts from nothing: the dialect's database and history are
 * dropped, the reader and writer made (scenarios/forges/template-body.ts
 * users), and the project made with `chant init --from <this
 * checkout>#templates/<dialect>`. It keeps the waves the scenario's setup
 * names (scenarios/harness/catalog.ts), takes this checkout's yodel from
 * `npm pack` (vendor/, committed, so every job's `npm ci` installs it: the
 * row's yodel is this commit's), and renders its pipelines with `yodel ci`.
 * Under the waves scenario's BREAK the waves are rendered with gate: never.
 * The base is committed with `[skip ci]`, so pushing it starts no run and
 * the ledger holds only the scenario's own runs. On the forge, the
 * repository gets the secrets the pipelines name (the servers as a job on
 * the harness network reaches them, chant's HARNESS_HOSTS), its pull
 * requests are closed, every branch but main is deleted (chant/lifecycle
 * with them) and main is forced to the base.
 *
 * The harness's Forgejo, its people and its runner are the maintainer's:
 *
 *   YODEL_HARNESS_FORGEJO_URL    default the harness's (harnessUrls)
 *   YODEL_HARNESS_REPO           <owner>/<repo>, default yodel-harness/yodel-<scenario>
 *   YODEL_HARNESS_ADMIN          <login>:<token>, a site admin (makes the repository, forces main)
 *   YODEL_HARNESS_AUTHOR         <login>:<token>, pushes, opens and merges
 *   YODEL_HARNESS_REVIEWER       <login>:<token>, reviews
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Dialect } from "../lib/claim.js";
import { dbFor } from "../lib/db.js";
import { run, type Ran } from "../lib/exec.js";
import { repoRoot } from "../lib/project.js";
import { READER, users, WRITER } from "../forges/template-body.js";
import type { RunRecordView } from "./harness.js";
import { makeOverlays } from "./overlays.js";
import type { Setup } from "./catalog.js";
import { setGate } from "./overlays.js";

export interface Person {
  login: string;
  token: string;
}

/** Where the harness's Forgejo is and who acts on it. */
export interface ForgeAccess {
  url: string;
  repo: string;
  admin: Person;
  author: Person;
  reviewer: Person;
}

/** A person from `<login>:<token>`. */
export function person(value: string | undefined, name: string): Person {
  const i = value?.indexOf(":") ?? -1;
  if (value === undefined || i <= 0 || i === value.length - 1) throw new Error(`${name} is not set as <login>:<token>; the harness scenarios act on Forgejo as three people`);
  return { login: value.slice(0, i), token: value.slice(i + 1) };
}

/** The forge access from the environment, for scenario `id`, with `defaultUrl` the harness's Forgejo. */
export function forgeAccess(env: NodeJS.ProcessEnv, id: string, defaultUrl: string): ForgeAccess {
  return {
    url: (env.YODEL_HARNESS_FORGEJO_URL ?? defaultUrl).replace(/\/+$/, ""),
    repo: env.YODEL_HARNESS_REPO ?? `yodel-harness/yodel-${id}`,
    admin: person(env.YODEL_HARNESS_ADMIN, "YODEL_HARNESS_ADMIN"),
    author: person(env.YODEL_HARNESS_AUTHOR, "YODEL_HARNESS_AUTHOR"),
    reviewer: person(env.YODEL_HARNESS_REVIEWER, "YODEL_HARNESS_REVIEWER"),
  };
}

/** The git remote of the repository as `who`. */
export const remoteAs = (a: ForgeAccess, who: Person): string =>
  `${a.url.replace("://", `://${encodeURIComponent(who.login)}:${encodeURIComponent(who.token)}@`)}/${a.repo}.git`;

/** One Forgejo API call as `who`; a 404 is null when `missingOk`. */
export async function forgejo<T>(a: ForgeAccess, who: Person, method: string, path: string, body?: unknown, missingOk = false): Promise<T | null> {
  const res = await fetch(`${a.url}/api/v1${path}`, {
    method,
    headers: { authorization: `token ${who.token}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 404 && missingOk) return null;
  const text = await res.text();
  if (!res.ok) throw new Error(`Forgejo ${method} ${path} answered ${String(res.status)}: ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

/** The dialect's names: the profile variables' prefix and the init parameters. */
export const dialectNames = (d: Dialect) => ({
  prefix: d === "ch" ? "DEV_CLICKHOUSE" : "DEV_POSTGRES",
  params: d === "ch" ? (["database", "history_database"] as const) : (["schema", "history_schema"] as const),
  template: d === "ch" ? "clickhouse" : "postgres",
});

/** The project of an arm, made by {@link seedArm}. */
export interface Seeded {
  dir: string;
  dialect: Dialect;
  /** The environment yodel runs with on this machine: the project's bin first, the dev profile's server and reader. */
  env: NodeJS.ProcessEnv;
  waves: readonly string[];
  overlays: Map<string, Record<string, string>>;
}

export interface SeedInput {
  id: string;
  dialect: Dialect;
  setup: Setup;
  /** BREAK's mode for this arm (the scenario's break.env YODEL_HARNESS_BREAK), or undefined for the plain arm. */
  breakMode: string | undefined;
  /** The arm's scratch directory; the project is made at `<work>/project`, fresh. */
  work: string;
  access: ForgeAccess;
  /** The servers as this machine reaches them, and as a job on the harness network does. */
  servers: { host: { clickhouse: string; postgres: string }; network: { clickhouse: string; postgres: string } };
  /** Forces main to the base commit (the harness forge's forceMain, which pushes from the project). */
  forceMain(sha: string): Promise<void>;
}

/** The project's own job, as the forge claim declares it (#65). */
const PROJECT_JOBS = `import { Job, Step } from "@intentius/chant-lexicon-github";
import { Image, Job as GitLabJob, Rule } from "@intentius/chant-lexicon-gitlab";

// The output is not the command's text, so a log that echoes commands does not hold it.
const say = 'echo "the project job, $((40 + 2))"';
export const actions = { "project-job": new Job({ "runs-on": "ubuntu-latest", steps: [new Step({ run: say })] }) };
export const gitlab = {
  "project-job": new GitLabJob({ stage: "test", image: new Image({ name: "node:22-bookworm" }), rules: [new Rule({ if: '$CI_PIPELINE_SOURCE == "merge_request_event"' })], script: [say] }),
};
`;

/** approval's policy at the base: no-drops refuses a drop in dev, and the harness may override it. */
export const HARNESS_OVERRIDER = "yodel-harness";
const POLICY = `  policy: { overriders: ["${HARNESS_OVERRIDER}"], rules: [{ id: "no-drops", environments: ["dev"], refuse: { classes: ["drop"] } }] },\n`;

/** yodel.config.ts as the setup and the arm want it. */
export function configFor(text: string, setup: Setup, breakMode: string | undefined): string {
  let out = text;
  if (!setup.waves.includes("prod")) {
    out = out.replace(/^ {4}prod: .*\n/m, "").replace(/^ {4}\{ env: "prod".*\n/m, "");
  }
  if (breakMode === "gate-never") for (const w of setup.waves) out = setGate(out, w, "never");
  if (setup.policy) out = out.replace(/^( {2}ci: \{)/m, `${POLICY}$1`);
  if (setup.projectJob) out = out.replace(/^( {2}ci: \{ forges: \[[^\]]*\])( \},)$/m, '$1, jobs: "ci/jobs.ts"$2');
  if (setup.policy && !out.includes('id: "no-drops"')) throw new Error("could not add the policy to yodel.config.ts");
  if (setup.projectJob && !out.includes('jobs: "ci/jobs.ts"')) throw new Error("could not name ci/jobs.ts in yodel.config.ts ci");
  return out;
}

/** The arm's project, its database and its repository, from nothing. */
export async function seedArm(i: SeedInput): Promise<Seeded> {
  const { dialect: d, setup } = i;
  const names = dialectNames(d);
  const db = dbFor(d, `harness-${setup.claim}`);
  await db.reset();
  await users({ dialect: d, db });

  mkdirSync(i.work, { recursive: true });
  const dir = join(i.work, "project");
  rmSync(dir, { recursive: true, force: true });
  const repoName = i.access.repo.split("/")[1] ?? i.id;
  const chant = join(repoRoot, "node_modules", ".bin", "chant");
  const init = await run(chant, ["init", "--from", `${repoRoot}#templates/${names.template}`, "--param", `name=${repoName}`, "--param", `${names.params[0]}=${db.name}`, "--param", `${names.params[1]}=${db.history}`, "project"], { cwd: i.work });
  if (init.code !== 0) throw new Error(`chant init --from templates/${names.template} failed: ${init.err.slice(-400)}`);

  // The waves the setup keeps: without prod, prod's profile, Ops and pipelines go.
  if (!setup.waves.includes("prod")) {
    const chantConfig = join(dir, "chant.config.ts");
    writeFileSync(chantConfig, readFileSync(chantConfig, "utf8").replace(/^ {6}prod: \w+\("prod".*\n/m, ""));
    for (const f of ["ops/migrate-prod.op.ts", "ops/watch-prod.op.ts", ".forgejo/workflows/watch-prod.yml", ".github/workflows/watch-prod.yml"]) rmSync(join(dir, f), { force: true });
    for (const f of existsSync(join(dir, ".gitlab")) ? readdirSync(join(dir, ".gitlab"), { recursive: true }) : []) {
      if (String(f).includes("prod")) rmSync(join(dir, ".gitlab", String(f)), { force: true });
    }
  }
  if (setup.projectJob) {
    mkdirSync(join(dir, "ci"), { recursive: true });
    writeFileSync(join(dir, "ci", "jobs.ts"), PROJECT_JOBS);
  }
  const configPath = join(dir, "yodel.config.ts");
  writeFileSync(configPath, configFor(readFileSync(configPath, "utf8"), setup, i.breakMode));

  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "CI" && !k.startsWith("GITHUB_"))),
    PATH: `${join(dir, "node_modules", ".bin")}:${process.env.PATH ?? ""}`,
    [`${names.prefix}_URL`]: d === "ch" ? i.servers.host.clickhouse : i.servers.host.postgres,
    [`${names.prefix}_READER_USER`]: READER.user,
    [`${names.prefix}_READER_PASSWORD`]: READER.password,
    NO_COLOR: "1",
  };
  // The out-of-band steps (scenarios/harness/act.ts) run yodel with the same profile.
  writeFileSync(join(i.work, "yodel-env.json"), `${JSON.stringify(Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith(names.prefix))), null, 2)}\n`);
  const sh = async (cmd: string, args: string[], timeoutMs = 600_000): Promise<Ran> => {
    const ran = await run(cmd, args, { cwd: dir, env, timeoutMs });
    if (ran.code !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${String(ran.code)}: ${ran.err.slice(-400)}`);
    return ran;
  };
  await sh("npm", ["install", "--no-audit", "--no-fund"]);
  // This checkout's yodel, packed and committed with the project: every job's npm ci installs the same.
  const vendor = join(dir, "vendor");
  mkdirSync(vendor, { recursive: true });
  const packed = await run("npm", ["pack", "--ignore-scripts", "--pack-destination", vendor], { cwd: repoRoot, timeoutMs: 300_000 });
  const tgz = packed.out.trim().split("\n").at(-1) ?? "";
  if (packed.code !== 0 || !tgz.endsWith(".tgz")) throw new Error(`npm pack of this checkout failed: ${packed.err}`);
  await sh("npm", ["install", "--no-audit", "--no-fund", `./vendor/${tgz}`]);
  await sh("npx", ["yodel", "new", "init"]);
  await sh("git", ["init", "-q", "-b", "main"]);
  await sh("git", ["config", "user.name", i.access.admin.login]);
  await sh("git", ["config", "user.email", `${i.access.admin.login}@yodel-harness.invalid`]);
  await sh("git", ["config", "commit.gpgsign", "false"]);
  // The apply waves read their gate at the first parent, so the base has one.
  await sh("git", ["commit", "-q", "--allow-empty", "-m", "chore: start [skip ci]"]);
  await sh("npm", ["run", "ci"]);
  await sh("git", ["add", "-A"]);
  await sh("git", ["commit", "-qm", "feat: the harness base [skip ci]"]);
  const base = (await sh("git", ["rev-parse", "HEAD"])).out.trim();

  await prepareRepo(i, d);
  await sh("git", ["remote", "add", "origin", remoteAs(i.access, i.access.admin)]);
  await i.forceMain(base);

  const clone = join(i.work, "overlays");
  rmSync(clone, { recursive: true, force: true });
  const overlays = await makeOverlays({ dir, dialect: d, env }, clone, setup.overlays);
  return { dir, dialect: d, env, waves: setup.waves, overlays };
}

/** The repository, made when missing, with the pipelines' secrets, no pull request open and no branch but main. */
async function prepareRepo(i: SeedInput, d: Dialect): Promise<void> {
  const a = i.access;
  const [owner = "", name = ""] = a.repo.split("/");
  const r = `/repos/${a.repo}`;
  if ((await forgejo(a, a.admin, "GET", r, undefined, true)) === null) {
    const orgUser = await forgejo(a, a.admin, "GET", `/orgs/${owner}`, undefined, true);
    if (orgUser === null) await forgejo(a, a.admin, "POST", "/orgs", { username: owner, visibility: "public" });
    await forgejo(a, a.admin, "POST", `/orgs/${owner}/repos`, { name, private: false, auto_init: false });
  }
  await forgejo(a, a.admin, "PATCH", r, { has_actions: true });
  for (const p of [a.author, a.reviewer]) await forgejo(a, a.admin, "PUT", `${r}/collaborators/${p.login}`, { permission: "write" });
  const prefix = dialectNames(d).prefix;
  const secrets: Record<string, string> = {
    [`${prefix}_URL`]: d === "ch" ? i.servers.network.clickhouse : i.servers.network.postgres,
    [`${prefix}_READER_USER`]: READER.user,
    [`${prefix}_READER_PASSWORD`]: READER.password,
    [`${prefix}_WRITER_USER`]: WRITER.user,
    [`${prefix}_WRITER_PASSWORD`]: WRITER.password,
  };
  for (const [k, v] of Object.entries(secrets)) await forgejo(a, a.admin, "PUT", `${r}/actions/secrets/${k}`, { data: v });
  for (const pull of (await forgejo<Array<{ number: number }>>(a, a.admin, "GET", `${r}/pulls?state=open&limit=50`)) ?? []) {
    await forgejo(a, a.admin, "PATCH", `${r}/pulls/${String(pull.number)}`, { state: "closed" });
  }
  for (const b of (await forgejo<Array<{ name: string }>>(a, a.admin, "GET", `${r}/branches?limit=50`, undefined, true)) ?? []) {
    if (b.name !== "main") await forgejo(a, a.admin, "DELETE", `${r}/branches/${encodeURIComponent(b.name)}`, undefined, true);
  }
}

// ── yodel in the project ─────────────────────────────────────────────────────

/**
 * Runs the project's yodel with a terminal that answers every question with
 * `answer`, as a person approving at a terminal does (yodel approve asks for
 * the environment's name and never approves without it).
 */
export async function yodelAsking(p: Pick<Seeded, "dir" | "env">, answer: string, args: string[], extra: NodeJS.ProcessEnv = {}): Promise<Ran> {
  // Under node_modules, so the script resolves tsx and yodel from the project.
  const script = join(p.dir, "node_modules", ".yodel-harness-ask.mjs");
  if (!existsSync(script)) {
    const cli = pathToFileURL(join(p.dir, "node_modules", "@intentius", "sql-yodeler", "dist", "cli.js")).href;
    writeFileSync(
      script,
      `import { register } from "tsx/esm/api";
register();
const { main } = await import(${JSON.stringify(cli)});
const [answer, ...args] = process.argv.slice(2);
process.exitCode = await main(args, {
  out: (t) => process.stdout.write(t),
  err: (t) => process.stderr.write(t),
  ask: async (q) => { process.stderr.write(q + answer + "\\n"); return answer; },
});
`,
    );
  }
  return run("node", [script, answer, ...args], { cwd: p.dir, env: { ...p.env, ...extra }, timeoutMs: 600_000 });
}

/** main and chant/lifecycle from the forge into the project: main fast-forwarded, the ledger branch forced to the forge's. */
export async function pullProject(p: Pick<Seeded, "dir" | "env">): Promise<void> {
  const git = (args: string[]) => run("git", args, { cwd: p.dir, env: p.env, timeoutMs: 120_000 });
  const fetched = await git(["fetch", "-q", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  if (fetched.code !== 0) throw new Error(`git fetch origin main failed: ${fetched.err}`);
  const merged = await git(["merge", "-q", "--ff-only", "origin/main"]);
  if (merged.code !== 0) throw new Error(`main does not fast-forward to the forge's: ${merged.err}`);
  // No ledger branch on the forge yet is nothing approved yet.
  await git(["fetch", "-q", "origin", "+refs/heads/chant/lifecycle:refs/heads/chant/lifecycle"]);
}

/** Pushes the project's chant/lifecycle, where an approval or an override was just recorded. */
export async function pushLedger(p: Pick<Seeded, "dir" | "env">): Promise<void> {
  const pushed = await run("git", ["push", "-q", "origin", "chant/lifecycle"], { cwd: p.dir, env: p.env, timeoutMs: 120_000 });
  if (pushed.code !== 0) throw new Error(`git push origin chant/lifecycle failed: ${pushed.err}`);
}

/** The run ledger's `op` records under `env`, as the forge's chant/lifecycle has them now. */
export async function ledgerRuns(p: Pick<Seeded, "dir" | "env">, env: string, op: string): Promise<RunRecordView[]> {
  await run("git", ["fetch", "-q", "origin", "+refs/heads/chant/lifecycle:refs/heads/chant/lifecycle"], { cwd: p.dir, env: p.env, timeoutMs: 120_000 });
  const { readRunLedger } = await import("@intentius/chant/lifecycle/run-ledger");
  const { records } = await readRunLedger(env, op, { cwd: p.dir });
  return records;
}

/** The environment of wave `gate` (`yodel-apply-wave-<k>`), from the waves in order. */
export function envOfGate(gate: string, waves: readonly string[]): string {
  const k = Number(/-wave-(\d+)$/.exec(gate)?.[1] ?? NaN);
  const env = waves[k - 1];
  if (env === undefined) throw new Error(`${gate} is not a wave gate of ${waves.join(", ")}`);
  return env;
}
