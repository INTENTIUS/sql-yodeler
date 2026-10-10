# Your first migration

This page takes you from an empty directory to two migrations applied to a ClickHouse database on your own machine. It needs Node 22.12 or later, npm, git, and Docker for the local database. Every command below ran as shown, and the output under it is what it printed; `<my-schema>` stands for the project's path.

## What chant is

SQL Yodeler is built on [chant](https://www.npmjs.com/package/@intentius/chant), a declarative infrastructure-as-code toolkit in TypeScript. You declare your schema with chant's `sql` lexicon, and the `yodel` CLI does the rest. You need chant's own CLI for three things only:

- `chant init --from ...` makes a new project from a template.
- `chant emulator up --lexicon sql` starts a local ClickHouse and Postgres in Docker.
- `chant approve ...` approves a plan before `yodel apply` runs it.

The chant CLI is the npm package `@intentius/chant`. Before your project exists, run it as `npx @intentius/chant`. Inside the project, `npm install` puts it in `node_modules`, so `npx chant` works there. (Plain `npx chant` outside a project runs an unrelated package with the same name.)

## 1. Make the project

```sh
npx @intentius/chant init --from INTENTIUS/sql-yodeler@main#templates/clickhouse --param name=events-schema --param database=events my-schema
cd my-schema
npm install
```

`database=events` is the ClickHouse database your schema lives in. The template declares one table in it, in `src/schema.ts`:

```ts
export const db = database`
  CREATE DATABASE events
  ENGINE = Atomic
  COMMENT 'Declared in src/schema.ts'`;

export const events = table`
  CREATE TABLE ${db}.events (
    id       UInt64,
    kind     LowCardinality(String),
    at       DateTime
  )
  ENGINE = MergeTree
  ORDER BY (kind, at)
  COMMENT 'One row per event'`;
```

For Postgres, use `templates/postgres` with `--param name=app-schema --param schema=app`; [Postgres](#postgres) below lists what changes.

`yodel` finds the Op that applies migrations through git, and chant keeps approvals on a git branch, so the project must be a git repository:

```sh
git init -b main
git add -A && git commit -m "chore: a new yodel project"
```

## 2. Start a local database

```sh
npx chant emulator up --lexicon sql
```

This starts ClickHouse on `http://127.0.0.1:8123` (user `default`, no password) and Postgres on `127.0.0.1:5432` (user `postgres`, password `chant`), in Docker.

## 3. Point the dev environment at it

`chant.config.ts` names the `dev` environment's server and credentials by environment variable, and never holds a value. `dev` defaults to `http://127.0.0.1:8123`, so only the user and password are needed:

```sh
export DEV_CLICKHOUSE_READER_USER=default
export DEV_CLICKHOUSE_READER_PASSWORD=
```

Without them, `npx yodel plan dev` stops with `sql.profiles.dev.user names DEV_CLICKHOUSE_READER_USER, which is not set`.

The template gives each environment two users: a reader (the default, used by plans, pull request comments and drift checks) and a writer, picked with `YODEL_CREDENTIALS=writer` (only CI's apply job sets it). The emulator's `default` user can do both, so on your machine the reader's variables are enough. Against a real server whose reader is read-only, also export `DEV_CLICKHOUSE_WRITER_USER` and `DEV_CLICKHOUSE_WRITER_PASSWORD` and run `yodel apply` with `YODEL_CREDENTIALS=writer`. The variables for every environment:

| Variable | Meaning |
|---|---|
| `<ENV>_CLICKHOUSE_URL` | the server's HTTP interface; `dev` defaults to `http://127.0.0.1:8123` |
| `<ENV>_CLICKHOUSE_READER_USER`, `<ENV>_CLICKHOUSE_READER_PASSWORD` | the read-only user |
| `<ENV>_CLICKHOUSE_WRITER_USER`, `<ENV>_CLICKHOUSE_WRITER_PASSWORD` | the user that applies, read when `YODEL_CREDENTIALS=writer` |

`<ENV>` is `DEV` or `PROD`.

## 4. Write the first migration

`yodel new` writes the next migration from the change in `src/` since the last one. The first one creates everything. `yodel lint` checks the migrations offline:

```console
$ npx yodel new init
Wrote migrations/20261010T0423-init/ (2 statements; the first migration)
$ npx yodel lint
1 migration: 0 errors, 0 warnings, 0 silenced.
```

Commit it:

```sh
git add -A && git commit -m "feat: the first migration"
```

## 5. Plan, approve, apply

`yodel plan` shows what `yodel apply` would run, and a digest of that plan:

```console
$ npx yodel plan dev
Plan for dev (clickhouse, history yodeler.history (single (yodel.config.ts))): 0 applied, 1 pending

20261010T0423-init
  0  statement  SQLCH200 create  events
       CREATE DATABASE events
         ENGINE = Atomic
         COMMENT 'Declared in src/schema.ts [chant managed-by=chant]'
  1  statement  SQLCH200 create  events.events
       CREATE TABLE events.events (
           id       UInt64,
           kind     LowCardinality(String),
           at       DateTime
         )
         ENGINE = MergeTree
         ORDER BY (kind, at)
         COMMENT 'One row per event [chant managed-by=chant]'

Plan digest: jcs1-sha256:6a24eb53da32eb1409c060578e15403fee6bd16279497cadf5f2a05cebbddcc6
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:6a24eb53da32eb1409c060578e15403fee6bd16279497cadf5f2a05cebbddcc6

Not approved yet. Approving binds exactly this digest; if anything it covers changes before the apply runs, the gate asks again and nothing is applied.
```

`yodel apply` runs only a plan someone approved. The first run stops at the approval and prints the command that gives it (exit 3):

```console
$ npx yodel apply dev
Migrations in dev (history yodeler.history, topology single (yodel.config.ts))

Applied: none

Pending (1):
  20261010T0423-init

Plan digest: jcs1-sha256:6a24eb53da32eb1409c060578e15403fee6bd16279497cadf5f2a05cebbddcc6

Running migrate-dev (<my-schema>/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   1.7s
[phase] Approve
  • gate:approve-migrate-dev()   skipped
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 2.1s
  plan    : jcs1-sha256:6a24eb53da32eb1409c060578e15403fee6bd16279497cadf5f2a05cebbddcc6
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:6a24eb53da32eb1409c060578e15403fee6bd16279497cadf5f2a05cebbddcc6
  expires : 2026-10-12T04:24:00.368Z
  warning : the pending fact was not pushed to the remote — no remote is configured for chant/lifecycle — the pending fact was recorded locally only. An operator elsewhere cannot approve it until it does.

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:6a24eb53da32eb1409c060578e15403fee6bd16279497cadf5f2a05cebbddcc6).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:6a24eb53da32eb1409c060578e15403fee6bd16279497cadf5f2a05cebbddcc6
then run yodel apply dev again.
[exit 3]
```

The warnings about a remote are expected: approvals live on a `chant/lifecycle` branch, and this repository has no remote to push it to.

To approve, run the printed `chant approve` command with `npx` in front, or let `yodel apply dev --digest` fill in the digest, as here. The approval holds for this exact plan only. Then run `yodel apply` again:

```console
$ npx chant approve migrate-dev approve-migrate-dev --plan "$(npx yodel apply dev --digest)"
warning: No remote is configured, so nothing was pushed. The resolution is recorded locally on chant/lifecycle. Until it reaches the remote, a run in another checkout will not see it.
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-10T04:24:02.719Z (local only — the push did not land)
This approves the plan jcs1-sha256:6a24eb53da32eb1409c060578e15403fee6bd16279497cadf5f2a05cebbddcc6, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
$ npx yodel apply dev
Migrations in dev (history yodeler.history, topology single (yodel.config.ts))

Applied: none

Pending (1):
  20261010T0423-init

Plan digest: jcs1-sha256:6a24eb53da32eb1409c060578e15403fee6bd16279497cadf5f2a05cebbddcc6

Running migrate-dev (<my-schema>/ops/migrate-dev.op.ts)
lock: no KeeperMap on this server (KeeperMap is disabled because 'keeper_map_path_prefix' config is not defined. (BAD_ARGUMENTS) (version 26.8.15.10 (official build))); the lock is a file on this machine, so cross-runner locking needs Keeper (and keeper_map_path_prefix)
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:6a24eb53da32eb1409c060578e15403fee6bd16279497cadf5f2a05cebbddcc6, by yodel at 2026-10-10T04:24:02.719Z
20261010T0423-init: applying
  statement 0: ok (SQLCH200 create, events)
  statement 1: ok (SQLCH200 create, events.events)
20261010T0423-init: applied

[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   853ms
[phase] Approve
  ✓ gate:approve-migrate-dev()   180ms
    [approved] yodel at 2026-10-10T04:24:02.719Z
[phase] Apply
  ✓ shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":"jcs1-sha256:6a24eb53da32eb1409c060578e15403fee6bd16279497cadf5f2a05cebbddcc6"})   1.6s
Op "migrate-dev" completed in 2.8s

Applied: 20261010T0423-init.
$ npx yodel status dev
Migrations in dev (history yodeler.history, topology single (yodel.config.ts))

Applied (1):
  20261010T0423-init  2026-10-10 04:24:06.164732 by yodel@example

Pending: none
```

## 6. A second migration

Add a column to the table in `src/schema.ts`:

```ts
    at       DateTime,
    country  LowCardinality(String) DEFAULT ''
```

Then write the migration, check it and commit it:

```console
$ npx yodel new add-country
Wrote migrations/20261010T0424-add-country/ (1 statement; follows 20261010T0423-init)
$ npx yodel lint
2 migrations: 0 errors, 0 warnings, 0 silenced.
```

```sh
git add -A && git commit -m "feat: events.country"
```

The plan has the one new statement. The approval you gave for the first migration does not hold for this plan, and the plan says why:

```console
$ npx yodel plan dev
Plan for dev (clickhouse, history yodeler.history (single (yodel.config.ts))): 1 applied, 1 pending

20261010T0424-add-country
  0  statement  SQLCH201 metadata  events.events
       ALTER TABLE `events`.`events` ADD COLUMN country  LowCardinality(String) DEFAULT '' AFTER `at`

Plan digest: jcs1-sha256:ec67a9919ba2f8584e1cff198c60281a448ee8902c8ddf8668e249684e0af362
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:ec67a9919ba2f8584e1cff198c60281a448ee8902c8ddf8668e249684e0af362

The newest approval of approve-migrate-dev, by yodel at 2026-10-10T04:24:02.719Z, is for jcs1-sha256:6a24eb53da32eb1409c060578e15403fee6bd16279497cadf5f2a05cebbddcc6, not this plan; it does not hold.
What moved (as far as yodel can tell): history changed: applied since: 20261010T0423-init (by yodel@example at 2026-10-10 04:24:06.164732); pending migrations changed: committed to since approval: 20261010T0424-add-country (8a43a76 at 2026-10-09T22:24:09-06:00); live schema changed: no state yodel can rebuild from the history and git hashes to the approved digest with today's live schema, so an object in the environment's live schema (a table, view, index, dictionary, database or schema) changed since approval (or a part yodel cannot rebuild did).
```

Approve and apply as before:

```console
$ npx chant approve migrate-dev approve-migrate-dev --plan "$(npx yodel apply dev --digest)"
warning: No remote is configured, so nothing was pushed. The resolution is recorded locally on chant/lifecycle. Until it reaches the remote, a run in another checkout will not see it.
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-10T04:24:12.207Z (local only — the push did not land)
This approves the plan jcs1-sha256:ec67a9919ba2f8584e1cff198c60281a448ee8902c8ddf8668e249684e0af362, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
$ npx yodel apply dev
Migrations in dev (history yodeler.history, topology single (yodel.config.ts))

Applied (1):
  20261010T0423-init  2026-10-10 04:24:06.164732 by yodel@example

Pending (1):
  20261010T0424-add-country

Plan digest: jcs1-sha256:ec67a9919ba2f8584e1cff198c60281a448ee8902c8ddf8668e249684e0af362

Running migrate-dev (<my-schema>/ops/migrate-dev.op.ts)
lock: no KeeperMap on this server (KeeperMap is disabled because 'keeper_map_path_prefix' config is not defined. (BAD_ARGUMENTS) (version 26.8.15.10 (official build))); the lock is a file on this machine, so cross-runner locking needs Keeper (and keeper_map_path_prefix)
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:ec67a9919ba2f8584e1cff198c60281a448ee8902c8ddf8668e249684e0af362, by yodel at 2026-10-10T04:24:12.207Z
20261010T0424-add-country: applying
  statement 0: ok (SQLCH201 metadata, events.events)
20261010T0424-add-country: applied

[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   834ms
[phase] Approve
  ✓ gate:approve-migrate-dev()   174ms
    [approved] yodel at 2026-10-10T04:24:12.207Z
[phase] Apply
  ✓ shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":"jcs1-sha256:ec67a9919ba2f8584e1cff198c60281a448ee8902c8ddf8668e249684e0af362"})   932ms
Op "migrate-dev" completed in 2.1s

Applied: 20261010T0424-add-country.
```

## The same steps with just

Each template has a `justfile` for these steps. [just](https://github.com/casey/just) is optional: every target runs the command beside it, and the commands work without it.

| just | Runs |
|---|---|
| `just up` | `npx chant emulator up --lexicon sql` |
| `just new <name>` | `npx yodel new <name>` |
| `just lint` | `npx yodel lint` |
| `just plan [env]` | `npx yodel plan <env>` (`dev` when left out) |
| `just apply [env]` | `npx yodel apply <env>` |
| `just approve [env]` | prints the `npx chant approve ...` command for the environment's current plan; it does not run it |
| `just status` | `npx yodel status dev` |
| `just drift` | `npx yodel drift dev` |
| `just ci` | `npm run ci`, which renders the CI pipelines again |

## Postgres

The steps are the same with `templates/postgres`. The variables are `<ENV>_POSTGRES_URL`, `<ENV>_POSTGRES_READER_USER` and so on, and the URL names the database:

```sh
export DEV_POSTGRES_URL=postgres://127.0.0.1:5432/postgres
export DEV_POSTGRES_READER_USER=postgres
export DEV_POSTGRES_READER_PASSWORD=chant
```

If a Postgres of your own already listens on `127.0.0.1:5432` (Homebrew's, for example), that address reaches it rather than the emulator. Stop it, or point `DEV_POSTGRES_URL` at the emulator's container another way.

## Next

- Push the project and set up CI: the README the template wrote into `my-schema` lists the secrets and users each forge needs. From then on each change is a pull request: edit `src/schema.ts`, `npx yodel new <name>`, commit both. The pull request gets a plan comment, and a merge applies what was approved.
- [The two workflows](workflows.md), [Migrations](migrations.md) and [Approval](approval.md) explain what you just ran.
- [Drift](drift.md) reports a declared object changed by hand on the server.
- To take a database you already have into migrations, see [Starting a project](adoption.md#adopting-an-existing-database-yodel-init-from).
