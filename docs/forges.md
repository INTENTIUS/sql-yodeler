---
claims: [template, template-github, template-gitlab]
type: howto
---

# Setting up each forge

`yodel ci` (`npm run ci` in a project made from a starter template) renders the same jobs for GitHub Actions, GitLab CI and Forgejo Actions: lint and a plan comment per environment on each pull request, an apply wave per environment on a push to main, and a drift watch per environment on its schedule. Which job holds which credentials is the same on every forge ([Least privilege on each forge](configuration.md#least-privilege-on-each-forge)). What differs is where you put the secrets, which tokens the jobs use, and what the runner needs:

| | GitHub | GitLab | Forgejo |
|---|---|---|---|
| Pipeline files | `.github/workflows/yodel-pr.yml`, `yodel-apply.yml`, `watch-<env>.yml` | `.gitlab-ci.yml`, `.gitlab/yodel-apply.gitlab-ci.yml`, `.gitlab/yodel-watch.gitlab-ci.yml` | `.forgejo/workflows/yodel-pr.yml`, `yodel-apply.yml`, `watch-<env>.yml` |
| Readers' secrets | repository secrets | CI/CD variables, masked, not protected (merge request pipelines run on unprotected branches), with no environment scope | repository secrets |
| Writer's secrets | environment secrets of the environment named `<env>`, whose deployment branches are limited to `main`; only the wave job names that environment, so a pull request job cannot read them | CI/CD variables, protected, masked and scoped to the environment `<env>`; only a job on a protected branch that declares that environment gets them, and only the wave job declares it | repository secrets: Forgejo has no environments, so a workflow on any branch can name them. Limit who can push branches to those trusted to apply |
| The plan comment | the job's `GITHUB_TOKEN`, with `pull-requests: write` (the workflow grants it) | `GITLAB_TOKEN`: a project access token with the `api` scope (Reporter); `CI_JOB_TOKEN` cannot write merge request notes | the job's own token (`FORGEJO_TOKEN`, else `GITHUB_TOKEN`) |
| The drift watch | `watch-<env>.yml` on the watch's cron; the job's token with `issues: write` for the tracking issue | no cron in the file: one pipeline schedule per watch, with the cron and `CHANT_SCHEDULED_OP` noted at the top of `.gitlab/yodel-watch.gitlab-ci.yml`; `GITLAB_TOKEN` for the tracking issue | `watch-<env>.yml` on the watch's cron; the job's own token writes the tracking issue |
| Resuming after `yodel approve` | re-runs the run's failed jobs at the same commit; a fine-grained token with Actions: read and write | retries the job, and the waves after it run when it passes; a project access token with the `api` scope and the Developer role (`CI_JOB_TOKEN` cannot retry a job) | dispatches `yodel-apply.yml` again on the branch (no re-run API), so the waves before it plan again and apply nothing new; a token with `write:repository` |
| Cloud roles over OIDC | the workflow grants `id-token: write` to a job that mints a cloud password | the job declares an ID token for the cloud's audience (`AWS_ID_TOKEN`, `GCP_ID_TOKEN` or `AZURE_ID_TOKEN`) | none: Forgejo issues no OIDC token to a job, so the runner's own cloud identity mints |
| Runner requirements | `ubuntu-latest`; the lint job runs in a `node:22-bookworm` container with its replay server as a service, so a self-hosted runner needs Docker | a runner that runs `image:` and `services:` (the Docker executor, say); the jobs run in `node:22-bookworm` | an Actions runner with the `docker` label |
| Pull requests from forks | they get no secrets and a read-only token: lint runs, but the plan jobs hold no reader and post no comment | a merge request from a fork runs its pipeline in the fork's project by default, with none of this project's variables | they get no secrets |

`yodel approve` takes its token from `CHANT_FORGE_TOKEN`, else `GITHUB_TOKEN` or `GH_TOKEN` (GitHub and Forgejo), or `GITLAB_TOKEN` (GitLab), on your machine ([Approve and resume](approval.md#approve-and-resume)). With `ci: { apply: false }` ([Lint and plan on pull requests only](lint-and-plan.md)) there is no apply pipeline and no writer's secret on any forge, and the rows about the writer and resuming do not apply. A role whose password a cloud token source mints has no password variable; [Short-lived tokens](configuration.md#short-lived-tokens) has the sources, and `ci.login` for exchanging the forge's OIDC token.

## The steps on each forge

The README a starter template writes into the project has the same steps, for reading offline.

<!-- tabs: forge -->

#### GitHub

- Repository secrets: the readers' variables and the URLs (`DEV_CLICKHOUSE_URL`, `DEV_CLICKHOUSE_READER_USER`, `DEV_CLICKHOUSE_READER_PASSWORD` for `dev` on ClickHouse; `DEV_POSTGRES_...` on Postgres).
- Environments `dev` and `prod` (Settings > Environments > `<env>`), each with deployment branches limited to `main`, holding that environment's URL and writer variables. Only the wave job names the environment, so pull request jobs cannot read its secrets. Pull requests from forks get no secrets at all.
- The workflows set their own token permissions: `contents: read` and `pull-requests: write` on `yodel-pr.yml` for the comment, `issues: write` on each `watch-<env>.yml` for the tracking issue, and `contents: write` on `yodel-apply.yml`, which pushes the pending approval to `chant/lifecycle`.
- The lint job runs in a `node:22-bookworm` container and reaches its replay server by the service's name, so it needs no free port on the runner; a self-hosted runner needs Docker.

#### GitLab

- CI/CD variables (Settings > CI/CD > Variables): the readers masked and not protected, with no environment scope, since merge request pipelines run on unprotected branches; the writers protected, masked and scoped to the environment `dev` or `prod`, which only the wave job for that environment declares. `.gitlab-ci.yml` lists the variables in its header.
- `GITLAB_TOKEN`: a project access token with the `api` scope, for the plan comment and the watch's tracking issue (`CI_JOB_TOKEN` cannot write merge request notes or issues). For `yodel approve` to retry a job, the token needs the Developer role.
- GitLab has no cron in the file: create one pipeline schedule per watch (Settings > CI/CD > Schedules) with the cron and the `CHANT_SCHEDULED_OP` value noted at the top of `.gitlab/yodel-watch.gitlab-ci.yml`.

#### Forgejo

- Repository secrets for all of the variables. Forgejo has no environments, so a workflow on any branch of the repository can name the writer's: restrict who can push branches to those trusted to apply, since a branch can change a workflow, or take changes only as pull requests from forks, which get no secrets. A token source whose cloud role trusts only the runner that runs `main` closes the rest.
- The comment and the tracking issue are posted with the job's own token.
- The jobs need an Actions runner with the `docker` label.

<!-- /tabs -->
