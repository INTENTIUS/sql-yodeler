---
claims: [topology, declarative, approval]
type: reference
---

# Installing and configuring

## Installing

`@intentius/sql-yodeler` is on npm. It needs Node 22.12 or later, and the project also needs chant and the `sql` lexicon, which `chant.config.ts` and the declarations import:

```sh
npm install @intentius/sql-yodeler @intentius/chant@0.121.0 @intentius/chant-lexicon-sql@0.121.0
npx yodel --version
```

No token is needed, on your machine or in CI. A project made from a starter template has all three in its `package.json` already, so `npm install` there is enough; [Your first migration](getting-started.md) goes from there. The starter templates' `package.json` names `^0.5.2`. While the version is 0.x, a caret range stays within one minor version, so moving to the next minor release means changing the range (`npm install @intentius/sql-yodeler@0.6`).

To try a commit that is not released yet, from git or from a clone, see [CONTRIBUTING.md](../CONTRIBUTING.md#running-an-unreleased-yodel-in-a-project).

## A project

A project is one directory:

```
chant.config.ts     the dialect and one profile per environment (chant's config)
yodel.config.ts     optional: what yodel needs per environment that chant's config does not say
src/                the declared schema: chant's sql lexicon, in TypeScript or plain .sql files
migrations/         the versioned migrations, written by yodel new (absent on the declarative path)
ops/                the Ops yodel apply runs (a migrations Op or an ApplyOp per environment), and drift watches
package.json
```

Every command takes `-C <dir>` (`--dir`) for a project elsewhere than the working directory.

## chant.config.ts

The connection and the scope of each environment are chant's: `sql.profiles.<env>`. From the Postgres example:

```ts
import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-sql";

export default {
  lexicons: ["sql"],
  sourceDir: "src",
  sql: {
    dialect: "postgres",
    profiles: {
      dev: {
        url: process.env.DEV_POSTGRES_URL ?? "postgres://127.0.0.1:5432/postgres",
        user: { env: "DEV_POSTGRES_USER" },
        password: { env: "DEV_POSTGRES_PASSWORD" },
        schemas: ["shop"],
      },
    },
  },
} satisfies ChantConfig;
```

| Field | Meaning |
|---|---|
| `url` | ClickHouse: the HTTP interface (`http://clickhouse:8123`). Postgres: a connection URL with no password in it. |
| `user`, `password` | `{ env: "<VAR>" }`: the variable each is read from. Credentials are never written in the file. A `password` can also be a token source; see [Credentials](#credentials-a-reader-and-a-writer). |
| `databases` (ClickHouse) | the databases the project's schema lives in. `yodel init --from` needs it, and the history's database must not be one of them. |
| `schemas` (Postgres) | the same, for schemas. |
| `topology` (ClickHouse) | the topology chant renders for; see [Topology](topology.md). |
| `lockTimeoutMs`, `statementTimeoutMs`, `scanTimeoutMs` (Postgres) | the `lock_timeout` of every statement `yodel apply` sends, and of the live-schema reads before it and in `yodel drift`, which name the lock they waited on (default 5000), the `statement_timeout` of a catalog change (default 60000), and of a statement that reads or rewrites rows (default none). |

## Credentials: a reader and a writer

Each environment has two database users. The reader can only read: pull request jobs, the drift watch and anyone at a terminal use it. The writer applies migrations, and only the environment's wave job after a merge holds it. `credentials()` gives a profile both:

```ts
import { credentials } from "@intentius/sql-yodeler";

profiles: {
  dev: { url: "postgres://127.0.0.1:5432/app", ...credentials("dev", "postgres"), schemas: ["shop"] },
}
```

A process connects as the reader unless `YODEL_CREDENTIALS` is `writer` (every environment) or `writer:<env>` (that one); only `<env>`'s wave job sets `writer:<env>`. Each role reads its user and password from a variable, by default `<ENV>_<DIALECT>_READER_USER`, `<ENV>_<DIALECT>_READER_PASSWORD`, `<ENV>_<DIALECT>_WRITER_USER` and `<ENV>_<DIALECT>_WRITER_PASSWORD` (`DEV_POSTGRES_READER_USER`), the names `yodel ci` maps the forge's secrets to. The third argument replaces a role's user or password: `credentials("prod", "postgres", { writer: { user: { env: "APP_MIGRATOR" } } })`. The starter templates' profiles are made this way.

Every command refuses the project, exit 4, when an environment's reader and writer are one identity: both read their user from the same variable, the two variables hold the same user name, or both read their password from the same variable. A job holding such a reader could write.

A command that writes (`yodel apply`, `yodel revert`, `yodel init`) refuses, exit 4, before its gate and before it connects, when it would run as an environment's reader:

```text
yodel apply: refused: npx yodel apply dev writes, and this process holds dev's reader, DEV_CLICKHOUSE_READER_USER (reader), because YODEL_CREDENTIALS is not set. Run it as the writer: YODEL_CREDENTIALS=writer:dev npx yodel apply dev. Nothing was done.
```

`yodel apply --plan` and `--digest`, and `yodel revert --dry-run`, only read, and run as the reader. Each command yodel prints for a person to run that writes (`then run ... again` after a gate stop, `yodel approve`'s `Apply it with`, `yodel override`'s) starts with `YODEL_CREDENTIALS=writer:<env>` for a profile made with `credentials()`. A server that refuses a write for want of a privilege (a profile without `credentials()`, or a writer missing a grant) is reported the same way, in one line naming the user and the server's message, exit 4.

```text
yodel status: refused: sql.profiles.prod: the reader (PROD_POSTGRES_READER_USER) and the writer (PROD_POSTGRES_WRITER_USER) are the same user, app, so a job that holds the reader can write. Give each role its own database user.
```

### Short-lived tokens

A role's password can be minted when a connection needs it, so CI holds no long-lived database password. chant's `sql` lexicon mints it:

| `password` | Mints with | Dialect |
|---|---|---|
| `{ token: "rds-iam" }` | `aws rds generate-db-auth-token`, for the profile's host, port and user; `region` or `AWS_REGION` | Postgres |
| `{ token: "cloud-sql-iam" }` | `gcloud sql generate-login-token` | Postgres |
| `{ token: "entra" }` | `az account get-access-token` for Azure Database for PostgreSQL | Postgres |
| `{ token: "command", command: ["./mint.sh"] }` | any program that prints the password on its standard output, run without a shell | both |

```ts
prod: {
  url: "postgres://db.abc.us-east-1.rds.amazonaws.com:5432/app",
  ...credentials("prod", "postgres", { writer: { password: { token: "rds-iam" } } }),
  schemas: ["shop"],
},
```

A token is reused until 80% of its lifetime has passed (`ttlSeconds`; 900 for `rds-iam`, 3600 for `cloud-sql-iam` and `entra`, 300 for `command`), and minted again when the server refuses it, so a long apply never sends an expired one. A source that cannot mint fails the command as `no-credentials`, naming the source and the program but never what it printed. The cloud sources run the cloud's own command line, which reads the identity of the machine or the job; the `command` source is how a test, or a mint the others do not cover, supplies one.

`yodel ci` gives each job the variables of the role it holds and nothing for a token-minted password. A job holding a role minted by `rds-iam`, `cloud-sql-iam` or `entra` also gets an OIDC token from the forge:

| Forge | What `yodel ci` renders |
|---|---|
| GitHub | `permissions: id-token: write` on the workflow (the pull request, apply or watch workflow whose jobs hold such a role) |
| GitLab | `id_tokens` on each job holding such a role: `AWS_ID_TOKEN` (audience `sts.amazonaws.com`), `GCP_ID_TOKEN` (`https://iam.googleapis.com/`, or the provider's own audience with `ci.login.gcp`) or `AZURE_ID_TOKEN` (`api://AzureADTokenExchange`) |
| Forgejo | nothing: Forgejo gives a job no OIDC token, so the runner's own cloud identity (an instance profile, a workload or managed identity) mints. The rendered files say so. |

The cloud's command line then has to reach that identity in the job. A runner that carries the identity itself needs nothing more. Otherwise `ci.login` in yodel.config.ts tells `yodel ci` how to exchange the token, and each job holding such a role logs in before yodel runs:

```ts
ci: {
  forges: ["github", "gitlab"],
  login: {
    aws: { roleArn: "arn:aws:iam::123456789012:role/yodel-dev" },
    gcp: { workloadIdentityProvider: "projects/123456789/locations/global/workloadIdentityPools/ci/providers/forge", serviceAccount: "yodel@shop.iam.gserviceaccount.com" },
    azure: { clientId: "<application id>", tenantId: "<directory id>" },
    environments: { prod: { aws: { roleArn: "arn:aws:iam::123456789012:role/yodel-prod" } } },
  },
},
```

| Cloud (token source) | The login step |
|---|---|
| `aws` (`rds-iam`) | the token in a file, and `AWS_ROLE_ARN`, `AWS_WEB_IDENTITY_TOKEN_FILE` and `AWS_ROLE_SESSION_NAME` (`sessionName`, default `yodel`), which the aws command line assumes the role with |
| `gcp` (`cloud-sql-iam`) | the token in a file, a workload identity credential configuration over it that impersonates `serviceAccount`, `gcloud auth login --cred-file` with it, and `GOOGLE_APPLICATION_CREDENTIALS` |
| `azure` (`entra`) | the token in a file, `az login --service-principal --federated-token`, and `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and `AZURE_FEDERATED_TOKEN_FILE` |

On GitHub the step requests the job's OIDC token for the cloud's audience and writes the variables to `$GITHUB_ENV`, so the later steps (the report too) have them. On GitLab the job writes its `id_tokens` variable to the file, and the variables are the job's own, so `after_script` has them. Forgejo gives a job no token, so there a login is rendered only when `tokenFile` names a token the runner provides; without one, the runner's identity mints. `tokenFile` also moves the file on GitHub (default `$RUNNER_TEMP/yodel-<cloud>-token`) and GitLab (`/tmp/yodel-<cloud>-token`). `environments.<env>` gives one environment's roles a login of their own; a job that holds two environments' roles with different logins for one cloud is refused, since it logs in once per cloud. The job's image needs the cloud's command line (`aws`, `gcloud`, `az`). `yodel ci` only renders these steps; nothing calls a cloud until the job runs. Trust the writer's cloud role from the apply job only: on GitHub by the subject `repo:<owner>/<repo>:environment:<env>`, on GitLab by `ref:main` and the environment.

### yodel config check

`yodel config check [<env>...]` prints each environment's settings and where each came from: the server, the role this process connects as, each role's user and password variable and whether it is set here (or the token source), the history's database, the topology and the lock settings. It never prints a password.

`--write-probe` tries a write with the credentials this process holds and exits 4 when the server lets it through: a `CREATE TABLE` in the environment's first schema inside a transaction that is rolled back (Postgres), or a `Memory` table in its first database, dropped at once (ClickHouse). Only a refusal for want of privilege counts as "cannot write"; a probe that cannot tell is an error. Every pull request plan job `yodel ci` renders runs it before the plan, with each reader the job holds (`yodel config check prod dev --write-probe`), so a pull request job that holds a writer fails. The pull request job that records the plans a `pr-review` wave's review approves (`yodel-apply-plans.yml`, GitLab's `yodel-apply-record-plans`) runs it too, before `chant run wave --record-plans`, with the reader of every environment a wave applies.

### Least privilege on each forge

| Job | Holds |
|---|---|
| lint (pull request) | no database credentials: the replay runs on a throwaway server the job starts |
| plan-`<env>` (pull request) | `<env>`'s reader, and the reader of the environment its wave requires |
| watch-`<env>` (schedule) | `<env>`'s reader |
| wave `<env>` (push to main) | `<env>`'s writer (`YODEL_CREDENTIALS=writer:<env>`), and the reader of the environment it requires |

The pipelines map only those, but a pull request can change a workflow, so where a secret is readable decides what a pull request could take. [Setting up each forge](forges.md) says where the readers' and the writer's secrets go on GitHub, GitLab and Forgejo so that only the wave job can read the writer's, and which tokens the jobs use.

The database grants are the other half: the reader with SELECT (and on Postgres `default_transaction_read_only = on`; on ClickHouse `readonly = 1`), the writer with what the migrations need on the environment's schema or database and the history's. The write probe proves the first half on every pull request.

## yodel.config.ts

Optional. Keyed by the profile names in `chant.config.ts`:

```ts
import { defineConfig } from "@intentius/sql-yodeler";

export default defineConfig({
  environments: {
    dev: { topology: "single", history: { database: "yodeler" } },
    prod: { topology: "cluster:main", history: { database: "yodeler" }, lockTtl: 1800, lockWait: 600 },
  },
  lint: { rules: { "ch-mutation": "warning" } },
});
```

`import type { YodelConfig } from "@intentius/sql-yodeler"` with `satisfies YodelConfig`, as the templates and examples do, types it the same way.

| Setting | 1. yodel.config.ts | 2. chant.config.ts | 3. variable | Default |
|---|---|---|---|---|
| topology (ClickHouse) | `environments.<env>.topology` | `sql.profiles.<env>.topology` | `YODEL_CREDENTIALS` | `credentials()` in chant.config.ts | `writer` or `writer:<env>`: connect as the writer; otherwise the reader. Only an environment's wave job sets it |
| `YODEL_TOPOLOGY` | `single` |
| the history's database (ClickHouse) or schema (Postgres) | `environments.<env>.history.database` | | `YODEL_HISTORY_DATABASE` | `yodeler` |
| the ClickHouse apply lock's TTL, in seconds | `environments.<env>.lockTtl` | | `YODEL_LOCK_TTL` | 900 |
| how long an apply waits for a lock another apply holds | `environments.<env>.lockWait` (seconds) | | `YODEL_LOCK_WAIT` (a duration: `90`, `30s`, `10m`, `1h`) | 0: exit 5 at once |
| access control: Postgres row-level security, policies, roles, grants; ClickHouse users, roles, row policies, grants ([Access control](access.md)) | `environments.<env>.access` | `sql.profiles.<env>.access` | | off |
| lint rule levels | `lint.rules` | | | each rule's own |
| the apply pipeline's waves and their gates | `waves` | | | none: every environment waits for an approval |
| a tenant set: one environment over many databases or schemas | `environments.<env>.tenants` | | | none |
| checks and commands run before and after an apply | `environments.<env>.steps` (read at the base commit) | | | none |
| which approvals count: a wave's (`ledger`, `pr-review`, `sealed`), and the migrations Op's (`ledger`, `sealed`) | `waves[].approval`, `environments.<env>.approval` (read at the base commit) | | | `ledger`; the migrations Op takes `sealed` from its wave |

`waves` lists the environments in the order the apply pipeline applies them, each with a gate policy: `[{ env: "dev", gate: "never" }, { env: "prod", gate: "on-destructive" }]`. An environment it does not name, or a wave without `gate`, waits for an approval whenever it has a migration to apply (`always`). The pipeline reads a wave's gate from the commit a change merges onto, not from the change; [Approval](approval.md#waves-a-gate-per-environment) has the rest. A wave applies only migrations the wave before it has applied; `requires: "<env>"` names another environment, `requires: false` none ([Promotion](approval.md#promotion-what-the-wave-before-has-applied)). A wave's `approval` says which approvals of its plan count: any `chant approve` (`ledger`, the default), also the pull request's review (`pr-review`), or only a sealed one (`sealed`); [Approval modes](approval.md#approval-modes-which-approvals-count) has the rest.

`tenants` makes an environment a tenant set: the same migrations applied to many ClickHouse databases or Postgres schemas, each with its own history. It is a list of names, `{ file: "tenants.txt" }` (one per line, or a JSON array), or `{ query: "SELECT ..." }`, read-only, run on the environment's server each time the wave runs (the rendered pipeline does not list those tenants). A wave over a tenant set can be split with `shares`. [Tenant sets](approval.md#tenant-sets-one-wave-over-many-databases-or-schemas) has the rest.

`ci` is what `yodel ci` renders the project's pipelines for: `forges`, the forges (default `["github", "gitlab", "forgejo"]`; a forge left out gets no files), and `jobs`, a module relative to the project that declares the project's own jobs with chant's lexicons: `export const actions = { ... }` (the github lexicon's `Job`, for GitHub and Forgejo) and `export const gitlab = { ... }` (the gitlab lexicon's `Job`). `yodel ci` adds them to the pull request pipeline after its own jobs (a GitLab job's stage goes after `review`), so they are kept every time the pipelines are rendered again; a name yodel's jobs use is refused. `image`, when set, is the CI image every job runs in, pinned by its digest (`ghcr.io/intentius/sql-yodeler:<version>@sha256:<digest>`; a tag alone is refused): it carries node, yodel, chant and the lexicons, so no job runs `npm ci`. `apply: false` renders no apply pipeline and no `yodel-waves.json`, so CI holds readers only; it is refused with a `pr-review` wave or `resume` ([Lint and plan on pull requests only](lint-and-plan.md)). See [The pipelines](workflows.md#the-pipelines-yodel-ci).

`sources` names DDL sources, the tables an ORM defines read from the DDL it prints; see [Schema from an ORM](orm.md).

The first one set wins. On ClickHouse, `yodel status <env>` and `yodel plan <env>` print the topology and where it came from (`topology single (default)`); Postgres has no topology, and they print none.

The declarative path plans and applies through chant, which reads only `sql.profiles.<env>.topology`. So a topology set in `yodel.config.ts` alone is refused there unless it is `single`, which is what chant renders when its profile sets none:

```console
$ yodel plan dev
yodel plan: yodel.config.ts sets environments.dev.topology to cluster:main, but the declarative path plans and applies through chant, which reads sql.profiles.dev.topology (unset, so a single node). Set sql.profiles.dev.topology to the same in chant.config.ts, or leave the topology to chant.config.ts.
```

`access` is the same: the declarative apply and `yodel drift` run chant, which reads `sql.profiles.<env>.access`, so on the declarative path an `access` in `yodel.config.ts` that the profile does not say is refused. yodel's own commands (`yodel plan`, `yodel new`, `yodel init --from`, the versioned apply) use `yodel.config.ts`'s. On ClickHouse, chant's apply has no access setting and makes every access declaration it is given, so the declarative path is refused instead where the environment does not manage access and `src/` declares a user, role, row policy or grant ([Access control](access.md#turn-it-on-per-environment)).

## Environment variables

| Variable | Read by | Meaning |
|---|---|---|
| `YODEL_TOPOLOGY` | the versioned commands on ClickHouse (`apply`, `plan`, `status`, `init`, `repair`, `lint --replay`) | the topology, when neither config sets one; the declarative path does not read it |
| `YODEL_HISTORY_DATABASE` | the versioned commands | the history's database or schema, when `yodel.config.ts` sets none |
| `YODEL_LOCK_TTL` | `yodel apply`, `yodel init`, `yodel repair` on ClickHouse | the lock's TTL in seconds |
| `YODEL_LOCK_WAIT` | `yodel apply` | how long to wait for a lock another apply holds, as `--lock-wait` (`10m`); `yodel apply` hands its `--lock-wait` to the Op's Apply step this way |
| `YODEL_STAND_DOWN` | `yodel apply` | `1`: as `--stand-down`, apply nothing and exit 0 when the run's branch has a newer commit on `origin` |
| `YODEL_LOCK_RETRIES` | `yodel apply` on Postgres | how many more times a statement that hit `lock_timeout` is tried (default 5, the pause doubling from 250 ms) |
| `GITHUB_TOKEN`, `GITLAB_TOKEN`, `FORGEJO_TOKEN` | `yodel plan --comment`, `yodel drift --issue` | the forge token; see [Approval](approval.md) and [Drift](drift.md#the-tracking-issue) |

`YODEL_APPROVED_PLAN` and `YODEL_ALLOW_OUT_OF_ORDER` are set by `yodel apply` for the migrations Op's own steps; you do not set them.
