---
claims: [topology]
---

# Installing and configuring

## Installing

`@intentius/sql-yodeler` is on npm. It needs Node 22.12 or later, and the project also needs chant and the `sql` lexicon, which `chant.config.ts` and the declarations import:

```sh
npm install @intentius/sql-yodeler @intentius/chant@0.117.0 @intentius/chant-lexicon-sql@0.117.0
npx yodel --version
```

No token is needed, on your machine or in CI. A project made from a starter template has all three in its `package.json` already, so `npm install` there is enough; [Your first migration](getting-started.md) goes from there. The starter templates' `package.json` names `^0.3.0`. While the version is 0.x, a caret range stays within one minor version, so moving to the next minor release means changing the range (`npm install @intentius/sql-yodeler@0.4`).

To try a commit that is not released yet, from git or from a clone, see [CONTRIBUTING.md](../CONTRIBUTING.md#running-an-unreleased-yodel-in-a-project).

## A project

A project is one directory:

```
chant.config.ts     the dialect and one profile per environment (chant's config)
yodel.config.ts     optional: what yodel needs per environment that chant's config does not say
src/                the declared schema (chant's sql lexicon)
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
| `user`, `password` | `{ env: "<VAR>" }`: the variable each is read from. Credentials are never written in the file. |
| `databases` (ClickHouse) | the databases the project's schema lives in. `yodel init --from` needs it, and the history's database must not be one of them. |
| `schemas` (Postgres) | the same, for schemas. |
| `topology` (ClickHouse) | the topology chant renders for; see [Topology](topology.md). |
| `lockTimeoutMs`, `statementTimeoutMs`, `scanTimeoutMs` (Postgres) | the `lock_timeout` of every statement `yodel apply` sends, and of the live-schema reads before it and in `yodel drift`, which name the lock they waited on (default 5000), the `statement_timeout` of a catalog change (default 60000), and of a statement that reads or rewrites rows (default none). |

The starter templates read a reader's or a writer's credentials by `YODEL_CREDENTIALS` (`writer` only in the apply job); see each template's README.

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
| topology (ClickHouse) | `environments.<env>.topology` | `sql.profiles.<env>.topology` | `YODEL_TOPOLOGY` | `single` |
| the history's database (ClickHouse) or schema (Postgres) | `environments.<env>.history.database` | | `YODEL_HISTORY_DATABASE` | `yodeler` |
| the ClickHouse apply lock's TTL, in seconds | `environments.<env>.lockTtl` | | `YODEL_LOCK_TTL` | 900 |
| how long an apply waits for a lock another apply holds | `environments.<env>.lockWait` (seconds) | | `YODEL_LOCK_WAIT` (a duration: `90`, `30s`, `10m`, `1h`) | 0: exit 5 at once |
| lint rule levels | `lint.rules` | | | each rule's own |
| the apply pipeline's waves and their gates | `waves` | | | none: every environment waits for an approval |

`waves` lists the environments in the order the apply pipeline applies them, each with a gate policy: `[{ env: "dev", gate: "never" }, { env: "prod", gate: "on-destructive" }]`. An environment it does not name, or a wave without `gate`, waits for an approval whenever it has a migration to apply (`always`). The pipeline reads a wave's gate from the commit a change merges onto, not from the change; [Approval](approval.md#waves-a-gate-per-environment) has the rest. A wave applies only migrations the wave before it has applied; `requires: "<env>"` names another environment, `requires: false` none ([Promotion](approval.md#promotion-what-the-wave-before-has-applied)).

`ci` is what `yodel ci` renders the project's pipelines for: `forges`, the forges (default `["github", "gitlab", "forgejo"]`; a forge left out gets no files), and `jobs`, a module relative to the project that declares the project's own jobs with chant's lexicons: `export const actions = { ... }` (the github lexicon's `Job`, for GitHub and Forgejo) and `export const gitlab = { ... }` (the gitlab lexicon's `Job`). `yodel ci` adds them to the pull request pipeline after its own jobs (a GitLab job's stage goes after `review`), so they are kept every time the pipelines are rendered again; a name yodel's jobs use is refused. `image`, when set, is the CI image every job runs in, pinned by its digest (`ghcr.io/intentius/sql-yodeler:<version>@sha256:<digest>`; a tag alone is refused): it carries node, yodel, chant and the lexicons, so no job runs `npm ci`. See [The pipelines](workflows.md#the-pipelines-yodel-ci).

`sources` names DDL sources, the tables an ORM defines read from the DDL it prints; see [Schema from an ORM](orm.md).

The first one set wins. On ClickHouse, `yodel status <env>` and `yodel plan <env>` print the topology and where it came from (`topology single (default)`); Postgres has no topology, and they print none.

The declarative path plans and applies through chant, which reads only `sql.profiles.<env>.topology`. So a topology set in `yodel.config.ts` alone is refused there unless it is `single`, which is what chant renders when its profile sets none:

```console
$ yodel plan dev
yodel plan: yodel.config.ts sets environments.dev.topology to cluster:main, but the declarative path plans and applies through chant, which reads sql.profiles.dev.topology (unset, so a single node). Set sql.profiles.dev.topology to the same in chant.config.ts, or leave the topology to chant.config.ts.
```

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
