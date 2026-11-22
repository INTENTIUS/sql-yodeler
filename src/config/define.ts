/**
 * `yodel.config.ts`: what yodel needs per environment that chant's
 * `chant.config.ts` does not say. Optional; a project without one runs on
 * the defaults below.
 *
 * ```ts
 * // yodel.config.ts
 * import { defineConfig } from "@intentius/sql-yodeler";
 *
 * export default defineConfig({
 *   environments: {
 *     dev: { topology: "single" },
 *     prod: { topology: "cluster:main", history: { database: "yodeler" }, lockTtl: 1800, lockWait: 600 },
 *   },
 * });
 * ```
 */

import type { Topology } from "@intentius/chant-lexicon-sql/clickhouse/topology";

import type { LevelSetting, LintRuleId } from "../lint/rules.js";
import type { DdlSource } from "../sources/index.js";
import type { NotifyConfig } from "../notify/index.js";

export type { NotifyConfig };

export type { Topology };


/**
 * A ClickHouse topology in its string form (`single`, `cluster:<name>`,
 * `replicated`, `replicated:<cluster>`, `cloud`) or chant's object form,
 * which also sets a cluster's Keeper path and replica name for the tables
 * the migrations create.
 */
export type TopologySetting = string | Topology;

export interface EnvironmentConfig {
  /**
   * The ClickHouse topology this environment runs. Every statement of every
   * migration is rendered for it when it is sent (`ON CLUSTER`, the
   * replicated engine), and the history table's engine follows it.
   * Default: `sql.profiles.<env>.topology` in chant.config.ts, then
   * `YODEL_TOPOLOGY`, then `single`.
   */
  topology?: TopologySetting;
  history?: {
    /** The database the history and lock tables live in. Default: `YODEL_HISTORY_DATABASE`, then `yodeler`. */
    database?: string;
  };
  /** The apply lock's TTL, in seconds. Default: `YODEL_LOCK_TTL`, then 900. */
  lockTtl?: number;
  /**
   * How long, in seconds, an apply waits for the lock another apply holds
   * before it gives up (exit 5). `yodel apply --lock-wait` overrides it.
   * Default: 0 (give up at once).
   */
  lockWait?: number;
  /**
   * A tenant set (#56): the environment is many targets with one schema,
   * each a ClickHouse database or a Postgres schema of the profile's server.
   * The profile names one database (ClickHouse `databases`) or schema
   * (Postgres `schemas`), the template the migrations are written against;
   * each tenant gets them with that name replaced by its own. A tenant is
   * named `<env>/<tenant>` (`yodel apply prod/acme`), keeps a history of its
   * own (`<history database>_<tenant>`), and its wave applies to every
   * tenant behind one gate. See {@link TenantSet}.
   */
  tenants?: TenantSet;
  /**
   * Steps around apply (#64): checks run before the migrations are applied
   * (replication lag, long transactions, disk headroom) and after (smoke
   * queries). Read from yodel.config.ts at the base commit, never from the
   * change, so a pull request cannot add a step that runs with the writer.
   * Each outcome is recorded in the history. See {@link ApplySteps}.
   */
  steps?: ApplySteps;
  /**
   * Whether yodel plans, applies and compares access control in this
   * environment (chant's `sql.profiles.<env>.access`). On Postgres:
   * row-level security, policies, the roles the schema declares, grants and
   * default privileges. Off, the access declarations are left out of the
   * plan and the server's access is not read. On, the declared privileges
   * are the whole of them: one granted by hand is revoked. Passwords and
   * role memberships are the environment's and are never declared. The
   * declarative apply and drift run chant, which reads chant.config.ts, so
   * there the two must agree. On ClickHouse (#46): users, roles, row
   * policies and grants; chant's apply has no switch, so off, the
   * declarative path is refused when `src/` declares any, and on, `yodel
   * init --from` adopts them. Default: `sql.profiles.<env>.access` in
   * chant.config.ts, then off.
   */
  access?: boolean;
  /**
   * Which approvals of the migrations Op's gate count (#48), for `yodel
   * apply <env>` outside the apply pipeline's waves:
   *
   * - `ledger` (the default): any `chant approve` of the plan digest;
   * - `sealed`: only an approval sealed with `chant approve --sign` (or
   *   `yodel approve --sign`) by a key the signers file
   *   (`.chant/allowed_signers`) at the base commit lists for the approver.
   *
   * Read from yodel.config.ts at the base commit, never from the change.
   * Default: the environment's wave's `approval` when that is `sealed`, else
   * `ledger`. A wave's `pr-review` is the wave's alone.
   */
  approval?: EnvironmentApprovalMode;
}

/**
 * Which approvals of a gate's plan digest count (#48), chant's wave
 * `approval`:
 *
 * - `ledger`: any `chant approve` of the digest on `chant/lifecycle`;
 * - `pr-review`: also an approving review of the merged pull request's head
 *   by a writer other than its author, when that head planned the digest;
 * - `sealed`: only an approval sealed by a key the signers file at the base
 *   commit lists for its approver.
 */
export type ApprovalMode = "ledger" | "pr-review" | "sealed";

export const APPROVAL_MODES: readonly ApprovalMode[] = ["ledger", "pr-review", "sealed"];

/** The modes the migrations Op's gate takes: `pr-review` needs the pipeline's waves. */
export type EnvironmentApprovalMode = Exclude<ApprovalMode, "pr-review">;

export const ENVIRONMENT_APPROVAL_MODES: readonly EnvironmentApprovalMode[] = ["ledger", "sealed"];

/** `steps` of an environment: run in order, `before` under the lock before the first migration, `after` after the last. */
export interface ApplySteps {
  before?: ApplyStep[];
  after?: ApplyStep[];
}

/**
 * One step: a read-only SQL query on the environment's server, judged like a
 * migration's pre-migration check (`expect`, default `empty`: no rows), or a
 * shell command run in the project directory with `YODEL_ENV` and
 * `YODEL_STEP` (`before` or `after`) set, which passes when it exits 0.
 *
 * ```ts
 * steps: {
 *   before: [{ name: "no-long-transactions", sql: "SELECT pid FROM pg_stat_activity WHERE xact_start < now() - interval '5 minutes'", onFailure: "approve" }],
 *   after: [{ name: "smoke", command: "./scripts/smoke.sh" }],
 * }
 * ```
 */
export interface ApplyStep {
  /** Names it in output and in the history: lowercase letters, digits, - and _. */
  name: string;
  sql?: string;
  /** What `sql` must return: `empty` (the default), `true`, or a number in `{ min, max }`. */
  expect?: "empty" | "true" | { min?: number; max?: number };
  command?: string;
  /**
   * A failing `before` step: `fail` (the default) refuses the apply, exit 1;
   * `approve` holds the environment's wave for a person instead, whatever
   * its gate, until someone approves the plan with the step failing. An
   * `after` step that fails fails the run (exit 1); the migrations stay
   * applied.
   */
  onFailure?: "fail" | "approve";
}

/**
 * The tenants of an environment: a list of names, a file of them (one per
 * line, or a JSON array), or a read-only SQL query whose first column lists
 * them, run on the environment's server with its profile (its reader
 * outside an apply job).
 *
 * ```ts
 * tenants: ["acme", "globex"]
 * tenants: { file: "tenants.txt" }
 * tenants: { query: "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'tenant_%'" }
 * ```
 */
export type TenantSet = string[] | { file: string } | { query: string };

/** When an environment's wave waits for an approval (chant's wave gate policy). */
export type WaveGate = "always" | "on-destructive" | "never";

export const WAVE_GATES: readonly WaveGate[] = ["always", "on-destructive", "never"];

/**
 * What a refusal of an unknown gate adds for `value`: terragucci spells
 * on-destructive `on-destroy`, so a reader who uses both is pointed at it.
 */
export function waveGateHint(value: unknown): string {
  return value === "on-destroy" ? ". on-destroy is terragucci's name for this policy; SQL Yodeler and chant call it on-destructive" : "";
}

/**
 * One wave of the apply pipeline: an environment, applied after the waves
 * before it, behind its own gate.
 */
export interface WaveConfig {
  /** The environment, by its name in `sql.profiles`. */
  env: string;
  /**
   * When the wave waits for an approval of its plan:
   *
   * - `always` (the default): whenever it has a migration to apply;
   * - `on-destructive`: when a pending step is destructive, a Postgres
   *   rewrite or lock-heavy statement, a ClickHouse mutation or rebuild, or
   *   an Op or manual step;
   * - `never`: never. Review and branch protection are all that stand in
   *   front of it.
   *
   * The pipeline reads it from the commit a change merges onto, never from
   * the change itself.
   */
  gate?: WaveGate;
  /**
   * The environment that must have applied a migration first: `yodel
   * apply <env>` reads its history (with its reader) and refuses, exit 3,
   * any pending migration it does not record as applied with the same
   * checksum. Default: the wave before this one; `false` for none. Both
   * the working tree's and the base commit's requirement are enforced, so a
   * change cannot drop its own.
   */
  requires?: string | false;
  /**
   * A tenant set's wave (#56): split it into a deciding job, which plans
   * every tenant and decides the gate once over all of them, and this many
   * share jobs, each applying a slice of the tenants. A share job refuses
   * (exit 4), naming it, a tenant whose plan moved since the decision, and
   * applies the rest. Default 1: one job plans, decides and applies.
   */
  shares?: number;
  /**
   * Which approvals of the wave's digest count (#48): `ledger` (the
   * default), `pr-review` or `sealed`; see {@link ApprovalMode}. Read, like
   * `gate`, from the commit a change merges onto. Under `pr-review`, `yodel
   * ci` adds the pull request job that records the plans each head makes
   * (`chant run wave --record-plans`).
   */
  approval?: ApprovalMode;
}

/** The CI image set `ci.imageBase` picks. */
export type CiImageBase = "debian" | "chainguard";

export const CI_IMAGE_BASES: readonly CiImageBase[] = ["debian", "chainguard"];

/** A forge `yodel ci` renders pipelines for. */
export type CiForge = "github" | "gitlab" | "forgejo";

export const CI_FORGES: readonly CiForge[] = ["github", "gitlab", "forgejo"];

/** `yodel ci` (#65): what the project's pipelines are rendered for. */
export interface CiConfig {
  /** The forges to render for. Default: all three. A forge left out gets no files, and `yodel ci --check` does not read its old ones. */
  forges?: CiForge[];
  /**
   * The project's own jobs: a module, relative to the project (such as
   * `ci/jobs.ts`), exporting `actions` (jobs declared with the github
   * lexicon, for GitHub and Forgejo) and `gitlab` (the gitlab lexicon's),
   * each keyed by the job's name. `yodel ci` adds them to the pull request
   * pipeline after yodel's own jobs, so they survive every render.
   */
  jobs?: string;
  /**
   * The image every job runs in (#66): the CI image
   * `ghcr.io/intentius/sql-yodeler:<version>@sha256:<digest>`, pinned by its
   * digest, which carries node, yodel, chant and the lexicons. Jobs then run
   * no `npm ci`. Default: `node:22-bookworm`, and each job runs `npm ci`.
   */
  image?: string;
  /**
   * Which of the release's CI images the jobs run in when `image` is not set
   * (sql-yodeler issue 405): `"debian"` or `"chainguard"`. Each release
   * publishes both to ghcr.io/intentius/sql-yodeler, `<version>` and
   * `<version>-chainguard`, and records both digests in the package, so
   * `yodel ci` names the one picked by its digest and every job runs in it
   * with no `npm ci`. The Debian image runs Node 22 as root; the Chainguard
   * image is Chainguard's `node` image, which runs Node 26, as user 65532.
   * Left out, the jobs run in `node:22-bookworm` and install the project's
   * packages, as before. `image` wins when both are set. A yodel release that
   * carries digests but none for the set picked refuses it; a yodel with no
   * digests (a clone, the yodel inside the image) takes the digest the
   * committed pipelines name.
   */
  imageBase?: CiImageBase;
  /**
   * A scheduled job that starts again an apply wave whose approval has
   * arrived (#47): `chant run resume --op yodel-apply`, which re-runs the
   * GitHub run, dispatches the Forgejo workflow or retries the GitLab job.
   * It approves nothing. `schedule` is a five-field cron, such as
   * `"*\/10 * * * *"`. GitHub uses the job's token (`actions: write`);
   * Forgejo the `CHANT_FORGE_TOKEN` secret (`write:repository`); GitLab runs
   * it in a pipeline schedule you create, with `GITLAB_TOKEN` (the `api`
   * scope, Developer role). Without it, `yodel approve` resumes the job.
   */
  resume?: { schedule: string };
  /**
   * The cloud login a job runs before yodel when a role it holds has a
   * password minted by a cloud token source (#132): `aws` for `rds-iam`,
   * `gcp` for `cloud-sql-iam`, `azure` for `entra`. `environments.<env>`
   * overrides a cloud's login for that environment's roles. See
   * {@link CiLogin}.
   */
  login?: CiLogin;
  /** The vocabulary's key for {@link CiConfig.login}, which stays accepted: set one of them. */
  identity?: CiLogin;
  /**
   * Whether `yodel ci` renders the apply pipeline (#175). Default `true`.
   * With `false` it renders the pull request checks (lint, the replay check,
   * the plan comment and its write probe) and the drift watches, all with
   * readers, and no `yodel-waves.json`, `yodel-apply` pipeline,
   * `yodel-apply-plans` job or GitLab apply stages and include; `yodel ci
   * --check` does not expect them. The project applies some other way, and
   * CI holds no writer. Refused with a wave whose `approval` is `pr-review`,
   * or with `resume`: both need the apply pipeline.
   */
  apply?: boolean;
  /**
   * The SQL tools the team already runs on migrations, run in the pull
   * request's check beside yodel's own checks (#294), off unless named:
   * `squawk` (Postgres only) lints each `migrations/<id>/migration.sql`,
   * `sqlfluff` lints `migrations/` in the project's dialect. Each must be
   * installed where the check job runs. They run as hooks on chant's check
   * moment (`ci.hooks.check` in chant.workspace.json), which `yodel ci`
   * writes when the installed chant has it; without it they do not run.
   */
  tools?: CheckTool[];
  /**
   * `yodel new` in chant's commit job (#311), where it runs with no name.
   * `name` is the migration's name, with `{pr}` standing for the pull
   * request's number (`CHANT_COMMIT_PR`, which the commit job sets).
   * Default `"pr-{pr}"`. It must hold `{pr}`, so no two pull requests
   * write a migration of the same name: `yodel new --replace-own` takes a
   * newest migration of that name for the pull request's own.
   */
  new?: { name?: string };
  /**
   * What answers on a pull request (#312), with chant's commit job: `new`
   * is `/yodel new`, which writes the migration the declared schema is
   * ahead by (`yodel new --if-changed --replace-own`) and pushes it to the
   * pull request's branch. `off` renders no job, `comment` (the default)
   * the job that answers the comment, and `on-change` that job and one
   * that runs after each push when `yodel lint` finds `unmigrated`.
   * `rebase` is `/yodel rebase` (#313), which merges the base branch into
   * the head and rebases a forked migrations directory (`yodel rebase
   * --env <env>...`, every environment the apply pipeline applies, read
   * with its reader): `off`, `comment` (the default) or `on-fork`, also
   * after each push when lint finds `fork`. On GitLab it runs after the
   * check only. A push token is needed on each forge (docs/workflows.md).
   */
  respond?: CiRespond;
  /**
   * The model run behind `respond.wave-refused: "summary"`, keyed as chant's
   * key vocabulary spells it (`agent.wave-refused.*`). Read only with that mode.
   */
  agent?: CiAgent;
  /**
   * Signed checks (chant issues 4870, 4869, 4964, 4978; sql-yodeler issue
   * 346): the pipeline's runner identity, which signs each environment's
   * plan as `plan:<env>` and `policy:<env>`, each check hook that passed by
   * its name, and each apply wave's plan as `plan:<wave>`. `runnerKeySecret`
   * names the secret (GitHub, Forgejo) or CI/CD variable (GitLab) holding
   * the runner key as PEM, which `.chant/trust.json` lists; on GitLab make
   * it protected and scope it to the `chant-evidence` environment, where
   * only the signing jobs run. `identity: "oidc"` signs keyless from the
   * job's OIDC identity instead, which `.chant/trust.json` lists under
   * `keyless.identities` (`audience` as `keyless.audience` says, default
   * `sigstore`). Absent: nothing is signed.
   */
  evidence?: CiEvidence;
  /**
   * The ref gate (chant issues 4867, 4913): `true` adds a `refs` rule for
   * main to `.chant/trust.json` that needs current evidence of each
   * environment's `plan:<env>` and `policy:<env>` and of each check hook,
   * and renders the job that sets `chant/ref-gate` on each pull request.
   * Off by default: with the rule in place a push to main is refused until
   * its checks are signed, so set `evidence` and list the runner first.
   */
  refGate?: boolean;
  /**
   * The environments as stages of chant's pipeline, in promotion order:
   * chant's `promotion` key. Set, `yodel ci` writes `.chant/pipeline.ts`
   * from this config with chant's helper, a merge applies the first stage's
   * wave and cuts a release, and each later stage takes that release with
   * `yodel promote --to <env>` behind its gate. It lists the environments
   * `waves` lists, in the same order. Absent, nothing of the pipeline is
   * written and the waves apply on merge as before.
   */
  promotion?: string[];
  /**
   * Each stage's settings, keyed by environment, in the stage keys of
   * chant's vocabulary. Read only with {@link CiConfig.promotion}. See
   * {@link CiStageConfig}.
   */
  environments?: Record<string, CiStageConfig>;
  /** The approval rules of every stage's gate, chant's `approval_rules`; a stage's own replace them. */
  approvalRules?: CiApprovalRule[];
  /**
   * The change risk (chant's `risk` keys): `approveAbove` is the score from
   * 0 to 1 above which a plan needs an approval of its own, for every stage
   * that sets none, and `questions` are those the review agent answers.
   * The score only adds approvals. Absent, no score is made.
   */
  risk?: CiRisk;
  /** Shared sets of config and secrets that a stage's `imports` takes, chant's `config_sets`. */
  configSets?: Record<string, CiEnvironmentSet>;
  /** What a merge does once the first stage applied, chant's `release` keys: `cut` (default true) and `label` (default `auto`). */
  release?: { cut?: boolean; label?: string };
  /** chant's `recheck`: `{ schedule }`, the cron line a promotion a soak holds is tried again on. */
  recheck?: { schedule: string };
}

/**
 * One approval rule of a stage's gate, or a group of them (chant's
 * `approval_rules`): `count` distinct approvers, from `roles`, `notAuthor`
 * one who is not the change's author, `proven` only approvers a seal or a
 * review proves; `all` and `any` group rules, nested up to three deep;
 * `name` shows in the rule's progress line.
 */
export type CiApprovalRule =
  | { name?: string; count: number; roles?: string[]; notAuthor?: boolean; proven?: boolean }
  | { name?: string; all: CiApprovalRule[] }
  | { name?: string; any: CiApprovalRule[] };

/** `ci.risk`. */
export interface CiRisk {
  approveAbove?: number;
  questions?: Array<{ id: string; text: string; weight: number; approveAbove?: number }>;
}

/** Where a secret is kept: a forge secret's name, or chant's map naming a store. */
export type CiSecretRef =
  | string
  | { forgeSecret: string }
  | { awsSecretsManager: string; jsonKey?: string; region?: string }
  | { gcpSecretManager: string }
  | { azureKeyVault: string };

/** A set of config and secrets a stage's jobs get as variables (chant's environment sets). */
export interface CiEnvironmentSet {
  /** Shared sets (`ci.configSets` keys) taken first, in order. */
  imports?: string[];
  config?: Record<string, string>;
  secrets?: Record<string, CiSecretRef>;
}

/** The soak check kinds a SQL Yodeler stage takes: an HTTP probe, a Prometheus query and a command. */
export type CiSoakCheckKind = "http" | "prometheus" | "command";

export const CI_SOAK_CHECK_KINDS: readonly CiSoakCheckKind[] = ["http", "prometheus", "command"];

/** One soak check, passed to chant as written: its `kind`, `onFail` (`restart`, the default, or `hold`) and that kind's settings. */
export interface CiSoakCheck {
  kind: CiSoakCheckKind;
  onFail?: "restart" | "hold";
  timeoutSeconds?: number;
  [setting: string]: unknown;
}

/**
 * `ci.environments.<env>`: one stage of chant's pipeline. Each key is the
 * camelCase spelling of a stage key on chant's vocabulary page, and yodel
 * hands it to chant as written. A stage's wave gate and approval mode stay
 * `waves[].gate` and `waves[].approval`, and the steps around apply stay
 * `environments.<env>.steps`.
 */
export interface CiStageConfig extends CiEnvironmentSet {
  /** A manual hold: no release is promoted into the stage. */
  hold?: boolean | { reason?: string; until?: string; description?: string };
  /** Windows in which no release is promoted into the stage, ISO 8601 times. */
  freeze?: Array<{ from: string; until: string; reason?: string }>;
  /** The failed runs a wave of many tenants lets through: a number, or a share such as `"10%"`. */
  failureTolerance?: number | `${number}%`;
  /** This stage's approval rules, in place of `ci.approvalRules`. */
  approvalRules?: CiApprovalRule[];
  /** Over `approveAbove`, the stage's wave waits whatever its gate says and its gate takes `approvalRules` on top of its own. */
  risk?: { approveAbove?: number; approvalRules?: Array<Extract<CiApprovalRule, { count: number }>> };
  /** Checks that must keep passing for `duration` after the stage's last apply before a release goes on. */
  soak?: { duration: string; checks?: CiSoakCheck[]; overrides?: Array<{ members: string[]; duration?: string; checks?: CiSoakCheck[] }> };
  /** The canary stage, whose soak holds every stage after it; it needs a soak with a check. */
  canary?: boolean;
  /** What a failed verify or soak does: `hold` (the default). A migration that ran stays run, so `rollback` is refused. */
  onVerifyFail?: "hold" | "rollback";
  /** The stages a release applies in before this one opens for it; default the stage before. */
  after?: string[];
  /** `replace`: one release at a time, a newer one waiting replacing an older. */
  queue?: "replace";
  /** The role whose one proven approval passes the stage's gate on `yodel promote --urgent`. */
  urgent?: { role: string };
  /** A rollback of the stage pauses it until `yodel resume`. */
  pauseAfterRollback?: boolean;
  /** Release artifacts the stage publishes once it applied: `{ member, output }`, or `{ secret }` naming where a secret is kept. */
  publish?: Record<string, { member: string; output: string } | { secret: CiSecretRef }>;
  /** Artifacts of earlier stages the stage's promote gets as variables: `{ stage, artifact }`. */
  reads?: Record<string, { stage: string; artifact: string }>;
}

/** `ci.evidence`: chant's `PipelineEvidence`, a runner key's secret or a keyless identity. */
export interface CiEvidence {
  runnerKeySecret?: string;
  identity?: "oidc";
  audience?: string;
}

/** `ci.respond` (#312). */
export interface CiRespond {
  new?: RespondNew;
  rebase?: RespondRebase;
  /**
   * What a wave that applied nothing posts when its plan moved since the
   * approval, another run held it or its decision declined it: `diff` posts
   * chant's diff of the migration plan (the members whose plan moved and what
   * moved in them) on the pull request the wave applies, or on a tracking
   * issue when it has none; `summary` posts the same diff with a model's
   * summary above it (chant's mechanism, off unless set, see `ci.agent`);
   * `off` posts nothing. Unset, the rendered files are as before and chant's wave job answers with its own default.
   */
  "wave-refused"?: RespondWaveRefused;
}

export type RespondWaveRefused = "off" | "diff" | "summary";
export const RESPOND_WAVE_REFUSED: readonly RespondWaveRefused[] = ["off", "diff", "summary"];

/** `ci.agent`: the model run of a refused wave's summary, as chant's `agent.wave-refused.*` keys name it. */
export interface CiAgent {
  "wave-refused"?: CiAgentWaveRefused;
}

/** The summary's settings. Every field is optional; chant's defaults answer for the ones left out. */
export interface CiAgentWaveRefused {
  /** The model command: prompt on stdin, summary on stdout. */
  command?: string;
  /** The secret holding the model's key (default `ANTHROPIC_API_KEY`). */
  key_secret?: string;
  /** Minutes the command may run. */
  timeout?: number;
  /** The most summaries per day. */
  max_runs?: number;
  /** The most US dollars the summaries may cost per day. */
  max_cost_usd?: number;
}

export type RespondNew = "off" | "comment" | "on-change";
export const RESPOND_NEW: readonly RespondNew[] = ["off", "comment", "on-change"];

export type RespondRebase = "off" | "comment" | "on-fork";
export const RESPOND_REBASE: readonly RespondRebase[] = ["off", "comment", "on-fork"];

/** The name `yodel new` takes with none given, `{pr}` the pull request's number (#311). */
export const DEFAULT_CI_NEW_NAME = "pr-{pr}";

/** A SQL tool yodel ships a check preset for (#294). */
export type CheckTool = "squawk" | "sqlfluff";

export const CHECK_TOOLS: readonly CheckTool[] = ["squawk", "sqlfluff"];

/**
 * How a CI job exchanges its OIDC token for a cloud login (#132). On GitHub
 * the job requests the token for the cloud's audience and writes it to
 * `tokenFile`; on GitLab the job's `id_tokens` variable is written there.
 * Forgejo gives a job no OIDC token, so there a login is rendered only when
 * `tokenFile` names a token the runner provides.
 *
 * ```ts
 * ci: {
 *   login: {
 *     aws: { roleArn: "arn:aws:iam::123456789012:role/yodel-dev" },
 *     environments: { prod: { aws: { roleArn: "arn:aws:iam::123456789012:role/yodel-prod" } } },
 *   },
 * }
 * ```
 */
export interface CiLogin extends CloudLogins {
  /** Per environment: a cloud's login for the roles of that environment, in place of the one above. */
  environments?: Record<string, CloudLogins>;
}

export interface CloudLogins {
  /** AWS web identity: `AWS_ROLE_ARN` and `AWS_WEB_IDENTITY_TOKEN_FILE`, which the aws command line assumes the role with. */
  aws?: AwsLogin;
  /** gcloud workload identity federation: a credential configuration over the token, and `gcloud auth login --cred-file`. */
  gcp?: GcpLogin;
  /** `az login --service-principal --federated-token` with the token. */
  azure?: AzureLogin;
}

export interface AwsLogin {
  /** The role to assume, `arn:aws:iam::<account>:role/<name>`. */
  roleArn: string;
  /** Where the token is (default: a file in the job's temporary directory). */
  tokenFile?: string;
  /** `AWS_ROLE_SESSION_NAME`. Default: `yodel`. */
  sessionName?: string;
  /**
   * The region the role is assumed in, and `AWS_REGION` after a login
   * through chant's ci-identity (#296), which an `rds-iam` token is signed
   * for unless the token source names its own. Default `us-east-1`.
   */
  region?: string;
}

export interface GcpLogin {
  /** The workload identity provider, `projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>`. */
  workloadIdentityProvider: string;
  /** The service account to impersonate, `<name>@<project>.iam.gserviceaccount.com`. */
  serviceAccount: string;
  tokenFile?: string;
}

export interface AzureLogin {
  /** The application (client) id of the identity with the federated credential. */
  clientId: string;
  /** The directory (tenant) id. */
  tenantId: string;
  tokenFile?: string;
}

export interface YodelConfig {
  /** Keyed by the environment's name in `sql.profiles`. */
  environments?: Record<string, EnvironmentConfig>;
  /**
   * The apply pipeline's waves, in order. An environment no wave names
   * waits for an approval whenever it has a migration to apply, as under
   * gate `always`.
   */
  waves?: WaveConfig[];
  /** `yodel lint`'s rule levels: `{ rules: { destructive: "warning" } }`. A misspelled rule name is a type error. */
  lint?: LintConfig;
  /** Rules over the plan (#53) that `yodel plan` reports and `yodel apply` enforces; see {@link PolicyConfig}. */
  policy?: PolicyConfig;
  /**
   * Webhook events (#61): the NAMES of the environment variables holding a
   * webhook's URL and signing key, and optionally a Slack or Teams incoming
   * webhook's URL. `{ webhook: "YODEL_WEBHOOK_URL", key: "YODEL_WEBHOOK_KEY" }`.
   */
  notify?: NotifyConfig & {
    /** The variable holding the key the webhook's events are signed with: the vocabulary's key for `key`, which stays accepted. */
    webhookKey?: string;
    /** The variable holding the key the relay checks Approve and Decline with: the vocabulary's key for `relay`, which stays accepted. */
    relayKey?: string;
  };
  /**
   * DDL sources (#67): schema an ORM defines, read from the DDL it prints,
   * keyed by a name. Each is written out as declarations in
   * `<sourceDir>/<name>.generated.ts` before every build. See
   * {@link DdlSource}.
   */
  sources?: Record<string, DdlSource>;
  /** `yodel ci`: the forges to render the pipelines for, and the project's own jobs; see {@link CiConfig}. */
  ci?: CiConfig;
  /**
   * `yodel check` (#1): another tool's migrations directory, linted on each
   * pull request. `{ dir: "db/migrations" }`; see {@link CheckConfig}.
   */
  check?: CheckConfig;
}

/** Another tool's migrations, as `yodel check` reads them (#1). */
export interface CheckConfig {
  /** The migrations directory, relative to the project. */
  dir: string;
  /** The tool that owns it. Default: detected from the file names. */
  tool?: "golang-migrate" | "goose" | "flyway" | "dbmate";
  /** The profile bound to the throwaway server the migrations run in. Default: `replay`. */
  env?: string;
}

/**
 * Rules over the versioned plan (#53). `yodel plan` shows each rule's
 * outcome, and `yodel apply` refuses (exit 7) a plan a rule denies, unless
 * someone {@link PolicyConfig.overriders} lists recorded an override of the
 * rules that deny it for exactly that plan digest (`yodel override <env>
 * --rule <id> --reason <text>`, through chant's override gate).
 *
 * ```ts
 * policy: {
 *   overriders: ["alice", "bob"],
 *   rules: [
 *     { id: "no-drops-in-prod", environments: ["prod"], refuse: { classes: ["drop"], destructive: true } },
 *     { id: "silences-cite-a-ticket", silences: { reason: /\b[A-Z]+-\d+\b/ } },
 *     { id: "no-rebuilds-in-hours", environments: ["prod"], check: (plan) => {
 *         const hour = new Date(plan.now).getUTCHours();
 *         const rebuilds = plan.pending.flatMap((m) => m.steps.filter((s) => s.classes.includes("rebuild")));
 *         return hour >= 8 && hour < 18 && rebuilds.length > 0 ? "a rebuild between 08:00 and 18:00 UTC" : undefined;
 *       } },
 *   ],
 * }
 * ```
 */
export interface PolicyConfig {
  rules: PolicyRule[];
  /** Who may override a rule: an override recorded by anyone else does not count. None listed, no override counts. */
  overriders?: string[];
}

/** One rule. It denies the plan when any of `refuse`, `silences` or `check` does. */
export interface PolicyRule {
  /** Names it in output, in the refusal and in `yodel override --rule`: lowercase letters, digits, `-` and `_`. */
  id: string;
  description?: string;
  /** The environments it applies to. Default: every one. */
  environments?: string[];
  /** Denies a pending step of one of these classes (`drop`, `rebuild`, `rewrite`, ...), or a destructive one when `destructive` is true. */
  refuse?: { classes?: string[]; destructive?: boolean };
  /** Denies a `-- yodel:allow` silence (of one of `rules`, default any) whose reason does not match `reason`. */
  silences?: { rules?: string[]; reason: RegExp };
  /** A predicate over the plan: a message (or several) or `false` denies it; `undefined`, `true` or `[]` allows it. */
  check?: (plan: PolicyPlan) => string | string[] | boolean | undefined;
}

/** What a policy rule sees: the plan `yodel apply` would run. Plain JSON. */
export interface PolicyPlan {
  environment: string;
  dialect: "clickhouse" | "postgres";
  /** When the plan is evaluated, ISO 8601 in UTC. */
  now: string;
  /** The migrations the run would apply, in order. For a revert, the one migration reverted, its steps the revert's statements. */
  pending: PolicyMigration[];
  /** Present when the plan is a revert (`yodel revert`): the migration undone and the one it goes back to (null: an empty schema). */
  revert?: { id: string; to: string | null };
  /**
   * Present when the project has no migrations (#249): the plan is the
   * declared schema against the live database, and `pending` holds one
   * entry, `declared`, its steps the planned changes (each a `statement`
   * with its rule and class, and no SQL).
   */
  declarative?: true;
}

export interface PolicyMigration {
  id: string;
  checksum: string;
  outOfOrder: boolean;
  steps: PolicyStep[];
  /** Its `-- yodel:allow` silences. */
  silences: Array<{ step: number; rule: string; reason: string }>;
}

export interface PolicyStep {
  index: number;
  kind: "statement" | "op" | "manual";
  object: string;
  name: string;
  /** A statement's class, or every class an Op or manual step's changes have. */
  classes: string[];
  destructive: boolean;
  /** The rules that classified it. */
  rules: string[];
  /** A statement's SQL. */
  sql?: string;
  /** An Op step's Op. */
  op?: string;
}

/**
 * The rules `lint.rules` can set: every lint rule, the replay check's, the
 * sql lexicon's schema checks (`SQLPG101`, `SQLCH113`), and the project's own
 * checks from `chant.config.ts` `lint.policies`, whose ids are upper case
 * with a dash (`ORG-CREATED-AT`). `yodel lint` refuses an id no rule has.
 */
export type LintRuleName = LintRuleId | "replay" | `SQLPG${number}` | `SQLCH${number}` | `${Uppercase<string>}-${Uppercase<string>}`;

/** A naming rule: a preset, or a regular expression the whole name must match. */
export type NamingRuleConfig = "snake_case" | "camelCase" | "PascalCase" | (string & {});

export interface LintConfig {
  /** Each rule's level. The integrity rules (fork, directory, checksum, unreadable-object) are always errors. */
  rules?: Partial<Record<LintRuleName, LevelSetting>>;
  /** The names a migration adds, per kind of object (rule `naming`): `{ table: "snake_case", index: "[a-z_]+_idx" }`. */
  naming?: Partial<Record<"table" | "column" | "index" | "constraint", NamingRuleConfig>>;
}

/** Returns `config` as is; it types the default export of `yodel.config.ts`. */
export const defineConfig = (config: YodelConfig): YodelConfig => config;
