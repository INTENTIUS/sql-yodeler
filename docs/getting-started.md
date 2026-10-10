---
claims: [new, lint, approval, drift]
---

# Your first migration

This page takes you from an empty directory to two migrations applied to a ClickHouse database on your own machine. It needs Node 22.12 or later, npm, git, and Docker for the local database. Every command below ran as shown, and the output under it is what it printed; `<my-schema>` stands for the project's path.

## What chant is

SQL Yodeler is built on [chant](https://www.npmjs.com/package/@intentius/chant), a declarative infrastructure-as-code toolkit in TypeScript. You declare your schema with chant's `sql` lexicon, and the `yodel` CLI does the rest. You need chant's own CLI for three things only:

- `chant init --from ...` makes a new project from a template.
- `chant emulator up --lexicon sql` starts a local ClickHouse and Postgres in Docker.
- `chant approve ...` approves a plan before `yodel apply` runs it (`yodel approve <env>` does the same at the terminal, without the chant names).

The chant CLI is the npm package `@intentius/chant`. Before your project exists, run it as `npx @intentius/chant@latest` (with `@latest`, npx does not reuse an older copy it cached). Inside the project, `npm install` puts the version the project pins in `node_modules`, so `npx chant` works there. (Plain `npx chant` outside a project runs an unrelated package with the same name.)

## 1. Make the project

```sh
npx @intentius/chant@latest init --from INTENTIUS/sql-yodeler@main#templates/clickhouse --param name=events-schema --param database=events my-schema
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

`chant.config.ts` names the `dev` environment's server and credentials by environment variable, and never holds a value. `dev` defaults to `http://127.0.0.1:8123`, so only the users and passwords are needed.

The template gives each environment two users: a reader (the default, used by plans, pull request comments and drift checks) and a writer, picked with `YODEL_CREDENTIALS=writer` (only CI's apply job sets it, and `just apply` on your machine). yodel refuses an environment whose reader and writer are the same user, so give the emulator a read-only user for the reader, and keep its `default` user, which can do everything, as the writer:

```sh
curl -s http://127.0.0.1:8123 --data-binary "CREATE USER reader IDENTIFIED WITH no_password SETTINGS readonly = 1"
curl -s http://127.0.0.1:8123 --data-binary "GRANT SELECT, SHOW ON *.* TO reader"
export DEV_CLICKHOUSE_READER_USER=reader DEV_CLICKHOUSE_READER_PASSWORD=
export DEV_CLICKHOUSE_WRITER_USER=default DEV_CLICKHOUSE_WRITER_PASSWORD=
```

Without them, `npx yodel plan dev` stops with `sql.profiles.dev.user names DEV_CLICKHOUSE_READER_USER, which is not set`. The reader cannot write, so `yodel apply` runs with `YODEL_CREDENTIALS=writer`, as `just apply` does. The variables for every environment:

| Variable | Meaning |
|---|---|
| `<ENV>_CLICKHOUSE_URL` | the server's HTTP interface; `dev` defaults to `http://127.0.0.1:8123` |
| `<ENV>_CLICKHOUSE_READER_USER`, `<ENV>_CLICKHOUSE_READER_PASSWORD` | the read-only user |
| `<ENV>_CLICKHOUSE_WRITER_USER`, `<ENV>_CLICKHOUSE_WRITER_PASSWORD` | the user that applies, read when `YODEL_CREDENTIALS=writer` |

`<ENV>` is `DEV` or `PROD`.

## 4. Write the first migration

`yodel new` writes the next migration from the change in `src/` since the last one. The first one creates everything. `yodel lint` checks the migrations offline:

<!-- quote: getting-started#first-migration -->
```console
$ npx yodel new init
Wrote migrations/20261010T1725-init/ (2 statements; the first migration)
$ npx yodel lint
1 migration: 0 errors, 0 warnings, 0 silenced.
```

Commit it:

```sh
git add -A && git commit -m "feat: the first migration"
```

## 5. Plan, approve, apply

`yodel plan` shows what `yodel apply` would run, and a digest of that plan:

<!-- quote: getting-started#plan -->
```console
$ npx yodel plan dev
Plan for dev (clickhouse 26.8.15.10 at 127.0.0.1:8123, history yodeler.history (single (yodel.config.ts))): 0 applied, 1 pending

20261010T1725-init
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

The apply pipeline waits in wave 1 for an approval of jcs1-sha256:6340b61b4b984aa701a0972c6a1af518e91294bbaa7366a3ca1d481d4d09b81d (gate always at 8a51fb17dffa).
Approve it for the pipeline with:
  chant approve yodel-apply yodel-apply-wave-1 --plan jcs1-sha256:6340b61b4b984aa701a0972c6a1af518e91294bbaa7366a3ca1d481d4d09b81d

Plan digest: jcs1-sha256:0c873832e493b597da52f6e021e8f5eccfb076ee46ec4d49479007b3f11674b6
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:0c873832e493b597da52f6e021e8f5eccfb076ee46ec4d49479007b3f11674b6
or, at a terminal, with npx yodel approve dev, which shows the plan and asks you first.

Not approved yet. Approving binds exactly this digest; if anything it covers changes before the apply runs, the gate asks again and nothing is applied.
```

`yodel apply` runs only a plan someone approved. The first run stops at the approval and prints the command that gives it (exit 3):

<!-- quote: getting-started#apply -->
```console
$ YODEL_CREDENTIALS=writer npx yodel apply dev
Migrations in dev (clickhouse 26.8.15.10 at 127.0.0.1:8123, history yodeler.history, topology single (yodel.config.ts))

Applied: none

Pending (1):
  20261010T1725-init

Plan digest: jcs1-sha256:0c873832e493b597da52f6e021e8f5eccfb076ee46ec4d49479007b3f11674b6

Running migrate-dev (<my-schema>/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   1.7s
[phase] Approve
  • gate:approve-migrate-dev()   skipped
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 2.2s
  plan    : jcs1-sha256:0c873832e493b597da52f6e021e8f5eccfb076ee46ec4d49479007b3f11674b6
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:0c873832e493b597da52f6e021e8f5eccfb076ee46ec4d49479007b3f11674b6
  expires : 2026-10-12T17:26:00.339Z
  warning : the pending fact was not pushed to the remote — no remote is configured for chant/lifecycle — the pending fact was recorded locally only. An operator elsewhere cannot approve it until it does.

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:0c873832e493b597da52f6e021e8f5eccfb076ee46ec4d49479007b3f11674b6).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:0c873832e493b597da52f6e021e8f5eccfb076ee46ec4d49479007b3f11674b6
or, at a terminal, with npx yodel approve dev, which shows the plan and asks you first;
then run npx yodel apply dev again.
[exit 3]
```

The warnings about a remote are expected: approvals live on a `chant/lifecycle` branch, and this repository has no remote to push it to.

To approve, run `npx yodel approve dev`: it shows the plan and asks you to type `dev`. Or run the printed `npx chant approve ...` command, or let `yodel apply dev --digest` fill in the digest, as here, where no terminal was there to ask. The approval holds for this exact plan only. Then run `yodel apply` again:

<!-- quote: getting-started#approve -->
```console
$ npx chant approve migrate-dev approve-migrate-dev --plan "$(npx yodel apply dev --digest)"
warning: No remote is configured, so nothing was pushed. The resolution is recorded locally on chant/lifecycle. Until it reaches the remote, a run in another checkout will not see it.
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-10T17:26:02.846Z (local only — the push did not land)
This approves the plan jcs1-sha256:0c873832e493b597da52f6e021e8f5eccfb076ee46ec4d49479007b3f11674b6, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
$ YODEL_CREDENTIALS=writer npx yodel apply dev
Migrations in dev (clickhouse 26.8.15.10 at 127.0.0.1:8123, history yodeler.history, topology single (yodel.config.ts))

Applied: none

Pending (1):
  20261010T1725-init

Plan digest: jcs1-sha256:0c873832e493b597da52f6e021e8f5eccfb076ee46ec4d49479007b3f11674b6

Running migrate-dev (<my-schema>/ops/migrate-dev.op.ts)
lock: no KeeperMap on this server (KeeperMap is disabled because 'keeper_map_path_prefix' config is not defined. (BAD_ARGUMENTS) (version 26.8.15.10 (official build))); the lock is a file on this machine, so cross-runner locking needs Keeper (and keeper_map_path_prefix)
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:0c873832e493b597da52f6e021e8f5eccfb076ee46ec4d49479007b3f11674b6, by yodel at 2026-10-10T17:26:02.846Z
20261010T1725-init: applying
  statement 0: ok (SQLCH200 create, events)
  statement 1: ok (SQLCH200 create, events.events)
20261010T1725-init: applied

[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   917ms
[phase] Approve
  ✓ gate:approve-migrate-dev()   199ms
    [approved] yodel at 2026-10-10T17:26:02.846Z
[phase] Apply
  ✓ shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":"jcs1-sha256:0c873832e493b597da52f6e021e8f5eccfb076ee46ec4d49479007b3f11674b6"})   1.8s
Op "migrate-dev" completed in 3.1s

Applied: 20261010T1725-init.
$ npx yodel status dev
Migrations in dev (clickhouse 26.8.15.10 at 127.0.0.1:8123, history yodeler.history, topology single (yodel.config.ts))

Applied (1):
  20261010T1725-init  2026-10-10 17:26:06.824780 by yodel@example

Pending: none
```

## 6. A second migration

Add a column to the table in `src/schema.ts`:

```ts
    at       DateTime,
    country  LowCardinality(String) DEFAULT ''
```

Then write the migration, check it and commit it:

<!-- quote: getting-started#second-migration -->
```console
$ npx yodel new add-country
Wrote migrations/20261010T1726-add-country/ (1 statement; follows 20261010T1725-init)
$ npx yodel lint
2 migrations: 0 errors, 0 warnings, 0 silenced.
```

```sh
git add -A && git commit -m "feat: events.country"
```

The plan has the one new statement. The approval you gave for the first migration does not hold for this plan, and the plan says why:

<!-- quote: getting-started#plan-second -->
```console
$ npx yodel plan dev
Plan for dev (clickhouse 26.8.15.10 at 127.0.0.1:8123, history yodeler.history (single (yodel.config.ts))): 1 applied, 1 pending

20261010T1726-add-country
  0  statement  SQLCH201 metadata  events.events
       ALTER TABLE `events`.`events` ADD COLUMN country  LowCardinality(String) DEFAULT '' AFTER `at`

The apply pipeline waits in wave 1 for an approval of jcs1-sha256:c9cecbb1d18b3bb3d88a8118136d7a388ad1ea8342f4a5934de4a8d4ec8f096f (gate always at b765bedcb435).
Approve it for the pipeline with:
  chant approve yodel-apply yodel-apply-wave-1 --plan jcs1-sha256:c9cecbb1d18b3bb3d88a8118136d7a388ad1ea8342f4a5934de4a8d4ec8f096f

Plan digest: jcs1-sha256:c060f51f2f56ca8d7b7de6f9eadd140d12ae8d4791e40be44f798c37f0432980
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:c060f51f2f56ca8d7b7de6f9eadd140d12ae8d4791e40be44f798c37f0432980
or, at a terminal, with npx yodel approve dev, which shows the plan and asks you first.

The newest approval of approve-migrate-dev, by yodel at 2026-10-10T17:26:02.846Z, is for jcs1-sha256:0c873832e493b597da52f6e021e8f5eccfb076ee46ec4d49479007b3f11674b6, not this plan; it does not hold.
What moved (as far as yodel can tell): history changed: applied since: 20261010T1725-init (by yodel@example at 2026-10-10 17:26:06.824780); pending migrations changed: committed to since approval: 20261010T1726-add-country (326c20e at 2026-10-10T11:26:10-06:00); live schema changed: as expected after the history change above: applying a migration changes the live schema, and yodel cannot rebuild the live schema as it was at approval, so it cannot confirm that nothing else in it changed.
```

Approve and apply as before:

<!-- quote: getting-started#approve-second -->
```console
$ npx chant approve migrate-dev approve-migrate-dev --plan "$(npx yodel apply dev --digest)"
warning: No remote is configured, so nothing was pushed. The resolution is recorded locally on chant/lifecycle. Until it reaches the remote, a run in another checkout will not see it.
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-10T17:26:14.093Z (local only — the push did not land)
This approves the plan jcs1-sha256:c060f51f2f56ca8d7b7de6f9eadd140d12ae8d4791e40be44f798c37f0432980, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
$ YODEL_CREDENTIALS=writer npx yodel apply dev
Migrations in dev (clickhouse 26.8.15.10 at 127.0.0.1:8123, history yodeler.history, topology single (yodel.config.ts))

Applied (1):
  20261010T1725-init  2026-10-10 17:26:06.824780 by yodel@example

Pending (1):
  20261010T1726-add-country

Plan digest: jcs1-sha256:c060f51f2f56ca8d7b7de6f9eadd140d12ae8d4791e40be44f798c37f0432980

Running migrate-dev (<my-schema>/ops/migrate-dev.op.ts)
lock: no KeeperMap on this server (KeeperMap is disabled because 'keeper_map_path_prefix' config is not defined. (BAD_ARGUMENTS) (version 26.8.15.10 (official build))); the lock is a file on this machine, so cross-runner locking needs Keeper (and keeper_map_path_prefix)
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:c060f51f2f56ca8d7b7de6f9eadd140d12ae8d4791e40be44f798c37f0432980, by yodel at 2026-10-10T17:26:14.093Z
20261010T1726-add-country: applying
  statement 0: ok (SQLCH201 metadata, events.events)
20261010T1726-add-country: applied

[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   1.0s
[phase] Approve
  ✓ gate:approve-migrate-dev()   239ms
    [approved] yodel at 2026-10-10T17:26:14.093Z
[phase] Apply
  ✓ shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":"jcs1-sha256:c060f51f2f56ca8d7b7de6f9eadd140d12ae8d4791e40be44f798c37f0432980"})   1.9s
Op "migrate-dev" completed in 3.4s

Applied: 20261010T1726-add-country.
```

## 7. Drift

`yodel drift` compares what `src/` declares with the server, and reports anything changed by hand. Change a default on the server, as someone might by hand:

```sql
ALTER TABLE events.events MODIFY COLUMN country LowCardinality(String) DEFAULT 'US'
```

`yodel drift dev` reports it, and exits 2:

<!-- quote: getting-started#drift -->
```console
$ npx yodel drift dev
Drift in dev (clickhouse 26.8.15.10 at 127.0.0.1:8123)

Compared with the schema 20261010T1726-add-country records, the newest migration the history records as applied.

Changed out of band:
  events (ClickHouse::Table)
    column country default.expr: declared '', live 'US'
[exit 2]
```

To put it right, change it back on the server, or declare the new default in `src/schema.ts` and write a migration for it.

## The same steps with just

Each template has a `justfile` for these steps. [just](https://github.com/casey/just) is optional: every target runs the command beside it, and the commands work without it.

| just | Runs |
|---|---|
| `just up` | `npx @intentius/chant emulator up --lexicon sql`, then `npx tsx scripts/local.ts`, which checks that `dev` reaches the emulator, makes the read-only user `reader` there (the statements in step 3, or for Postgres below), and prints the reader and writer lines for a `.env` file |
| `just down` | `npx @intentius/chant emulator down --lexicon sql` |
| `just new <name>` | `npx yodel new <name>` |
| `just lint` | `npx yodel lint` |
| `just replay` | `npm run replay`: every migration replayed into a throwaway server and compared with its recorded schema |
| `just plan [env]` | `npx yodel plan <env>` (`dev` when left out) |
| `just approve [env]` | prints the command that approves the environment's plan, for you to run; it never runs it |
| `just apply [env]` | `YODEL_CREDENTIALS=writer npx yodel apply <env>` |
| `just status [env]` | `npx yodel status <env>` |
| `just drift [env]` | `npx yodel drift <env>` |
| `just ci` | `npm run ci`, which renders the CI pipelines again |

The justfile reads a `.env` file in the project when there is one, so the variables from step 3 can go there in place of `export`; `.gitignore` keeps it out of git.

## Postgres

The steps are the same with `templates/postgres`. The variables are `<ENV>_POSTGRES_URL`, `<ENV>_POSTGRES_READER_USER` and so on, and the URL names the database:

```sh
export DEV_POSTGRES_URL=postgres://127.0.0.1:5432/postgres
export DEV_POSTGRES_READER_USER=reader DEV_POSTGRES_READER_PASSWORD=reader
export DEV_POSTGRES_WRITER_USER=postgres DEV_POSTGRES_WRITER_PASSWORD=chant
```

The reader is a role of its own on the emulator, made once as `postgres`:

```sql
CREATE ROLE reader LOGIN PASSWORD 'reader';
ALTER ROLE reader SET default_transaction_read_only = on;
GRANT pg_read_all_data TO reader;
```

If a Postgres of your own already listens on `127.0.0.1:5432` (Homebrew's, for example), that address reaches it rather than the emulator. Stop it, or point `DEV_POSTGRES_URL` at the emulator's container another way.

## Next

- Push the project and set up CI: the README the template wrote into `my-schema` lists the secrets and users each forge needs. From then on each change is a pull request: edit `src/schema.ts`, `npx yodel new <name>`, commit both. The pull request gets a plan comment, and a merge applies what was approved.
- [The two workflows](workflows.md), [Migrations](migrations.md) and [Approval](approval.md) explain what you just ran.
- [Drift](drift.md) has the scheduled drift check the pipelines run.
- To take a database you already have into migrations, see [Starting a project](adoption.md#adopting-an-existing-database-yodel-init-from).
