---
claims: [approval, waves]
type: concepts
---

# Approval

`yodel apply` applies only a plan someone approved, on both paths. The approval is chant's (the [Glossary](glossary.md) has the terms): a gate in an Op, bound to a plan digest, resolved by a person with `yodel approve` (chant's `approve` underneath), and kept on the `chant/lifecycle` branch of the project's git repository. yodel keeps no approval store of its own. The output quoted here is from the examples' runs; `...` marks lines left out. The runs were recorded before yodel printed `yodel approve` in its messages: where they show `chant approve ...`, yodel now prints `npx yodel approve <env> --plan <digest>`, which records the same approval, and the runs approve with chant's command because they had no terminal to ask.

## The migrations Op

On the versioned path, `yodel apply <env>` runs the project's migrations Op for the environment with `chant run`. It is an ordinary chant Op with three phases, which the starter templates and the examples declare in `ops/migrate-<env>.op.ts`:

<!-- quote: clickhouse#migrations-op -->
```ts
import { Op, phase, gate, shell, stepOutput } from "@intentius/chant/op";

// yodel apply dev runs this Op when migrations are pending. The gate is bound
// to the plan digest (the pending migrations' checksums, the topology, the
// history and the live schema), so an approval given for one state never
// applies another.
const plan = shell("yodel apply dev --digest", { id: "plan" });
const digest = stepOutput(plan, "stdout");

export const op = Op({
  name: "migrate-dev",
  overview: "Apply the pending migrations to dev, behind an approval bound to their plan digest",
  phases: [
    phase("Plan", [plan]),
    phase("Approve", [gate("approve-migrate-dev", { plan: digest })]),
    phase("Apply", [shell("yodel apply dev --execute", { env: { YODEL_APPROVED_PLAN: digest }, timeout: "2h" })]),
  ],
});
```

- Plan: `yodel apply dev --digest` prints the plan digest.
- Approve: a gate bound to that output. A resolution counts only for that digest.
- Apply: `yodel apply dev --execute`, given the approved digest in `YODEL_APPROVED_PLAN`, takes the lock, computes the digest again, refuses if it moved, and applies.

The digest is checked twice: by the gate on every run, against the approval, and by the Apply step under the lock, against the digest the gate passed, so a change between the two (another runner applying first, a table altered out of band) refuses too.

`yodel apply` finds the Op by its shape, whatever its name. When there is none it prints this declaration to add; when more than one applies the environment, `--op <name>` picks one; an Op whose gate is not bound to the Plan step's output is refused. `chant run migrate-dev` run directly (as CI may) needs `yodel` on `PATH`; `yodel apply` puts itself there for the Op it runs. The declarative path's `ApplyOp` carries its own plan-bound gate ([The two workflows](workflows.md)).

## The plan digest

On the versioned path the digest covers what the run would do and the state it would start from:

- the migrations it would apply, in order, each with its files' checksum and the statements of it that already succeeded (a migration that failed part way resumes);
- the history it starts from: every applied migration and its checksum;
- the topology the statements are rendered for;
- the live schema: a fingerprint of the server's catalog in the environment's databases or schemas. The history's own database is left out, so recording a run does not move the digest.

It is chant's plan digest (`jcs1-sha256:...`), the one the gate binds. `yodel plan <env>` prints it with the command that approves it, `npx yodel approve <env> --plan <digest>`:

<!-- quote: clickhouse#plan -->
```console
$ npx yodel plan dev
Plan for dev (clickhouse 26.8.15.10 at 127.0.0.1:8123, history yodeler.history (single (default))): 1 applied, 1 pending

20261010T1722-add-country
  0  statement  SQLCH201 metadata  shop.events
       ALTER TABLE `shop`.`events` ADD COLUMN country LowCardinality(String) DEFAULT '' AFTER `at`

Plan digest: jcs1-sha256:c6a49076c4a2b58c984b7a73d59e86c5788e82cb89728c5ec24307869e72bd03
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:c6a49076c4a2b58c984b7a73d59e86c5788e82cb89728c5ec24307869e72bd03
or, at a terminal, with npx yodel approve dev, which shows the plan and asks you first.

Not approved yet. Approving binds exactly this digest; if anything it covers changes before the apply runs, the gate asks again and nothing is applied.
```

`yodel status <env>` prints it too, and `yodel apply <env> --plan` prints the pending migrations and the digest without applying.

## Approving

Run the command the plan printed, at a terminal: `npx yodel approve dev --plan <digest>` shows the plan, asks you to type `dev`, and records the approval ([Approve and resume](#approve-and-resume)). The run below, with no terminal to ask, recorded the same approval with chant's command:

<!-- quote: clickhouse#approve -->
```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:c6a49076c4a2b58c984b7a73d59e86c5788e82cb89728c5ec24307869e72bd03
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-10T17:22:18.586Z
This approves the plan jcs1-sha256:c6a49076c4a2b58c984b7a73d59e86c5788e82cb89728c5ec24307869e72bd03, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

The approval is a commit on the local `chant/lifecycle` branch. chant pushes it to the remote's `chant/lifecycle` when the repository has a remote, so CI sees it: every job in the starter templates fetches that branch first. In the templates, the pull request comment ends with the approve command; approve before merging, and the apply job after the merge goes through. A merge with nothing approved applies nothing and fails with the command to run; [`yodel approve`](#approve-and-resume) records the approval and starts that job again.

Then `yodel apply` runs through the gate:

<!-- quote: clickhouse#apply -->
```console
$ npx yodel apply dev
...
Running migrate-dev (<tmp>/clickhouse/ops/migrate-dev.op.ts)
lock: no KeeperMap on this server (KeeperMap is disabled because 'keeper_map_path_prefix' config is not defined. (BAD_ARGUMENTS) (version 26.8.15.10 (official build))); the lock is a file on this machine, so cross-runner locking needs Keeper (and keeper_map_path_prefix)
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:c6a49076c4a2b58c984b7a73d59e86c5788e82cb89728c5ec24307869e72bd03, by yodel at 2026-10-10T17:22:18.586Z
20261010T1722-add-country: applying
  statement 0: ok (SQLCH201 metadata, shop.events)
20261010T1722-add-country: applied
...
```

### Approve and resume

`yodel approve <env>` approves at the terminal without the Op and gate names or the digest. It shows the pending migrations (each statement's class, and any destructive step) and the plan digest, asks you to type the environment's name, and records the same approval `chant approve` gives, bound to the same digest. Then it starts the CI job that waits at the gate again, so the apply goes on without a new push:

```sh
npx yodel approve prod
```

That one command is the loop: the waiting job printed the gate and the digest, `yodel approve` records the approval, chant pushes `chant/lifecycle`, and calls the forge to start the job again. It runs `chant approve <op> <gate> --plan <digest> --resume`, and chant finds the job from the pending record it wrote at the gate:

| Forge | What chant calls | The token it needs, at least |
|---|---|---|
| GitHub | re-runs the run's failed jobs (`POST /repos/{repo}/actions/runs/{run}/rerun-failed-jobs`), at the same commit | a fine-grained token with Actions: read and write on the repository |
| GitLab | retries the job (`POST /projects/{id}/jobs/{job}/retry`); the waves after it run when it passes | a project access token with the `api` scope and the Developer role (`CI_JOB_TOKEN` cannot retry a job) |
| Forgejo | dispatches `yodel-apply.yml` again on the branch (Forgejo has no re-run API), so the waves before it plan again and apply nothing new | a token with the `write:repository` scope |

The token comes from `CHANT_FORGE_TOKEN`, else `GITHUB_TOKEN` or `GH_TOKEN` (GitHub and Forgejo), or `GITLAB_TOKEN` (GitLab). The push of `chant/lifecycle` needs your usual git access to the repository.

- `--plan <digest>` names the digest you mean to approve, the one in the pull request comment or the waiting job's log. When it is not the plan that waits, nothing is approved, and yodel names the digest that waits.
- `--no-resume` records the approval and starts nothing. Push `chant/lifecycle` and run the job again yourself, or leave it to the [scheduled resume job](#the-scheduled-resume-job).
- When the approval is recorded but no job was started (no token, a token the forge refused, a push that did not land), chant says why and `yodel approve` exits 3. Once that is fixed, run the job again, or leave it to the [scheduled resume job](#the-scheduled-resume-job).
- When no CI job waits (the gate was reached by `yodel apply` on your machine), there is nothing to resume; run `yodel apply <env>`. In a repository with no remote, `yodel approve` records the approval and resumes nothing.

It never approves without a person at the terminal: with no terminal to ask (a script, CI, a coding agent) it approves nothing and exits 4, and no flag skips the question. A script that records approvals itself takes chant's command from the `--json` output's `chantApprove` field.

### The scheduled resume job

An approval recorded with `--no-resume`, by a script with `chantApprove`, or one whose resume failed, leaves the job waiting. `yodel.config.ts` `ci.resume` adds a job that starts it on a schedule:

```ts
ci: { forges: ["github", "gitlab", "forgejo"], resume: { schedule: "*/10 * * * *" } },
```

`npm run ci` then renders `yodel-apply-resume`, which runs `chant run resume --op yodel-apply`: every apply wave that waits at its gate and whose approval has arrived since is started again, the way `yodel approve` starts it. It approves nothing, and it skips a run that is still going, passed, or was already started again, so it can run every few minutes.

- GitHub: `.github/workflows/yodel-apply-resume.yml`, with the job's own token and `actions: write`.
- Forgejo: `.forgejo/workflows/yodel-apply-resume.yml`, with the `CHANT_FORGE_TOKEN` secret, a token with `write:repository` (the job's own token cannot dispatch a workflow).
- GitLab: a `yodel-apply-resume` job that runs in scheduled pipelines only. Create a pipeline schedule with the cron (Settings > CI/CD > Schedules); `GITLAB_TOKEN` needs the `api` scope and the Developer role.

## Waves: a gate per environment

In SQL Yodeler a wave is one environment (for a tenant set, one environment over many databases or schemas); terragucci uses the word for a batch of Terraform roots applied behind one approval. The starter templates' apply pipeline is a list of waves, one per environment, in the order `yodel.config.ts` gives them. Each wave has its own gate policy:

```ts
waves: [
  { env: "dev", gate: "never" },
  { env: "staging", gate: "on-destructive" },
  { env: "prod", gate: "always" },
],
```

| `gate` | The wave waits for an approval when |
|---|---|
| `always` (the default) | it has a migration to apply |
| `on-destructive` | a pending step drops something, is a Postgres rewrite or lock-heavy statement (lint's `destructive`, `pg-rewrite`, `pg-lock`), a ClickHouse mutation or rebuild (`ch-mutation`, `ch-rebuild`), takes access away (`pg-access`, `ch-access`), or is an Op or manual step |
| `never` | never; review and branch protection are all that stand in front of it |

terragucci's `on-destroy` is the same rule; SQL Yodeler and chant spell it `on-destructive`, and SQL Yodeler refuses `on-destroy` ([terragucci's gate policies](https://intentius.io/terragucci/reference/stages/#gate-policy)).

`npm run ci` renders the waves as `yodel-waves.json`, a chant Op waves spec, and the `yodel-apply` pipeline from it on GitHub, GitLab and Forgejo: one job per wave, each needing the one before. Every job runs `chant run wave`, which:

1. plans the environment with `yodel apply <env> --wave-plan <file>`: the migrations' plan digest, the gate policy, and whether a pending step is destructive, all in one digest;
2. reads the wave's gate policy from `yodel-waves.json` as the commit before the push has it, and decides. A wave that needs an approval applies nothing, prints the command that approves it, `npx yodel approve <env> --plan <digest>`, and exits 3, so the waves after it do not run;
3. applies with `yodel apply <env> --wave-apply <file>`, which takes the lock, plans again, and applies only when the plan is still the one the wave decided on and the decision holds: an approval of the wave's digest in the gate ledger, or a policy at the base commit that needs none.

To let a waiting wave through, run `yodel approve <env>` at a terminal: it approves the wave and starts its job again ([Approve and resume](#approve-and-resume)). With `--no-resume`, push `chant/lifecycle` and re-run the failed job (on GitLab, retry it). In a project whose `yodel.config.ts` `waves` names the environment, `yodel approve` approves the wave's gate, `yodel-apply-wave-<k>`, for the wave's set digest, which is what the job waits on, not the migrations Op's gate. It plans the wave as the job does (the plan, the gate policy at the base commit, what the environments before it applied), shows it, and asks you to type the environment's name. A wave whose policy needs no approval for the plan has nothing to approve, and one an earlier environment has not caught up with is refused until it has.

The policy comes from the base commit, the first parent of the commit being applied, never from the change. A pull request that sets prod's gate to `never` merges, and prod still waits under the gate main had. Only the gate is read there: the waves, their order and the migrations come from the commit being applied. yodel reads its own config at the base the same way: `YODEL_BASE` names another commit, and on a pull request it is the merge base with the target branch.

### Promotion: what the wave before has applied

A wave applies only migrations the environment before it has applied. `waves[].requires` names that environment; it defaults to the wave before, and `requires: false` turns it off. Before anything is asked or applied, `yodel apply <env>` (in a wave job, run by hand, or the migrations Op's Apply step) reads the required environment's history with that environment's own profile, which outside its own wave job is its reader, and refuses any pending migration the history does not record as applied with the checksum its files have now. It exits 4 and applies nothing, with a message like this one:

```text
yodel apply: refused: prod applies only migrations staging applied first, and 1 pending one has not run there:
  20261010T0644-add-promo: staging's history does not record it applied (required by yodel.config.ts and yodel.config.ts at aa556870d420)
Nothing was applied. Apply it to staging first.
```

The requirement is read from the working tree's `yodel.config.ts` and from the base commit's, and both hold, so a change that drops its own requirement is still held to the base's. A re-run of prod's job, a manual `yodel apply prod`, or a staging wave someone skipped all stop here. The wave plan's digest covers the requirement and which pending migrations the required history records, so prod's approval is of a plan staging has already run: approve prod's wave after staging applied.

`yodel plan <env>` and the pull request comment list, for each pending migration, whether the required environment has run it. The templates give each plan job and each wave job the required environment's reader for that.

### Tenant sets: one wave over many databases or schemas

A product with a database or schema per tenant applies the same migrations to every one of them. `environments.<env>.tenants` in `yodel.config.ts` makes the environment a tenant set:

```ts
environments: {
  prod: { tenants: ["acme", "globex", "initech"] },
  // or { file: "tenants.txt" }, one name per line or a JSON array,
  // or { query: "SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'tenant_%'" }
},
waves: [
  { env: "staging", gate: "on-destructive" },
  { env: "prod", gate: "always", shares: 4 },
],
```

The profile in `chant.config.ts` names one database (ClickHouse `databases`) or schema (Postgres `schemas`): the template the declared schema and the migrations are written against. A tenant is named `<env>/<tenant>`, as in `yodel apply prod/acme`, and is the environment's profile on the tenant's database or schema. Each statement and each pre-migration check is sent with the template's name replaced by the tenant's, wherever it stands alone as an identifier, quoted or not. An Op step runs on each tenant too: a backfill's `yodelSql` statements are renamed the same way, and a rebuild or a `PostgresMigrationOp` runs on the tenant's table, with the template renamed in its options and in the migration's recorded schema. Each tenant keeps its own history, `<history database>_<tenant>`, its own lock, and its own backfill receipts. `yodel apply prod` without a tenant refuses.

`yodel ci` renders the tenant set's wave with a run per tenant of a list or a file. A set given by a query is read when the wave runs, not when the pipeline is rendered: its wave is one run, or one per share (`prod/@1of4` to `prod/@4of4`), and each run plans every tenant the query lists at that moment whose name hashes to it. A tenant added since the pipeline was rendered is in the next run of the wave, and the rendered files do not change. The wave plans every tenant and gates once, on one approval of the set digest over every tenant's plan, which the deciding job prints. With `shares`, the wave is a deciding job and that many share jobs, each applying a slice of the tenants (for a list or a file, sorted by name). A share job plans its slice again, and a tenant whose plan moved since the decision (someone changed its schema, or a migration landed) is not applied: the job names it and exits 4, and applies the rest. For a set read by a query, a share whose tenants changed (a tenant added or gone, or a plan that moved) is not applied at all, and the job exits 4. Run the wave again to decide over the plan as it is now.

A tenant requires what its environment requires: the same tenant when the environment before is a tenant set too, else that environment.

`yodel plan prod` plans every tenant against its own history and shows them as one plan: the tenants with the same migrations pending once, as a group, then the wave and its approval. `--comment` posts it as one comment for the set, updated on the next push. `yodel approve prod` plans every tenant as the deciding job does, shows what is pending on each group, asks you to type `prod`, and approves the wave's set digest, then starts the waiting job again. `yodel approve prod/acme` approves one tenant's plan for `yodel apply prod/acme`, outside the pipeline.

`yodel status prod` lists every tenant against its own history, then how many are up to date (exit 3 while any is behind), and `yodel report prod` shows a column per tenant.

### Steps around apply: checks before and after

Checks a runbook asks for before a migration (replication lag, long transactions, disk headroom) and smoke queries after go in `environments.<env>.steps`:

```ts
environments: {
  prod: {
    steps: {
      before: [
        { name: "no-long-transactions", sql: "SELECT pid FROM pg_stat_activity WHERE xact_start < now() - interval '5 minutes'", onFailure: "approve" },
        { name: "disk", command: "./scripts/disk-headroom.sh" },
      ],
      after: [{ name: "smoke", sql: "SELECT count(*) FROM app.orders", expect: { min: 1 } }],
    },
  },
},
```

A `sql` step is a read-only query on the environment's server, judged like a migration's pre-migration check: `expect` is `empty` (the default, no rows), `true`, or `{ min, max }`. A `command` step runs with `sh -c` in the project directory, with `YODEL_ENV` and `YODEL_STEP` (`before` or `after`) set, and passes when it exits 0.

The steps are read from `yodel.config.ts` at the base commit, like the policy, so a pull request cannot add a step that runs with the writer's credentials, or remove one that would hold it. They run only when something is pending:

- `before` steps run under the lock just before the first migration. A SQL check also runs when the wave is planned (`--wave-plan`), and in the migrations Op's path `yodel apply <env>` runs it before the gate. A command runs once per apply, under the lock: it may have side effects (a notification, a snapshot), so planning only shows that it will run. In a wave it runs once the wave may apply, after the SQL checks. A failing step refuses the run, exit 4, nothing applied.
- With `onFailure: "approve"`, a failing `before` step holds the wave for a person instead, whatever its gate: the wave plan's digest names the held steps, `on-destructive` waits on it, and under `never` the wave job applies nothing and exits 3 with the command that approves the wave's digest, `yodel approve <env> --plan <digest>`. Once someone approves that plan, the job run again applies it. If the step passes by then, the plan has moved and the wave decides again. A command's failure is only known under the lock, so it is not in the plan's digest: the job stops there the same way, and the command runs again on the approved run, its failure let through.
- `after` steps run under the lock once the last migration's statements succeeded. A failing one fails the run, exit 1; the migrations stay applied.

Every outcome is in the history: the `before` steps on each migration's `started` row, the `after` steps on the last migration's `succeeded` row (`note.steps`). `yodel report` lists them as `step` entries in the audit log.

## Approval modes: which approvals count

Anyone who can push to `chant/lifecycle` can record an approval, in any name. That is enough for dev. For an environment where it is not, a wave's `approval` says which approvals of its digest count:

```ts
waves: [
  { env: "dev", gate: "never" },
  { env: "staging", gate: "always", approval: "pr-review" },
  { env: "prod", gate: "always", approval: "sealed" },
],
```

| `approval` | What counts |
|---|---|
| `ledger` (the default) | any approval of the digest (`yodel approve`), as above |
| `pr-review` | an approving review of the merged pull request's head by a writer other than its author, when that head planned this digest; a `yodel approve` of the digest counts too |
| `sealed` | only an approval sealed with an ssh key (`yodel approve --sign`) that the signers file at the base commit lists for the approver |

The mode is read at the base commit with the gate, so a pull request that switches prod from `sealed` to `ledger` merges, and prod still counts only sealed approvals. `yodel ci` writes it into `yodel-waves.json`, where `chant run wave` reads it, and `yodel apply --wave-apply` checks it again under the lock. chant documents the modes in [Which approvals count](https://intentius.io/chant/guide/op-waves/#which-approvals-count). `yodel plan` and the pull request comment name the mode of a wave that waits, and a sealed wave's approve command ends in `--sign`. The history records how each wave was approved: the mode, and the review (pull request, head, approvers) or the signer, on the wave's `note.wave`.

The migrations Op's gate, which `yodel apply <env>` goes through outside the waves, takes `environments.<env>.approval`, `ledger` or `sealed`, also read at the base commit. Without it, the environment takes `sealed` when its wave is sealed, else `ledger`. chant's gate step does not know the mode, so it may pass an unsealed approval, but the Apply step (`yodel apply --execute`) refuses it, exit 3, nothing applied, and says why. `pr-review` is a wave's only: the review approves the plans the pull request's pipeline records for the waves.

### Sealed approvals

The signers file is `.chant/allowed_signers` at the root of the repository (or the path `.chant/trust.json` names), in ssh-keygen's allowed signers format: a principal and a public key per line.

```text
alice ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI...
bob ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI...
```

It is read at the base commit, never from the change being applied, so a key that a pull request adds to the file cannot approve that pull request's own plan: it counts for the changes merged after it. Changing the file is a change like any other, reviewed and merged. With no signers file at the base, no approval of a sealed gate counts. [chant workspace signers](https://intentius.io/chant/cli/workspace-signers/) documents how chant reads the file and rotates the keys in it.

`yodel approve <env> --sign` seals the approval with git's signing key (`user.signingkey`, with `gpg.format ssh`), or the private key `--key <file>` names. Under a sealed gate, `yodel approve` seals without being asked. The approver is `--actor <name>`, else the name chant takes from `GITHUB_ACTOR`, `GITLAB_USER_LOGIN` or `USER`, and it must be the principal the signers file gives the key; a seal by a listed key in another approver's name does not count. With the command a waiting job printed:

```sh
npx yodel approve prod --plan jcs1-sha256:... --sign --key ~/.ssh/id_ed25519 --actor alice
```

The job verifies the seal with `ssh-keygen`, which the CI image and `node:22-bookworm` carry. A job image without it cannot verify a seal, and the wave waits.

### Pull request review

Under `pr-review`, the pull request's own review approves the wave, with no `yodel approve`. `yodel ci` renders a pull request job that runs `chant run wave --spec yodel-waves.json --record-plans`: it plans every wave at the pull request's head, as the wave will plan after the merge (each environment a wave requires taken as having applied what is pending, which the wave checks when it runs; no `before` step is run), and records the digests on `chant/lifecycle` (`_wave-plans/yodel-apply/<head>.json`). It holds no writer: it plans with each environment's reader, and runs the write probe first ([Configuration](configuration.md)), as every pull request job does.

| Forge | The job | What counts as an approving review |
|---|---|---|
| GitHub | `.github/workflows/yodel-apply-plans.yml` | the reviewer's newest review is `APPROVED` on the head commit, and the reviewer has write, maintain or admin on the repository |
| Forgejo | `.forgejo/workflows/yodel-apply-plans.yml` | the same, and the review is official (Forgejo's mark for a reviewer with write access), not stale and not dismissed |
| GitLab | `yodel-apply-record-plans`, in merge request pipelines, stage `plans` | the merge request's approvals, by members with the Developer role or higher, and only when the project removes approvals on a new push |

After the merge, the wave finds the pull request that made the commit it applies, and its head. When a writer other than the author approved that head and the head recorded the digest the wave plans now, the wave applies and chant writes an approval to the ledger that names the review. The author's own review never counts, and a writer's standing request for changes holds the review back. A plan that moved after the review (another merge first, a table changed by hand, a wave before it that did not apply what was pending) has a new digest, so the wave waits for a `yodel approve` of it.

The wave job reads the review with the forge's API: on GitHub and Forgejo with the job's token (`yodel ci` gives the wave's job `GITHUB_TOKEN`, and on GitHub the workflow `pull-requests: read`); on GitLab with `CHANT_FORGE_TOKEN` or `GITLAB_TOKEN`, a token with `read_api`.

GitLab's limits:

- An approval on GitLab names no commit, so it is tied to the head only by the project's setting "Remove all approvals when commits are added to the source branch" (`reset_approvals_on_push`). Without it, no GitLab approval counts.
- The record job pushes `chant/lifecycle`, which `CI_JOB_TOKEN` can do only when the project allows Git push requests from job tokens. Otherwise the job fails, nothing is recorded, and the wave waits for `yodel approve`.
- Merged results and merge trains plan a commit that is not the merge request's head; the recorded plan is the head's, so a merge that changes what the wave plans waits for `yodel approve`.

A pull request from a fork runs its pipeline without the repository's secrets and with a read-only token: the record job can neither read the environments nor push `chant/lifecycle`, so nothing is recorded, and after the merge the wave waits for a `yodel approve` of its digest. Approve those as under `ledger`.

## The pull request comment

`yodel plan <env> --comment` posts the plan as one comment per environment on the pull (merge) request, and updates that comment on the next push rather than adding another. `--format markdown` prints the same Markdown without posting. From the ClickHouse example, for its rebuild:

<!-- quote: clickhouse#comment -->
````console
$ npx yodel plan dev --format markdown
<!-- yodel:plan env=dev -->
### yodel plan: `dev`

ClickHouse, history `yodeler.history (single (default))`: 2 applied, **1 pending**.

#### `20261010T1722-events-by-id`

| # | Step | Rule | Class | Object |
|---|---|---|---|---|
| 0 | **Op ClickHouseRebuildOp** | SQLCH220 | rebuild | `shop.events` |

Op steps:
- step 0, `shop.events`: made by Op `ClickHouseRebuildOp` (SQLCH220 rebuild orderBy). yodel apply runs it as this step.

  <details><summary>ClickHouseRebuildOp for events</summary>

  ```text
  needs a rebuild, which ALTER cannot make: SQLCH220 Change the sorting key on orderBy (( kind , at ) -> ( kind , id )): The sorting key is the on-disk order of every part (and in ReplacingMergeTree the deduplication identity); beyond appending new columns (SQLCH216) it cannot change in place. https://clickhouse.com/docs/sql-reference/statements/alter/order-by. Run it as the rebuild migration Op: ClickHouseRebuildOp({ table: "shop.events", ... }) from @intentius/chant-lexicon-sql/clickhouse
  ```

  ```ts
  export const { op } = ClickHouseRebuildOp({ name: "rebuild-shop-events", env: "<env>", table: "shop.events", dualWrite: { mode: "materialized-view", cutoverColumn: "at" } });
  ```

  </details>

#### Approval

Plan digest the apply gate binds: `jcs1-sha256:82c892052401d2b5a35d49964395124736586c6a8222858f8f0905155d29eb47`

Approve it with:

```sh
chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:82c892052401d2b5a35d49964395124736586c6a8222858f8f0905155d29eb47
```

The newest approval of `approve-migrate-dev`, by yodel at 2026-10-10T17:22:18.586Z, is for `jcs1-sha256:c6a49076c4a2b58c984b7a73d59e86c5788e82cb89728c5ec24307869e72bd03`, not this plan; it does not hold.
What moved (as far as yodel can tell): history changed: applied since: 20261010T1722-add-country (by yodel@example at 2026-10-10 17:22:22.954144); pending migrations changed: committed to since approval: 20261010T1722-events-by-id (1880fda at 2026-10-10T11:22:28-06:00); live schema changed: as expected after the history change above: applying a migration changes the live schema, and yodel cannot rebuild the live schema as it was at approval, so it cannot confirm that nothing else in it changed.

<!-- yodel:subject eyJlbnZpcm9ubWVudCI6ImRldiIsImhpc3RvcnlEYXRhYmFzZSI6InlvZGVsZXIiLCJ0b3BvbG9neSI6eyJraW5kIjoic2luZ2xlIn0sImFwcGxpZWQiOlt7ImlkIjoiMjAyNjEwMTBUMTcyMi1iYXNlbGluZSIsImNoZWNrc3VtIjoic2hhMjU2OjU3MWI2MzNjMGQ2YzRlNDYxZDc2Mjg1MzI4Y2I3MTYwMGIzYzMzYzFhNDI5ZjkwZGIxYTVmOWUxNzQyMjhkZWIifSx7ImlkIjoiMjAyNjEwMTBUMTcyMi1hZGQtY291bnRyeSIsImNoZWNrc3VtIjoic2hhMjU2OjU1NGQwMzQ5Y2QwNTA5YzkwYTc5MTA1N2M0MmRlYzI0NWMzMmQ2M2NiY2MxOGFhNDZlODk2OTY2NDg3YTE0MzgifV0sInBlbmRpbmciOlt7ImlkIjoiMjAyNjEwMTBUMTcyMi1ldmVudHMtYnktaWQiLCJjaGVja3N1bSI6InNoYTI1Njo5NTdkZGMxZTFjMzFmZjIyMmM3ZmE1NjdlOGJjYjViYzZjZWRlZjAzZjYyMWQwMjYzZGEwOTEzYTdjNGY5NTNjIiwiZG9uZSI6W119XSwibGl2ZSI6InNoYTI1NjpiYTA4MzBmYjk2NjkzNWMzYTNiNmQ1Nzg3ODIwNGJhMzMzMzQxMTg2YzJkMzk4M2E3YTMwN2IxMjk4MmFiMmY1In0 -->
````

The hidden `yodel:subject` line at the end records the state the plan was made from; the next `--comment` run reads it from the comment it updates, to say what moved. The forge, the repository, the request and the API come from the CI job's environment:

| Forge | Detected by | Token |
|---|---|---|
| GitHub Actions | `GITHUB_ACTIONS=true` | the first set of `CHANT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`; the job's `GITHUB_TOKEN` needs `pull-requests: write` |
| GitLab CI | `GITLAB_CI=true` | the first set of `CHANT_GITLAB_TOKEN`, `GITLAB_TOKEN`, `CI_JOB_TOKEN`: set `GITLAB_TOKEN` to a project or personal access token with `api` scope (`CI_JOB_TOKEN` cannot write merge request notes) |
| Forgejo Actions | `FORGEJO_ACTIONS=true` or `GITEA_ACTIONS=true` (or a GitHub-style job whose API URL ends in `/api/v1`) | the first set of `CHANT_FORGEJO_TOKEN`, `FORGEJO_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN` |

Outside those, or to override them: `--forge github|gitlab|forgejo`, `--repo`, `--pr`, `--api-url`, and `--token-env <VAR>` for the one variable that holds the token. The token is never a flag and never printed. chant's forge client (`@intentius/chant/pr-forge`) reads the job's environment and posts the comment; yodel writes the body. The comment job needs only read credentials for the database; the starter templates give it the reader.

## When the digest moves

Anything the digest covers that changes after the approval (another migration, an edited one, another run applying first, a table changed out of band) makes a new digest, and the approval does not carry over. The gate asks again, nothing is applied, and yodel says what moved, as far as it can tell from the history and git.

In the ClickHouse example a plan is approved, then someone adds a column by hand before the apply runs:

<!-- quote: clickhouse#plan-add-source -->
```console
$ npx yodel plan dev
Plan for dev (clickhouse 26.8.15.10 at 127.0.0.1:8123, history yodeler.history (single (default))): 4 applied, 1 pending

Kept by earlier steps, until their retention date: shop.events__chant_old (until 2026-10-17T17:22:47.304Z). yodel cleanup dev drops each after its date, behind an approval.

20261010T1723-add-source
  0  statement  SQLCH201 metadata  shop.events
       ALTER TABLE `shop`.`events` ADD COLUMN source LowCardinality(String) DEFAULT 'web' AFTER `country`

Plan digest: jcs1-sha256:3c0f36706f2c91b7ac34fc175ae3a05ff0161364c71a6ca7dbecdc8982255544
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:3c0f36706f2c91b7ac34fc175ae3a05ff0161364c71a6ca7dbecdc8982255544
or, at a terminal, with npx yodel approve dev, which shows the plan and asks you first.

The newest approval of approve-migrate-dev, by yodel at 2026-10-10T17:22:58.009Z, is for jcs1-sha256:96f8f3625b2628eedd9a5567254b9b7ecf5e53ae0a22550d6da7cf3a37ff200e, not this plan; it does not hold.
What moved: history changed: applied since: 20261010T1722-fill-country (by yodel@example at 2026-10-10 17:23:03.136317); pending migrations changed: new pending migration: 20261010T1723-add-source.
```

<!-- quote: clickhouse#approve-add-source -->
```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:3c0f36706f2c91b7ac34fc175ae3a05ff0161364c71a6ca7dbecdc8982255544
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-10T17:23:08.576Z
This approves the plan jcs1-sha256:3c0f36706f2c91b7ac34fc175ae3a05ff0161364c71a6ca7dbecdc8982255544, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

```sql
ALTER TABLE shop.events ADD COLUMN debug String DEFAULT ''
```

<!-- quote: clickhouse#moved -->
```console
$ npx yodel apply dev
...
Running migrate-dev (<tmp>/clickhouse/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   1.2s
[phase] Approve
  • gate:approve-migrate-dev()   skipped
    [refused] Gate "approve-migrate-dev" is approved, but not for this plan. approved: jcs1-sha256:3c0f36706f2c91b7ac34fc175ae3a05ff0161364c71a6ca7dbecdc8982255544 (by yodel at 2026-10-10T17:23:08.576Z); planned: jcs1-sha256:4646f73faf35fc9a8563f817637d72126db7718931d03158677fb5160fe33605. The configuration or the live system changed between that approval and this plan, so it needs a fresh one: chant approve migrate-dev approve-migrate-dev
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 2.0s
  plan    : jcs1-sha256:4646f73faf35fc9a8563f817637d72126db7718931d03158677fb5160fe33605
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:4646f73faf35fc9a8563f817637d72126db7718931d03158677fb5160fe33605
  expires : 2026-10-12T17:23:12.217Z

Nothing was applied. The approval of jcs1-sha256:3c0f36706f2c91b7ac34fc175ae3a05ff0161364c71a6ca7dbecdc8982255544 (by yodel at 2026-10-10T17:23:08.576Z) does not hold: the plan moved since. What moved, as far as yodel can tell: live schema changed: no state yodel can rebuild from the history and git hashes to the approved digest with today's live schema, so an object in the environment's live schema (a table, view, index, dictionary, database or schema) changed since approval (or a part yodel cannot rebuild did).

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:4646f73faf35fc9a8563f817637d72126db7718931d03158677fb5160fe33605).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:4646f73faf35fc9a8563f817637d72126db7718931d03158677fb5160fe33605
or, at a terminal, with npx yodel approve dev, which shows the plan and asks you first;
then run npx yodel apply dev again.
[exit 3]
```

Dropping the column puts the live schema back, and the digest is the approved one again. The gate still asks again, because the refused run asked for approval after that approval was given; an approval holds only when it is newer than the latest request. `yodel plan` and `yodel apply` say so:

<!-- quote: clickhouse#asked-again-plan -->
```console
$ npx yodel plan dev
Plan for dev (clickhouse 26.8.15.10 at 127.0.0.1:8123, history yodeler.history (single (default))): 4 applied, 1 pending

Kept by earlier steps, until their retention date: shop.events__chant_old (until 2026-10-17T17:22:47.304Z). yodel cleanup dev drops each after its date, behind an approval.

20261010T1723-add-source
  0  statement  SQLCH201 metadata  shop.events
       ALTER TABLE `shop`.`events` ADD COLUMN source LowCardinality(String) DEFAULT 'web' AFTER `country`

Plan digest: jcs1-sha256:3c0f36706f2c91b7ac34fc175ae3a05ff0161364c71a6ca7dbecdc8982255544
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:3c0f36706f2c91b7ac34fc175ae3a05ff0161364c71a6ca7dbecdc8982255544
or, at a terminal, with npx yodel approve dev, which shows the plan and asks you first.

The newest approval of approve-migrate-dev, by yodel at 2026-10-10T17:23:08.576Z, is for this plan's digest, but approval was asked for again after it at 2026-10-10T17:23:12.217Z (a run holding jcs1-sha256:4646f73faf35fc9a8563f817637d72126db7718931d03158677fb5160fe33605), so it does not hold; approve this plan again.
```

<!-- quote: clickhouse#asked-again-apply -->
```console
$ npx yodel apply dev
...
Op "migrate-dev" is gated on "approve-migrate-dev" after 1.7s
  plan    : jcs1-sha256:3c0f36706f2c91b7ac34fc175ae3a05ff0161364c71a6ca7dbecdc8982255544
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:3c0f36706f2c91b7ac34fc175ae3a05ff0161364c71a6ca7dbecdc8982255544
  expires : 2026-10-12T17:23:19.304Z

Nothing was applied. The approval of jcs1-sha256:3c0f36706f2c91b7ac34fc175ae3a05ff0161364c71a6ca7dbecdc8982255544 (by yodel at 2026-10-10T17:23:08.576Z) is for this plan's digest, but approval was asked for again after it at 2026-10-10T17:23:12.217Z (a run holding jcs1-sha256:4646f73faf35fc9a8563f817637d72126db7718931d03158677fb5160fe33605), so it does not hold; approve this plan again.

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:3c0f36706f2c91b7ac34fc175ae3a05ff0161364c71a6ca7dbecdc8982255544).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:3c0f36706f2c91b7ac34fc175ae3a05ff0161364c71a6ca7dbecdc8982255544
or, at a terminal, with npx yodel approve dev, which shows the plan and asks you first;
then run npx yodel apply dev again.
[exit 3]
```

After a new approval (`yodel approve`), the apply goes through. A migration that failed part way moves the digest too, since the statements that succeeded are part of it; the [Postgres example](../examples/postgres/README.md#4-a-migration-that-fails-part-way-and-resumes) approves again before resuming.

## Policy and overrides

Some rules are not lint: no drops in production, no rebuilds during business hours, every silence cites a ticket. `yodel.config.ts` declares them as `policy`, rules over the plan `yodel apply` would run:

```ts
// yodel.config.ts
import { defineConfig } from "@intentius/sql-yodeler";

export default defineConfig({
  policy: {
    overriders: ["alice", "bob"],
    rules: [
      { id: "no-drops-in-prod", environments: ["prod"], description: "no drops in prod", refuse: { classes: ["drop"], destructive: true } },
      { id: "silences-cite-a-ticket", silences: { reason: /\b[A-Z]+-\d+\b/ } },
      {
        id: "no-rebuilds-in-hours",
        environments: ["prod"],
        check: (plan) => {
          const hour = new Date(plan.now).getUTCHours();
          const rebuild = plan.pending.some((m) => m.steps.some((s) => s.classes.includes("rebuild")));
          return rebuild && hour >= 8 && hour < 18 ? "a rebuild between 08:00 and 18:00 UTC" : undefined;
        },
      },
    ],
  },
});
```

A rule applies to the environments it lists, or to every one. It denies the plan when any of its parts does:

- `refuse.classes` denies a pending step of one of those classes (ClickHouse: `metadata`, `create`, `rewrite`, `rebuild`, `drop`; Postgres: `metadata`, `create`, `validate`, `concurrently`, `rewrite`, `expand`, `drop`), and `refuse.destructive` any destructive step.
- `silences.reason` denies a `-- yodel:allow` silence (of `silences.rules`, default any) whose reason does not match the pattern.
- `check` is a TypeScript predicate over the plan: the environment, the dialect, the time (`now`), and each pending migration with its id, checksum, steps (classes, destructive, rules, SQL, Op) and silences. A message, a list of messages or `false` denies; `undefined`, `true` or `[]` allows.

The policy is read from `yodel.config.ts` at the base commit, the commit a change merges onto (the merge base with the target branch on a pull request, `HEAD^1` on main, or `YODEL_BASE`), as a wave's gate is, never from the working tree. A pull request that weakens or deletes a rule is judged by the rule the branch had, and its own policy applies once it is merged. A rule the base does not have applies to nothing yet. When the working tree's policy differs from the base's, `yodel plan` and `yodel apply` say which one applies.

`yodel plan` shows each rule's outcome, and the pull request comment shows them in a table with the command that overrides a denial. `yodel apply` judges the policy before the gate and the Apply step judges it again under the lock: a rule that denies the plan refuses the apply with exit 4, naming the rule and why, and nothing is applied.

An override is a person's decision, with a reason, to apply a plan a rule denies:

```sh
npx yodel override prod --rule no-drops-in-prod --reason "the table has been empty since OPS-412" --by alice
```

It goes through chant's override gate, on the `chant/lifecycle` branch (`_gates/policy-override.jsonl`): `yodel override` records the denial under the name of the environment's migrations Op, then the override with `chant approve policy-override <op> --rule <id> --reason <text>` (with `--sign` under `approval: "sealed"`). It counts only for the current plan digest and the rules that deny it: if the plan moves (a migration added or edited, the live schema changed), the rules deny again and need a new override. It counts only when `policy.overriders` in `yodel.config.ts` at the base commit lists who recorded it (`--by`, else chant's actor: the CI user or your login), and under `approval: "sealed"` only when it is sealed by a key the signers file at base lists. Name every rule that denies the plan: one override answers one denial, and `yodel override` refuses a rule that does not deny the current plan or a denying rule left out. An override does not approve the plan: the migrations Op's gate still asks for approval as before.

An override counts once. Before the Apply step applies under it, it records on `chant/lifecycle` that the override is spent, so a plan denied again later waits for an override of its own. When `chant approve policy-override` warns that the checkout has no `.chant/overriders`, that is expected: SQL Yodeler reads its overriders from `policy.overriders`. Overrides recorded before 0.8 (approvals of an `override-<rule>` gate) no longer count; `yodel report` still lists them.

The Apply step writes the overrides it relied on into the history, in the `note` of each migration's `started` row, as `{"policy":{"overrides":[{"rule":...,"by":...,"at":...,"reason":...,"digest":...}]}}`.

### Reverts

`yodel revert` ([Reverting](migrations.md#reverting-yodel-revert)) is judged by the same policy, read at the base commit, before the gate and again under the lock. The rules see the revert as a plan with one entry in `pending`, the migration reverted, whose steps are the revert's statements in the order they run (a hand-written revert step's first), and `plan.revert` names the migration and the one it goes back to. A revert usually drops what the migration added, so a rule that refuses drops (or `refuse.destructive`) in prod refuses the revert too: exit 4, nothing reverted. To revert anyway, override for the revert's own digest:

```sh
npx yodel override prod --revert 20261010T0900-add-coupons --rule no-drops-in-prod --reason "added by mistake, OPS-415" --by alice
```

With `--step <file>` as well when the revert has a hand-written step. An override of the apply's plan never counts for a revert, nor the other way round. The revert's Apply step writes the overrides it relied on into the note of the migration's `reverted` row.

A revert always stops at the migrations Op's gate, whatever the wave's gate policy in an environment `waves` names: under `on-destructive`, a destructive revert waits for an approval, and so does any other revert. `yodel revert --json` says what the wave's gate, at the base commit, makes of the revert (`wave`: its destructive statements, counted as a wave plan counts them, and whether the policy asks for an approval).
