---
claims: []
---

# SQL Yodeler

SQL Yodeler manages the schemas of ClickHouse and Postgres databases. You declare the schema in TypeScript with chant's `sql` lexicon, and the `yodel` CLI either applies it directly (the declarative path) or writes versioned migrations from it and applies those (the versioned path). Both paths apply behind an approval bound to a digest of the plan. Data migrations (rebuilds, backfills, expand-and-contract column changes) are steps inside a migration, recorded in the same history as the DDL, and resume where they stopped.

| Page | What it covers |
|---|---|
| [Your first migration](getting-started.md) | from an empty directory to applied migrations on a local database: the template, the emulator, the variables, plan, approve and apply |
| [Installing and configuring](configuration.md) | installing `yodel`, the project layout, `chant.config.ts` profiles, `yodel.config.ts`, the environment variables |
| [Starting a project](adoption.md) | a new project from a starter template, and `yodel init --from` to adopt a database that already exists |
| [The two workflows](workflows.md) | the declarative path (`yodel plan`, `yodel apply` against the declared schema) and the versioned path (`yodel new`, then `yodel apply`) |
| [Migrations](migrations.md) | the migrations directory, the history table, the apply lock, resume, out-of-order refusal, `yodel status`, `yodel rebase`, `yodel repair` |
| [Steps](steps.md) | ClickHouse rebuilds, backfills, Postgres `PostgresMigrationOp` steps, and manual steps |
| [Access control](access.md) | Postgres row-level security, policies, roles and grants: `access` per environment, what the schema owns and what the environment owns, the plan's access section, adopting them |
| [Lint](lint.md) | the rules, `yodel:allow` silences, rule levels, `--env`, and the replay check (`--replay`) |
| [Approval](approval.md) | the migrations Op and its gate, the plan digest, the pull request comment, and what happens when the digest moves |
| [Reports and the audit log](audit.md) | `yodel report`: every environment's migrations side by side, the audit log derived from the history and the gate ledger, its gaps, `audit.jsonl` and the HTML run view |
| [Schema from an ORM](orm.md) | `sources` in `yodel.config.ts`: tables an ORM defines, read from the DDL it prints, planned and applied with the rest |
| [Drift](drift.md) | `yodel drift` and the scheduled `WatchOp` |
| [Webhook events](notify.md) | `notify` in `yodel.config.ts`: signed events for an apply waiting for approval, a refusal, a failure and drift, and checking them in a receiver |
| [Schema docs](schema-docs.md) | `yodel docs`: an HTML reference and a Mermaid ERD of the schema, from the build |
| [Topology](topology.md) | ClickHouse on a single node, a cluster, a `Replicated` database and ClickHouse Cloud |
| [Set up with a coding agent](agents.md) | the prompt to hand a coding agent, the steps it follows to add SQL Yodeler to a repository, and what it leaves to people |
| [Glossary](glossary.md) | the chant terms yodel's commands and output use, in yodel's terms |

Two example projects, one per dialect, show each of these on a real server. They are finished projects, and their READMEs are transcripts of the runs that made them, against chant's emulator, with the output each command printed. To follow along step by step, start with [Your first migration](getting-started.md):

- [examples/clickhouse](../examples/clickhouse/README.md): adoption, a migration, a sort-key rebuild, a backfill, a lint silence, an approval that stops holding, drift, the replay check.
- [examples/postgres](../examples/postgres/README.md): adoption, lint findings, a migration that fails part way and resumes, a column rename as an expand-and-contract step, a destructive change silenced, a fork resolved with `yodel rebase` and `yodel repair`, an out-of-order migration, drift, the replay check.

The pages quote those runs.

## The commands

```console
$ yodel --help
Usage: yodel <command> [options]

Schema management and migrations for ClickHouse and Postgres.

Commands:
  init        adopt a live database: declarations and an applied baseline
  plan        show what apply would change in an environment
  apply       bring an environment to its declared schema or pending migrations
  approve     approve the plan yodel apply would run (a person at a terminal)
  override    override a policy rule for the current plan, with a reason
  new         write the next migration from the declared schema
  checkpoint  write a checkpoint: the newest recorded schema from nothing
  lint        check the migrations against the lint rules
  status      list applied, pending and out-of-order migrations
  report      each environment's migrations side by side, and the audit log
  drift       report declared objects changed out of band or gone
  docs        write an HTML reference and a Mermaid ERD of the schema
  ci          render the project's CI pipelines (GitHub, GitLab, Forgejo)
  rebase      move a migration onto a new parent and recompute its schema
  repair      record a new checksum for an applied migration, with a reason
  revert      undo the newest applied migration from its recorded schemas
  mcp         serve read-only tools to a coding agent (MCP, stdio)

Options:
  -h, --help     show this help
  -v, --version  print the version

yodel <command> --help (or yodel help <command>) shows a command's options.
Docs: https://intentius.io/sql-yodeler/

Exit codes (yodel <command> --help lists a command's own):
  0  done, or nothing to do
  1  an error
  2  something yodel will not do itself (a change that needs an Op it does not
     run, a manual step); for yodel drift, drift found
  3  something outstanding: apply stopped at its approval gate, status found
     pending migrations, lint found errors
  4  refused, nothing done: a checksum mismatch, an applied migration gone from
     the directory, an out-of-order migration, a fork or another problem in the
     migrations directory, a migration the environment it must run on first has
     not applied
  5  another apply holds the lock
  yodel plan exits 0 when migrations are pending: it reports, and a CI job that
  posts the plan on a pull request should not fail because the pull request adds
  a migration. To gate on pending migrations, use yodel status.
```

`yodel <command> --help` lists each command's options and exit codes. The exit codes mean the same across commands where they can: 0 done, or nothing to do; 1 an error; 2 something `yodel` will not do itself (a change that needs an Op it does not run, a manual step); for `yodel drift`, drift found; 3 something outstanding: apply stopped at its approval gate, status found pending migrations, lint found errors; 4 refused, nothing done: a checksum mismatch, an applied migration gone from the directory, an out-of-order migration, a fork or another problem in the migrations directory, a migration the environment it must run on first has not applied; 5 another apply holds the lock. `yodel apply` exits with the code of its Op's Apply step, so a lock held by another apply is 5 there too. `yodel plan` exits 0 when migrations are pending: it reports, and a CI job that posts the plan on a pull request should not fail because the pull request adds a migration. To gate on pending migrations, use `yodel status`.

With `--json`, a command prints one JSON document on stdout. Each document has a JSON Schema, shipped in the package's `schemas/` directory and published at `https://intentius.io/sql-yodeler/schemas/v1/<name>.schema.json`:

| Command | Schema |
|---|---|
| `yodel init --from <env> --json` | [`init`](https://intentius.io/sql-yodeler/schemas/v1/init.schema.json) |
| `yodel plan <env> --json` | [`plan`](https://intentius.io/sql-yodeler/schemas/v1/plan.schema.json): the versioned plan (`"mode": "versioned"`) or the declarative one |
| `yodel apply <env> --json` | [`apply`](https://intentius.io/sql-yodeler/schemas/v1/apply.schema.json) |
| `yodel new <name> --json` | [`new`](https://intentius.io/sql-yodeler/schemas/v1/new.schema.json) |
| `yodel lint --json` | [`lint`](https://intentius.io/sql-yodeler/schemas/v1/lint.schema.json); `yodel lint --rules --json` prints [`lint-rules`](https://intentius.io/sql-yodeler/schemas/v1/lint-rules.schema.json) |
| `yodel status <env> --json` | [`status`](https://intentius.io/sql-yodeler/schemas/v1/status.schema.json) |
| `yodel drift <env> --json` | [`drift`](https://intentius.io/sql-yodeler/schemas/v1/drift.schema.json) |
| `yodel rebase --json` | [`rebase`](https://intentius.io/sql-yodeler/schemas/v1/rebase.schema.json) |
| `yodel repair <env> <id> --reason <text> --json` | [`repair`](https://intentius.io/sql-yodeler/schemas/v1/repair.schema.json) |

The version is in each schema's `$id` (`v1`). Within a version, fields are only added, so a reader ignores fields it does not know; removing a field or changing what one means is a new version. The exit code is the same with or without `--json`. `yodel mcp` serves the read-only commands to a coding agent, with these schemas: [Set up with a coding agent](agents.md#read-only-tools-yodel-mcp).
