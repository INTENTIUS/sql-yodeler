---
claims: [forgejo, github, gitlab]
type: howto
---

# Lint and plan on pull requests only

This page is for a team that wants SQL Yodeler to review migrations in pull requests before it lets SQL Yodeler apply anything. Every pull request gets `yodel lint`, the replay check and a plan comment per environment, and the migrations are applied some other way for now: from a terminal with `yodel apply`, or with the process the team already has. CI holds read-only credentials only, and no job in it can write to a database.

## Setting it up

1. Make the project. [Starting a project](adoption.md) covers both ways in: a new project from a starter template, or `yodel init --from <env>` for a database that already exists.

2. Turn the apply pipeline off in `yodel.config.ts`:

   ```ts
   // yodel.config.ts
   export default defineConfig({
     // ...
     ci: { forges: ["github", "gitlab", "forgejo"], apply: false },
   });
   ```

   `apply: false` cannot be combined with a wave whose `approval` is `pr-review` or with `ci.resume`, since both run in the apply pipeline. `yodel ci` refuses either combination and names the setting to remove.

3. Render the pipelines with `npm run ci` (which runs `yodel ci`). With `apply: false` it writes `yodel-pr` and a `watch-<env>` per environment on each forge, and no `yodel-waves.json`, no `yodel-apply` or `yodel-apply-plans` workflow, and no `.gitlab/yodel-apply.gitlab-ci.yml`; `.gitlab-ci.yml` has no apply stages and does not include that file. A project made from a template already has those files: `yodel ci` does not delete them, so delete them yourself and commit the result. `yodel ci --check` then passes, because it no longer expects them.

4. Add only the readers' secrets on the forge: for each environment, its URL and its reader (`DEV_CLICKHOUSE_URL`, `DEV_CLICKHOUSE_READER_USER`, `DEV_CLICKHOUSE_READER_PASSWORD` for `dev` on ClickHouse, `DEV_POSTGRES_...` on Postgres), and on GitLab `GITLAB_TOKEN`, a project access token with the `api` scope (Reporter) for the plan comment and the drift watch's issue. Where each one goes on each forge is in [Setting up each forge](forges.md). No writer's secret is needed.

5. Open a pull request with a migration and read the plan comment: the pending migrations for each environment, what they would run, and the digest an approval would be bound to. [The pull request comment](approval.md#the-pull-request-comment) shows one.

## What runs

On each pull request, every job with readers or with no database credentials at all:

- `lint`: `yodel ci --check`, `yodel lint`, and the replay check, which replays every migration into a throwaway server the job starts. It holds no database credentials.
- `plan-<env>`: `yodel config check <env> --write-probe`, which tries a write and fails the job if the server allows it, then `yodel plan <env> --comment`. It holds the environment's reader, and the reader of the environment before it in the waves (`waves[].requires`), so the plan can show where each migration has run.

On its schedule, `watch-<env>` compares the server with the declared schema and keeps a tracking issue open while it finds drift ([Drift](drift.md)). It holds the environment's reader.

Applying is left to you. `YODEL_CREDENTIALS=writer yodel apply <env>` from a machine that holds the writer applies behind the same approval as the pipeline would ([Approving](approval.md#approving)), and records each migration in the history the plan comment and the watch read.

## Turning apply on later

1. Remove `apply: false` from `ci` in `yodel.config.ts`.
2. Run `npm run ci` and commit what it writes: `yodel-waves.json` and the apply pipeline on each forge.
3. Add the writers' secrets where [Setting up each forge](forges.md) says, so that only each environment's wave job can read them.

The next push to main runs the apply waves, each waiting for its approval. [Approval](approval.md) covers the gates and the waves.
