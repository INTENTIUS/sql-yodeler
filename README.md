<p align="center"><img src="docs-site/public/brand/hat-160.png" width="160" height="148" alt="SQL Yodeler's logo, a pixel-art cowboy hat with a database on it"></p>

# SQL Yodeler

Schema management and migrations for ClickHouse and Postgres, on chant's `sql` lexicon.

SQL Yodeler is built on [chant](https://intentius.io/chant/), a declarative infrastructure-as-code toolkit in TypeScript. You need chant's CLI (`@intentius/chant` on npm) for two things only: `chant init` to make a project from a template, and `chant emulator up` for a local database. Run the CLI as `npx @intentius/chant@latest` before the project exists, and as `npx chant` inside it, where `npm install` put it. You approve a plan with `yodel approve`, which records chant's approval for you.

## Getting started

[Your first migration](docs/getting-started.md) goes from an empty directory to two applied migrations on a local ClickHouse, with every command and its output. In short:

```sh
npx @intentius/chant@latest init --from INTENTIUS/sql-yodeler@main#templates/clickhouse --param name=events-schema --param database=events my-schema
cd my-schema && npm install && git init -b main && git add -A && git commit -m "chore: a new yodel project"
npx chant emulator up --lexicon sql            # ClickHouse and Postgres in Docker
curl -s http://127.0.0.1:8123 --data-binary "CREATE USER IF NOT EXISTS reader IDENTIFIED WITH no_password SETTINGS readonly = 1"
curl -s http://127.0.0.1:8123 --data-binary "GRANT SELECT, SHOW ON *.* TO reader"
export DEV_CLICKHOUSE_READER_USER=reader DEV_CLICKHOUSE_READER_PASSWORD= DEV_CLICKHOUSE_WRITER_USER=default DEV_CLICKHOUSE_WRITER_PASSWORD=
npx yodel new init && npx yodel lint
git add -A && git commit -m "feat: the first migration"
YODEL_CREDENTIALS=writer npx yodel apply dev   # stops at the approval
npx yodel approve dev   # shows the plan; type dev to approve
YODEL_CREDENTIALS=writer npx yodel apply dev
```

yodel refuses an environment whose reader and writer are one user, so dev reads with a read-only user, `reader`, and applies with the emulator's `default` user, picked by `YODEL_CREDENTIALS=writer`. The template's `just up` makes the reader and prints these variables for a `.env` file, and `just apply` sets the writer.

For Postgres, use `templates/postgres` with `--param name=app-schema --param schema=app`.

Each template gives `chant.config.ts` with a profile per environment (`dev`, `prod`), `yodel.config.ts`, a migrate Op per environment (`yodel apply` behind a gate bound to the plan digest), a `WatchOp` per environment for drift on a schedule, and pipelines for GitHub Actions, GitLab CI and Forgejo Actions: `yodel lint` and the plan comment on pull requests with read-only credentials, `yodel apply` on a push to main with the writer, and the drift watch on its cron with the reader. `yodel ci` (`npm run ci`) renders the pipelines from the installed package, so upgrading yodel and rendering again brings its pipeline fixes, and the project's own jobs, declared in a module `yodel.config.ts` `ci.jobs` names, are kept. The parameters are in each template's `chant.template.json`; the template's README covers the credentials and each forge's setup, and so does [Setting up each forge](docs/forges.md).

## Documentation

The documentation is at [intentius.io/sql-yodeler](https://intentius.io/sql-yodeler/), built from [`docs/`](docs/README.md): [installing](docs/configuration.md#installing) (`npm install @intentius/sql-yodeler`), [starting a project](docs/adoption.md) from a template or with `yodel init --from`, [the declarative and versioned workflows](docs/workflows.md), [migrations](docs/migrations.md), [steps](docs/steps.md), [lint](docs/lint.md), [approval](docs/approval.md), [drift](docs/drift.md) and [topology](docs/topology.md).

[`examples/clickhouse`](examples/clickhouse/README.md) and [`examples/postgres`](examples/postgres/README.md) are finished example projects, each with a transcript of a run against chant's emulator.

## Versioned migrations

`yodel apply <env>` takes the versioned path when the project has a `migrations/` directory holding at least one migration (`yodel new` writes them); otherwise it is the declarative path, unchanged. `yodel status <env>` lists applied, pending, out-of-order and part-way migrations and checksum mismatches (`--json`; exit 0 up to date, 3 pending, 4 mismatch or out of order, 2 an Op step, 1 error).

`yodel init --from <env>` adopts an existing database: it reads it with chant's import (`chant import --from`), writes the declarations to `src/`, checks they plan clean, writes the baseline migration (the first one, creating everything) and records it applied in the history without running it (a succeeded migration row whose `note` starts `baseline:`). It needs a `chant.config.ts` with `sql.profiles.<env>` already, and for ClickHouse the profile's `databases`; `yodel init --help` has the rest. On Postgres it does the same, recording the baseline in `<history schema>.history`. `yodel init --baseline <env>` then records the same baseline in another environment that already holds the schema (staging, prod): it compares that environment's live schema with the schema the baseline records, refuses naming each difference, and otherwise records the baseline applied behind the environment's gate.

The history is an append-only table, `<db>.history`, one row per migration and per statement event, never updated or deleted.

### yodel.config.ts

An optional `yodel.config.ts` next to `chant.config.ts` sets what chant's config does not, per environment (by its `sql.profiles` name):

```ts
// yodel.config.ts
import { defineConfig } from "@intentius/sql-yodeler";

export default defineConfig({
  environments: {
    dev: { topology: "single" },
    staging: { topology: "replicated" },
    prod: { topology: "cluster:main", history: { database: "yodeler" }, lockTtl: 1800 },
  },
});
```

- `topology`: `single` (a single node), `cluster:<name>` (`ON CLUSTER <name>`, `Replicated*MergeTree` with a Keeper path), `replicated` or `replicated:<cluster>` (a `Replicated` database: no `ON CLUSTER`, `Replicated*MergeTree` with no arguments), or `cloud` (no `ON CLUSTER`, plain MergeTree, which Cloud makes `SharedMergeTree`). The object form, `{ kind: "cluster", cluster: "main", replicaPath, replicaName }`, sets the Keeper path and replica name of the tables the migrations create. Order: `yodel.config.ts`, then `sql.profiles.<env>.topology` in chant.config.ts, then `YODEL_TOPOLOGY`, then `single`.
- `history.database`: the database for the history and the lock. Then `YODEL_HISTORY_DATABASE`, then `yodeler`.
- `lockTtl`: the apply lock's TTL in seconds. Then `YODEL_LOCK_TTL`, then 900.

One migrations directory serves every topology. `yodel new` writes each statement for a single node and records nothing about where it runs; `yodel apply` renders each statement for the environment's topology as it sends it (chant's `renderStatement`). The history records a statement by the hash of the statement as written, so a migration that failed part way resumes the same way on any topology, and the statement row's `note` says the topology it was sent for (`topology=cluster:main`). The plan digest covers the topology, so an approval given for one topology does not apply on another. The history table's own engine follows the topology too: MergeTree on a single node and on Cloud, `ReplicatedMergeTree` `ON CLUSTER` on a cluster (one copy for the whole cluster), `ReplicatedMergeTree` inside a `Replicated` database. `yodel status` and `yodel plan` print the topology and where it came from.

The declarative path (no `migrations/`) plans and applies through chant, which reads `sql.profiles.<env>.topology` only, so a topology other than `single` set in `yodel.config.ts` alone is refused there; set it in chant.config.ts as well. A rebuild step (`ClickHouseRebuildOp`) runs through chant too, but yodel hands its activities the environment's topology, so it renders for the same topology as the statements around it.

One apply runs at a time: the lock is a row in a KeeperMap table, `<db>.lock`, which needs Keeper and `keeper_map_path_prefix` on the server. A single node without them gets a lock file on the runner's machine, and the run says cross-runner locking needs Keeper. A lock left by a dead runner expires; to clear it sooner, once you know nothing is applying: `ALTER TABLE <db>.lock DELETE WHERE name = 'apply'` (or remove the lock file the refusal names).

The apply runs as a chant Op behind a gate bound to the plan digest (the pending migrations' checksums, the history and the live schema). `yodel apply <env>` prints the declaration to add when there is none:

```ts
// ops/migrate-prod.op.ts
import { Op, phase, gate, shell, stepOutput } from "@intentius/chant/op";

const plan = shell("yodel apply prod --digest", { id: "plan" });
const digest = stepOutput(plan, "stdout");

export const op = Op({
  name: "migrate-prod",
  overview: "Apply the pending migrations to prod, behind an approval bound to their plan digest",
  phases: [
    phase("Plan", [plan]),
    phase("Approve", [gate("approve-migrate-prod", { plan: digest })]),
    phase("Apply", [shell("yodel apply prod --execute", { env: { YODEL_APPROVED_PLAN: digest }, timeout: "2h" })]),
  ],
});
```

`yodel apply prod` stops at the gate; approve at a terminal with `npx yodel approve prod`, then run it again. A script, which has no terminal to ask, runs the `chant approve migrate-prod approve-migrate-prod --plan <digest>` command that `yodel apply` prints instead. `yodel apply prod --plan` prints the pending migrations and the digest without applying. Running `chant run migrate-prod` directly needs `yodel` on PATH.

## yodel lint

`yodel lint` checks the migrations directory offline, with no server, so it runs in CI on every pull request. Every rule is free. Exit 0 when there is no error (warnings and silenced findings do not fail), 3 when there is at least one, 1 when lint cannot run; `--json` prints the findings.

- Integrity, always errors: `fork` (two migrations follow the same parent; `yodel rebase`), `directory` (a bad name or file, a missing parent, a cycle, another dialect), `checksum` (a migration's files changed since it was written), `unreadable-object` (an object in a recorded schema, or a step, the sql lexicon cannot read or classify; never skipped).
- From the classifier's classes: `destructive` (a drop), `pg-rewrite` (a rewrite or full scan under ACCESS EXCLUSIVE), `pg-lock` (writes blocked for a whole index build or scan: no `CONCURRENTLY`, a constraint validated in place), `pg-signature` (a function or procedure dropped and created with another signature), `pg-access` (a privilege revoked, a policy dropped, row-level security turned off), `pg-rls-not-forced` (a warning: row-level security enabled but not forced), `ch-mutation` (a mutation rewriting parts), `ch-rebuild` (a `ClickHouseRebuildOp` step), `ch-access` (a privilege or role revoked).
- `refused-step` (a step `yodel apply` will not run), `pg-routine-in-use` (a function dropped while a declared trigger still executes it), `migration-sql` (migration.sql does not hold a statement migration.json records), `silence` (a bad or unused `yodel:allow` line).

A line above a statement in its `migration.sql` silences one of the classifier rules for that statement:

```sql
-- yodel:allow destructive the column was never read; checked in prod 2026-10-08
ALTER TABLE `db`.`events` DROP COLUMN `legacy`;
```

The reason is required. `yodel apply` records each silence (step, rule, reason) in every history row the migration writes, in the `silences` column. The line changes the migration's checksum, so record the new one with `yodel lint --update-checksum <id>` while it is applied nowhere.

`yodel lint --env <env>` also reads the environment's history: an applied migration whose files changed since it ran is a `checksum` error, a pending migration's edit a warning. `yodel.config.ts` sets rule levels: `lint: { rules: { "ch-mutation": "warning", "pg-lock": "off" } }`; the integrity rules cannot be lowered. `yodel lint --rules` lists the rules and their levels.

`yodel lint --replay <env>` also replays every migration, in order, into `<env>`'s server (a throwaway emulator, `npx chant emulator up --lexicon sql`) and compares each with its recorded schema; the first that differs fails the run (rule `replay`, exit 3), named. The databases or schemas the history names must not exist there yet: otherwise it exits 4 and runs nothing, unless `--reset`, which drops them first (never point it at a server whose data matters). `--keep` leaves the replayed database in place to look at.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) covers building SQL Yodeler from a clone, the checks, and the scenario claims.
