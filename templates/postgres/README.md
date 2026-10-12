# {{chant:name}}

The Postgres schema `{{chant:schema}}`, managed with SQL Yodeler (`yodel`) on chant's `sql` lexicon. Made with `yodel create` from SQL Yodeler's Postgres template.

| Path | What it is |
|---|---|
| `chant.config.ts` | the dialect and one profile per environment (`dev`, `prod`): the database URL and the credentials, by environment variable; and `replay`, the lint job's throwaway server |
| `yodel.config.ts` | the apply pipeline's waves; `ci`, the forges `yodel ci` renders pipelines for and the project's own jobs; per environment: the schema yodel's history table lives in |
| `src/schema.ts` | the declared schema |
| `migrations/` | the versioned migrations, written by `yodel new` |
| `ops/migrate-<env>.op.ts` | the Op `yodel apply <env>` runs: plan, a gate bound to the plan digest, apply |
| `ops/watch-<env>.op.ts` | the drift watch, a chant `WatchOp` on a schedule |
| `scripts/local.ts` | after `just up`: says whether dev's server is the emulator, makes the read-only user `reader` on it, and prints what `.env` needs for dev on it (`reader` as dev's reader, the emulator's admin user as its writer) |
| `justfile` | the routine commands as `just` targets (below) |
| `.github/workflows/`, `.forgejo/workflows/`, `.gitlab-ci.yml`, `.gitlab/` | the pipelines for GitHub Actions, Forgejo Actions and GitLab CI, rendered by `yodel ci` (`npm run ci`) from the files above; `yodel ci --check` (`npm run ci:check`) fails when one is stale |

The history table lives in schema `{{chant:history_schema}}`, set per environment in `yodel.config.ts`. The apply lock is a Postgres advisory lock, so it needs no table.

## First steps

```sh
npm install                 # writes package-lock.json; commit it, CI runs npm ci
just up                     # the local database (yodel emulator up); prints what .env needs for dev
just new init               # the first migration, from src/schema.ts
git init -q && git add -A && git commit -m "feat: the schema"
just plan                   # what applying to dev would do, and the plan digest
just approve                # prints the command that approves that digest: run it yourself
just apply                  # applies the approved plan to dev
```

Then create the users and the forge's secrets (below), and push. Every change after that is a pull request: edit `src/schema.ts`, run `just new <name>`, commit both.

### When schema `{{chant:schema}}` already exists

To adopt a database that already holds the schema (one another migration tool managed, or one made by hand), run `yodel init` in place of `just new init`, as the environment's writer, since it writes the baseline's row to the history:

```sh
YODEL_CREDENTIALS=writer npx yodel init --from <env> --force
```

`--force` lets it write over the placeholder `src/schema.ts` with the declarations it reads from the database. It writes the baseline migration and records it applied in that environment without running it. Coming from another tool, move its migration files out of `migrations/` first. [Coming from another migration tool](https://intentius.io/sql-yodeler/from-other-tools/) in the SQL Yodeler docs covers the rest: the other tool's history table, the other environments, and rollback.

## The targets

`just` is optional. Each target is a thin wrapper in `justfile`, and the command beside it here does the same without `just`. `[env]` defaults to `dev`. Every target reads `.env` when there is one (`.gitignore` keeps it out of git): put the variables of the environments you reach from this machine there, as `just up` prints them for dev on the emulator.

| Target | Runs |
|---|---|
| `just` | `just --list`: the targets, one line each |
| `just up` | `npx yodel emulator up`, then `npx tsx scripts/local.ts`, which warns when dev's address (`127.0.0.1`) reaches another server on this machine instead of the emulator, and on the emulator makes the read-only user `reader` that dev reads with (yodel refuses one user as both reader and writer) |
| `just down` | `npx yodel emulator down` |
| `just new <name>` | `npx yodel new <name>` |
| `just lint` | `npx yodel lint` |
| `just replay` | `npm run replay`, which is `yodel ci --replay` (see [The replay check](#the-replay-check)) |
| `just plan [env]` | `npx yodel plan <env>` |
| `just approve [env]` | prints the approve command from `npx yodel plan <env> --json`, `npx yodel approve <env> --plan <digest>`, for you to run at a terminal; it never runs it |
| `just apply [env]` | `YODEL_CREDENTIALS=writer npx yodel apply <env>` |
| `just drift [env]` | `npx yodel drift <env>` |
| `just status [env]` | `npx yodel status <env>` |
| `just ci` | `npm run ci`, which is `yodel ci` |
| `just ci-check` | `npm run ci:check`, which is `yodel ci --check` |

If 127.0.0.1 reaches another server (a Postgres installed on this machine), `just up` says so; point dev at the emulator through another address of this machine in `.env`: `DEV_POSTGRES_URL=postgres://<address>:5432/postgres`, with the address from `ipconfig getifaddr en0` on macOS.

## Credentials

Each environment has two Postgres roles. `chant.config.ts` picks the reader unless `YODEL_CREDENTIALS=writer` (every environment) or `writer:<env>` (that one), and only an environment's wave job sets that, for its own environment.

`credentials()` in `chant.config.ts` gives each profile both. yodel refuses the project (exit 4) when an environment's reader and writer are the same user or read the same variable, and every pull request plan job runs `yodel config check <env> --write-probe` first, which fails the job when its credentials can write. A password can be a short-lived token instead of a variable (`{ token: "rds-iam" }` and the others in SQL Yodeler's configuration docs); `npm run ci` then leaves its secret out of the jobs and renders the OIDC grant the token needs.

| Variable | Held by |
|---|---|
| `<ENV>_POSTGRES_URL` | every job for that environment, e.g. `postgres://db.example.com:5432/app` |
| `<ENV>_POSTGRES_READER_USER`, `<ENV>_POSTGRES_READER_PASSWORD` | the plan comment and the drift watch, and the next wave's jobs, which read this environment's history before they apply |
| `<ENV>_POSTGRES_WRITER_USER`, `<ENV>_POSTGRES_WRITER_PASSWORD` | the environment's wave job, after a merge to main, and nothing else |

`<ENV>` is `DEV` or `PROD`. The roles, for example, where the writer creates both schemas on the first apply:

```sql
CREATE ROLE app_writer LOGIN PASSWORD '...';
GRANT CREATE ON DATABASE app TO app_writer;

CREATE ROLE app_reader LOGIN PASSWORD '...';
ALTER ROLE app_reader SET default_transaction_read_only = on;
-- Whatever the writer creates, the reader can see and read.
ALTER DEFAULT PRIVILEGES FOR ROLE app_writer GRANT USAGE ON SCHEMAS TO app_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE app_writer GRANT SELECT ON TABLES TO app_reader;
```

On your machine, put an environment's variables in `.env` (or export them) to run `just plan <env>` or `just drift <env>`; `just apply <env>` needs the writer's.

## What runs where

| When | Job | Runs | Credentials |
|---|---|---|---|
| a pull request to main | `lint` | `npm run ci:check`, `yodel lint`, and `yodel lint --replay replay --reset`: every migration replayed into a throwaway server the job starts as a service (profile `replay`) and compared with the schema it recorded | none (the service's own) |
| | `plan-<env>` | `yodel plan <env> --comment`: one comment per environment with the pending migrations and the plan digest | reader, and a forge token that can comment |
| a push to main | `wave-<k>-<env>`, one per wave of `yodel.config.ts` `waves`, each needing the one before | `chant run wave`: `yodel apply <env> --wave-plan`, the wave's gate, `yodel apply <env> --wave-apply` | writer |
| on each watch's schedule (and by hand) | `watch-<env>` | `chant run watch-<env>`, then `yodel drift <env> --issue`: drift against the newest applied migration, and the environment's tracking issue | reader |

Each plan and wave job also runs `yodel report <env>` (JSON and the HTML run view) into `yodel-report/`, whatever the job's outcome, and keeps it as the job's artifact (`yodel-report-<job>`). The wave, plan and watch jobs pass `YODEL_WEBHOOK_URL` and `YODEL_WEBHOOK_KEY` from the forge's secrets for webhook events (`notify` in `yodel.config.ts`); while they are unset, yodel sends nothing.

### Approving

Each environment is a wave of the apply pipeline, with a gate policy in `yodel.config.ts`: `always` (the default) waits for an approval whenever there is a migration to apply, `on-destructive` only when a pending step drops something, rewrites or locks a table, rebuilds, or is an Op or manual step, and `never` never waits. The pipeline reads the gate from the commit before the push, so a pull request cannot loosen its own. When the wave will wait, the pull request comment ends with the command:

```sh
npx yodel approve dev --plan jcs1-sha256:...
```

Run it at a terminal: it shows the plan, asks you to type the environment's name, records the approval as a commit on the `chant/lifecycle` branch and pushes it (every job fetches that branch), and starts a job that waits at the gate again. Approve before merging, and the wave after the merge goes through. A wave with nothing approved applies nothing, prints the command, and fails, and the waves after it do not run; `yodel approve` records the approval and starts the failed job again. A wave applies only migrations the wave before it has applied: `yodel apply <env>` reads that environment's history and refuses (exit 4, nothing applied) a migration it does not record, so approve prod's wave once dev has run it. If anything the digest covers changes after the approval (another migration, the live schema), the gate asks again and the comment says what moved.

### Drift

The watch reports a declared object changed out of band or gone; an object `src/` does not declare is never reported. It compares the server with the schema the newest applied migration records, so a migration merged but waiting at its gate is not drift. It keeps one issue per environment: opened when drift is found, updated while the drift changes, closed when it is gone; a run that cannot read a declared object leaves the issue as it is. It reads with the reader and never pushes: its snapshot stays in the job. Its token writes only issues (GitHub: `issues: write`; GitLab: `GITLAB_TOKEN`).

## Setting up each forge

The same steps, with every forge side by side, are at https://intentius.io/sql-yodeler/forges/.

GitHub Actions:

- Repository secrets: the readers' variables and the URLs.
- Environments `dev` and `prod`, each limited to the `main` branch, holding that environment's URL and writer variables. Pull request jobs cannot read an environment's secrets.
- The workflows set their own token permissions: `contents: read`, and `pull-requests: write` on the pull request workflow for the comment.
- The lint job runs in a `node:22-bookworm` container and reaches its replay server by the service's name, so it needs no free port on the runner; a self-hosted runner needs Docker.

Forgejo Actions:

- Repository secrets for all of the variables. Forgejo has no environments, so each job names only its own secrets; restrict who can push to the repository, since a branch can change a workflow.
- The comment is posted with the job's own token. It needs an Actions runner with the `docker` label.

GitLab CI:

- CI/CD variables: readers not protected (merge request pipelines run on unprotected branches); writers protected and scoped to environment `dev` or `prod`, which only the wave job for that environment declares.
- `GITLAB_TOKEN`: a project access token with the `api` scope, for the plan comment and the watch's tracking issue (`CI_JOB_TOKEN` cannot write merge request notes or issues).
- GitLab has no cron in the file: create one pipeline schedule per watch (Settings > CI/CD > Schedules) with the cron and the `CHANT_SCHEDULED_OP` value noted at the top of `.gitlab/yodel-watch.gitlab-ci.yml`.

### The replay check

The `replay` profile in `chant.config.ts` is not an environment: it is a throwaway server, and `--reset` drops what the history names there before replaying. In CI it is the service the lint job starts from the image chant's emulator runs.

On your machine, run `just replay` (`npm run replay`, which is `yodel ci --replay`; it needs Docker). It starts a server of its own from the same image on a free port, points `replay` at it with `REPLAY_POSTGRES_URL`, runs `yodel lint --replay replay --reset`, and removes the server. Do not point `replay` at the emulator dev uses: the history names dev's schema, `{{chant:schema}}`, and `--reset` would drop it. Without `REPLAY_POSTGRES_URL` the profile names no server (`replay.invalid`), so a plain `npx yodel lint --replay replay` reaches nothing.

Delete the profile and `npm run ci` to stop running the check.

## Adding an environment

Add its profile to `chant.config.ts`, its entry to `yodel.config.ts` `environments` and its wave to `waves` (in the order merges apply them), copy `ops/migrate-dev.op.ts` and `ops/watch-dev.op.ts` to the new name and change `dev` in them, then `just ci` (`npm run ci`). `just ci-check` (`npm run ci:check`) fails when the pipelines are stale.

## The sql-yodeler dependency

`package.json` takes `@intentius/sql-yodeler` from npm, `^0.8.0`, and `package-lock.json` pins the version `npm install` resolved. A newer sql-yodeler is `npm install @intentius/sql-yodeler@latest`; a minor release (0.9.0 after 0.8.x) needs the range changed, since `^0.8.0` stops at 0.8.x.
