---
claims: []
type: reference
---

# The commands

Everything a SQL Yodeler project needs is a `yodel` command, and the starter templates add `just` targets that wrap them. This page says which one does what, then lists `yodel`'s commands, its exit codes and the JSON Schemas of its `--json` output.

## Which command runs what

| Command | What it is for |
|---|---|
| `npx @intentius/sql-yodeler create <dir> --clickhouse` (or `--postgres`) | once, to make the project from SQL Yodeler's template, the one released with that yodel ([Your first migration](getting-started.md#1-make-the-project)). |
| `yodel emulator up` | a local ClickHouse and Postgres in Docker, for development; `yodel emulator status` and `yodel emulator down` check and stop them. |
| `yodel` | everything about the schema and the migrations: `plan`, `new`, `lint`, `apply`, `status`, `drift`, `report`, `ci` and the rest of the commands `yodel --help` lists below. Inside a project, run it as `npx yodel`. |
| `yodel approve <env>` | a person's approval of the plan `yodel apply` would run, at a terminal: it shows the plan and asks you to type the environment's name. Every message that asks for an approval prints it with the digest, `yodel approve <env> --plan <digest>` ([Approval](approval.md)). |
| the template's `just` targets | optional shortcuts that print the command they run; [the table in Your first migration](getting-started.md#the-same-steps-with-just) lists them. |
| `yodel check` | lints another tool's migrations (golang-migrate, goose, Flyway, dbmate) on your pull requests while that tool keeps applying them ([Try it without switching](from-other-tools.md#try-it-without-switching)). |
| `yodel mcp` | read-only tools for a coding agent, over MCP ([Set up with a coding agent](agents.md#read-only-tools-yodel-mcp)). |
| the JSON Schemas | for anything that parses `yodel`'s output: [JSON output](#json-output). |

yodel runs [chant](https://intentius.io/chant/)'s CLI underneath (`chant init`, `chant emulator`, `chant run`, `chant approve`), so you never need to; [chant's CLI reference](https://intentius.io/chant/cli/overview/) is there for the curious.

## yodel --help

```console
$ yodel --help
Usage: yodel <command> [options]

Schema changes for ClickHouse and Postgres, and the ops they imply.

Commands:
  create      make a new project from SQL Yodeler's template
  init        adopt a live database, or record its baseline in another env
  emulator    start, stop or check the local ClickHouse and Postgres (Docker)
  plan        show what apply would change in an environment
  apply       bring an environment to its declared schema or pending migrations
  approve     approve the plan yodel apply would run (a person at a terminal)
  override    override a policy rule for the current plan, with a reason
  new         write the next migration from the declared schema
  checkpoint  write a checkpoint: the newest recorded schema from nothing
  lint        check the migrations against the lint rules
  check       lint a golang-migrate, goose, Flyway or dbmate directory
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
  1  failed, or refused for a reason no approval fixes: a bad config, a checksum
     mismatch, an applied migration gone from the directory, an out-of-order
     migration, a fork or another problem in the migrations directory, an
     environment whose reader and writer are one identity, a command that writes
     run with an environment's reader, lint errors
  2  for yodel drift, drift found
  3  waiting for a person: apply stopped at its approval gate, status found
     pending migrations, a migration the environment it must run on first has
     not applied, a change that needs an Op yodel does not run, a manual step
  4  the plan moved: the approved plan, or the one a wave decided on, is not the
     plan that would apply now; nothing applied
  5  another apply holds the lock
  7  a policy rule denies the plan and no override counts; nothing applied
  8  yodel approve: the answer was not the environment's name; nothing approved
  yodel plan exits 0 when migrations are pending: it reports, and a CI job that
  posts the plan on a pull request should not fail because the pull request adds
  a migration. To gate on pending migrations, use yodel status.
```

## Exit codes

yodel exits by chant's one exit-code table, the same numbers terragucci and plywood use; [chant's exit codes reference](https://intentius.io/chant/reference/exit-codes/) has the whole table. `yodel <command> --help` lists each command's options and the codes it can return:

| Code | Meaning |
|---|---|
| 0 | done, or nothing to do |
| 1 | failed, or refused for a reason no approval fixes: a bad config, a checksum mismatch, an applied migration gone from the directory, an out-of-order migration, a fork or another problem in the migrations directory, an environment whose reader and writer are one identity, a command that writes run with an environment's reader, lint errors |
| 2 | for `yodel drift`, drift found |
| 3 | waiting for a person: apply stopped at its approval gate, status found pending migrations, a migration the environment it must run on first has not applied, a change that needs an Op yodel does not run, a manual step |
| 4 | the plan moved: the approved plan, or the one a wave decided on, is not the plan that would apply now; nothing applied |
| 5 | another apply holds the lock |
| 7 | a policy rule denies the plan and no override counts; nothing applied |
| 8 | `yodel approve`: the answer was not the environment's name; nothing approved |

chant's table also has 6, a newer push applies instead, which yodel itself does not return: `yodel apply --stand-down` exits 0. A refusal no approval fixes is 1, so a pipeline tells a broken migrations directory from a waiting gate (3), a moved plan (4) and a policy denial (7). `yodel apply` exits with the code of its Op's Apply step, so a lock held by another apply is 5 there too. `yodel plan` exits 0 when migrations are pending: it reports, and a CI job that posts the plan on a pull request should not fail because the pull request adds a migration. To gate on pending migrations, use `yodel status`.

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

Where a document asks for an approval, `approve` is the command a person runs, `yodel approve <env> --plan <digest>`, and `chantApprove` is chant's own command for the same approval, for a script that records approvals itself. The version is in each schema's `$id` (`v1`). Within a version, fields are only added, so a reader ignores fields it does not know; removing a field or changing what one means is a new version. The exit code is the same with or without `--json`. `yodel mcp` serves the read-only commands to a coding agent, with these schemas: [Set up with a coding agent](agents.md#read-only-tools-yodel-mcp).
