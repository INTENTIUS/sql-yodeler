# Starting a project

There are two ways in: a new project from a starter template, whose first migration creates everything, or `yodel init --from <env>`, which adopts a database that already exists.

## A new project from a template

`templates/clickhouse` and `templates/postgres` in this repository are starter projects for `chant init --from`. Each gives `chant.config.ts` with a `dev` and a `prod` profile, `yodel.config.ts`, a migrations Op and a drift watch per environment, and CI pipelines for GitHub Actions, GitLab CI and Forgejo Actions. The parameters are in each template's `chant.template.json`.

From GitHub:

```sh
chant init --from INTENTIUS/sql-yodeler@main#templates/clickhouse --param name=events-schema --param database=events my-schema
chant init --from INTENTIUS/sql-yodeler@main#templates/postgres --param name=app-schema --param schema=app my-schema
```

or from a clone, by path. The run quoted here is `examples/walkthrough/template.ts` (`npx tsx examples/walkthrough/run.ts template --write` runs it again and rewrites these quotes), from a clone whose path is shown as `<clone>`:

```console
$ npx chant init --from <clone>/templates/clickhouse --param name=events-schema --param database=yodel_18_tpl --param history_database=yodel_18_tpl_history my-schema
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
  .gitlab/yodel-watch.gitlab-ci.yml
  chant.config.ts
  migrations/.gitkeep
  ops/migrate-dev.op.ts
  ops/migrate-prod.op.ts
  ops/watch-dev.op.ts
  ops/watch-prod.op.ts
  package.json
  README.md
  scripts/ci.ts
  scripts/watch-outcome.ts
  src/schema.ts
  tsconfig.json
  yodel.config.ts
  .chant/workspace.lock.json

Lineage: dir:<clone>/templates/clickhouse (a directory, recorded by digest only), recorded in .chant/workspace.lock.json
Parameters: database="yodel_18_tpl", history_database="yodel_18_tpl_history", name="events-schema"
```

The template's `package.json` takes `@intentius/sql-yodeler` from npm (`^0.1.0`), so `npm install` in `my-schema` needs no token, and neither do the generated pipelines' `npm ci`; [Installing](configuration.md#installing) has the other routes. The run skips `npm install` and links the clone's `node_modules` into `my-schema`, so it runs the yodel built in the clone.

The first migration creates what `src/schema.ts` declares. `yodel new` needs no server:

```console
$ npx yodel new init
Wrote migrations/20261010T0301-init/ (2 statements; the first migration)
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

The live database is only read. The one write is the history row (and the history's database or schema and table, when they are not there yet).

What it needs first: a `chant.config.ts` with `lexicons: ["sql"]`, `sql.dialect` and `sql.profiles.<env>`, with the project's databases (ClickHouse, `databases`) or schemas (Postgres, `schemas`) listed and the history's database or schema not among them, and a `package.json` from which chant and the `sql` lexicon resolve. `init` does not write `chant.config.ts`. It refuses (exit 4, nothing written) when the source directory already declares a schema (unless `--force`), the project already has migrations, the history already records migrations, or the environment holds nothing.

Both examples adopt a database this way. The ClickHouse example's run, where the database was first made on the declarative path, so `src/schema.ts` was there and `--force` writes over it:

```console
$ npx yodel init --from dev --force
read 2 object(s) from dev
wrote src/schema.ts
planned against dev: no change
wrote migrations/20261009T2305-baseline (2 statements)
lock: no KeeperMap on this server (KeeperMap is disabled because 'keeper_map_path_prefix' config is not defined. (BAD_ARGUMENTS) (version 26.8.15.10 (official build))); the lock is a file on this machine, so cross-runner locking needs Keeper (and keeper_map_path_prefix)
recorded 20261009T2305-baseline applied in yodel_18_history.history as a baseline; none of its statements was run
Adopted dev (clickhouse): 2 objects
  Database yodel_18_shop
  Table yodel_18_shop.events

Declarations: src/schema.ts
Baseline:     migrations/20261009T2305-baseline/ (2 statements, sha256:ed4d48a54c04dfe42f3d414e6094b1c164c240eeb47b1bb038b8b310428b3df5)
Recorded:     applied in yodel_18_history.history as a baseline; none of its statements was run

yodel plan dev shows no change, and yodel status dev lists the baseline applied.
```

The declarations it wrote:

```ts
import { database, table } from "@intentius/chant-lexicon-sql/clickhouse";

export const yodel18ShopDb = database`
  CREATE DATABASE yodel_18_shop
  ENGINE = Atomic
  COMMENT 'The SQL Yodeler ClickHouse example'`;

export const events = table`
  CREATE TABLE ${yodel18ShopDb}.events
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

```console
$ npx yodel status dev
Migrations in dev (history yodel_18_history.history, topology single (default))

Applied (1):
  20261009T2305-baseline  2026-10-09 23:05:28.654129 by yodel@example

Pending: none
```

The baseline's statements are the ones that would create the database from nothing, so a new environment (a fresh dev database, the replay check's throwaway server) gets everything by applying it. On the adopted environment it is never run.

Objects made by hand carry no chant ownership marker in their comments, and `init` does not add one: they stay unmarked until a declarative apply stamps them. The plan compares declared definitions without the marker, so they plan clean either way.

After `init`, `yodel apply <env>` needs a migrations Op for the environment (an Op with a Plan step running `yodel apply <env> --digest`, a gate bound to its output, and an Apply step running `yodel apply <env> --execute`); `yodel apply` prints the declaration to add when there is none. See [Approval](approval.md).

The [Postgres example](../examples/postgres/README.md#2-adopting-the-schema-into-versioned-migrations) does the same on Postgres.
