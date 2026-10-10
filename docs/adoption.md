---
claims: [adopt, new]
---

# Starting a project

There are two ways in: a new project from a starter template, whose first migration creates everything, or `yodel init --from <env>`, which adopts a database that already exists.

## A new project from a template

`templates/clickhouse` and `templates/postgres` in this repository are starter projects for `chant init --from`. [Your first migration](getting-started.md) takes a project made this way to applied migrations on a local database, step by step. Each gives `chant.config.ts` with a `dev` and a `prod` profile, `yodel.config.ts`, a migrations Op and a drift watch per environment, and CI pipelines for GitHub Actions, GitLab CI and Forgejo Actions. The parameters are in each template's `chant.template.json`.

From GitHub, with chant's CLI from npm (`@intentius/chant`; plain `npx chant` outside a project runs an unrelated package):

```sh
npx @intentius/chant@latest init --from INTENTIUS/sql-yodeler@main#templates/clickhouse --param name=events-schema --param database=events my-schema
npx @intentius/chant@latest init --from INTENTIUS/sql-yodeler@main#templates/postgres --param name=app-schema --param schema=app my-schema
```

or from a clone, by path, shown here as `<clone>`. Inside the clone, `npx chant` is the clone's own chant:

<!-- quote: template#template-init -->
```console
$ npx chant init --from <clone>/templates/clickhouse --param name=events-schema --param database=events my-schema
Created:
  .forgejo/workflows/watch-dev.yml
  .forgejo/workflows/watch-prod.yml
  .forgejo/workflows/yodel-apply.yml
  .forgejo/workflows/yodel-pr.yml
  .github/workflows/watch-dev.yml
  .github/workflows/watch-prod.yml
  .github/workflows/yodel-apply.yml
  .github/workflows/yodel-pr.yml
  .gitignore
  .gitlab-ci.yml
  .gitlab/yodel-apply.gitlab-ci.yml
  .gitlab/yodel-watch.gitlab-ci.yml
  chant.config.ts
  justfile
  migrations/.gitkeep
  ops/migrate-dev.op.ts
  ops/migrate-prod.op.ts
  ops/watch-dev.op.ts
  ops/watch-prod.op.ts
  package.json
  README.md
  scripts/local.ts
  src/schema.ts
  tsconfig.json
  yodel-waves.json
  yodel.config.ts
  .chant/workspace.lock.json

Lineage: dir:<clone>/templates/clickhouse (a directory, recorded by digest only), recorded in .chant/workspace.lock.json
Parameters: database="events", history_database="yodeler", name="events-schema"
```

The template's `package.json` takes `@intentius/sql-yodeler` from npm (`^0.4.0`), so `npm install` in `my-schema` needs no token, and neither do the generated pipelines' `npm ci`; [Installing](configuration.md#installing) has the other routes. The run quoted here linked the clone's `node_modules` into `my-schema` in place of `npm install`.

The first migration creates what `src/schema.ts` declares. `yodel new` needs no server:

<!-- quote: template#template-new -->
```console
$ npx yodel new init
Wrote migrations/20261010T0527-init/ (2 statements; the first migration)
$ npx yodel lint
1 migration: 0 errors, 0 warnings, 0 silenced.
```

Make the directory a git repository and commit (`yodel apply` finds the migrations Op through git, and chant keeps approvals on the `chant/lifecycle` branch). Then create the database users and the forge's secrets the template's README lists, and push. From there each change is a pull request: edit `src/schema.ts`, run `npx yodel new <name>`, commit both. [The two workflows](workflows.md) and [Approval](approval.md) go on from here.

## Adopting an existing database: yodel init --from

`yodel init --from <env>` takes a database that already exists into versioned migrations in one command:

1. It reads the live database the profile names (chant's import, as `chant import --from <env>` runs it) and writes the declarations to the source directory (`sourceDir`, else `src/`).
2. It builds them and plans them against the same database. The plan must show no change; if it does not, everything it wrote is taken back.
3. It writes the baseline migration, `migrations/<timestamp>-baseline/`: the first migration, whose statements create everything.
4. It records the baseline applied in the environment's history, without running any of its statements.

On Postgres, when the environment manages access (`environments.<env>.access` in `yodel.config.ts`, or `sql.profiles.<env>.access`), step 1 also reads each table's row-level security, the policies and the privileges, and declares them; roles stay the environment's and are named as text ([Access control](access.md#adopting-a-database)). On ClickHouse it reads the row policies on the tables, the users and roles that hold privileges there, and every grant each of them holds, and writes them to `src/access.ts`; a user's password stays the environment's ([Access control](access.md#adopting)). Dictionaries and functions are adopted with the tables whether access is managed or not.

The live database is only read. The one write is the history row (and the history's database or schema and table, when they are not there yet).

What it needs first:

- A project: a `chant.config.ts` with `lexicons: ["sql"]`, `sql.dialect` and `sql.profiles.<env>`, with the project's databases (ClickHouse, `databases`) or schemas (Postgres, `schemas`) listed and the history's database or schema not among them, and a `package.json` from which chant and the `sql` lexicon resolve. `init` does not write `chant.config.ts`. The usual way to get one is a [starter template](#a-new-project-from-a-template) made with the existing database's name (`--param database=<name>` for ClickHouse, `--param schema=<name>` for Postgres); its `src/schema.ts` is a placeholder, so run `init` with `--force` to write over it.
- The writer's credentials. `init` writes the history row, and creates the history's database or schema and table when they are not there. The templates read the reader's credentials, which their READMEs create read-only, unless `YODEL_CREDENTIALS=writer`, so with a template it is `YODEL_CREDENTIALS=writer npx yodel init --from <env> --force`.
- No subdirectory in `migrations/`. Move another tool's migration files out of it first.

It refuses (exit 4, nothing written) when the source directory already declares a schema (unless `--force`), the project already has migrations, the history already records migrations, or the environment holds nothing.

`init` adopts every object in the profile's databases or schemas, except the history tables of other migration tools (golang-migrate's and dbmate's `schema_migrations`, goose's `goose_db_version`, Flyway's `flyway_schema_history`, and others), which it leaves out with a warning. There is no exclude list: a table the project should not own belongs in a database or schema the profile does not list. [Coming from another migration tool](from-other-tools.md) covers adopting a database another tool manages: the old tool's files and table, more than one environment, cutting CI over, and rollback.

Both examples adopt a database this way. The ClickHouse example's run, where the database was first made on the declarative path, so `src/schema.ts` was there and `--force` writes over it:

<!-- quote: clickhouse#adopt -->
```console
$ npx yodel init --from dev --force
read 2 object(s) from dev
wrote src/schema.ts
planned against dev: no change
wrote migrations/20261010T0528-baseline (2 statements)
lock: no KeeperMap on this server (KeeperMap is disabled because 'keeper_map_path_prefix' config is not defined. (BAD_ARGUMENTS) (version 26.8.15.10 (official build))); the lock is a file on this machine, so cross-runner locking needs Keeper (and keeper_map_path_prefix)
recorded 20261010T0528-baseline applied in yodeler.history as a baseline; none of its statements was run
Adopted dev (clickhouse): 2 objects
  Database shop
  Table shop.events

Declarations: src/schema.ts
Baseline:     migrations/20261010T0528-baseline/ (2 statements, sha256:52d4c819e57238a09a32ce81934552f9cb38acfd51a78933f79340a6c451e584)
Recorded:     applied in yodeler.history as a baseline; none of its statements was run

yodel plan dev shows no change, and yodel status dev lists the baseline applied.
```

The declarations it wrote:

<!-- quote: clickhouse#adopt-schema -->
```ts
import { database, table } from "@intentius/chant-lexicon-sql/clickhouse";

export const shopDb = database`
  CREATE DATABASE shop
  ENGINE = Atomic
  COMMENT 'The SQL Yodeler ClickHouse example'`;

export const events = table`
  CREATE TABLE ${shopDb}.events
  (
      id UInt64,
      kind LowCardinality(String),
      at DateTime
  )
  ENGINE = MergeTree
  PARTITION BY toYYYYMM(at)
  ORDER BY (kind, at)`;
```

and the history:

<!-- quote: clickhouse#adopt-status -->
```console
$ npx yodel status dev
Migrations in dev (clickhouse 26.8.15.10 at 127.0.0.1:8123, history yodeler.history, topology single (default))

Applied (1):
  20261010T0528-baseline  2026-10-10 05:28:36.291790 by yodel@example

Pending: none
```

The baseline's statements are the ones that would create the database from nothing, so a new environment (a fresh dev database, the replay check's throwaway server) gets everything by applying it. On the adopted environment it is never run.

Objects made by hand carry no chant ownership marker in their comments, and `init` does not add one: they stay unmarked until a declarative apply stamps them. The plan compares declared definitions without the marker, so they plan clean either way.

After `init`, `yodel apply <env>` needs a migrations Op for the environment (an Op with a Plan step running `yodel apply <env> --digest`, a gate bound to its output, and an Apply step running `yodel apply <env> --execute`); `yodel apply` prints the declaration to add when there is none. See [Approval](approval.md).

The [Postgres example](../examples/postgres/README.md#2-adopting-the-schema-into-versioned-migrations) does the same on Postgres.

## Another environment that already holds the schema: yodel init --baseline

`init --from` adopts one environment. Another environment that holds the same schema with its data (staging, prod) cannot run the baseline, whose first `CREATE` would fail there. `yodel init --baseline <env>` records the baseline applied in it instead, without running it:

```sh
YODEL_CREDENTIALS=writer npx yodel init --baseline prod
```

1. It plans the schema the baseline (the project's first migration) records against `<env>`'s live database, from `migration.json` alone. The plan must be empty: every object the baseline declares is there as it declares it, and the profile's databases or schemas hold nothing else. Each difference is named, with what the environment has and what the baseline declares, and the command refuses (exit 4), recording nothing:

   ```text
   yodel init: refused: prod's live schema is not the schema 20261010T1745-baseline records, so the baseline cannot be recorded applied there. 1 difference:
     customers (app.customers) columns.extra: extra text in the environment, (none) in the baseline (SQLPG204)
   Make prod hold the baseline's schema (or empty it, and let yodel apply run the baseline), then run yodel init --baseline prod again. Nothing was recorded.
   ```

2. When they match, it runs `<env>`'s migrations Op, as `yodel apply` does. The Plan step compares again and prints the record's digest (the baseline, the empty history and the live schema), the gate binds the approval to that digest, and the run stops there (exit 3) with the `chant approve` command to run. Approve, and run `yodel init --baseline <env>` again.
3. The Apply step takes the lock, checks that the history still records nothing, compares again, refuses if the digest moved since the approval, and appends the baseline's history row: a succeeded migration row whose `note` starts `baseline:`, with the approved digest. None of the baseline's statements is sent.

From there `yodel status <env>` lists the baseline applied, and `yodel plan <env>` and `yodel apply <env>` take the migrations after it, as in every other environment. It refuses (exit 4) a project with no migrations and an environment whose history records anything.
