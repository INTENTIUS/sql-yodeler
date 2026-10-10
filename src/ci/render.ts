/**
 * `yodel ci` (#65): a project's CI for GitHub Actions, GitLab CI and Forgejo
 * Actions, rendered by the installed package, so a fix to the pipelines
 * reaches a project when it upgrades yodel and renders again. Until #65 the
 * templates carried this as scripts/ci.ts.
 *
 *   yodel ci            write the files
 *   yodel ci --check    exit 1 when a file differs from what this renders
 *   yodel ci --replay   the lint job's replay check on this machine (./replay.ts)
 *
 * yodel.config.ts `ci` picks the forges (default all three) and names the
 * module that declares the project's own jobs, which are merged after
 * yodel's into the pull request pipeline and kept on every render
 * ({@link ProjectJobs}).
 *
 * Environments are the keys of `sql.profiles` in chant.config.ts, in order,
 * but `replay`, which is the lint job's throwaway server.
 * Each one needs ops/migrate-<env>.op.ts and ops/watch-<env>.op.ts.
 * The apply pipeline's waves are yodel.config.ts `waves`, in order; without
 * it, one wave per environment in profile order, each with gate `always`.
 *
 * Three pipelines per forge, each declared with chant: yodel-pr with the
 * github lexicon's Workflow, Job and Step (Forgejo renders the same
 * declaration through the forgejo lexicon's dialect) and the gitlab
 * lexicon's Workflow and Job; yodel-apply with chant's
 * generateOpWavesPipeline, from the waves spec this writes
 * (yodel-waves.json); the watch with generateOpsPipeline.
 *
 * - yodel-pr: on a pull (merge) request, `yodel ci --check` (these files are
 *   what yodel ci renders), `yodel lint`, and the replay check into a
 *   throwaway server the job starts (the `replay` profile), then for each
 *   environment `yodel plan <env> --comment`, which posts the pending
 *   migrations and the digest to approve. One job per environment, holding
 *   that environment's reader credentials and nothing else.
 * - yodel-apply: on a push to main, one job per wave, each needing the one
 *   before, running `chant run wave`: it plans the environment (`yodel apply
 *   <env> --wave-plan`), reads the wave's gate policy from yodel-waves.json
 *   as the commit before the push has it, waits for an approval when that
 *   policy asks for one (exit 3, and the waves after it do not run), and
 *   applies (`yodel apply <env> --wave-apply`). The only jobs that hold a
 *   writer's credentials, one environment's each, with
 *   YODEL_CREDENTIALS=writer. Two merges in quick succession do not fail the
 *   second apply: it waits for the first's lock (YODEL_LOCK_WAIT), and an
 *   apply whose commit is no longer main's tip stands down
 *   (YODEL_STAND_DOWN), since the newer commit's waves apply the same
 *   environments.
 * - watch-<env>: the environment's WatchOp on its own schedule, rendered by
 *   chant's generateOpsPipeline, with the reader's credentials. After the
 *   Op, `yodel drift <env> --issue` compares the server with the schema the
 *   newest applied migration records (so a migration waiting at its gate is
 *   not drift), keeps one tracking issue for the environment (opened on
 *   drift, updated while it changes, closed when it is gone), and fails the
 *   job on drift. The issue is written with the job's token on GitHub
 *   (issues: write) and Forgejo, and with GITLAB_TOKEN on GitLab.
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
 * needs no token, in IMAGE. With yodel.config.ts `ci.image` (#66), the CI
 * image ghcr.io/intentius/sql-yodeler pinned by its digest, every job runs
 * in that image instead, which carries node, yodel, chant and the lexicons
 * on PATH, and no job runs `npm ci` ({@link Toolchain}).
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { APPROVAL_MODES, type ApprovalMode, type YodelConfig } from "../config/define.js";
import { RECORD_PLANS_ENV } from "../approval-mode/index.js";
import { cloudToken, credentialsOf, roleVariables, type CloudToken, type Role } from "../credentials.js";
import { loadYodelConfig } from "../config/load.js";
import { testFiles } from "../testing/files.js";
import { CODE_QUALITY_FILE } from "../lint/annotations.js";
import type { Declarable } from "@intentius/chant/declarable";
import type { SerializerResult } from "@intentius/chant/serializer";
import { emitYAMLEntry, parseYAMLDocument } from "@intentius/chant/yaml";
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
  Artifacts as GitLabArtifacts,
  Image,
  Job as GitLabJob,
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

/** The CI image (#66): yodel, chant and the sql lexicon, published for each release. */
export const YODEL_IMAGE = "ghcr.io/intentius/sql-yodeler";

/**
 * What the jobs run in. By default IMAGE, and each job installs the
 * project's packages with `npm ci` and puts node_modules/.bin on PATH. With
 * `ci.image` the yodel image (pinned by digest): its yodel, chant and tsx
 * are on PATH, and a checkout resolves chant and the lexicons from the
 * image's /node_modules, so nothing is installed.
 */
export interface Toolchain {
  image: string;
  /** The yodel image: no `npm ci`, and every job in the container. */
  yodelImage: boolean;
}

export const toolchainOf = (envs: Pick<Environments, "image">): Toolchain => (envs.image ? { image: envs.image, yodelImage: true } : { image: IMAGE, yodelImage: false });

/** The steps that install the project's packages and put their bins on PATH, as each forge writes them. */
const installLines = (tc: Toolchain, forge: Forge): string[] =>
  tc.yodelImage ? [] : ["npm ci", forge === "gitlab" ? 'export PATH="$PWD/node_modules/.bin:$PATH"' : 'echo "$PWD/node_modules/.bin" >> "$GITHUB_PATH"'];
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
  /** The forges to render for: yodel.config.ts `ci.forges`, default every one. */
  forges?: readonly Forge[];
  /** The project's own jobs (yodel.config.ts `ci.jobs`), merged after yodel's. */
  jobs?: ProjectJobs;
  /** yodel.config.ts `ci.image`: the yodel image every job runs in, by digest. */
  image?: string;
  /** yodel.config.ts `ci.resume`: the scheduled job that resumes a wave whose approval arrived. */
  resume?: { schedule: string };
  /** The apply pipeline's waves, in order. */
  waves: readonly Wave[];
  /** chant.config.ts declares the `replay` profile, so the lint job runs the replay check. */
  replay: boolean;
  /** The project has tests/*.test.ts: with the replay profile, the lint job runs yodel test on its server too (#54). */
  tests?: boolean;
  /**
   * The environments whose profile is made with credentials() (#50): the
   * variables each role reads, and the cloud token source that mints its
   * password, if any. An environment not here reads the default variables.
   */
  credentials?: Record<string, EnvCredentials>;
}

/** What a job holding one role of an environment needs: the variables it reads, and the cloud identity its token source mints from. */
export interface RoleNeeds {
  variables: string[];
  cloud?: CloudToken;
}

export type EnvCredentials = Record<Role, RoleNeeds>;

/** DEV_CLICKHOUSE for dev on ClickHouse: what an environment's variables start with. */
export const variablePrefix = (env: string, dialect: Dialect): string => `${prefixOf(env)}_${dialect.toUpperCase()}`;

/** The variables a job reading `env` holds: the URL and the reader (the variables credentials() names; none for a token-minted password). */
export const readerVariables = (env: string, dialect: Dialect, creds?: EnvCredentials): string[] => {
  const p = variablePrefix(env, dialect);
  return [`${p}_URL`, ...(creds?.reader.variables ?? [`${p}_READER_USER`, `${p}_READER_PASSWORD`])];
};

/** The variables the apply job for `env` holds: the URL and the writer. */
export const writerVariables = (env: string, dialect: Dialect, creds?: EnvCredentials): string[] => {
  const p = variablePrefix(env, dialect);
  return [`${p}_URL`, ...(creds?.writer.variables ?? [`${p}_WRITER_USER`, `${p}_WRITER_PASSWORD`])];
};

// ── Cloud identity (#50) ────────────────────────────────────────────────────
//
// A role whose password is minted by a cloud token source (rds-iam,
// cloud-sql-iam, entra) mints it with the cloud's command line, from the
// job's identity. A job holding one gets an OIDC token from the forge: on
// GitHub the workflow grants `id-token: write`; on GitLab the job declares
// an ID token for the cloud's audience. Forgejo issues no OIDC token to a
// job (its dialect drops `permissions:`), so there the runner's own cloud
// identity mints.

/** The GitLab ID token per cloud: its variable and its audience. */
export const ID_TOKENS: Record<CloudToken, { variable: string; aud: string }> = {
  "rds-iam": { variable: "AWS_ID_TOKEN", aud: "sts.amazonaws.com" },
  "cloud-sql-iam": { variable: "GCP_ID_TOKEN", aud: "https://iam.googleapis.com/" },
  entra: { variable: "AZURE_ID_TOKEN", aud: "api://AzureADTokenExchange" },
};

/** The cloud token sources the roles `held` mint from, each once, in order. */
const cloudsOf = (envs: Pick<Environments, "credentials">, held: ReadonlyArray<readonly [string, Role]>): CloudToken[] => [
  ...new Set(held.map(([env, role]) => envs.credentials?.[env]?.[role].cloud).filter((c): c is CloudToken => c !== undefined)),
];

/** A GitLab job's `id_tokens` for `clouds`. */
const idTokens = (clouds: readonly CloudToken[]): Record<string, { aud: string }> => Object.fromEntries(clouds.map((c) => [ID_TOKENS[c].variable, { aud: ID_TOKENS[c].aud }]));

/** The roles a pull request's plan job for `env` holds: the environment's reader and the reader of the one it requires. */
const planRoles = (waves: readonly Wave[], env: string): Array<[string, Role]> => [env, ...requiredOf(waves, env)].map((e) => [e, "reader"]);

/** The roles a wave job for `env` holds: the writer, and the reader of the environment it requires. */
const waveRoles = (waves: readonly Wave[], env: string): Array<[string, Role]> => [[env, "writer"], ...requiredOf(waves, env).map((e): [string, Role] => [e, "reader"])];

/** The header lines saying what the cloud identity is for, when a job here holds a cloud-minted role. */
function identityHeader(forge: Forge, clouds: readonly CloudToken[]): string[] {
  if (clouds.length === 0) return [];
  const names = clouds.join(", ");
  if (forge === "github") return [`# Cloud identity: a password here is a ${names} token, minted from the job's`, "# identity, so the workflow grants id-token: write (an OIDC token)."];
  if (forge === "gitlab") return [`# Cloud identity: a password here is a ${names} token, minted from the job's`, `# identity: the jobs that hold one declare id_tokens (${clouds.map((c) => ID_TOKENS[c].variable).join(", ")}).`];
  return [`# Cloud identity: a password here is a ${names} token. Forgejo gives a job no`, "# OIDC token, so the runner's own cloud identity mints it."];
}

/** The write probe a pull request job runs before its plan: it holds no writer for `envs`. */
export const writeProbe = (envs: readonly string[]): string => `yodel config check ${envs.join(" ")} --write-probe`;

const secret = (name: string) => `\${{ secrets.${name} }}`;
const secrets = (names: readonly string[]) => Object.fromEntries(names.map((n) => [n, secret(n)]));

/**
 * The approvals: `chant approve` records them on the chant/lifecycle branch,
 * and approvers push it. A CI checkout fetches one ref, so fetch this one too.
 * The remote-tracking ref is what chant's push lease reads.
 */
export const FETCH_APPROVALS =
  "git fetch --no-tags origin '+refs/heads/chant/lifecycle:refs/remotes/origin/chant/lifecycle' && git branch -f chant/lifecycle origin/chant/lifecycle || echo 'no chant/lifecycle branch yet, so nothing is approved'";

/** The apply jobs' lock settings: wait for another apply's lock, and stand down for a newer commit on main. */
export const APPLY_LOCK: Record<string, string> = { YODEL_LOCK_WAIT: "10m", YODEL_STAND_DOWN: "1" };

/** The watch reads; it never pushes. See the comment at the top. */
export const NO_PUSH = "git remote set-url --push origin no-push://the-drift-watch-only-reads";

/** After the watch's `chant run`: drift against the history, the environment's tracking issue, and exit 2 on drift. */
export const watchDrift = (env: string): string => `yodel drift ${env} --issue`;

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
  /** The server's URL at `host`, on `port` (default: the service's own). */
  url: (host: string, port?: number) => string;
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
    url: (host, port = 8123) => `http://${host}:${String(port)}`,
    jobEnv: {},
  },
  postgres: {
    name: "replay-postgres",
    image: "postgres:18.6",
    port: 5432,
    env: { POSTGRES_PASSWORD: "replay" },
    // Over TCP: during its first start the image runs a server on the socket only, then restarts.
    health: "pg_isready -h 127.0.0.1 -U postgres",
    url: (host, port = 5432) => `postgres://${host}:${String(port)}/postgres`,
    jobEnv: { REPLAY_POSTGRES_USER: "postgres", REPLAY_POSTGRES_PASSWORD: "replay" },
  },
};

/** Waits up to 90 s for the replay server's port; a shell-free one-liner, so every forge runs it the same. */
export const waitFor = (host: string, port: number): string =>
  `node -e 'const net = require("net"); let n = 0; (function t() { const s = net.connect(${String(port)}, "${host}", () => { s.end(); process.exit(0); }); s.on("error", () => { if (++n > 90) { console.error("${host}:${String(port)} did not answer"); process.exit(1); } setTimeout(t, 1000); }); })()'`;

export const LINT = "yodel lint";

/**
 * The lint job's `yodel lint`, with its findings where the forge shows them
 * (#129): workflow commands on GitHub and Forgejo, which annotate the
 * migration files in the pull request; on GitLab the code quality report,
 * which the job keeps as its `artifacts:reports:codequality`
 * ({@link CODE_QUALITY_FILE}) and the merge request shows.
 */
export const lintCommand = (forge: Forge): string => (forge === "gitlab" ? `${LINT} --format gitlab --output ${CODE_QUALITY_FILE}` : `${LINT} --format github`);
export const REPLAY = `yodel lint --replay ${REPLAY_PROFILE} --reset`;

/** yodel test (#54), after the replay check on the same throwaway server, its outcome as JUnit XML. */
export const TEST = `yodel test --env ${REPLAY_PROFILE} --reset --junit yodel-test.xml`;

/** Fails a pull request whose pipelines differ from what yodel ci renders. */
export const CI_CHECK = "yodel ci --check";

/**
 * Webhook events (yodel.config.ts `notify`): the variables the apply, plan
 * and watch jobs pass from the forge's secrets. yodel sends nothing while
 * they are unset (empty), so an unconfigured repository needs neither.
 * GitLab jobs have the project's variables already.
 */
export const WEBHOOK_VARIABLES = ["YODEL_WEBHOOK_URL", "YODEL_WEBHOOK_KEY"];

/** Where the plan and apply jobs write `yodel report`, kept as the job's artifact. */
export const REPORT_DIR = "yodel-report";

/**
 * `yodel report <env>` as JSON and as the HTML run view, into REPORT_DIR.
 * It runs whatever the job's outcome, and a gap it reports (exit 4) does not
 * fail the job: the report is for reading. `yodel` is the project's, named
 * by path, since GitLab's after_script does not keep before_script's PATH;
 * in the yodel image, the image's, which is on PATH.
 */
export const reportCommand = (env: string, tc: Toolchain = { image: IMAGE, yodelImage: false }): string => {
  const yodel = tc.yodelImage ? "yodel" : "./node_modules/.bin/yodel";
  return `mkdir -p ${REPORT_DIR}; ${yodel} report ${env} --json > ${REPORT_DIR}/${env}.json || true; ${yodel} report ${env} --html ${REPORT_DIR}/${env}.html || true`;
};

/** The artifact a job keeps its report in. */
export const reportArtifact = (job: string): string => `yodel-report-${job}`;

const UPLOAD_ARTIFACT = "actions/upload-artifact@v4";

/**
 * The comment at the top of every file. Added here, not by chant: neither the
 * github nor the gitlab lexicon's serializer writes YAML comments
 * (INTENTIUS/chant#3667, INTENTIUS/chant#3669).
 */
const HEADER = [
  "# Rendered by yodel ci from chant.config.ts, yodel.config.ts and ops/.",
  "# Edit those and render again; yodel ci --check says when this file is stale.",
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

/** The report steps of a job: `yodel report` into REPORT_DIR and the artifact, whatever the job's outcome. */
function reportSteps(env: string, job: string, tc: Toolchain): AStep[] {
  return [
    new Step({ name: `yodel report ${env}`, if: "always()", run: reportCommand(env, tc) }),
    new Step({ name: "Keep the report", if: "always()", uses: UPLOAD_ARTIFACT, with: { name: reportArtifact(job), path: REPORT_DIR, "if-no-files-found": "ignore" } }),
  ];
}

/** `inContainer`: the job runs in the toolchain's image, which has node, so it needs no setup-node. */
function setupSteps(inContainer: boolean, tc: Toolchain): AStep[] {
  // Step inputs are strings in the lexicon's schema (INTENTIUS/chant#3670); the actions read them as strings either way.
  const steps = [new Step({ uses: CHECKOUT, with: { "fetch-depth": "0" } })];
  if (!inContainer) steps.push(new Step({ uses: SETUP_NODE, with: { "node-version": "22", cache: "npm" } }));
  steps.push(...installLines(tc, "github").map((run) => new Step({ run })), new Step({ name: "Fetch the approvals (chant/lifecycle)", run: FETCH_APPROVALS }));
  return steps;
}

/** Forgejo runs every job in the image; GitHub on the runner's VM, unless the job asks for the container or the image is yodel's. */
const inContainer = (forge: Actions, tc: Toolchain): boolean => forge === "forgejo" || tc.yodelImage;
const runner = (container: boolean, tc: Toolchain) => ({ "runs-on": "ubuntu-latest", ...(container ? { container: tc.image } : {}) });

/** The token `yodel plan --comment` posts with: the job's own. */
function commentToken(forge: Actions): Record<string, string> {
  return forge === "github" ? { GITHUB_TOKEN: "${{ github.token }}" } : { FORGEJO_TOKEN: "${{ github.token }}" };
}

function lintJob(forge: Actions, dialect: Dialect, replay: boolean, tc: Toolchain, tests = false): AJob {
  // With the replay check, the job runs in IMAGE on every forge and reaches
  // its replay server by the service's name on the job's own network. On
  // GitHub's VM the service would be on localhost through a published port,
  // which collides with any database already on that port (act, a
  // self-hosted runner).
  const container = replay || inContainer(forge, tc);
  const steps = [
    ...setupSteps(container, tc),
    new Step({ name: "The pipelines are up to date", run: CI_CHECK }),
    new Step({ name: "yodel lint", run: lintCommand(forge) }),
  ];
  if (!replay) return new ActionsJob({ ...runner(container, tc), steps });
  const svc = REPLAY_SERVICE[dialect];
  return new ActionsJob({
    ...runner(container, tc),
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
      ...(tests ? [new Step({ name: "yodel test", run: TEST })] : []),
    ],
  });
}

export function actionsReview(forge: Actions, envs_: Environments): RenderedFile {
  const { dialect, names: envs, replay, waves, jobs: own } = envs_;
  const tc = toolchainOf(envs_);
  const jobs: Record<string, AJob> = { lint: lintJob(forge, dialect, replay, tc, envs_.tests === true) };
  for (const env of envs) {
    const read = [env, ...requiredOf(waves, env)];
    jobs[`plan-${env}`] = new ActionsJob({
      ...runner(inContainer(forge, tc), tc),
      // The plan shows where each migration has run: the required environment's reader too.
      env: secrets([...read.flatMap((e) => readerVariables(e, dialect, envs_.credentials?.[e])), ...WEBHOOK_VARIABLES]),
      steps: [
        // The plan explains what moved since an approval from git's history of migrations/.
        ...setupSteps(inContainer(forge, tc), tc),
        new Step({ name: "This job cannot write", run: writeProbe(read) }),
        new Step({ name: `yodel plan ${env} --comment`, run: `yodel plan ${env} --comment`, env: commentToken(forge) }),
        ...reportSteps(env, `plan-${env}`, tc),
      ],
    });
  }
  Object.assign(jobs, ownJobs<AJob>(own?.actions, jobs, "actions"));
  const clouds = cloudsOf(envs_, envs.flatMap((env) => planRoles(waves, env)));
  const workflow = new ActionsWorkflow({
    name: "yodel-pr",
    on: { pull_request: { branches: [MAIN] } },
    permissions: new Permissions({ contents: "read", "pull-requests": "write", ...(clouds.length > 0 ? { "id-token": "write" as const } : {}) }),
    concurrency: new Concurrency({ group: "yodel-pr-${{ github.event.pull_request.number }}", "cancel-in-progress": true }),
    jobs,
  });
  const header = [
    ...HEADER,
    "#",
    "# Pull requests: yodel lint and the replay check (into a throwaway server the",
    "# lint job starts), and the plan comment per environment with the",
    "# environment's reader credentials. No job here holds a writer, and each plan",
    "# job shows it first: yodel config check --write-probe tries a write and",
    "# fails the job when the server lets it through.",
    ...(forge === "forgejo"
      ? ["# The comment is posted with the job's own token (Forgejo gives a same-repository", "# pull request one that can comment)."]
      : []),
    ...identityHeader(forge, clouds),
  ];
  return {
    path: `${forge === "github" ? ".github" : ".forgejo"}/workflows/yodel-pr.yml`,
    content: withHeader(header, renderActions(forge, workflow)),
  };
}

// ── GitLab CI ───────────────────────────────────────────────────────────────

export const GITLAB_WATCH_FILE = ".gitlab/yodel-watch.gitlab-ci.yml";
export const GITLAB_APPLY_FILE = ".gitlab/yodel-apply.gitlab-ci.yml";

/** The stage of the scheduled resume job in GITLAB_APPLY_FILE, as chant names it. */
const RESUME_STAGE = "resume";

/** The stage of the merge request job that records the plans a pr-review wave's review approves (#48), as chant names it. */
const PLANS_STAGE = "plans";

/** The stage of each wave's job in GITLAB_APPLY_FILE, as chant names it. */
const waveStages = (waves: readonly Wave[]): string[] => waves.map((w, i) => `wave-${String(i + 1)}-${w.env}`);

export function gitlabPipeline(envs_: Environments): RenderedFile {
  const { dialect, names: envs, replay, waves, jobs: own } = envs_;
  const tc = toolchainOf(envs_);
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
      image: new Image({ name: tc.image }),
      before_script: [...installLines(tc, "gitlab"), FETCH_APPROVALS],
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
            script: [CI_CHECK, lintCommand("gitlab"), waitFor(svc.name, svc.port), REPLAY, ...(envs_.tests === true ? [TEST] : [])],
            services: [new GitLabService({ name: svc.image, alias: svc.name, variables: svc.env })],
            variables: { [`${variablePrefix(REPLAY_PROFILE, dialect)}_URL`]: svc.url(svc.name), ...svc.jobEnv },
          }
        : { script: [CI_CHECK, lintCommand("gitlab")] }),
      // The code quality report, kept when lint fails too: that is when it has something to show.
      artifacts: new GitLabArtifacts({ when: "always", reports: { codequality: CODE_QUALITY_FILE } }),
    }),
  );
  for (const env of envs) {
    const clouds = cloudsOf(envs_, planRoles(waves, env));
    jobs.set(
      `plan-${env}`,
      new GitLabJob({
        extends: ".yodel",
        stage: "review",
        rules: mr(),
        script: [writeProbe([env, ...requiredOf(waves, env)]), `yodel plan ${env} --comment`],
        ...(clouds.length > 0 ? { id_tokens: idTokens(clouds) } : {}),
        after_script: [reportCommand(env, tc)],
        artifacts: new GitLabArtifacts({ name: reportArtifact(`plan-${env}`), when: "always", paths: [`${REPORT_DIR}/`] }),
      }),
    );
  }
  for (const [name, job] of Object.entries(ownJobs<Declarable>(own?.gitlab, Object.fromEntries(jobs), "gitlab"))) jobs.set(name, job);
  const serialize = (entities: Map<string, Declarable>): string => oneFile("gitlab", gitlabSerializer.serialize(entities));
  // Exception (INTENTIUS/chant#3669): the gitlab serializer writes no
  // top-level include or variables, and its stages are only the ones the
  // declared jobs name, so not the watch file's ops. It writes those stages
  // first; they are replaced by GITLAB_STAGES, and include and variables are
  // written beside them.
  const jobsYaml = serialize(jobs);
  const end = jobsYaml.indexOf("\n\n");
  const derivedStages = (parseYAMLDocument(jobsYaml.slice(0, end + 1)) as { stages?: unknown }).stages;
  if (!jobsYaml.startsWith("stages:\n") || !Array.isArray(derivedStages) || derivedStages[0] !== "review") throw new Error("gitlab: expected the jobs' YAML to start with their stages, review first");
  const derived = jobsYaml.slice(0, end + 2);
  // The stages this file's jobs use (review, then any the project's own jobs add), then the apply file's waves and the watch file's ops.
  // A pr-review wave (#48) adds the merge request job that records the plans, in chant's stage "plans".
  const plans = waves.some((w) => w.approval === "pr-review") ? [PLANS_STAGE] : [];
  const stages = [...new Set([...derivedStages.map(String), ...plans, ...waveStages(waves), ...(envs_.resume ? [RESUME_STAGE] : []), "ops"])];
  const topLevel = [
    emitYAMLEntry("include", [{ local: GITLAB_APPLY_FILE }, { local: GITLAB_WATCH_FILE }]),
    emitYAMLEntry("stages", stages),
    emitYAMLEntry("variables", { GIT_DEPTH: "0" }),
  ];
  const yaml = `${serialize(new Map([["workflow", workflow]]))}\n${topLevel.join("\n\n")}\n\n${jobsYaml.slice(derived.length)}`;

  const variables = envs.flatMap((env) => {
    const creds = envs_.credentials?.[env];
    const writer = writerVariables(env, dialect, creds).slice(1);
    return [
      `#   ${readerVariables(env, dialect, creds).join(", ")}: not protected (merge request`,
      "#     pipelines run on unprotected branches), masked; no environment scope.",
      ...(writer.length > 0
        ? [`#   ${writer.join(", ")}: protected, masked,`, `#     environment scope "${env}": only ${env}'s wave job declares that environment.`]
        : []),
    ];
  });
  const header = [
    ...HEADER,
    "#",
    "# Merge requests: lint and the plan comment (stage review). A push to the",
    `# default branch: the apply waves, one stage each, in ${GITLAB_APPLY_FILE}.`,
    `# The drift watches are in ${GITLAB_WATCH_FILE} (stage ops).`,
    "#",
    "# GitLab gives every job the project's CI/CD variables unless a variable is",
    "# protected or scoped to an environment, so the split between reader and",
    "# writer is in the variables' settings (Settings > CI/CD > Variables):",
    ...variables,
    ...(envs_.resume
      ? [
          "#   GITLAB_TOKEN: a project access token with the api scope (Developer), for",
          "#     the plan comment, the drift watch's tracking issue and the resume job's",
          "#     retry of a wave whose approval arrived; CI_JOB_TOKEN cannot write merge",
          "#     request notes or issues, or retry a job.",
        ]
      : [
          "#   GITLAB_TOKEN: a project access token with the api scope (Reporter), for",
          "#     the plan comment and the drift watch's tracking issue; CI_JOB_TOKEN",
          "#     cannot write merge request notes or issues.",
        ]),
    "# The jobs that hold no writer read with the reader: chant.config.ts picks an",
    "# environment's writer only under YODEL_CREDENTIALS=writer:<env>, which only",
    "# that environment's wave job sets.",
    ...identityHeader("gitlab", cloudsOf(envs_, envs.flatMap((env) => [...planRoles(waves, env), ...waveRoles(waves, env), [env, "reader"] as [string, Role]]))),
  ];
  return { path: ".gitlab-ci.yml", content: withHeader(header, yaml) };
}

// ── The apply waves, through chant's generateOpWavesPipeline ───────────────

/** When a wave waits for an approval; yodel.config.ts `waves[].gate`. */
export type WaveGate = "always" | "on-destructive" | "never";
const WAVE_GATES: readonly WaveGate[] = ["always", "on-destructive", "never"];

export interface Wave {
  env: string;
  gate: WaveGate;
  /**
   * The environment whose history must record a migration applied before
   * this one applies it (yodel.config.ts `waves[].requires`, default the
   * wave before): this wave's jobs, and its plan job, read it with its reader.
   */
  requires?: string;
  /**
   * A tenant set's wave (#56): a run per tenant, `<env>/<tenant>`, or per
   * slot of a set read at run time, `<env>/@<i>of<n>`, in place of the
   * environment's one, all behind the wave's one gate.
   */
  targets?: readonly string[];
  /** Split the wave into a deciding job and this many share jobs (yodel.config.ts `waves[].shares`). */
  shares?: number;
  /** Which approvals of the wave's digest count (yodel.config.ts `waves[].approval`, #48); absent, `ledger`. */
  approval?: ApprovalMode;
}

/** The environment `env`'s wave requires, as a list. */
const requiredOf = (waves: readonly Wave[], env: string): string[] => {
  const r = waves.find((w) => w.env === env)?.requires;
  return r ? [r] : [];
};

/** The waves spec: committed, and read by every wave job (its gate policy at the commit before the push). */
export const WAVES_SPEC = "yodel-waves.json";
export const APPLY_PIPELINE = "yodel-apply";

interface WavesSpec {
  name: string;
  op: string;
  plan: string[];
  apply: string[];
  branches: string[];
  waves: Array<{
    name: string;
    runs: Array<{ target: string; op: string }>;
    gate: WaveGate;
    shares?: number;
    approval?: ApprovalMode;
    environment?: { name: string };
    variables?: Record<string, string>;
  }>;
  /** The scheduled resume job (yodel.config.ts `ci.resume`); only the pipelines are rendered from it, the spec file leaves it out. */
  resume?: { schedule: string };
}

/**
 * The waves spec. What the file holds is the same for every forge; each
 * forge's jobs get their own variables on top (`variables`).
 */
export function wavesSpec(waves: readonly Wave[], variables?: (env: string) => Record<string, string>, resume?: { schedule: string }): WavesSpec {
  const first = waves[0];
  if (!first) throw new Error("no waves to render");
  return {
    name: APPLY_PIPELINE,
    op: `migrate-${first.env}`,
    plan: ["yodel", "apply", "{target}", "--wave-plan", "{plan}", "--spec", WAVES_SPEC],
    apply: ["yodel", "apply", "{target}", "--wave-apply", "{plan}", "--spec", WAVES_SPEC],
    branches: [MAIN],
    waves: waves.map((w) => ({
      name: w.env,
      runs: (w.targets ?? [w.env]).map((target) => ({ target, op: `migrate-${w.env}` })),
      gate: w.gate,
      ...(w.shares !== undefined && w.shares > 1 ? { shares: w.shares } : {}),
      ...(w.approval !== undefined && w.approval !== "ledger" ? { approval: w.approval } : {}),
      ...(variables ? { environment: { name: w.env }, variables: variables(w.env) } : {}),
    })),
    ...(resume ? { resume } : {}),
  };
}

interface WavesPipelineResult {
  success: boolean;
  files?: Array<{ name: string; yaml: string }>;
  error?: string;
}

/** The waves spec file and the apply pipeline on each forge. */
export async function applyPipelines(dir: string, envs: Environments): Promise<RenderedFile[]> {
  const { dialect, waves } = envs;
  const tc = toolchainOf(envs);
  const { generateOpWavesPipeline } = (await import("@intentius/chant/op")) as unknown as {
    generateOpWavesPipeline: (spec: unknown, lexicon: string, options: Record<string, unknown>, cwd: string) => Promise<WavesPipelineResult>;
  };
  const out: RenderedFile[] = [{ path: WAVES_SPEC, content: `${JSON.stringify(wavesSpec(waves), null, 2)}\n` }];
  // A GitLab job already has the project's variables, a writer's only under its environment.
  const variables = (forge: Forge) => (env: string) => {
    const wave = waves.find((w) => w.env === env);
    const required = wave?.requires;
    return {
      YODEL_CREDENTIALS: `writer:${env}`,
      ...APPLY_LOCK,
      ...(forge === "gitlab"
        ? {}
        : {
            ...secrets([...writerVariables(env, dialect, envs.credentials?.[env]), ...WEBHOOK_VARIABLES]),
            ...(required ? secrets(readerVariables(required, dialect, envs.credentials?.[required])) : {}),
            // A pr-review wave (#48) reads the merged pull request's reviews with the job's token.
            ...(wave?.approval === "pr-review" ? { GITHUB_TOKEN: "${{ github.token }}" } : {}),
          }),
    };
  };
  const header = [
    ...HEADER,
    "#",
    "# A push to main: one job per wave, each needing the one before. Each runs",
    "# chant run wave: yodel apply <env> --wave-plan plans the environment, the",
    `# wave's gate policy is read from ${WAVES_SPEC} as the commit before the push`,
    "# has it (yodel.config.ts waves, rendered), and a wave that needs an approval",
    "# exits 3 with the chant approve command, so the waves after it do not run.",
    "# yodel approve <env> records the approval and starts the waiting job again",
    "# (or approve, push chant/lifecycle, and run the failed job again). These are",
    "# the only jobs that hold a writer's credentials, one environment's each, with",
    "# the reader of the environment before (waves[].requires): yodel apply refuses",
    "# a migration that environment's history does not record as applied.",
  ];
  const resumeHeader = (forge: Forge): string[] => [
    ...HEADER,
    "#",
    `# On its schedule: chant run resume --op ${APPLY_PIPELINE} starts again each apply wave`,
    "# that waits at its gate and whose approval has arrived since. It approves",
    "# nothing; a wave whose approval does not count waits again.",
    ...(forge === "github"
      ? ["# It re-runs the run's failed jobs with the job's token (actions: write)."]
      : ["# Forgejo has no re-run: it dispatches yodel-apply.yml again on main, with the", "# CHANT_FORGE_TOKEN secret, a token with the write:repository scope."]),
  ];
  const waveClouds = cloudsOf(envs, waves.flatMap((w) => waveRoles(waves, w.env)));
  const plansHeader = [
    ...HEADER,
    "#",
    "# A pull request into main, when a wave's approval is pr-review (yodel.config.ts",
    "# waves[].approval): chant run wave --record-plans plans every wave at the pull",
    "# request's head, as it will be after the merge, and records the digests on",
    "# chant/lifecycle. After the merge, an approving review of that head by a writer",
    "# other than its author approves the digest it recorded, and only that one. It",
    "# holds no writer's credentials: it plans with each environment's reader.",
  ];
  for (const forge of FORGES) {
    const result = await generateOpWavesPipeline(
      wavesSpec(waves, variables(forge), envs.resume),
      forge,
      {
        specFile: WAVES_SPEC,
        image: tc.image,
        beforeScript: [...installLines(tc, forge), FETCH_APPROVALS],
        ...(forge === "gitlab" ? { opsFileName: GITLAB_APPLY_FILE } : {}),
      },
      dir,
    );
    if (!result.success || !result.files) throw new Error(`${forge}: ${result.error ?? "generateOpWavesPipeline rendered nothing"}`);
    for (const file of result.files) {
      const at = forge === "gitlab" ? GITLAB_APPLY_FILE : `${forge === "github" ? ".github" : ".forgejo"}/workflows/${file.name}`;
      const yaml = file.yaml.endsWith("\n") ? file.yaml : `${file.yaml}\n`;
      // The resume workflow (GitHub, Forgejo) has no wave job to report on.
      if (forge !== "gitlab" && file.name === `${APPLY_PIPELINE}-resume.yml`) out.push({ path: at, content: withHeader(resumeHeader(forge), yaml) });
      // The pull request workflow that records the plans a review approves (#48).
      else if (forge !== "gitlab" && file.name === `${APPLY_PIPELINE}-plans.yml`) out.push({ path: at, content: withHeader(plansHeader, withPlansReaders(forge, yaml, waves, dialect, envs)) });
      else out.push({ path: at, content: withHeader([...header, ...identityHeader(forge, waveClouds)], withWaveReports(forge, yaml, waves, tc, envs)) });
    }
  }
  return out;
}

/**
 * The wave jobs' report: chant's generateOpWavesPipeline takes run lines
 * after the wave's command but no step that runs when it fails (a wave that
 * waits exits 3), and no artifact, so they are added to its output here.
 * The output is parsed and emitted again; the emitter is checked to give
 * back chant's text unchanged before anything is added, so a change in
 * chant's emitter fails here instead of rendering something else.
 */
function withWaveReports(forge: Forge, yaml: string, waves: readonly Wave[], tc: Toolchain, envs: Pick<Environments, "credentials"> = {}): string {
  // A wide wave's jobs are wave-<k>-<env>-decide and -share-<i>.
  const envOf = (job: string) => waves.find((w, i) => new RegExp(`^wave-${String(i + 1)}-${w.env.replace(/[^A-Za-z0-9]/g, "\\$&")}(-decide|-share-\\d+)?$`).test(job))?.env;
  const body = yaml.search(/^[^#\n]/m);
  const header = yaml.slice(0, body);
  const doc = parseYAMLDocument(yaml) as Record<string, unknown>;
  if (forge === "gitlab") {
    const emit = (d: Record<string, unknown>) => `${header}${Object.entries(d).map(([k, v]) => emitYAMLEntry(k, v)).join("\n\n")}\n`;
    if (emit(doc) !== yaml) throw new Error("gitlab: the apply waves do not emit back to chant's text");
    // The merge request job that records the plans a review approves (#48): the waves as after the merge.
    const record = doc[`${APPLY_PIPELINE}-record-plans`] as { variables?: Record<string, string>; id_tokens?: unknown; script?: string[] } | undefined;
    if (record) {
      record.variables = { ...(record.variables ?? {}), [RECORD_PLANS_ENV]: "1" };
      // It holds readers only, and shows it first, as every merge request job does (#50, #130).
      const waveEnvs = [...new Set(waves.map((w) => w.env))];
      const at = record.script?.findIndex((l) => l.includes("--record-plans")) ?? -1;
      if (!record.script || at < 0) throw new Error("gitlab: the record-plans job has no chant run wave --record-plans line");
      record.script.splice(at, 0, writeProbe(waveEnvs));
      const readers = cloudsOf(envs, waveEnvs.map((e): [string, Role] => [e, "reader"]));
      if (readers.length > 0) record.id_tokens = idTokens(readers);
    }
    for (const [name, job] of Object.entries(doc)) {
      const env = envOf(name);
      if (!env || typeof job !== "object" || job === null) continue;
      const clouds = cloudsOf(envs, waveRoles(waves, env));
      Object.assign(job, { after_script: [reportCommand(env, tc)], artifacts: { name: reportArtifact(name), when: "always", paths: [`${REPORT_DIR}/`] }, ...(clouds.length > 0 ? { id_tokens: idTokens(clouds) } : {}) });
    }
    return emit(doc);
  }
  const at = yaml.indexOf("\njobs:\n");
  if (at < 0) throw new Error(`${forge}: the apply waves have no jobs`);
  const jobs = doc.jobs as Record<string, { steps: Array<Record<string, unknown>> }>;
  const top = yaml.slice(0, at + 1);
  const emitJobs = () => `${emitYAMLEntry("jobs", jobs)}\n`;
  if (`${top}${emitJobs()}` !== yaml) throw new Error(`${forge}: the apply waves do not emit back to chant's text`);
  for (const [name, job] of Object.entries(jobs)) {
    const env = envOf(name);
    if (!env) continue;
    job.steps.push(
      { name: `yodel report ${env}`, if: "always()", run: reportCommand(env, tc) },
      // chant's forgejo output is already in Forgejo's dialect, so the action is named as the forgejo lexicon names it.
      { name: "Keep the report", if: "always()", uses: forge === "forgejo" ? `https://code.forgejo.org/${UPLOAD_ARTIFACT}` : UPLOAD_ARTIFACT, with: { name: reportArtifact(name), path: REPORT_DIR, "if-no-files-found": "ignore" } },
    );
  }
  return `${withIdToken(forge, top, cloudsOf(envs, waves.flatMap((w) => waveRoles(waves, w.env))))}${emitJobs()}`;
}

/**
 * The plans workflow (GitHub, Forgejo) for a pr-review wave (#48): chant's,
 * with each environment's reader (the waves are planned on every one, and a
 * wave reads the history of the one it requires) and {@link RECORD_PLANS_ENV}
 * on its job. The output is parsed and emitted again, checked first to give
 * back chant's text unchanged.
 */
function withPlansReaders(forge: Forge, yaml: string, waves: readonly Wave[], dialect: Dialect, creds: Pick<Environments, "credentials"> = {}): string {
  const at = yaml.indexOf("\njobs:\n");
  if (at < 0) throw new Error(`${forge}: the plans workflow has no jobs`);
  const doc = parseYAMLDocument(yaml) as { jobs: Record<string, Record<string, unknown>> };
  const top = yaml.slice(0, at + 1);
  const emitJobs = () => `${emitYAMLEntry("jobs", doc.jobs)}\n`;
  if (`${top}${emitJobs()}` !== yaml) throw new Error(`${forge}: the plans workflow does not emit back to chant's text`);
  const job = doc.jobs["record-plans"];
  if (!job) throw new Error(`${forge}: the plans workflow has no record-plans job`);
  const envs = [...new Set(waves.map((w) => w.env))];
  const steps = job.steps as Array<Record<string, unknown>>;
  // It holds readers only, and shows it before it plans, as every pull request job does (#50, #130).
  const recordAt = steps.findIndex((st) => typeof st.run === "string" && st.run.includes("--record-plans"));
  if (recordAt < 0) throw new Error(`${forge}: the record-plans job has no chant run wave --record-plans step`);
  steps.splice(recordAt, 0, { name: "This job cannot write", run: writeProbe(envs) });
  delete job.steps;
  Object.assign(job, { env: { [RECORD_PLANS_ENV]: "1", ...secrets(envs.flatMap((e) => readerVariables(e, dialect, creds.credentials?.[e]))) }, steps });
  // A reader whose password is a cloud token (#50) is minted from the job's identity.
  return `${withIdToken(forge, top, cloudsOf(creds, envs.map((e): [string, Role] => [e, "reader"])))}${emitJobs()}`;
}

/** yodel.config.ts `waves`, checked against the environments; one wave per environment, gate `always`, without it. */
export async function readWaves(dir: string, envs: readonly string[]): Promise<Wave[]> {
  const declared = (await readConfig(dir))?.waves as unknown;
  if (declared === undefined) return envs.map((env, i) => ({ env, gate: "always", ...(i > 0 ? { requires: envs[i - 1] } : {}) }));
  if (!Array.isArray(declared) || declared.length === 0) throw new Error("yodel.config.ts: waves must list at least one { env, gate }");
  return declared.map((w: { env?: unknown; gate?: unknown; requires?: unknown; shares?: unknown; approval?: unknown }, i, all: Array<{ env?: unknown }>) => {
    const env = String(w.env);
    if (!envs.includes(env)) throw new Error(`yodel.config.ts: waves[${String(i)}].env ${env} is not an environment (${envs.join(", ")})`);
    const gate = (w.gate ?? "always") as WaveGate;
    if (!WAVE_GATES.includes(gate)) throw new Error(`yodel.config.ts: waves[${String(i)}].gate ${String(w.gate)} is not ${WAVE_GATES.join(", ")}`);
    const requires = w.requires === false ? undefined : w.requires === undefined ? (i > 0 ? String(all[i - 1]?.env) : undefined) : typeof w.requires === "string" ? w.requires : JSON.stringify(w.requires);
    if (requires !== undefined && !envs.includes(requires)) throw new Error(`yodel.config.ts: waves[${String(i)}].requires ${requires} is not an environment (${envs.join(", ")})`);
    const approval = w.approval as ApprovalMode | undefined;
    if (approval !== undefined && !APPROVAL_MODES.includes(approval)) throw new Error(`yodel.config.ts: waves[${String(i)}].approval ${String(w.approval)} is not ${APPROVAL_MODES.join(", ")}`);
    return { env, gate, ...(requires ? { requires } : {}), ...(typeof w.shares === "number" && w.shares > 1 ? { shares: w.shares } : {}), ...(approval && approval !== "ledger" ? { approval } : {}) };
  });
}

/**
 * Each wave of an environment with a tenant set (#56), with its runs: a
 * run per tenant of a list or a file, or for a set given by a query,
 * `shares` slots (one without) that read the tenants when the wave runs.
 * The query is not run here, so the pipeline stays the same as tenants come
 * and go; a list or a file is in the repository, and changing it is
 * rendering again.
 */
export async function withTenants(dir: string, waves: readonly Wave[]): Promise<Wave[]> {
  const { loadProject } = await import("../project.js");
  const { waveTargets } = await import("../tenants/wave.js");
  const project = await loadProject(dir);
  const out: Wave[] = [];
  for (const w of waves) {
    const targets = await waveTargets(project, w.env, w.shares);
    out.push(targets === undefined ? w : { ...w, targets });
  }
  return out;
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
export function watchSpec(env: string, dialect: Dialect, forge: Forge, creds?: EnvCredentials): { name: string; variables?: Record<string, string>; permissions?: Record<string, string> } {
  if (forge === "gitlab") return { name: `watch-${env}` };
  // The job's token, for the tracking issue: GitHub grants it issues: write here, Forgejo's can write already.
  return {
    name: `watch-${env}`,
    variables: { ...secrets([...readerVariables(env, dialect, creds), ...WEBHOOK_VARIABLES]), GITHUB_TOKEN: "${{ github.token }}" },
    ...(forge === "github" ? { permissions: { issues: "write", ...(creds?.reader.cloud ? { "id-token": "write" } : {}) } } : {}),
  };
}

/** A GitHub workflow's top-level `permissions:` with `id-token: write` added, when a job holds a cloud-minted role. */
function withIdToken(forge: Forge, top: string, clouds: readonly CloudToken[]): string {
  if (forge !== "github" || clouds.length === 0) return top;
  const added = top.replace(/^permissions:\n((?: {2}\S.*\n)*)/m, (_m, scopes: string) => `permissions:\n${scopes}  id-token: write\n`);
  if (added === top) throw new Error("github: the apply waves have no top-level permissions to add id-token: write to");
  return added;
}

/** The GitLab watch file with `id_tokens` on each watch job whose reader is cloud-minted. Parsed and emitted again, checked against chant's text first. */
function withWatchIdTokens(yaml: string, envs: Pick<Environments, "names" | "credentials">): string {
  const clouds = (env: string) => cloudsOf(envs, [[env, "reader"]]);
  if (!envs.names.some((env) => clouds(env).length > 0)) return yaml;
  const body = yaml.search(/^[^#\n]/m);
  const header = yaml.slice(0, body);
  const doc = parseYAMLDocument(yaml) as Record<string, unknown>;
  const emit = (d: Record<string, unknown>) => `${header}${Object.entries(d).map(([k, v]) => emitYAMLEntry(k, v)).join("\n\n")}\n`;
  if (emit(doc) !== yaml) throw new Error("gitlab: the watch file does not emit back to chant's text");
  for (const env of envs.names) {
    const job = doc[`watch-${env}`];
    if (clouds(env).length > 0 && typeof job === "object" && job !== null) Object.assign(job, { id_tokens: idTokens(clouds(env)) });
  }
  return emit(doc);
}

export async function watchPipelines(dir: string, envs_: Environments): Promise<RenderedFile[]> {
  const { dialect, names: envs } = envs_;
  const tc = toolchainOf(envs_);
  const { generateOpsPipeline } = (await import("@intentius/chant/op")) as unknown as {
    generateOpsPipeline: (ops: unknown[], lexicon: string, options: Record<string, unknown>, cwd: string) => Promise<OpsPipelineResult>;
  };
  const out: RenderedFile[] = [];
  const emit = async (forge: Forge, specs: unknown[], extraScript: string[]) => {
    const result = await generateOpsPipeline(
      specs,
      forge,
      {
        image: tc.image,
        beforeScript: [...installLines(tc, forge), FETCH_APPROVALS, NO_PUSH],
        extraScript,
        ...(forge === "gitlab" ? { opsStage: "ops", opsFileName: GITLAB_WATCH_FILE } : {}),
      },
      dir,
    );
    if (!result.success || !result.files) throw new Error(`${forge}: ${result.error ?? "generateOpsPipeline rendered nothing"}`);
    for (const file of result.files) {
      const at = forge === "gitlab" ? GITLAB_WATCH_FILE : `${forge === "github" ? ".github" : ".forgejo"}/workflows/${file.name}`;
      const yaml = file.yaml.endsWith("\n") ? file.yaml : `${file.yaml}\n`;
      out.push({ path: at, content: `${HEADER.join("\n")}\n${forge === "gitlab" ? withWatchIdTokens(yaml, envs_) : yaml}` });
    }
  };
  // `chant run` exits 0 when a watch finds drift; the last line, yodel drift, fails the job then.
  for (const forge of ["github", "forgejo"] as const) {
    for (const env of envs) await emit(forge, [watchSpec(env, dialect, forge, envs_.credentials?.[env])], [watchDrift(env)]);
  }
  // GitLab: one file for every watch, so the last line takes the environment from the job's own name.
  await emit("gitlab", envs.map((env) => watchSpec(env, dialect, "gitlab")), [watchDrift('"${CI_JOB_NAME#watch-}"')]);
  return out;
}

// ── The project ─────────────────────────────────────────────────────────────

/** Whether the project has a test file for yodel test (tests/*.test.ts). */
const hasTests = (dir: string): boolean => testFiles(dir).length > 0;

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
  const ci = (await readConfig(dir))?.ci;
  const credentials = credentialsIn(sql?.profiles ?? {}, envs);
  return {
    dialect,
    names: envs,
    ...(Object.keys(credentials).length > 0 ? { credentials } : {}),
    replay,
    ...(hasTests(dir) ? { tests: true } : {}),
    waves: await withTenants(dir, await readWaves(dir, envs)),
    forges: ci?.forges ?? FORGES,
    ...(ci?.jobs ? { jobs: await loadProjectJobs(dir, ci.jobs) } : {}),
    ...(ci?.image ? { image: ci.image } : {}),
    ...(ci?.resume ? { resume: { schedule: ci.resume.schedule } } : {}),
  };
}

/** The roles of each environment whose profile is made with credentials(). */
export function credentialsIn(profiles: Record<string, unknown>, envs: readonly string[]): Record<string, EnvCredentials> {
  const out: Record<string, EnvCredentials> = {};
  for (const env of envs) {
    const c = credentialsOf(profiles[env]);
    if (!c) continue;
    const needs = (role: Role): RoleNeeds => {
      const cloud = cloudToken(c, role);
      return { variables: roleVariables(c, role), ...(cloud ? { cloud } : {}) };
    };
    out[env] = { reader: needs("reader"), writer: needs("writer") };
  }
  return out;
}

/** yodel.config.ts, checked; undefined when the project has none. */
async function readConfig(dir: string): Promise<YodelConfig | undefined> {
  return (await loadYodelConfig(dir))?.config;
}

/**
 * The project's own jobs (#65): the module yodel.config.ts `ci.jobs` names,
 * relative to the project, declaring jobs with chant's lexicons. `actions`
 * (the github lexicon's Job) goes into yodel-pr on GitHub and Forgejo, after
 * yodel's jobs; `gitlab` (the gitlab lexicon's Job) into .gitlab-ci.yml,
 * after yodel's, its stages after `review`. They are declared here, not
 * edited into the rendered files, so every `yodel ci` keeps them:
 *
 * ```ts
 * // ci/jobs.ts
 * import { Job, Step } from "@intentius/chant-lexicon-github";
 * import { Job as GitLabJob, Image } from "@intentius/chant-lexicon-gitlab";
 * export const actions = { test: new Job({ "runs-on": "ubuntu-latest", steps: [new Step({ uses: "actions/checkout@v7" }), new Step({ run: "npm test" })] }) };
 * export const gitlab = { test: new GitLabJob({ stage: "test", image: new Image({ name: "node:22" }), script: ["npm test"] }) };
 * ```
 */
export interface ProjectJobs {
  actions?: Record<string, Declarable>;
  gitlab?: Record<string, Declarable>;
}

/** Loads the module `ci.jobs` names. */
export async function loadProjectJobs(dir: string, file: string): Promise<ProjectJobs> {
  const path = resolve(dir, file);
  if (!existsSync(path)) throw new Error(`yodel.config.ts: ci.jobs names ${file}, which is not there`);
  const mod = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
  const out: ProjectJobs = {};
  for (const key of Object.keys(mod)) {
    if (key !== "actions" && key !== "gitlab" && key !== "default") throw new Error(`${file}: export ${key} is not actions or gitlab`);
  }
  for (const key of ["actions", "gitlab"] as const) {
    const v = mod[key];
    if (v === undefined) continue;
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`${file}: ${key} must be an object of jobs, keyed by the job's name`);
    out[key] = v as Record<string, Declarable>;
  }
  return out;
}

/** The project's jobs for one pipeline, refusing a name yodel's jobs already use. */
function ownJobs<T>(own: Record<string, Declarable> | undefined, yodels: Record<string, unknown>, what: string): Record<string, T> {
  if (!own) return {};
  for (const name of Object.keys(own)) {
    if (name in yodels) throw new Error(`ci.jobs: ${what} job ${name} has the name of one of yodel's jobs; name it something else`);
  }
  return own as Record<string, T>;
}

/** The pipelines that need no Op discovery: pull requests, and GitLab's main file. */
export function review(envs: Environments): RenderedFile[] {
  return [actionsReview("github", envs), actionsReview("forgejo", envs), gitlabPipeline(envs)];
}

/** The forge a rendered file is for; undefined for the waves spec, which every forge's apply reads. */
export function forgeOf(path: string): Forge | undefined {
  if (path.startsWith(".github/")) return "github";
  if (path.startsWith(".forgejo/")) return "forgejo";
  if (path.startsWith(".gitlab")) return "gitlab";
  return undefined;
}

export async function render(dir: string): Promise<RenderedFile[]> {
  const envs = await environments(dir);
  const forges = envs.forges ?? FORGES;
  const files = [...review(envs), ...(await applyPipelines(dir, envs)), ...(await watchPipelines(dir, envs))];
  return files.filter((f) => {
    const forge = forgeOf(f.path);
    return forge === undefined || forges.includes(forge);
  });
}

