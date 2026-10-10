---
claims: []
---

# The commands

A SQL Yodeler project meets three command-line tools: `yodel`, chant's CLI, and the `just` targets the starter templates add. This page says which one does what, then lists `yodel`'s commands, its exit codes and the JSON Schemas of its `--json` output.

## Which command runs what

| Command | What it is for |
|---|---|
| `yodel` | everything about the schema and the migrations: `plan`, `new`, `lint`, `apply`, `approve`, `status`, `drift`, `report`, `ci` and the rest of the commands `yodel --help` lists below. Inside a project, run it as `npx yodel`. |
| `npx @intentius/chant@latest init --from ...` | once, to make the project from a starter template ([Your first migration](getting-started.md#1-make-the-project)). |
| `npx chant emulator up --lexicon sql` | a local ClickHouse and Postgres in Docker, for development. |
| `chant approve` | records an approval of a plan digest. `yodel approve <env>` records the same approval for you at a terminal; `chant approve <op> <gate> --plan <digest>` is the form a script uses ([Approval](approval.md)). |
| `chant run` | runs an Op. `yodel apply` runs the migrations Op itself, so you need `chant run` only to run an Op directly, as CI may. |
| the template's `just` targets | optional shortcuts that print the command they run; [the table in Your first migration](getting-started.md#the-same-steps-with-just) lists them. |
| `yodel mcp` | read-only tools for a coding agent, over MCP ([Set up with a coding agent](agents.md#read-only-tools-yodel-mcp)). |
| the JSON Schemas | for anything that parses `yodel`'s output: [JSON output](#json-output). |

## yodel --help

```console
$ yodel --help
Usage: yodel <command> [options]

Schema management and migrations for ClickHouse and Postgres.

Commands:
  init        adopt a live database, or record its baseline in another env
  plan        show what apply would change in an environment
  apply       bring an environment to its declared schema or pending migrations
  approve     approve the plan yodel apply would run (a person at a terminal)
  override    override a policy rule for the current plan, with a reason
  new         write the next migration from the declared schema
  checkpoint  write a checkpoint: the newest recorded schema from nothing
  lint        check the migrations against the lint rules
  test        run tests/*.test.ts on databases built from the migrations
  status      list applied, pending and out-of-order migrations
  report      each environment's migrations side by side, and the audit log
  drift       report declared objects changed out of band or gone
  docs        write an HTML reference and a Mermaid ERD of the schema
  ci          render the project's CI pipelines (GitHub, GitLab, Forgejo)
  config      print each environment's settings, and prove a job cannot write
  rebase      move a migration onto a new parent and recompute its schema
  repair      record a new checksum for an applied migration, with a reason
  revert      undo the newest applied migration from its recorded schemas
  cleanup     drop the old tables and columns steps kept, once past their date
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
     not applied, an environment whose reader and writer are one identity, a
     command that writes run with an environment's reader
  5  another apply holds the lock
  yodel plan exits 0 when migrations are pending: it reports, and a CI job that
  posts the plan on a pull request should not fail because the pull request adds
  a migration. To gate on pending migrations, use yodel status.
```

## Exit codes

`yodel <command> --help` lists each command's options and exit codes. The exit codes mean the same across commands where they can:

| Code | Meaning |
|---|---|
| 0 | done, or nothing to do |
| 1 | an error |
| 2 | something yodel will not do itself (a change that needs an Op it does not run, a manual step); for `yodel drift`, drift found |
| 3 | something outstanding: apply stopped at its approval gate, status found pending migrations, lint found errors |
| 4 | refused, nothing done: a checksum mismatch, an applied migration gone from the directory, an out-of-order migration, a fork or another problem in the migrations directory, a migration the environment it must run on first has not applied, an environment whose reader and writer are one identity, a command that writes run with an environment's reader |
| 5 | another apply holds the lock |

`yodel apply` exits with the code of its Op's Apply step, so a lock held by another apply is 5 there too. `yodel plan` exits 0 when migrations are pending: it reports, and a CI job that posts the plan on a pull request should not fail because the pull request adds a migration. To gate on pending migrations, use `yodel status`.

## JSON output

With `--json`, a command prints one JSON document on stdout. Each document has a JSON Schema, shipped in the package's `schemas/` directory and published at `https://intentius.io/sql-yodeler/schemas/v1/<name>.schema.json`:

| Command | Schema |
|---|---|
| `yodel init --from <env> --json`, `yodel init --baseline <env> --json` | [`init`](https://intentius.io/sql-yodeler/schemas/v1/init.schema.json) |
| `yodel plan <env> --json` | [`plan`](https://intentius.io/sql-yodeler/schemas/v1/plan.schema.json): the versioned plan (`"mode": "versioned"`) or the declarative one |
| `yodel apply <env> --json` | [`apply`](https://intentius.io/sql-yodeler/schemas/v1/apply.schema.json) |
| `yodel new <name> --json` | [`new`](https://intentius.io/sql-yodeler/schemas/v1/new.schema.json) |
| `yodel lint --json` | [`lint`](https://intentius.io/sql-yodeler/schemas/v1/lint.schema.json); `yodel lint --rules --json` prints [`lint-rules`](https://intentius.io/sql-yodeler/schemas/v1/lint-rules.schema.json) |
| `yodel status <env> --json` | [`status`](https://intentius.io/sql-yodeler/schemas/v1/status.schema.json) |
| `yodel drift <env> --json` | [`drift`](https://intentius.io/sql-yodeler/schemas/v1/drift.schema.json) |
| `yodel rebase --json` | [`rebase`](https://intentius.io/sql-yodeler/schemas/v1/rebase.schema.json) |
| `yodel repair <env> <id> --reason <text> --json` | [`repair`](https://intentius.io/sql-yodeler/schemas/v1/repair.schema.json) |
| `yodel cleanup <env> --json` | [`cleanup`](https://intentius.io/sql-yodeler/schemas/v1/cleanup.schema.json) |

The version is in each schema's `$id` (`v1`). Within a version, fields are only added, so a reader ignores fields it does not know; removing a field or changing what one means is a new version. The exit code is the same with or without `--json`. `yodel mcp` serves the read-only commands to a coding agent, with these schemas: [Set up with a coding agent](agents.md#read-only-tools-yodel-mcp).
