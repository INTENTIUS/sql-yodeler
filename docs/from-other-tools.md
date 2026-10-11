---
claims: [declarative, resume, migrations]
type: howto
---

# Coming from another migration tool

This page is for a database that golang-migrate, goose, Flyway or dbmate manages today. It maps their concepts onto SQL Yodeler's, takes the database into versioned migrations with its current schema as the starting point, and says how rollback works.

## The concepts, side by side

The main difference in day-to-day work: you do not write the migration's SQL. You change the declared schema in `src/` (chant's `sql` lexicon), and `yodel new <name>` writes the migration from the difference between that and the schema the previous migration recorded. You can still edit `migration.sql` by hand before it is applied anywhere; `yodel lint --update-checksum <id>` then records the new checksum.

| In golang-migrate, goose, Flyway, dbmate | In SQL Yodeler |
|---|---|
| An up file: `1_add_note.up.sql`, `V2__add_note.sql`, a `-- +goose Up` or `-- migrate:up` section | A directory, `migrations/<YYYYMMDDTHHMM>-<name>/`, with `migration.sql` (the statements) and `migration.json` (its parent, its checksum, its steps and the schema as it stands after it). `yodel new <name>` writes it. See [Migrations](migrations.md#the-directory). |
| A down file, `-- +goose Down`, `-- migrate:down`, `flyway undo` | No down files. `yodel revert <env> <id>` plans the reverse from the recorded schemas when you need it ([below](#rolling-back)). |
| The order: the version number or timestamp in the file name | Each migration names its parent; the chain of parents is the order. The timestamp in the id is for people and never decides the order. |
| `schema_migrations` (version, dirty), `goose_db_version`, `flyway_schema_history` | `<history>.history`, in a database (ClickHouse) or schema (Postgres) of its own, `yodeler` by default. It is append-only: one row per event (a migration or statement started, succeeded, failed), with who ran it and under which approval. See [The history table](migrations.md#the-history-table). |
| `migrate version`, `goose status`, `flyway info`, `dbmate status` | `yodel status <env>`: applied, pending, failed part way, out of order, checksum mismatches. |
| golang-migrate's dirty flag and `migrate force`; a failed row in `flyway_schema_history` | A migration that failed part way. The history records each statement, so the next `yodel apply` resumes at the statement that failed and never sends again one that succeeded. There is nothing to force. See [Resuming](migrations.md#resuming-a-migration-that-failed-part-way). |
| `flyway validate` | `yodel status` and `yodel apply` check every applied migration's files against the checksum recorded when it ran, and refuse on a mismatch; `yodel lint` checks each migration's own `checksum` field. |
| `flyway repair` | `yodel repair <env> <id> --reason "<text>"` records a new checksum for an applied migration whose files were edited on purpose, with the reason. Nothing runs on the server. It does not clear failures: a failed migration resumes instead. |
| `baseline`, `baselineOnMigrate` | `yodel init --from <env>`: reads the live database into declarations, writes a baseline migration whose statements create all of it, and records it applied without running it. See [Adopting it](#adopting-the-database). |
| `outOfOrder=true`, goose's `--allow-missing` | `yodel apply <env> --allow-out-of-order`, for one run. Without it, a pending migration the chain puts before an applied one is refused (exit 4), never skipped. See [Out-of-order migrations](migrations.md#out-of-order-migrations). |
| Flyway's repeatable migrations (`R__`) for views and functions | Views, functions, procedures and triggers are declared in `src/` like tables. A changed body becomes a `CREATE OR REPLACE` in the next migration ([Postgres objects](workflows.md#postgres-objects)). |
| goose's Go migrations, Flyway's Java migrations: code that moves data | Steps inside a migration: a backfill (`yodel new <name> --backfill <file>`), a ClickHouse rebuild, a Postgres expand-and-contract change. They resume from their receipts. See [Data migrations](steps.md). |
| Flyway callbacks (`beforeMigrate`, `afterMigrate`) | `environments.<env>.steps` in `yodel.config.ts`: read-only checks and commands before and after each apply ([Steps around apply](approval.md#steps-around-apply-checks-before-and-after)). |
| dbmate's `schema.sql` dump | Each `migration.json` records the schema after it, and `src/` declares the current one. `yodel docs` writes an HTML reference and an ERD ([Generated schema reference](schema-docs.md)). |
| Squashing old migrations into one | `yodel checkpoint <name>`: new environments start from it instead of replaying the whole chain ([Checkpoints](migrations.md#checkpoints-yodel-checkpoint)). |
| `migrate up` / `flyway migrate` in a deploy job | `yodel apply <env>` in the pipelines `yodel ci` renders: the plan is posted on the pull request, and the apply after a merge waits for an approval bound to a digest of that plan ([Approval](approval.md)). |
| Tests that run the migrations on a fresh database | `yodel test`: cases in `tests/*.test.ts`, run on a database built from the migrations ([Lint](lint.md#tests-on-the-replayed-database-yodel-test)). |

## Adopting the database

Adoption keeps the database as it is. The migrations the old tool ran are not imported one by one: the schema they produced becomes the baseline, the first migration of the new chain, recorded as applied without running.

### Before you start

1. Stop the old tool's migration jobs for the environment, and apply whatever the old tool still has pending, so the database holds the schema you mean to keep. A migration the old tool runs after the baseline is recorded changes the database behind yodel's back: `yodel drift` reports a declared object it changed or dropped, and a table it created stays undeclared.
2. Decide which environment to adopt with `yodel init --from`, usually production. The others that hold the same schema take the baseline afterwards with `yodel init --baseline` (see [More than one environment](#more-than-one-environment)).
3. Have the writer's credentials for it. `init` reads the database and then writes one row to the history (creating the history's database or schema and table first, when they are not there), so the user needs to create those: on ClickHouse, `CREATE DATABASE` (or an existing history database it can create tables in); on Postgres, `CREATE` on the database. A read-only user fails at that write. The plan check before it only reads.

### The project

`yodel init` needs a project around it: `chant.config.ts` with a profile for the environment, `yodel.config.ts`, a migrations Op, and a `package.json` from which chant and the `sql` lexicon resolve. It does not write these. The quickest way to get them is a starter template, made with `yodel create` and the database (ClickHouse) or schema (Postgres) you already have:

```sh
npx @intentius/sql-yodeler@latest create events-schema --clickhouse --database events
npx @intentius/sql-yodeler@latest create app-schema --postgres --schema app
cd app-schema && npm install
```

The history goes in its own database or schema (`--history <name>` on `yodel create`, `yodeler` by default); it must not be one of the project's. When the project owns more than one database or schema, list each in `databases` (ClickHouse) or `schemas` (Postgres) of every profile in `chant.config.ts`. [Starting a project](adoption.md#a-new-project-from-a-template) has the rest of what the template writes.

### Moving the old tool's files

yodel's migrations live in `migrations/` at the project root, and the name is fixed. Move the old tool's files out of it before you run `init` (for example to `legacy-migrations/`, or delete them and let git keep them). `init` refuses while `migrations/` holds any subdirectory, and yodel never reads the old files: flat `.sql` files left there are ignored, which only confuses whoever reads the directory later.

### Running init

Point the environment at the database (in the templates, `<ENV>_CLICKHOUSE_URL` or `<ENV>_POSTGRES_URL`, and the writer's user and password variables), then:

```sh
YODEL_CREDENTIALS=writer npx yodel init --from prod --force
```

- `YODEL_CREDENTIALS=writer` makes the template's `chant.config.ts` read the writer's variables. Without it the template reads the reader's, which its README creates read-only.
- `--force` is needed because the template's `src/schema.ts` is a placeholder schema, and `init` refuses to write over declarations without it: `refused: src already declares a schema (schema.ts) ... Pass --force to overwrite`. The import writes `src/schema.ts`; any other file in `src/` is kept and built with it, so remove files that declare objects the database does not have.

What `init` does, step by step, and what it refuses, is in [Adopting an existing database](adoption.md#adopting-an-existing-database-yodel-init-from). Afterwards `npx yodel plan prod` shows no change and `npx yodel status prod` lists the baseline applied. Commit `src/`, the baseline and the project.

### The old tool's history table

`init` leaves the old tool's history table out of the declared schema, with a warning such as `app.schema_migrations is kept by a migration runner (Rails, golang-migrate, dbmate); left out, since declaring it would have chant change what that tool owns`. It does this on both dialects for the tables chant knows by name: `schema_migrations`, `goose_db_version`, `flyway_schema_history`, and those of Prisma, Rails, Django, Alembic, drizzle-kit, Knex, Sequelize and node-pg-migrate. (Flyway keeps its table under a configurable name; one under another name is adopted like any other table.)

From then on yodel never reads it or writes to it: migrations are written from the declared schema, and drift reports only declared objects. Keep it while you might go back to the old tool, and drop it by hand once nothing runs the old tool. Its rows changing does not move a plan's digest; creating or dropping the table in one of the project's databases or schemas does, so drop it between applies, not while an approved plan is waiting.

### Tables the project should not own

There is no exclude list. The scope is the databases (ClickHouse) or schemas (Postgres) the profile lists: `init` adopts every object in them except the history tables above, and nothing outside them. To keep a table out of the project (a table another service owns, a scratch table), keep it in a database or schema the profile does not list. Deleting a table's declaration after `init` does not undeclare it: the baseline recorded it, so the next `yodel new` writes a `DROP TABLE`, which `yodel lint` flags as destructive.

An undeclared object in a listed database or schema (one created after `init`) is left alone: migrations are written from the declarations, and drift does not report it. Creating or dropping one does move the plan digest, since the digest covers the catalog of those databases or schemas.

### More than one environment

Once `migrations/` holds the baseline, `init --from` refuses in that project, so it records the baseline in one environment. An environment that does not hold the schema yet, or one you can empty first (a dev or CI database), starts with an empty history, and `yodel apply` runs the baseline there, which creates everything. An environment that already holds the schema and its data takes it with `yodel init --baseline <env>`: it compares that environment's live schema with the schema the baseline records, refuses and names each difference when they differ, and otherwise records the baseline applied there, without running it, behind the environment's gate ([Another environment that already holds the schema](adoption.md#another-environment-that-already-holds-the-schema-yodel-init-baseline)). Stop the old tool in that environment first too, and bring it to the same schema as the adopted one.

### Cutting CI over

The template renders pipelines for GitHub Actions, GitLab CI and Forgejo Actions (`npm run ci`, which is `yodel ci`): lint and a plan comment on each pull request with the reader's credentials, and on a merge, an apply per environment with the writer's, behind its approval. Create the users the template's README lists and the secrets [Setting up each forge](forges.md) places, remove the old tool's migration jobs in the same pull request that adds these, and from then on make each change by editing `src/` and running `yodel new <name>`. [The two workflows](workflows.md#the-pipelines-yodel-ci) has the details.

## Rolling back

There are no down migrations to write or keep in step with the up ones. Each migration records the schema after it, and its parent records the schema before it, so yodel can plan the reverse when you ask for it.

### Reverting the newest migration

```sh
npx yodel revert prod <id> --dry-run    # the reverse statements, each with its rule and class, and the digest
YODEL_CREDENTIALS=writer npx yodel revert prod <id>
```

`yodel revert` undoes the newest migration applied in the environment, and only that one, since any later migration was written against it. It goes through the migrations Op like an apply: it stops at the gate with the approve command (exit 3), and once approved, the next `yodel revert` runs it under the lock. The policy in `yodel.config.ts` judges its statements, so a rule that refuses drops refuses a revert that drops what the migration added unless an override is recorded. The history gets a row for each reverse statement and a `reverted` row; the migration is then pending again, and `yodel status` marks it reverted. Delete it, or rewrite it with `yodel new <name> --replace`, before the next `yodel apply`, which would otherwise apply it again.

A revert carries the schema back, not the data. A dropped column comes back empty, and a revert that drops a column the migration added loses what was written to it since. Reverting the baseline plans the drop of everything it created.

### When a hand-written step is needed

- The migration has a data step (a backfill). The revert is refused (exit 2) until `--step <file>` names SQL that undoes the data step; it runs before the reverse statements and is part of the digest.
- The reverse would need an Op or a manual step (a ClickHouse sort key changed back, a Postgres column renamed back). The revert is refused (exit 2). Write the change back as a new migration: edit `src/`, then `yodel new <name>`.
- The migration is not the newest applied one, or other environments have moved on from it. Roll forward the same way: a new migration that undoes it.

### A migration that failed part way

It is not rolled back. Statements that succeeded stay, and the next `yodel apply` resumes at the one that failed. Fix the cause on the server (the row a constraint rejects, a lock someone holds), or edit that statement in `migration.sql` and record the files' new checksum with `yodel lint --update-checksum <id>`; then approve and apply again. `yodel repair` is for a migration that applied completely and whose files were edited afterwards; it refuses one that failed part way. On Postgres, each statement that can run in a transaction runs in its own, so a failed statement leaves nothing half done.
