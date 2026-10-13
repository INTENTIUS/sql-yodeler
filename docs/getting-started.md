---
claims: [migrations, approval, declarative]
type: tutorial
---

# Your first migration

This page takes you from an empty directory to two migrations applied to a ClickHouse or Postgres database on your own machine. It needs Node 22.12 or later, npm, git, and Docker for the local database. Every command below ran as shown, and the output under it is what it printed; `<my-schema>` stands for the project's path.

## What chant is

SQL Yodeler is built on [chant](https://intentius.io/chant/) (`@intentius/chant` on npm), a declarative infrastructure-as-code toolkit in TypeScript. You declare your schema with chant's `sql` lexicon, and the `yodel` CLI does the rest, running chant's CLI underneath where it needs it:

- `yodel create` makes a new project from a template.
- `yodel emulator up` starts a local ClickHouse and Postgres in Docker.
- `yodel approve <env>` approves a plan before `yodel apply` runs it: it shows the plan, asks you to type the environment's name, and records the approval for you.

Before your project exists, run yodel as `npx @intentius/sql-yodeler@latest` (with `@latest`, npx does not reuse an older copy it cached). Inside the project, `npm install` puts the version the project pins in `node_modules`, so `npx yodel` works there.

## 1. Make the project

<!-- tabs: dialect -->
#### ClickHouse

```sh
npx @intentius/sql-yodeler@latest create my-schema --clickhouse --database events --name events-schema
cd my-schema
npm install
```

`--database events` is the ClickHouse database your schema lives in, and `--name` the package name (the directory's name when left out). The template declares one table in it, in `src/schema.ts`. This declaration is what the database should be; every migration below is worked out from it ([Declaring the schema](schema.md) has the form):

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

#### Postgres

```sh
npx @intentius/sql-yodeler@latest create my-schema --postgres --schema app --name app-schema
cd my-schema
npm install
```

`--schema app` is the Postgres schema your objects live in. The template declares a table and an index in it, in `src/schema.ts`. This declaration is what the database should be; every migration below is worked out from it ([Declaring the schema](schema.md) has the form):

```ts
export const app = schema`
  CREATE SCHEMA app;
  COMMENT ON SCHEMA app IS 'Declared in src/schema.ts'`;

export const events = table`
  CREATE TABLE ${app}.events (
    id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind text NOT NULL,
    at   timestamptz NOT NULL DEFAULT now()
  )`;

export const eventsKind = index`
  CREATE INDEX events_kind_idx ON ${events} (${events.columns.kind})`;
```

<!-- /tabs -->

`yodel` finds the Op that applies migrations through git, and chant keeps approvals on a git branch, so the project must be a git repository:

```sh
git init -b main
git add -A && git commit -m "chore: a new yodel project"
```

## 2. Start a local database

```sh
npx yodel emulator up
```

This starts ClickHouse on `http://127.0.0.1:8123` (user `default`, no password) and Postgres on `127.0.0.1:5432` (user `postgres`, password `chant`), in Docker, and prints both. `npx yodel emulator status` says whether they run, and `npx yodel emulator down` stops them.

## 3. Point the dev environment at it

`chant.config.ts` names the `dev` environment's server and credentials by environment variable, and never holds a value. `dev` defaults to the emulator's address, so only the users and passwords are needed.

The template gives each environment two users: a reader (the default, used by plans, pull request comments and drift checks) and a writer, picked with `YODEL_CREDENTIALS=writer:<env>` (or `writer` for every environment; only CI's apply job sets it, and `just apply` on your machine). yodel refuses an environment whose reader and writer are the same user, so give the emulator a read-only user for the reader, and keep its admin user, which can do everything, as the writer:

<!-- tabs: dialect -->
#### ClickHouse

```sh
curl -s http://127.0.0.1:8123 --data-binary "CREATE USER IF NOT EXISTS reader IDENTIFIED WITH no_password SETTINGS readonly = 1"
curl -s http://127.0.0.1:8123 --data-binary "GRANT SELECT, SHOW ON *.* TO reader"
export DEV_CLICKHOUSE_READER_USER=reader DEV_CLICKHOUSE_READER_PASSWORD=
export DEV_CLICKHOUSE_WRITER_USER=default DEV_CLICKHOUSE_WRITER_PASSWORD=
```

The variables for every environment:

| Variable | Meaning |
|---|---|
| `<ENV>_CLICKHOUSE_URL` | the server's HTTP interface; `dev` defaults to `http://127.0.0.1:8123` |
| `<ENV>_CLICKHOUSE_READER_USER`, `<ENV>_CLICKHOUSE_READER_PASSWORD` | the read-only user |
| `<ENV>_CLICKHOUSE_WRITER_USER`, `<ENV>_CLICKHOUSE_WRITER_PASSWORD` | the user that applies, read when `YODEL_CREDENTIALS=writer:<env>` |

#### Postgres

The reader is a role of its own on the emulator, made once as `postgres`:

```sql
CREATE ROLE reader LOGIN PASSWORD 'reader';
ALTER ROLE reader SET default_transaction_read_only = on;
GRANT pg_read_all_data TO reader;
```

```sh
export DEV_POSTGRES_URL=postgres://127.0.0.1:5432/postgres
export DEV_POSTGRES_READER_USER=reader DEV_POSTGRES_READER_PASSWORD=reader
export DEV_POSTGRES_WRITER_USER=postgres DEV_POSTGRES_WRITER_PASSWORD=chant
```

The variables for every environment:

| Variable | Meaning |
|---|---|
| `<ENV>_POSTGRES_URL` | the server and the database, as `postgres://host:5432/database`; `dev` defaults to `postgres://127.0.0.1:5432/postgres` |
| `<ENV>_POSTGRES_READER_USER`, `<ENV>_POSTGRES_READER_PASSWORD` | the read-only role |
| `<ENV>_POSTGRES_WRITER_USER`, `<ENV>_POSTGRES_WRITER_PASSWORD` | the role that applies, read when `YODEL_CREDENTIALS=writer:<env>` |

If a Postgres of your own already listens on `127.0.0.1:5432` (Homebrew's, for example), that address reaches it rather than the emulator. `just up` warns when it does. Stop that server, or reach the emulator through another address of this machine: `DEV_POSTGRES_URL=postgres://<address>:5432/postgres`, with the address from `ipconfig getifaddr en0` on macOS.

<!-- /tabs -->

`<ENV>` is `DEV` or `PROD`. Without the users, `npx yodel plan dev` stops with `sql.profiles.dev.user names DEV_CLICKHOUSE_READER_USER, which is not set` (`DEV_POSTGRES_READER_USER` on Postgres). The reader cannot write, so `yodel apply` runs with `YODEL_CREDENTIALS=writer:dev`, as `just apply` does. Run as the reader, `yodel apply dev` refuses before the approval gate (exit 4) and names the variable to set; the commands yodel prints to run again carry it too (`YODEL_CREDENTIALS=writer:dev npx yodel apply dev`).

## 4. Write the first migration

The output on the rest of this page is from a run of the ClickHouse template; on Postgres the commands are the same. It was recorded before yodel printed `yodel approve` in its messages, so where an approval is asked for, the output shows chant's `chant approve` command, and the run approves with it, having no terminal to ask; you run `npx yodel approve dev`, which records the same approval.

`yodel new` writes the next migration from the change in `src/` since the last one. The first one creates everything. `yodel lint` checks the migrations offline:

<!-- quote: getting-started#first-migration -->
```console
$ npx yodel new init
Wrote migrations/20261010T2213-init/ (2 statements; the first migration)
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

20261010T2213-init
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

The apply pipeline waits in wave 1 for an approval of jcs1-sha256:753d2acf4bf5873de6c3517ecc47c2b8c2dc5e285d9c54fb972ace5b7465be26 (gate always at 27fbeee6832b).
Approve it for the pipeline with:
  chant approve yodel-apply yodel-apply-wave-1 --plan jcs1-sha256:753d2acf4bf5873de6c3517ecc47c2b8c2dc5e285d9c54fb972ace5b7465be26

Plan digest: jcs1-sha256:96585362be63615a9c5a29c059b2e211f409bcb3e3d5a20a1b226773dfea9aa3
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:96585362be63615a9c5a29c059b2e211f409bcb3e3d5a20a1b226773dfea9aa3
or, at a terminal, with npx yodel approve dev, which shows the plan and asks you first.

Not approved yet. Approving binds exactly this digest; if anything it covers changes before the apply runs, the gate asks again and nothing is applied.
```

The plan prints two approvals. The first, of the apply pipeline's wave, is for the CI pipeline's wave job after a merge, and you need it only once the project has a remote and CI. The second, of `migrate-dev`, is the one `yodel apply dev` waits for on your machine.

`yodel apply` runs only a plan someone approved. The first run stops at the approval and prints the command that gives it (exit 3):

<!-- quote: getting-started#apply -->
```console
$ YODEL_CREDENTIALS=writer:dev npx yodel apply dev
Migrations in dev (clickhouse 26.8.15.10 at 127.0.0.1:8123, history yodeler.history, topology single (yodel.config.ts))

Applied: none

Pending (1):
  20261010T2213-init

Plan digest: jcs1-sha256:96585362be63615a9c5a29c059b2e211f409bcb3e3d5a20a1b226773dfea9aa3

Running migrate-dev (<my-schema>/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   2.4s
[phase] Approve
  • gate:approve-migrate-dev()   skipped
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 2.9s
  plan    : jcs1-sha256:96585362be63615a9c5a29c059b2e211f409bcb3e3d5a20a1b226773dfea9aa3
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:96585362be63615a9c5a29c059b2e211f409bcb3e3d5a20a1b226773dfea9aa3
  expires : 2026-10-12T22:13:43.677Z
  note    : recorded locally (no remote for chant/lifecycle)

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:96585362be63615a9c5a29c059b2e211f409bcb3e3d5a20a1b226773dfea9aa3).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:96585362be63615a9c5a29c059b2e211f409bcb3e3d5a20a1b226773dfea9aa3
or, at a terminal, with npx yodel approve dev, which shows the plan and asks you first;
then run YODEL_CREDENTIALS=writer:dev npx yodel apply dev again.
[exit 3]
```

The note about a remote is expected: approvals live on a `chant/lifecycle` branch, and this repository has no remote to push it to.

To approve, run `npx yodel approve dev`: it shows the plan and asks you to type `dev`. The command `yodel apply` prints adds the digest, `npx yodel approve dev --plan <digest>`, so it approves only the plan you were shown. The run below had no terminal to ask, so it recorded the same approval with chant's command. The approval holds for this exact plan only. Then run `yodel apply` again:

<!-- quote: getting-started#approve -->
```console
$ npx chant approve migrate-dev approve-migrate-dev --plan "$(npx yodel apply dev --digest)"
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-10T22:13:46.126Z (recorded locally (no remote for chant/lifecycle))
This approves the plan jcs1-sha256:96585362be63615a9c5a29c059b2e211f409bcb3e3d5a20a1b226773dfea9aa3, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
$ YODEL_CREDENTIALS=writer:dev npx yodel apply dev
Migrations in dev (clickhouse 26.8.15.10 at 127.0.0.1:8123, history yodeler.history, topology single (yodel.config.ts))

Applied: none

Pending (1):
  20261010T2213-init

Plan digest: jcs1-sha256:96585362be63615a9c5a29c059b2e211f409bcb3e3d5a20a1b226773dfea9aa3

Running migrate-dev (<my-schema>/ops/migrate-dev.op.ts)
lock: no KeeperMap on this server (KeeperMap is disabled because 'keeper_map_path_prefix' config is not defined. (BAD_ARGUMENTS) (version 26.8.15.10 (official build))); the lock is a file on this machine, so cross-runner locking needs Keeper (and keeper_map_path_prefix)
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:96585362be63615a9c5a29c059b2e211f409bcb3e3d5a20a1b226773dfea9aa3, by yodel at 2026-10-10T22:13:46.126Z
20261010T2213-init: applying
  statement 0: ok (SQLCH200 create, events)
  statement 1: ok (SQLCH200 create, events.events)
20261010T2213-init: applied

[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   899ms
[phase] Approve
  ✓ gate:approve-migrate-dev()   180ms
    [approved] yodel at 2026-10-10T22:13:46.126Z
[phase] Apply
  ✓ shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":"jcs1-sha256:96585362be63615a9c5a29c059b2e211f409bcb3e3d5a20a1b226773dfea9aa3"})   2.0s
Op "migrate-dev" completed in 3.2s

Applied: 20261010T2213-init.
$ npx yodel status dev
Migrations in dev (clickhouse 26.8.15.10 at 127.0.0.1:8123, history yodeler.history, topology single (yodel.config.ts))

Applied (1):
  20261010T2213-init  2026-10-10 22:13:49.991391 by yodel@example

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
Wrote migrations/20261010T2213-add-country/ (1 statement; follows 20261010T2213-init)
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

20261010T2213-add-country
  0  statement  SQLCH201 metadata  events.events
       ALTER TABLE `events`.`events` ADD COLUMN country  LowCardinality(String) DEFAULT '' AFTER `at`

The apply pipeline waits in wave 1 for an approval of jcs1-sha256:2cef01bec2fd0e3182fcb24fe645ec39f48697c3573f26338e064c459f656203 (gate always at b3e7a48d268e).
Approve it for the pipeline with:
  chant approve yodel-apply yodel-apply-wave-1 --plan jcs1-sha256:2cef01bec2fd0e3182fcb24fe645ec39f48697c3573f26338e064c459f656203

Plan digest: jcs1-sha256:3df448990a3d23ff2213501d47ac943e9acc6267e1c0fa134e012ac6ab97af8a
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:3df448990a3d23ff2213501d47ac943e9acc6267e1c0fa134e012ac6ab97af8a
or, at a terminal, with npx yodel approve dev, which shows the plan and asks you first.

The newest approval of approve-migrate-dev, by yodel at 2026-10-10T22:13:46.126Z, is for jcs1-sha256:96585362be63615a9c5a29c059b2e211f409bcb3e3d5a20a1b226773dfea9aa3, not this plan; it does not hold.
What moved (as far as yodel can tell): history changed: applied since: 20261010T2213-init (by yodel@example at 2026-10-10 22:13:49.991391); pending migrations changed: committed to since approval: 20261010T2213-add-country (1ee6e61 at 2026-10-10T16:13:53-06:00); live schema changed: as expected after the history change above: applying a migration changes the live schema, and yodel cannot rebuild the live schema as it was at approval, so it cannot confirm that nothing else in it changed.
```

Approve and apply as before:

<!-- quote: getting-started#approve-second -->
```console
$ npx chant approve migrate-dev approve-migrate-dev --plan "$(npx yodel apply dev --digest)"
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-10T22:13:57.553Z (recorded locally (no remote for chant/lifecycle))
This approves the plan jcs1-sha256:3df448990a3d23ff2213501d47ac943e9acc6267e1c0fa134e012ac6ab97af8a, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
$ YODEL_CREDENTIALS=writer:dev npx yodel apply dev
Migrations in dev (clickhouse 26.8.15.10 at 127.0.0.1:8123, history yodeler.history, topology single (yodel.config.ts))

Applied (1):
  20261010T2213-init  2026-10-10 22:13:49.991391 by yodel@example

Pending (1):
  20261010T2213-add-country

Plan digest: jcs1-sha256:3df448990a3d23ff2213501d47ac943e9acc6267e1c0fa134e012ac6ab97af8a

Running migrate-dev (<my-schema>/ops/migrate-dev.op.ts)
lock: no KeeperMap on this server (KeeperMap is disabled because 'keeper_map_path_prefix' config is not defined. (BAD_ARGUMENTS) (version 26.8.15.10 (official build))); the lock is a file on this machine, so cross-runner locking needs Keeper (and keeper_map_path_prefix)
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:3df448990a3d23ff2213501d47ac943e9acc6267e1c0fa134e012ac6ab97af8a, by yodel at 2026-10-10T22:13:57.553Z
20261010T2213-add-country: applying
  statement 0: ok (SQLCH201 metadata, events.events)
20261010T2213-add-country: applied

[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   947ms
[phase] Approve
  ✓ gate:approve-migrate-dev()   216ms
    [approved] yodel at 2026-10-10T22:13:57.553Z
[phase] Apply
  ✓ shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":"jcs1-sha256:3df448990a3d23ff2213501d47ac943e9acc6267e1c0fa134e012ac6ab97af8a"})   2.0s
Op "migrate-dev" completed in 3.3s

Applied: 20261010T2213-add-country.
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

Compared with the schema 20261010T2213-add-country records, the newest migration the history records as applied.

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
| `just up` | `npx yodel emulator up`, then `npx tsx scripts/local.ts`, which checks that `dev` reaches the emulator, makes the read-only user `reader` there (the statements in step 3), and prints the reader and writer lines for a `.env` file |
| `just down` | `npx yodel emulator down` |
| `just new <name>` | `npx yodel new <name>` |
| `just lint` | `npx yodel lint` |
| `just replay` | `npm run replay`: every migration replayed into a throwaway server and compared with its recorded schema |
| `just plan [env]` | `npx yodel plan <env>` (`dev` when left out) |
| `just approve [env]` | prints the command that approves the environment's plan, for you to run; it never runs it |
| `just apply [env]` | `YODEL_CREDENTIALS=writer:<env> npx yodel apply <env>` |
| `just status [env]` | `npx yodel status <env>` |
| `just drift [env]` | `npx yodel drift <env>` |
| `just ci` | `npm run ci`, which renders the CI pipelines again |

The justfile reads a `.env` file in the project when there is one, so the variables from step 3 can go there in place of `export`; `.gitignore` keeps it out of git. Only `just` reads it: the plain `npx yodel ...` commands above see only the shell's environment, so to run them with the variables in `.env`, load it first with `set -a; . ./.env; set +a`.

## Next

- Push the project and set up CI: [Setting up each forge](forges.md) has the secrets, tokens and runner each forge needs. From then on each change is a pull request: edit `src/schema.ts`, `npx yodel new <name>`, commit both. The pull request gets a plan comment, and a merge applies what was approved.
- [The two workflows](workflows.md), [Migrations](migrations.md) and [Approval](approval.md) explain what you just ran.
- [Data migrations](steps.md): the rebuilds, safe renames and backfills a migration carries.
- [Drift](drift.md) has the scheduled drift check the pipelines run.
- To take a database you already have into migrations, see [Starting a project](adoption.md#adopting-an-existing-database-yodel-init-from).
