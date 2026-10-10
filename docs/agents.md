# Set up with a coding agent

Setup needs no agent: [Your first migration](getting-started.md) and [Starting a project](adoption.md) give every step by hand. This page is for a coding agent adding SQL Yodeler to a repository, and for the person handing it the task. Run the agent in the repository and give it this prompt:

```text
Set up SQL Yodeler in this repository.
Read https://intentius.io/sql-yodeler/llms.txt first, then
https://intentius.io/sql-yodeler/agents/ and follow it.
Open a pull request with the result.
Never run `yodel apply` against a shared environment, never run `chant approve` or `yodel approve`, never merge; approvals and applies belong to people.
```

The last line is in every prompt on this site. Applying to a shared environment, approving a plan and merging stay with people; the agent prepares the change and hands those steps over.

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
3. Make the project from the template, with chant's CLI from npm (plain `npx chant` outside a project is an unrelated package). `--force` lets it write into a directory that is not empty; check `git status` afterwards.

   ```sh
   npx @intentius/chant@latest init --from INTENTIUS/sql-yodeler@main#templates/clickhouse --param name=<package name> --param database=<database> --force .
   npx @intentius/chant@latest init --from INTENTIUS/sql-yodeler@main#templates/postgres --param name=<package name> --param schema=<schema> --force .
   npm install
   ```

4. Edit `chant.config.ts`: each environment's default server address (`dev`, `prod`, and any the user names). Credentials stay out of files: the profiles name environment variables, and the template's README lists them. For another environment, add its profile, its entry in `yodel.config.ts`, and copies of `ops/migrate-dev.op.ts` and `ops/watch-dev.op.ts` with `dev` changed, then run `npm run ci` to render the pipelines again.
5. For a new database, declare the tables in `src/` (chant's `sql` lexicon; the template's `src/schema.ts` shows the form) and write the first migration with `npx yodel new init`. For a database that exists, do not write `src/` by hand: `npx yodel init --from <env> --force` adopts it ([Starting a project](adoption.md)). It writes one row to that environment's history, so ask the user first and run it with the credentials they give you.
6. Run `npx yodel lint` and `npm run ci:check`. Both must pass.
7. Optionally, check the migrations on a local database: `npx chant emulator up --lexicon sql` starts one in Docker, and [Your first migration](getting-started.md) has the variables. `npx yodel plan dev` and `npx yodel apply dev` against it are safe; `yodel apply` stops at the approval, and that is where the agent stops too.
8. Commit the project (with `package-lock.json`) on a new branch and open a pull request. Check `git status` so the commit holds nothing else.
9. Tell the user what is left for them, from the template's README: create each environment's reader and writer database users, add the forge's secrets, approve each plan the pull request comment shows, and merge.

## Rules for the agent

- `npx yodel <command> --help` lists each command's options and exit codes; [the commands](README.md#the-commands) says what the exit codes mean.
- Print the approve command a plan shows, and never run it. The approval is bound to that plan's digest, and it is the user's.
- Never edit a migration that is committed on the default branch: write a new one with `npx yodel new <name>`. `npx yodel lint` reports an edited one as a `checksum` error.
- Silence a lint finding (`-- yodel:allow <rule> <reason>`) only with a reason the user gives.
- Credentials go in the forge's secrets, never in a file or a commit.
