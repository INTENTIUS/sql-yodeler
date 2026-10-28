---
claims: []
type: howto
---

# Set up with a coding agent

Setup needs no agent: [Your first migration](getting-started.md) and [Starting a project](adoption.md) give every step by hand. This page is for a coding agent adding SQL Yodeler to a repository, and for the person handing it the task. Run the agent in the repository and give it this prompt:

```text
Set up SQL Yodeler in this repository.
Read https://intentius.io/sql-yodeler/llms.txt first, then
https://intentius.io/sql-yodeler/agents/ and follow it.
Open a pull request with the result.
Never run `yodel apply` against a shared environment, never run `chant approve`, `yodel approve` or `yodel override`, never edit the `chant/lifecycle` branch or `.chant/allowed_signers`, never merge; approvals and applies belong to people.
```

The last line is in every prompt on this site. Applying to a shared environment, approving a plan, changing the `chant/lifecycle` branch (where chant keeps approvals) and merging stay with people; the agent prepares the change and hands those steps over. So does overriding a policy rule with `yodel override`, which records a person's decision to apply a plan the rule denies, and editing `.chant/allowed_signers`, the signers file that decides whose sealed approvals count.

## What the agent reads

| File | Holds |
|---|---|
| [`llms.txt`](https://intentius.io/sql-yodeler/llms.txt) | every page, with a one-line description and its prompt |
| [`llms-full.txt`](https://intentius.io/sql-yodeler/llms-full.txt) | the text of every page in one file |
| Copy page as Markdown, under each page's title | that page's text, with its prompt |

A task page's own prompt sits under its title as "Optional: hand this page to your coding agent". The [Glossary](glossary.md) explains the chant terms the commands use.

## Steps for the agent

1. Check the repository: Node 22.12 or later, a git repository, and whether it already holds other code. The template's CI pipelines go in the project's `.github/workflows`, `.forgejo/workflows` and `.gitlab-ci.yml`, which a forge reads only at the repository root. If the repository holds other code, ask the user where the project goes.
2. Ask the user for the dialect (ClickHouse or Postgres), the database (ClickHouse) or schema (Postgres) the tables live in, and whether it exists already.
3. Make the project from the template with `yodel create`, from npm. It makes the project in a new directory, or one that holds nothing but `.git`, and refuses any other; check `git status` afterwards.

   ```sh
   npx @intentius/sql-yodeler@latest create <dir> --clickhouse --database <database> --name <package name>
   npx @intentius/sql-yodeler@latest create <dir> --postgres --schema <schema> --name <package name>
   cd <dir> && npm install
   ```

4. Edit `chant.config.ts`: each environment's default server address (`dev`, `prod`, and any the user names). Credentials stay out of files: the profiles name environment variables, and the template's README lists them. For another environment, add its profile, its entry in `yodel.config.ts`, and copies of `ops/migrate-dev.op.ts` and `ops/watch-dev.op.ts` with `dev` changed, then run `npm run ci` to render the pipelines again.
5. For a new database, declare the tables in `src/` (chant's `sql` lexicon; the template's `src/schema.ts` shows the form) and write the first migration with `npx yodel new init`. For a database that exists, do not write `src/` by hand: `npx yodel init --from <env> --force` adopts it ([Starting a project](adoption.md)). It writes one row to that environment's history, so ask the user first and run it with the credentials they give you.
6. Run `npx yodel lint` and `npm run ci:check`. Both must pass.
7. Optionally, check the migrations on a local database: `npx yodel emulator up` starts one in Docker, and [Your first migration](getting-started.md) has the variables. `npx yodel plan dev` and `npx yodel apply dev` against it are safe; `yodel apply` stops at the approval, and that is where the agent stops too.
8. Commit the project (with `package-lock.json`) on a new branch and open a pull request. Check `git status` so the commit holds nothing else.
9. Tell the user what is left for them, from the template's README: create each environment's reader and writer database users, add the forge's secrets where [Setting up each forge](forges.md) says, approve each plan the pull request comment shows, and merge.

## Rules for the agent

- `npx yodel <command> --help` lists each command's options and exit codes; [the exit codes](cli.md#exit-codes) says what they mean.
- Print the approve command a plan shows, and never run it. The approval is bound to that plan's digest, and it is the user's.
- Never edit a migration that is committed on the default branch: write a new one with `npx yodel new <name>`. `npx yodel lint` reports an edited one as a `checksum` error.
- Print the `yodel override` command a plan shows for a denied policy rule, and never run it. An override is the user's decision, with the user's reason.
- Never edit `.chant/allowed_signers`, the file that lists whose sealed approvals count. Adding or removing a signer is the user's change.
- Silence a lint finding (`-- yodel:allow <rule> <reason>`) only with a reason the user gives.
- Credentials go in the forge's secrets, never in a file or a commit.
- Read a command's result from its `--json` output, never from its text. Each document has a JSON Schema; [JSON output](cli.md#json-output) lists them.

## Read-only tools (yodel mcp)

An agent that should look at a project's state without a shell can use `yodel mcp`, a Model Context Protocol server on stdin and stdout. Register it with the agent's MCP client, started in the project with the reader's credentials in its environment (the ones `yodel plan` uses):

```json
{ "mcpServers": { "yodel": { "command": "npx", "args": ["yodel", "mcp"] } } }
```

`--dir <project>` serves a project in another directory. The tools are read-only:

| Tool | Runs | Gives |
|---|---|---|
| `status` | `yodel status <env> --json` | applied, pending, out-of-order and part-way migrations, checksum mismatches, the plan digest apply would ask approval for |
| `plan` | `yodel plan <env> --json` | what `yodel apply` would run; in `forPerson`, the approve command when the plan waits for approval, and `yodel override` for each policy rule that denies it |
| `lint` | `yodel lint [--env <env>] --json` | the findings and silences; with `env`, against that environment's history |
| `drift` | `yodel drift <env> --json` | the declared objects changed out of band or gone |
| `history` | `yodel status <env> --json` | the migrations the history records applied: who, when, under which digest, and any repairs |
| `explain` | `yodel lint --rules --json` | what a lint rule checks and whether it can be silenced (`topic`: the rule's id), or what an exit code means (`topic`: `0` to `5`) |

Each tool answers with one envelope ([`mcp.schema.json`](https://intentius.io/sql-yodeler/schemas/v1/mcp.schema.json)): `schema` (the envelope's version, `1`), `tool`, `command` (the command line it ran), `exit` (its exit code, the same as on a terminal), `results` (what it printed with `--json`, or `null` when it failed), `resultsSchema` (the `$id` of the schema `results` follows), `error` (what it wrote to stderr) and `forPerson` (steps that belong to a person, each with the command the person runs).

There is no tool that applies, approves, overrides a policy rule, repairs, rebases, writes a migration or touches `chant/lifecycle`. The server refuses to start with a tool named for `apply`, `approve`, `repair`, `rebase`, `new`, `init` or `override`, a tool that runs any command besides `status`, `plan`, `lint` and `drift`, or a tool not marked read-only, and no tool passes a flag that writes (`--replay`, `--update-checksum`, `--comment`, `--execute`). The commands in `forPerson` are the person's to run: the agent shows them and stops, as the never-line above says.

With a chant that has the product tool hook (the release after 0.124.51, chant#4555), `yodel mcp` serves these tools on chant's own read-only server, `chant serve mcp --read-only`, in the same process. They are named `yodel:status`, `yodel:plan`, `yodel:lint`, `yodel:drift`, `yodel:history` and `yodel:explain`, and chant's reads of the ledger, the runs, the gates and the workspace graph sit beside them. Each tool declares itself read-only, and chant refuses to start a read-only server with a tool named as a write, as yodel's check above does first. The registration above stays the same. `YODEL_OWN_MCP=1` serves yodel's own server with the unprefixed names.
