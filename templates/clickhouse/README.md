# {{chant:name}}

The ClickHouse schema of database `{{chant:database}}`, managed with SQL Yodeler (`yodel`) on chant's `sql` lexicon. Made with `chant init --from` from SQL Yodeler's ClickHouse template.

| Path | What it is |
|---|---|
| `chant.config.ts` | the dialect and one profile per environment (`dev`, `prod`): the server and the credentials, by environment variable; and `replay`, the lint job's throwaway server |
| `yodel.config.ts` | per environment: the ClickHouse topology the migrations are rendered for, and the history's database |
| `src/schema.ts` | the declared schema |
| `migrations/` | the versioned migrations, written by `yodel new` |
| `ops/migrate-<env>.op.ts` | the Op `yodel apply <env>` runs: plan, a gate bound to the plan digest, apply |
| `ops/watch-<env>.op.ts` | the drift watch, a chant `WatchOp` on a schedule |
| `scripts/ci.ts` | renders the pipelines below (`npm run ci`), and runs the lint job's replay check on your machine (`npm run replay`) |
| `scripts/local.ts` | after `just up`: says whether dev's server is the emulator, and what `.env` needs for dev on it |
| `justfile` | the routine commands as `just` targets (below) |
| `.github/workflows/`, `.forgejo/workflows/`, `.gitlab-ci.yml`, `.gitlab/` | the pipelines for GitHub Actions, Forgejo Actions and GitLab CI |

The history table and the apply lock live in database `{{chant:history_database}}`, set per environment in `yodel.config.ts` with each environment's ClickHouse topology (`single` here; a cluster is `cluster:<name>`).

## First steps

```sh
npm install                 # writes package-lock.json; commit it, CI runs npm ci
just up                     # the local database (chant's emulator); prints what .env needs for dev
just new init               # the first migration, from src/schema.ts
git init -q && git add -A && git commit -m "feat: the schema"
just plan                   # what applying to dev would do, and the plan digest
just approve                # prints the command that approves that digest: run it yourself
just apply                  # applies the approved plan to dev
```

Then create the users and the forge's secrets (below), and push. Every change after that is a pull request: edit `src/schema.ts`, run `just new <name>`, commit both.

## The targets

`just` is optional. Each target is a thin wrapper in `justfile`, and the command beside it here does the same without `just`. `[env]` defaults to `dev`. Every target reads `.env` when there is one (`.gitignore` keeps it out of git): put the variables of the environments you reach from this machine there, as `just up` prints them for dev on the emulator.

| Target | Runs |
|---|---|
| `just` | `just --list`: the targets, one line each |
| `just up` | `npx @intentius/chant emulator up --lexicon sql`, then `npx tsx scripts/local.ts`, which warns when dev's address (`127.0.0.1`) reaches another server on this machine instead of the emulator |
| `just down` | `npx @intentius/chant emulator down --lexicon sql` |
| `just new <name>` | `npx yodel new <name>` |
| `just lint` | `npx yodel lint` |
| `just replay` | `npm run replay` (see [The replay check](#the-replay-check)) |
| `just plan [env]` | `npx yodel plan <env>` |
| `just approve [env]` | prints the approve command from `npx yodel plan <env> --json`, as `npx @intentius/chant approve ...`, and `git push origin chant/lifecycle`; it never runs them |
| `just apply [env]` | `YODEL_CREDENTIALS=writer npx yodel apply <env>` |
| `just drift [env]` | `npx yodel drift <env>` |
| `just status [env]` | `npx yodel status <env>` |
| `just ci` | `npm run ci` |
| `just ci-check` | `npm run ci:check` |

If 127.0.0.1 reaches another server (a ClickHouse installed on this machine), `just up` says so; point dev at the emulator through another address of this machine in `.env`: `DEV_CLICKHOUSE_URL=http://<address>:8123`, with the address from `ipconfig getifaddr en0` on macOS.

## Credentials

Each environment has two ClickHouse users. `chant.config.ts` picks the reader unless `YODEL_CREDENTIALS=writer`, and only the apply job sets that.

| Variable | Held by |
|---|---|
| `<ENV>_CLICKHOUSE_URL` | every job for that environment |
| `<ENV>_CLICKHOUSE_READER_USER`, `<ENV>_CLICKHOUSE_READER_PASSWORD` | the plan comment and the drift watch |
| `<ENV>_CLICKHOUSE_WRITER_USER`, `<ENV>_CLICKHOUSE_WRITER_PASSWORD` | `apply-<env>`, after a merge to main, and nothing else |

`<ENV>` is `DEV` or `PROD`. The reader, for example:

```sql
CREATE USER app_reader IDENTIFIED BY '...' SETTINGS readonly = 1;
GRANT SELECT, SHOW ON {{chant:database}}.* TO app_reader;
GRANT SELECT, SHOW ON {{chant:history_database}}.* TO app_reader;
```

The writer needs to create and alter objects in both databases (`GRANT ALL ON {{chant:database}}.*`, the same on `{{chant:history_database}}.*`, and `CREATE DATABASE` for the first apply).

On your machine, put an environment's variables in `.env` (or export them) to run `just plan <env>` or `just drift <env>`; `just apply <env>` needs the writer's.

## What runs where

| When | Job | Runs | Credentials |
|---|---|---|---|
| a pull request to main | `lint` | `npm run ci:check`, `yodel lint`, and `yodel lint --replay replay --reset`: every migration replayed into a throwaway server the job starts as a service (profile `replay`) and compared with the schema it recorded | none (the service's own) |
| | `plan-<env>` | `yodel plan <env> --comment`: one comment per environment with the pending migrations and the plan digest | reader, and a forge token that can comment |
| a push to main | `apply-<env>`, in order | `yodel apply <env>` | writer |
| on each watch's schedule (and by hand) | `watch-<env>` | `chant run watch-<env>`: drift, declared against live | reader |

### Approving

`yodel apply <env>` applies only a plan someone approved. The pull request comment ends with the command:

```sh
chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:...
git push origin chant/lifecycle
```

The approval is a commit on the `chant/lifecycle` branch; every job fetches that branch. Approve before merging, and the apply after the merge goes through. A merge with nothing approved applies nothing and fails with the command to run; approve and push, then run the apply workflow again (GitHub and Forgejo: run `yodel-apply` by hand; GitLab: run a pipeline on main). If anything the digest covers changes after the approval (another migration, the live schema), the gate asks again and the comment says what moved.

### Drift

The watch reports a declared object changed out of band or gone; an object `src/` does not declare is never reported. It reads with the reader and never pushes: its snapshot stays in the job. A read-only CI token is enough.

## Setting up each forge

GitHub Actions:

- Repository secrets: the readers' variables and the URLs.
- Environments `dev` and `prod`, each limited to the `main` branch, holding that environment's URL and writer variables. Pull request jobs cannot read an environment's secrets.
- The workflows set their own token permissions: `contents: read`, and `pull-requests: write` on the pull request workflow for the comment.
- The lint job runs in a `node:22-bookworm` container and reaches its replay server by the service's name, so it needs no free port on the runner; a self-hosted runner needs Docker.

Forgejo Actions:

- Repository secrets for all of the variables. Forgejo has no environments, so each job names only its own secrets; restrict who can push to the repository, since a branch can change a workflow.
- The comment is posted with the job's own token. It needs an Actions runner with the `docker` label.

GitLab CI:

- CI/CD variables: readers not protected (merge request pipelines run on unprotected branches); writers protected and scoped to environment `dev` or `prod`, which only `apply-<env>` declares.
- `GITLAB_TOKEN`: a project access token with the `api` scope, for the plan comment (`CI_JOB_TOKEN` cannot write merge request notes).
- GitLab has no cron in the file: create one pipeline schedule per watch (Settings > CI/CD > Schedules) with the cron and the `CHANT_SCHEDULED_OP` value noted at the top of `.gitlab/yodel-watch.gitlab-ci.yml`.

### The replay check

The `replay` profile in `chant.config.ts` is not an environment: it is a throwaway server, and `--reset` drops what the history names there before replaying. In CI it is the service the lint job starts from the image chant's emulator runs.

On your machine, run `just replay` (`npm run replay`, in `scripts/ci.ts`; it needs Docker). It starts a server of its own from the same image on a free port, points `replay` at it with `REPLAY_CLICKHOUSE_URL`, runs `yodel lint --replay replay --reset`, and removes the server. Do not point `replay` at the emulator dev uses: the history names dev's database, `{{chant:database}}`, and `--reset` would drop it. Without `REPLAY_CLICKHOUSE_URL` the profile names no server (`replay.invalid`), so a plain `npx yodel lint --replay replay` reaches nothing.

Delete the profile and `npm run ci` to stop running the check.

## Adding an environment

Add its profile to `chant.config.ts` (in the order merges apply them) and its entry to `yodel.config.ts`, copy `ops/migrate-dev.op.ts` and `ops/watch-dev.op.ts` to the new name and change `dev` in them, then `just ci` (`npm run ci`). `just ci-check` (`npm run ci:check`) fails when the pipelines are stale.

## The sql-yodeler dependency

`package.json` takes `@intentius/sql-yodeler` from npm, `^0.1.0`, and `package-lock.json` pins the version `npm install` resolved. A newer sql-yodeler is `npm install @intentius/sql-yodeler@latest`; a minor release (0.2.0 after 0.1.x) needs the range changed, since `^0.1.0` stops at 0.1.x.
