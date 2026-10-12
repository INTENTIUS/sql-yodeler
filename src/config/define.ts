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
   * Default: `YODEL_LOCK_WAIT`, then 0 (give up at once).
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
   * A failing `before` step: `fail` (the default) refuses the apply, exit 4;
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
   * apply <env>` reads its history (with its reader) and refuses, exit 4,
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
}

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
  notify?: NotifyConfig;
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
 * outcome, and `yodel apply` refuses (exit 4) a plan a rule denies, unless
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
