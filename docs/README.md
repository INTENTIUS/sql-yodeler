---
claims: []
---

# SQL Yodeler

SQL Yodeler manages the schemas of ClickHouse and Postgres databases. You declare the schema in TypeScript with chant's `sql` lexicon, and the `yodel` CLI either applies it directly (the declarative path) or writes versioned migrations from it and applies those (the versioned path). Both paths apply behind an approval bound to a digest of the plan. Data migrations (rebuilds, backfills, expand-and-contract column changes) are steps inside a migration, recorded in the same history as the DDL, and resume where they stopped.

| Page | What it covers |
|---|---|
| [Your first migration](getting-started.md) | from an empty directory to applied migrations on a local database: the template, the emulator, the variables, plan, approve and apply |
| [Installing and configuring](configuration.md) | installing `yodel`, the project layout, `chant.config.ts` profiles, `yodel.config.ts`, the environment variables |
| [Starting a project](adoption.md) | a new project from a starter template, `yodel init --from` to adopt a database that already exists, and `yodel init --baseline` for another environment that holds the same schema |
| [Coming from another migration tool](from-other-tools.md) | for a database golang-migrate, goose, Flyway or dbmate manages: the concepts mapped, adopting it with `yodel init --from`, the old tool's files and table, and rollback with `yodel revert` |
| [The two workflows](workflows.md) | the declarative path (`yodel plan`, `yodel apply` against the declared schema) and the versioned path (`yodel new`, then `yodel apply`) |
| [Migrations](migrations.md) | the migrations directory, the history table, the apply lock, resume, out-of-order refusal, `yodel status`, `yodel rebase`, `yodel repair`, `yodel checkpoint`, and rollback with `yodel revert` |
| [Steps](steps.md) | ClickHouse rebuilds, backfills, Postgres `PostgresMigrationOp` steps, `yodel cleanup` of what they keep, and manual steps |
| [Access control](access.md) | Postgres row-level security, policies, roles and grants, and ClickHouse users, roles, row policies and grants: `access` per environment, what the schema owns and what the environment owns, the plan's access section, adopting them |
| [Lint](lint.md) | the rules, `yodel:allow` silences, rule levels, `--env`, and the replay check (`--replay`) |
| [Approval](approval.md) | the migrations Op and its gate, the plan digest, the pull request comment, and what happens when the digest moves |
| [Reports and the audit log](audit.md) | `yodel report`: every environment's migrations side by side, the audit log derived from the history and the gate ledger, its gaps, `audit.jsonl` and the HTML run view |
| [Schema from an ORM](orm.md) | `sources` in `yodel.config.ts`: tables an ORM defines, read from the DDL it prints, planned and applied with the rest |
| [Drift](drift.md) | `yodel drift` and the scheduled `WatchOp` |
| [Webhook events](notify.md) | `notify` in `yodel.config.ts`: signed events for an apply waiting for approval, a refusal, a failure and drift, and checking them in a receiver |
| [Schema docs](schema-docs.md) | `yodel docs`: an HTML reference and a Mermaid ERD of the schema, from the build |
| [Topology](topology.md) | ClickHouse on a single node, a cluster, a `Replicated` database and ClickHouse Cloud |
| [The commands](cli.md) | which command runs what (`yodel`, chant's CLI, the template's `just` targets), `yodel --help`, the exit codes, and the JSON Schemas of `--json` output |
| [Set up with a coding agent](agents.md) | the prompt to hand a coding agent, the steps it follows to add SQL Yodeler to a repository, and what it leaves to people |
| [Glossary](glossary.md) | the chant terms yodel's commands and output use, in yodel's terms |

Two example projects, one per dialect, show each of these on a real server. They are finished projects, and their READMEs are transcripts of the runs that made them, against chant's emulator, with the output each command printed. To follow along step by step, start with [Your first migration](getting-started.md):

- [examples/clickhouse](../examples/clickhouse/README.md): adoption, a migration, a sort-key rebuild, a backfill, a lint silence, an approval that stops holding, drift, the replay check.
- [examples/postgres](../examples/postgres/README.md): adoption, lint findings, a migration that fails part way and resumes, a column rename as an expand-and-contract step, a destructive change silenced, a fork resolved with `yodel rebase` and `yodel repair`, an out-of-order migration, drift, the replay check.

The pages quote those runs.
