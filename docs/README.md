---
claims: []
---

# SQL Yodeler

SQL Yodeler manages the schemas of ClickHouse and Postgres databases declaratively. You declare what the schema should be in TypeScript with chant's `sql` lexicon ([Declaring the schema](schema.md)), and the `yodel` CLI works out the change: it either applies it directly (the declarative path) or writes versioned migrations from it and applies those (the versioned path). Both paths apply behind an approval bound to a digest of the plan.

Some schema changes imply work beyond one statement, and yodel does that work as a step of the migration, in the same history as the DDL:

- **ClickHouse rebuild.** Some changes, such as a new sort key, engine or partitioning, can't be made with `ALTER`. yodel creates a new table, copies the rows into it, checks that they match, and swaps it in.
- **Postgres safe rename.** Renaming a column or table in one step breaks the app that is still using the old name. yodel adds the new name, keeps both in sync, moves readers over, and drops the old name later. This is called expand and contract.
- **Backfill.** A new column often needs values for the rows already there. You write the fill once, and yodel runs it in batches, resuming where it stopped if it is interrupted.

Rebuilds, renames and backfills run once, inside the migration. No recurring jobs. Not an ORM; it works next to one ([Schema from an ORM](orm.md)).

| Page | What it covers |
|---|---|
| [Your first migration](getting-started.md) | from an empty directory to applied migrations on a local database: the template, the emulator, the variables, plan, approve and apply |
| [Installing and configuring](configuration.md) | installing `yodel`, the project layout, `chant.config.ts` profiles, `yodel.config.ts`, the environment variables |
| [Starting a project](adoption.md) | a new project from a starter template, `yodel init --from` to adopt a database that already exists, and `yodel init --baseline` for another environment that holds the same schema |
| [Coming from another migration tool](from-other-tools.md) | for a database golang-migrate, goose, Flyway or dbmate manages: the concepts mapped, adopting it with `yodel init --from`, the old tool's files and table, and rollback with `yodel revert` |
| [Declaring the schema](schema.md) | the schema as TypeScript in `src/`: [why plain SQL](schema.md#why-plain-sql), one export per object in the database's own DDL, references with `${}`, splitting it across files, generating objects with code, composites, what the build checks and the editor |
| [The two workflows](workflows.md) | the declarative path (`yodel plan`, `yodel apply` against the declared schema) and the versioned path (`yodel new`, then `yodel apply`) |
| [Migrations](migrations.md) | the migrations directory, the history table, the apply lock, resume, out-of-order refusal, `yodel status`, `yodel rebase`, `yodel repair`, `yodel checkpoint`, and rollback with `yodel revert` |
| [Data migrations](steps.md) | ClickHouse rebuilds, backfills, Postgres `PostgresMigrationOp` steps, `yodel cleanup` of what they keep, and manual steps |
| [Access control](access.md) | Postgres row-level security, policies, roles and grants, and ClickHouse users, roles, row policies and grants: `access` per environment, what the schema owns and what the environment owns, the plan's access section, adopting them |
| [Lint](lint.md) | the rules, `yodel:allow` silences, rule levels, `--env`, and the replay check (`--replay`) |
| [Lint and plan on pull requests only](lint-and-plan.md) | `ci: { apply: false }`: lint, the replay check and the plan comment on every pull request with readers only, no apply pipeline, and turning apply on later |
| [Setting up each forge](forges.md) | GitHub, GitLab and Forgejo side by side: the pipeline files, where the readers' and the writer's secrets go, the tokens for the plan comment, the drift watch and resuming, cloud roles over OIDC, runners and pull requests from forks |
| [SQL Yodeler on chant CI](chant-ci.md) | which parts of the pipelines are chant's and which are SQL Yodeler's, each part chant takes over from chant 0.124.56, and `yodel upgrade` |
| [Applying from Kubernetes](kubernetes.md) | a Job or Helm hook that runs `yodel apply <env>` before a rollout: the CI image, the checkout with `chant/lifecycle`, the writer from a Secret, approving first, the exit codes, and the lock between two rollouts |
| [Running yodel alongside Terraform](terraform.md) | Terraform creates the database or schema, the reader and writer users and their secrets; the pipeline then runs `yodel apply <env>`; where each tool's state lives |
| [Approval](approval.md) | the migrations Op and its gate, the plan digest, the pull request comment, and what happens when the digest moves |
| [Reports and the audit log](audit.md) | `yodel report`: every environment's migrations side by side, the audit log derived from the history and the gate ledger, its gaps, `audit.jsonl` and the HTML run view |
| [Schema from an ORM](orm.md) | `sources` in `yodel.config.ts`: tables an ORM defines, read from the DDL it prints, planned and applied with the rest |
| [In a chant workspace](workspace.md) | a yodel project as a member of a chant workspace: its tables and columns as outputs, dbt sources that link to them, and `chant workspace check` failing on a dropped or renamed column |
| [Drift](drift.md) | `yodel drift` and the scheduled `WatchOp` |
| [Webhook events](notify.md) | `notify` in `yodel.config.ts`: signed events for an apply waiting for approval, a refusal, a failure and drift, and checking them in a receiver |
| [Generated schema reference](schema-docs.md) | `yodel docs`: an HTML reference and a Mermaid ERD generated from the declared schema |
| [Topology](topology.md) | ClickHouse on a single node, a cluster, a `Replicated` database and ClickHouse Cloud |
| [The commands](cli.md) | which command runs what (`yodel`, chant's CLI, the template's `just` targets), `yodel --help`, the exit codes, and the JSON Schemas of `--json` output |
| [Set up with a coding agent](agents.md) | the prompt to hand a coding agent, the steps it follows to add SQL Yodeler to a repository, and what it leaves to people |
| [Glossary](glossary.md) | the chant terms yodel's commands and output use, in yodel's terms |
| [Claims status](claims.md) | every scenario claim, what it says, and whether it passed plain and was caught broken on ClickHouse and on Postgres, with the pages each one proves |

Two example projects, one per dialect, show each of these on a real server. They are finished projects, and their READMEs are transcripts of the runs that made them, against chant's emulator, with the output each command printed. To follow along step by step, start with [Your first migration](getting-started.md):

- [examples/clickhouse](../examples/clickhouse/README.md): adoption, a migration, a sort-key rebuild, a backfill, a lint silence, an approval that stops holding, drift, the replay check.
- [examples/postgres](../examples/postgres/README.md): adoption, lint findings, a migration that fails part way and resumes, a column rename as an expand-and-contract step, a destructive change silenced, a fork resolved with `yodel rebase` and `yodel repair`, an out-of-order migration, drift, the replay check.

The pages quote those runs.
