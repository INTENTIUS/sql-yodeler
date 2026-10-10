/**
 * Renders this project's CI for GitHub Actions, GitLab CI and Forgejo Actions.
 *
 *   npm run ci          write the files
 *   npm run ci:check    exit 1 when a file differs from what this renders
 *
 * Environments are the keys of `sql.profiles` in chant.config.ts, in order,
 * but `replay`, which is the lint job's throwaway server.
 * Each one needs ops/migrate-<env>.op.ts and ops/watch-<env>.op.ts.
 *
 * Three pipelines per forge, each declared with chant: yodel-pr and
 * yodel-apply with the github lexicon's Workflow, Job and Step (Forgejo
 * renders the same declaration through the forgejo lexicon's dialect) and
 * the gitlab lexicon's Workflow and Job; the watch with generateOpsPipeline.
 *
 * - yodel-pr: on a pull (merge) request, `npm run ci:check` (these files are
 *   what this script renders), `yodel lint`, and the replay check into a
 *   throwaway server the job starts (the `replay` profile), then for each
 *   environment `yodel plan <env> --comment`, which posts the pending
 *   migrations and the digest to approve. One job per environment, holding
 *   that environment's reader credentials and nothing else.
 * - yodel-apply: on a push to main, `yodel apply <env>` for each environment
 *   in order. The only jobs that hold a writer's credentials, one
 *   environment's each, with YODEL_CREDENTIALS=writer.
 * - watch-<env>: the environment's WatchOp on its own schedule, rendered by
 *   chant's generateOpsPipeline, with the reader's credentials. The job fails
 *   when the run found drift (scripts/watch-outcome.ts).
 *
 * The scheduled watch never pushes. Its first phase (chant lifecycle
 * snapshot) commits a snapshot to chant/lifecycle and tries to push it; the
 * drift it reports comes from `chant lifecycle diff --live`, declared against
 * live, which needs no snapshot on the remote. So the job sets a push URL
 * that cannot be pushed to: the push fails, chant carries on, and the job
 * works the same with a read-only token (GitHub `contents: read`, GitLab's
 * CI_JOB_TOKEN) as with Forgejo's token, which can write. A push that could
 * land would race the approvals people push to chant/lifecycle.
 *
 * Every job installs @intentius/sql-yodeler from npm with `npm ci`, which
 * needs no token.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Declarable } from "@intentius/chant/declarable";
import type { SerializerResult } from "@intentius/chant/serializer";
import { emitYAMLEntry } from "@intentius/chant/yaml";
import {
  Concurrency,
  Job as ActionsJob,
  Permissions,
  Service as ActionsService,
  Step,
  Workflow as ActionsWorkflow,
} from "@intentius/chant-lexicon-github";
import { githubSerializer } from "@intentius/chant-lexicon-github/serializer";
import { forgejoSerializer } from "@intentius/chant-lexicon-forgejo/serializer";
import {
  Environment as GitLabEnvironment,
  Image,
  Job as GitLabJob,
  Need,
  Rule,
  Service as GitLabService,
  Workflow as GitLabWorkflow,
  WorkflowRule,
} from "@intentius/chant-lexicon-gitlab";
import { gitlabSerializer } from "@intentius/chant-lexicon-gitlab/serializer";

export type Forge = "github" | "gitlab" | "forgejo";
export const FORGES: readonly Forge[] = ["github", "gitlab", "forgejo"];

export interface RenderedFile {
  /** Relative to the project. */
  path: string;
  content: string;
}

/** The image every job runs in, where the forge runs jobs in a container. It needs git, so not -slim. */
export const IMAGE = "node:22-bookworm";
export const MAIN = "main";

/** The forgejo lexicon rewrites it to https://code.forgejo.org/actions/checkout@v7 on Forgejo. */
const CHECKOUT = "actions/checkout@v7";
const SETUP_NODE = "actions/setup-node@v7";

/** DEV for dev: the prefix of an environment's variables. */
export const prefixOf = (env: string): string => env.toUpperCase().replace(/[^A-Z0-9]/g, "_");

export type Dialect = "clickhouse" | "postgres";

/** The environments to render for: chant.config.ts's sql.dialect and its profiles, in order. */
export interface Environments {
  dialect: Dialect;
  names: readonly string[];
  /** chant.config.ts declares the `replay` profile, so the lint job runs the replay check. */
  replay: boolean;
}

/** DEV_CLICKHOUSE for dev on ClickHouse: what an environment's variables start with. */
const variablePrefix = (env: string, dialect: Dialect): string => `${prefixOf(env)}_${dialect.toUpperCase()}`;

/** The variables a job reading `env` holds: the URL and the reader. */
export const readerVariables = (env: string, dialect: Dialect): string[] => {
  const p = variablePrefix(env, dialect);
  return [`${p}_URL`, `${p}_READER_USER`, `${p}_READER_PASSWORD`];
};

/** The variables the apply job for `env` holds: the URL and the writer. */
export const writerVariables = (env: string, dialect: Dialect): string[] => {
  const p = variablePrefix(env, dialect);
  return [`${p}_URL`, `${p}_WRITER_USER`, `${p}_WRITER_PASSWORD`];
};

const secret = (name: string) => `\${{ secrets.${name} }}`;
const secrets = (names: readonly string[]) => Object.fromEntries(names.map((n) => [n, secret(n)]));

/**
 * The approvals: `chant approve` records them on the chant/lifecycle branch,
 * and approvers push it. A CI checkout fetches one ref, so fetch this one too.
 * The remote-tracking ref is what chant's push lease reads.
 */
export const FETCH_APPROVALS =
  "git fetch --no-tags origin '+refs/heads/chant/lifecycle:refs/remotes/origin/chant/lifecycle' && git branch -f chant/lifecycle origin/chant/lifecycle || echo 'no chant/lifecycle branch yet, so nothing is approved'";

/** The watch reads; it never pushes. See the comment at the top. */
export const NO_PUSH = "git remote set-url --push origin no-push://the-drift-watch-only-reads";

/** After the watch's `chant run`: exit 1 when that run found drift (scripts/watch-outcome.ts). */
export const watchOutcome = (op: string): string => `tsx scripts/watch-outcome.ts ${op}`;

/**
 * The replay check: `yodel lint --replay replay --reset` replays every
 * migration, in order, into a fresh database on the `replay` profile's
 * server and fails when one does not give the schema it recorded. That
 * server is a throwaway container the lint job starts as a service, the
 * image chant's emulator runs, which the job (in IMAGE, on every forge)
 * reaches by the service's name; never a server whose data matters, since
 * --reset drops what the history names there first.
 */
export const REPLAY_PROFILE = "replay";

interface ReplayService {
  /**
   * The service's name, and its host where the job runs in a container.
   * Prefixed, so it cannot meet another container's alias on a runner's
   * shared network: a host that answers for two servers would split the replay.
   */
  name: string;
  image: string;
  port: number;
  /** The service container's environment. */
  env: Record<string, string>;
  health: string;
  url: (host: string) => string;
  /** What the lint job sets besides the URL: the throwaway server's credentials. */
  jobEnv: Record<string, string>;
}

export const REPLAY_SERVICE: Record<Dialect, ReplayService> = {
  clickhouse: {
    name: "replay-clickhouse",
    image: "clickhouse/clickhouse-server:26.8.15.10",
    port: 8123,
    // The default user, with no password, from outside the container.
    env: { CLICKHOUSE_SKIP_USER_SETUP: "1" },
    health: "clickhouse-client --query 'SELECT 1'",
    url: (host) => `http://${host}:8123`,
    jobEnv: {},
  },
  postgres: {
    name: "replay-postgres",
    image: "postgres:18.6",
    port: 5432,
    env: { POSTGRES_PASSWORD: "replay" },
    health: "pg_isready -U postgres",
    url: (host) => `postgres://${host}:5432/postgres`,
    jobEnv: { REPLAY_POSTGRES_USER: "postgres", REPLAY_POSTGRES_PASSWORD: "replay" },
  },
};

/** Waits up to 90 s for the replay server's port; a shell-free one-liner, so every forge runs it the same. */
export const waitFor = (host: string, port: number): string =>
  `node -e 'const net = require("net"); let n = 0; (function t() { const s = net.connect(${String(port)}, "${host}", () => { s.end(); process.exit(0); }); s.on("error", () => { if (++n > 90) { console.error("${host}:${String(port)} did not answer"); process.exit(1); } setTimeout(t, 1000); }); })()'`;

export const LINT = "yodel lint";
export const REPLAY = `yodel lint --replay ${REPLAY_PROFILE} --reset`;

/** Fails a pull request whose pipelines differ from what this script renders. */
export const CI_CHECK = "npm run ci:check";

/**
 * The comment at the top of every file. Added here, not by chant: neither the
 * github nor the gitlab lexicon's serializer writes YAML comments
 * (INTENTIUS/chant#3667, INTENTIUS/chant#3669).
 */
const HEADER = [
  "# Rendered by scripts/ci.ts (npm run ci) from chant.config.ts and ops/.",
  "# Edit those and render again; npm run ci:check says when this file is stale.",
];

const withHeader = (header: readonly string[], yaml: string): string => `${[...header, ""].join("\n")}${yaml}`;

/** A serializer's output for one file: its YAML, refusing anything else (a second file, a warning). */
function oneFile(forge: Forge, out: string | SerializerResult): string {
  if (typeof out === "string") return out;
  const extra = [...Object.keys(out.files ?? {}), ...(out.warnings ?? [])];
  if (extra.length > 0) throw new Error(`${forge}: expected one file and no warnings, got ${extra.join("; ")}`);
  return out.primary;
}

// ── GitHub Actions and Forgejo Actions ──────────────────────────────────────
//
// One declaration, rendered by the github lexicon for GitHub and by the
// forgejo lexicon for Forgejo. The forgejo dialect maps runs-on ubuntu-latest
// to the runner label docker, resolves actions/checkout on code.forgejo.org
// and drops the permissions block, which Forgejo does not read.

type Actions = "github" | "forgejo";
type AStep = InstanceType<typeof Step>;
type AJob = InstanceType<typeof ActionsJob>;
type AWorkflow = InstanceType<typeof ActionsWorkflow>;

function renderActions(forge: Actions, workflow: AWorkflow): string {
  const serializer = forge === "github" ? githubSerializer : forgejoSerializer;
  return oneFile(forge, serializer.serialize(new Map([["workflow", workflow]])));
}

/** `inContainer`: the job runs in IMAGE, which has node, so it needs no setup-node. */
function setupSteps(inContainer: boolean): AStep[] {
  // Step inputs are strings in the lexicon's schema (INTENTIUS/chant#3670); the actions read them as strings either way.
  const steps = [new Step({ uses: CHECKOUT, with: { "fetch-depth": "0" } })];
  if (!inContainer) steps.push(new Step({ uses: SETUP_NODE, with: { "node-version": "22", cache: "npm" } }));
  steps.push(
    new Step({ run: "npm ci" }),
    new Step({ run: 'echo "$PWD/node_modules/.bin" >> "$GITHUB_PATH"' }),
    new Step({ name: "Fetch the approvals (chant/lifecycle)", run: FETCH_APPROVALS }),
  );
  return steps;
}

/** Forgejo runs every job in IMAGE; GitHub on the runner's VM, unless the job asks for the container. */
const inContainer = (forge: Actions): boolean => forge === "forgejo";
const runner = (container: boolean) => ({ "runs-on": "ubuntu-latest", ...(container ? { container: IMAGE } : {}) });

/** The token `yodel plan --comment` posts with: the job's own. */
function commentToken(forge: Actions): Record<string, string> {
  return forge === "github" ? { GITHUB_TOKEN: "${{ github.token }}" } : { FORGEJO_TOKEN: "${{ github.token }}" };
}

function lintJob(forge: Actions, dialect: Dialect, replay: boolean): AJob {
  // With the replay check, the job runs in IMAGE on every forge and reaches
  // its replay server by the service's name on the job's own network. On
  // GitHub's VM the service would be on localhost through a published port,
  // which collides with any database already on that port (act, a
  // self-hosted runner).
  const container = replay || inContainer(forge);
  const steps = [
    ...setupSteps(container),
    new Step({ name: "The pipelines are up to date", run: CI_CHECK }),
    new Step({ name: "yodel lint", run: LINT }),
  ];
  if (!replay) return new ActionsJob({ ...runner(container), steps });
  const svc = REPLAY_SERVICE[dialect];
  return new ActionsJob({
    ...runner(container),
    services: {
      [svc.name]: new ActionsService({
        image: svc.image,
        env: svc.env,
        options: `--health-cmd "${svc.health}" --health-interval 2s --health-timeout 5s --health-retries 45`,
      }),
    },
    env: { [`${variablePrefix(REPLAY_PROFILE, dialect)}_URL`]: svc.url(svc.name), ...svc.jobEnv },
    steps: [
      ...steps,
      new Step({ name: `Wait for the replay server (${svc.name})`, run: waitFor(svc.name, svc.port) }),
      new Step({ name: "yodel lint --replay", run: REPLAY }),
    ],
  });
}

export function actionsReview(forge: Actions, { dialect, names: envs, replay }: Environments): RenderedFile {
  const jobs: Record<string, AJob> = { lint: lintJob(forge, dialect, replay) };
  for (const env of envs) {
    jobs[`plan-${env}`] = new ActionsJob({
      ...runner(inContainer(forge)),
      env: secrets(readerVariables(env, dialect)),
      steps: [
        // The plan explains what moved since an approval from git's history of migrations/.
        ...setupSteps(inContainer(forge)),
        new Step({ name: `yodel plan ${env} --comment`, run: `yodel plan ${env} --comment`, env: commentToken(forge) }),
      ],
    });
  }
  const workflow = new ActionsWorkflow({
    name: "yodel-pr",
    on: { pull_request: { branches: [MAIN] } },
    permissions: new Permissions({ contents: "read", "pull-requests": "write" }),
    concurrency: new Concurrency({ group: "yodel-pr-${{ github.event.pull_request.number }}", "cancel-in-progress": true }),
    jobs,
  });
  const header = [
    ...HEADER,
    "#",
    "# Pull requests: yodel lint and the replay check (into a throwaway server the",
    "# lint job starts), and the plan comment per environment with the",
    "# environment's reader credentials. No job here holds a writer.",
    ...(forge === "forgejo"
      ? ["# The comment is posted with the job's own token (Forgejo gives a same-repository", "# pull request one that can comment)."]
      : []),
  ];
  return {
    path: `${forge === "github" ? ".github" : ".forgejo"}/workflows/yodel-pr.yml`,
    content: withHeader(header, renderActions(forge, workflow)),
  };
}

export function actionsApply(forge: Actions, { dialect, names: envs }: Environments): RenderedFile {
  const jobs: Record<string, AJob> = {};
  let previous: string | undefined;
  for (const env of envs) {
    const job = `apply-${env}`;
    jobs[job] = new ActionsJob({
      ...runner(inContainer(forge)),
      ...(previous ? { needs: [previous] } : {}),
      // A GitHub environment holds the writer's secrets, restricted to main.
      ...(forge === "github" ? { environment: env } : {}),
      concurrency: new Concurrency({ group: `yodel-apply-${env}`, "cancel-in-progress": false }),
      env: { YODEL_CREDENTIALS: "writer", ...secrets(writerVariables(env, dialect)) },
      steps: [...setupSteps(inContainer(forge)), new Step({ name: `yodel apply ${env}`, run: `yodel apply ${env}` })],
    });
    previous = job;
  }
  const workflow = new ActionsWorkflow({
    name: "yodel-apply",
    on: { push: { branches: [MAIN] }, workflow_dispatch: {} },
    permissions: new Permissions({ contents: "read" }),
    jobs,
  });
  const header = [
    ...HEADER,
    "#",
    "# A push to main: yodel apply per environment, in order. These are the only",
    "# jobs that hold a writer's credentials, one environment's each. yodel apply",
    "# runs the environment's migrate Op, whose gate needs an approval of the plan",
    "# digest the pull request comment showed: run the chant approve command from",
    "# the comment and push chant/lifecycle. Without one, the job fails with the",
    "# command to run, and applies nothing; approve, then run this workflow again.",
    ...(forge === "forgejo"
      ? ["#", "# Forgejo has no environments: every secret is the repository's. Name each in", "# its own job only, as below, and keep who can push workflows short."]
      : []),
  ];
  return {
    path: `${forge === "github" ? ".github" : ".forgejo"}/workflows/yodel-apply.yml`,
    content: withHeader(header, renderActions(forge, workflow)),
  };
}

// ── GitLab CI ───────────────────────────────────────────────────────────────

export const GITLAB_WATCH_FILE = ".gitlab/yodel-watch.gitlab-ci.yml";

/** The stages the watch file's jobs use, after the ones this file's jobs use. */
const GITLAB_STAGES = ["review", "apply", "ops"];

export function gitlabPipeline({ dialect, names: envs, replay }: Environments): RenderedFile {
  const mr = () => [new Rule({ if: '$CI_PIPELINE_SOURCE == "merge_request_event"' })];
  const workflow = new GitLabWorkflow({
    rules: [
      new WorkflowRule({ if: '$CI_PIPELINE_SOURCE == "merge_request_event"' }),
      new WorkflowRule({ if: "$CI_COMMIT_BRANCH && $CI_OPEN_MERGE_REQUESTS", when: "never" }),
      new WorkflowRule({ if: "$CI_COMMIT_BRANCH" }),
    ],
  });
  const jobs = new Map<string, Declarable>();
  jobs.set(
    ".yodel",
    new GitLabJob({
      image: new Image({ name: IMAGE }),
      before_script: ["npm ci", 'export PATH="$PWD/node_modules/.bin:$PATH"', FETCH_APPROVALS],
    }),
  );
  const svc = REPLAY_SERVICE[dialect];
  jobs.set(
    "lint",
    new GitLabJob({
      extends: ".yodel",
      stage: "review",
      rules: mr(),
      ...(replay
        ? {
            script: [CI_CHECK, LINT, waitFor(svc.name, svc.port), REPLAY],
            services: [new GitLabService({ name: svc.image, alias: svc.name, variables: svc.env })],
            variables: { [`${variablePrefix(REPLAY_PROFILE, dialect)}_URL`]: svc.url(svc.name), ...svc.jobEnv },
          }
        : { script: [CI_CHECK, LINT] }),
    }),
  );
  for (const env of envs) {
    jobs.set(`plan-${env}`, new GitLabJob({ extends: ".yodel", stage: "review", rules: mr(), script: [`yodel plan ${env} --comment`] }));
  }
  let previous: string | undefined;
  for (const env of envs) {
    const job = `apply-${env}`;
    jobs.set(
      job,
      new GitLabJob({
        extends: ".yodel",
        stage: "apply",
        rules: [new Rule({ if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && ($CI_PIPELINE_SOURCE == "push" || $CI_PIPELINE_SOURCE == "web")' })],
        ...(previous ? { needs: [new Need({ job: previous })] } : {}),
        // The writer's variables are scoped to this environment, so no other job gets them.
        environment: new GitLabEnvironment({ name: env }),
        resource_group: `yodel-apply-${env}`,
        variables: { YODEL_CREDENTIALS: "writer" },
        script: [`yodel apply ${env}`],
      }),
    );
    previous = job;
  }

  const serialize = (entities: Map<string, Declarable>): string => oneFile("gitlab", gitlabSerializer.serialize(entities));
  // Exception (INTENTIUS/chant#3669): the gitlab serializer writes no
  // top-level include or variables, and its stages are only the ones the
  // declared jobs name, so not the watch file's ops. It writes those stages
  // first; they are replaced by GITLAB_STAGES, and include and variables are
  // written beside them.
  const derived = `${emitYAMLEntry("stages", GITLAB_STAGES.slice(0, 2))}\n\n`;
  const jobsYaml = serialize(jobs);
  if (!jobsYaml.startsWith(derived)) throw new Error(`gitlab: expected the jobs' YAML to start with\n${derived}`);
  const topLevel = [
    emitYAMLEntry("include", [{ local: GITLAB_WATCH_FILE }]),
    emitYAMLEntry("stages", GITLAB_STAGES),
    emitYAMLEntry("variables", { GIT_DEPTH: "0" }),
  ];
  const yaml = `${serialize(new Map([["workflow", workflow]]))}\n${topLevel.join("\n\n")}\n\n${jobsYaml.slice(derived.length)}`;

  const variables = envs.flatMap((env) => [
    `#   ${readerVariables(env, dialect).join(", ")}: not protected (merge request`,
    "#     pipelines run on unprotected branches), masked; no environment scope.",
    `#   ${writerVariables(env, dialect).slice(1).join(", ")}: protected, masked,`,
    `#     environment scope "${env}": only apply-${env} declares that environment.`,
  ]);
  const header = [
    ...HEADER,
    "#",
    "# Merge requests: lint and the plan comment (stage review). A push to the",
    "# default branch: yodel apply per environment (stage apply). The drift",
    `# watches are in ${GITLAB_WATCH_FILE} (stage ops).`,
    "#",
    "# GitLab gives every job the project's CI/CD variables unless a variable is",
    "# protected or scoped to an environment, so the split between reader and",
    "# writer is in the variables' settings (Settings > CI/CD > Variables):",
    ...variables,
    "#   GITLAB_TOKEN: a project access token with the api scope (Reporter), for",
    "#     the plan comment; CI_JOB_TOKEN cannot write merge request notes.",
    "# The jobs that hold no writer read with the reader: chant.config.ts picks",
    "# the writer only under YODEL_CREDENTIALS=writer, which only the apply jobs set.",
  ];
  return { path: ".gitlab-ci.yml", content: withHeader(header, yaml) };
}

// ── The drift watch, through chant's generateOpsPipeline ────────────────────

interface OpsPipelineResult {
  success: boolean;
  files?: Array<{ name: string; yaml: string }>;
  error?: string;
}

/**
 * The watch's spec for one environment: the Op, and on GitHub and Forgejo the
 * reader's secrets. A GitLab job already has the project's variables (a
 * writer's only under its environment, which the watch does not declare), and
 * `NAME: $NAME` there would refer to itself.
 */
export function watchSpec(env: string, dialect: Dialect, forge: Forge): { name: string; variables?: Record<string, string> } {
  if (forge === "gitlab") return { name: `watch-${env}` };
  return { name: `watch-${env}`, variables: secrets(readerVariables(env, dialect)) };
}

export async function watchPipelines(dir: string, { dialect, names: envs }: Environments): Promise<RenderedFile[]> {
  const { generateOpsPipeline } = (await import("@intentius/chant/op")) as unknown as {
    generateOpsPipeline: (ops: unknown[], lexicon: string, options: Record<string, unknown>, cwd: string) => Promise<OpsPipelineResult>;
  };
  const out: RenderedFile[] = [];
  const emit = async (forge: Forge, specs: unknown[], extraScript: string[]) => {
    const path = forge === "gitlab" ? 'export PATH="$PWD/node_modules/.bin:$PATH"' : 'echo "$PWD/node_modules/.bin" >> "$GITHUB_PATH"';
    const result = await generateOpsPipeline(
      specs,
      forge,
      {
        image: IMAGE,
        beforeScript: ["npm ci", path, FETCH_APPROVALS, NO_PUSH],
        extraScript,
        ...(forge === "gitlab" ? { opsStage: "ops", opsFileName: GITLAB_WATCH_FILE } : {}),
      },
      dir,
    );
    if (!result.success || !result.files) throw new Error(`${forge}: ${result.error ?? "generateOpsPipeline rendered nothing"}`);
    for (const file of result.files) {
      const at = forge === "gitlab" ? GITLAB_WATCH_FILE : `${forge === "github" ? ".github" : ".forgejo"}/workflows/${file.name}`;
      out.push({ path: at, content: `${HEADER.join("\n")}\n${file.yaml.endsWith("\n") ? file.yaml : `${file.yaml}\n`}` });
    }
  };
  // `chant run` exits 0 when a watch finds drift; the last line fails the job then.
  for (const forge of ["github", "forgejo"] as const) {
    for (const env of envs) await emit(forge, [watchSpec(env, dialect, forge)], [watchOutcome(`watch-${env}`)]);
  }
  // GitLab: one file for every watch, so the last line names the job's own Op.
  await emit("gitlab", envs.map((env) => watchSpec(env, dialect, "gitlab")), [watchOutcome('"$CI_JOB_NAME"')]);
  return out;
}

// ── The project ─────────────────────────────────────────────────────────────

/** The dialect and the environments chant.config.ts declares, in order. */
export async function environments(dir: string): Promise<Environments> {
  const { loadChantConfig } = await import("@intentius/chant/config");
  const { config } = await loadChantConfig(dir);
  const sql = (config as { sql?: { dialect?: unknown; profiles?: Record<string, unknown> } }).sql;
  const dialect = sql?.dialect;
  if (dialect !== "clickhouse" && dialect !== "postgres") throw new Error(`chant.config.ts: sql.dialect must be clickhouse or postgres, got ${String(dialect)}`);
  const all = Object.keys(sql?.profiles ?? {});
  const replay = all.includes(REPLAY_PROFILE);
  const envs = all.filter((name) => name !== REPLAY_PROFILE);
  if (envs.length === 0) throw new Error("chant.config.ts declares no sql.profiles");
  for (const env of envs) {
    for (const op of [`migrate-${env}`, `watch-${env}`]) {
      if (!existsSync(join(dir, "ops", `${op}.op.ts`))) throw new Error(`sql.profiles.${env} has no ops/${op}.op.ts`);
    }
  }
  return { dialect, names: envs, replay };
}

/** The pipelines that need no Op discovery: pull requests and apply. */
export function reviewAndApply(envs: Environments): RenderedFile[] {
  return [
    actionsReview("github", envs),
    actionsApply("github", envs),
    actionsReview("forgejo", envs),
    actionsApply("forgejo", envs),
    gitlabPipeline(envs),
  ];
}

export async function render(dir: string): Promise<RenderedFile[]> {
  const envs = await environments(dir);
  return [...reviewAndApply(envs), ...(await watchPipelines(dir, envs))];
}

async function main(argv: readonly string[]): Promise<number> {
  const dir = resolve(".");
  const check = argv.includes("--check");
  const files = await render(dir);
  const stale: string[] = [];
  for (const file of files) {
    const abs = join(dir, file.path);
    const current = existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
    if (current === file.content) continue;
    if (check) {
      stale.push(file.path);
      continue;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, file.content);
    console.log(`wrote ${file.path}`);
  }
  if (check && stale.length > 0) {
    console.error(`stale, run npm run ci: ${stale.join(", ")}`);
    return 1;
  }
  if (check) console.log(`${String(files.length)} CI files are up to date`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
