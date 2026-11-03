---
claims: [forge]
type: concepts
---

# SQL Yodeler on chant CI

SQL Yodeler's pipelines run on [chant](https://intentius.io/chant/)'s CI, as terragucci's do for Terraform and plywood's for Pulumi. chant runs the apply waves, holds the gates and keeps the records of approvals. SQL Yodeler holds the migrations engine, the `yodel` commands and their words, `yodel.config.ts`, the starter templates and these docs. chant's [CI Products on chant](https://intentius.io/chant/concepts/ci-products/) page has the rule that decides where a feature goes: chant CI core when the products share it, then chant's sql lexicon when it belongs to the SQL engines, then SQL Yodeler.

## Which parts are chant's

| Part | chant | SQL Yodeler |
|---|---|---|
| The pipeline files | the forge lexicons serialize every job for GitHub Actions, GitLab CI and Forgejo Actions | `yodel ci` declares the jobs from `chant.config.ts`, `yodel.config.ts` and `ops/` ([The pipelines](workflows.md#the-pipelines-yodel-ci)) |
| Applying on merge | Op waves: `chant run wave` runs one job per wave from `yodel-waves.json`, decides each wave's gate and records the run | each environment's plan and apply, `yodel apply <env> --wave-plan` and `--wave-apply` |
| Gates and approvals | the gate, the plan digest it binds, and the ledger on `chant/lifecycle` that `chant approve` writes | `yodel approve <env>`, which shows the plan, asks a person and records through chant ([Approval](approval.md)) |
| Policy overrides | the override gate, under the Op's name | the policy rules in `yodel.config.ts` and `yodel override` |
| Steps around an apply | Op-wave stage hooks | the SQL checks and steps a migration declares ([Data migrations](steps.md)) |
| Drift | the `WatchOp`, its schedule and the verdict on an overdue watch | `yodel drift <env> --issue` against the newest applied migration ([Drift](drift.md)) |
| Webhook events | the notify event and its signature | the `x-yodel` header names and the approve line in each event ([Webhook events](notify.md)) |
| The migrations engine | none | the migrations directory, checksums, the history table, the apply lock, rebuilds, backfills and expand-and-contract steps, tenant sets, revert and rebase ([Migrations](migrations.md)) |

chant never applies a migration itself. It runs the engine through `yodel` commands, and the engine checks the approval on chant's ledger again under its own lock before it applies, so `yodel apply --execute` with the writer's credentials outside CI still needs the approval.

## From chant 0.124.67

chant 0.124.67 has the product pipeline terragucci and plywood use, and more of a SQL Yodeler project's pipeline moves onto chant there. `yodel upgrade` moves a project in one commit ([Upgrading the pipelines to chant 0.124.67](workflows.md#upgrading-the-pipelines-to-chant-012467)), and `yodel ci` keeps rendering the same files after it. From SQL Yodeler 0.12 this is the only way `yodel ci` renders, and a project runs `yodel upgrade` before it moves to 0.12 ([What 0.12 no longer has](#what-012-no-longer-has)). The sections below say what each part does from then on. The gates, the approval modes, the tenant sets and the secrets each job holds stay as they are, and so do the op and gate names, `yodel-apply` and `yodel-apply-wave-<k>`, so approvals already on `chant/lifecycle` keep counting.

### The pipelines

Each job that runs chant runs `yodel chant <args>` in its place. `yodel chant` runs that chant command in the same process with yodel's words, so the lines chant prints for a person name yodel's commands: an approval is `yodel approve <env> --plan <digest>`, and an override `yodel override <env> --rule <rule> --reason <text>`. People keep typing yodel's own commands; `yodel chant` is for the jobs, and `yodel --help` does not list it. `yodel-waves.json` names the gate pattern, `"gateName": "yodel-apply-wave-{k}"`. The plan jobs stay `yodel plan <env> --comment`, with the write probe before them.

### Exit codes

yodel reads its exit codes from chant's table, which terragucci and plywood use too, with 9 (`misplaced`, a refused job guard) read from it when the installed chant has it. The numbers are the ones [The commands](cli.md#exit-codes) lists. [chant's exit codes reference](https://intentius.io/chant/reference/exit-codes/) has the table for every product.

### The apply waves

`yodel-waves.json` names a step, `{ "kind": "sql-migrate", "environment": "{target}", "spec": "yodel-waves.json" }`, in place of the `plan` and `apply` command lines. chant's sql lexicon plans and applies each run through its capability, which calls the engine as `yodel apply <env> --wave-plan` and `--wave-apply`. The wave's `before` SQL checks run when chant plans the wave, and one that fails with `onFailure: "approve"` still holds the wave for a person. Every step then runs once, under the engine's lock, inside `--wave-apply`, as it does when `yodel apply` runs at a terminal.

### Locks

The waves take chant's lock grain. The sql lexicon gives a SQL member the `target` grain, its environment, and refuses `ci.lockGrain: resource`, since the engine applies a whole environment's migrations at once. chant holds a lease on the environment for the length of the wave's apply, and an apply that finds it held exits 5 (`held`). The engine's own lock ([Topology](topology.md)) still guards the history under it, with `lockTtl`, and catches an apply from a laptop. A wave that a newer commit on main will apply anyway stands down and exits 6 (`superseded`), through `standDown` in `yodel-waves.json` ([chant's op waves guide](https://intentius.io/chant/guide/op-waves/#stand-down-for-a-newer-commit)). The apply jobs carry no `YODEL_LOCK_WAIT` or `YODEL_STAND_DOWN`, and from 0.12 `yodel apply` refuses either one by name. `yodel apply --stand-down` at a terminal asks chant the same question chant's waves ask. [Target locks](https://intentius.io/chant/guide/target-locks/) has the grain.

### The check on chant's check hooks

`yodel ci` writes yodel's checks into the workspace declaration's `ci.hooks.check` as presets (`yodel upgrade` adds `chant.workspace.json` when the project has none), and the lint job runs `yodel chant ci check --base <the pull request's base>`. The presets, in the order the job runs them:

| Hook | Runs | When |
|---|---|---|
| `yodel-ci-check` | `yodel ci --check` | always |
| `yodel-sql-types` | `chant sql types --check` | the project commits `sql-types.d.ts` |
| `yodel-lint` | `yodel lint --format forge` | always |
| `yodel-replay` | `yodel lint --replay replay --reset` | chant.config.ts declares the `replay` profile |
| `yodel-test` | `yodel test --env replay --reset --junit yodel-test.xml` | the replay profile, and `tests/*.test.ts` |
| `yodel-check` | `yodel check --env replay --reset --base origin/main --format forge` | the replay profile, and yodel.config.ts `check` |
| `squawk` | `squawk migrations/*/migration.sql` | yodel.config.ts `ci.tools` names it (Postgres only) |
| `sqlfluff` | `sqlfluff lint migrations --dialect <dialect>` | yodel.config.ts `ci.tools` names it |

squawk and sqlfluff are off unless `ci.tools` names them, and each must be installed where the lint job runs (the job's image, or a step in `ci.jobs`). yodel ships no rule of its own that repeats theirs.

```ts
export default defineConfig({ ci: { tools: ["squawk", "sqlfluff"] } });
```

chant reads the hooks from the declaration at the pull request's base, so a pull request that removes one still runs it, and a hook a pull request adds runs once it is merged. Each hook runs with no forge token and no cloud credentials. The job's log shows each one's output, so `yodel lint`'s annotations still appear on GitHub and Forgejo, and on GitLab the job keeps the code quality report. `.chant/check/check-hooks.json` lists each hook with its result and exit code, and the job fails on the first hook that fails. `yodel ci --check` compares the declaration's hooks with the presets too. A hook removed from `ci.tools` stays in the declaration until you delete it there, since `yodel ci` adds and replaces hooks and never removes one.

### The review agent

`review` in `yodel.config.ts` has a model read the migrations each pull request adds and post what it finds as one note beside the plan note. It runs on chant's [reviewAgent](https://intentius.io/chant/guide/review-agent/), which terragucci and plywood use too. The note approves nothing and gates nothing: the approvals and the gates stay as they are.

```ts
export default defineConfig({ review: true });
// or
export default defineConfig({ review: { keyEnv: "ANTHROPIC_API_KEY", timeout: 5, rules: ["Every new table in shop has an owner comment."] } });
```

| Key | Default | What it is |
|---|---|---|
| `command` | chant's: Claude Code in print mode with no tools | the model command, run with the prompt on stdin; it prints the review |
| `keyEnv` | `ANTHROPIC_API_KEY` | the variable holding the model's key, the one secret the command sees |
| `timeout` | 10 | minutes the command may run |
| `rules` | none | the team's own rules, after yodel's |

With it set, `yodel ci` writes three more things, and `yodel ci --check` compares them like the rest:

- `ops/yodel-review.op.ts`, a pull request Op. Its first step runs `yodel plan --pull-request --change-set .chant/pr/change-set.json`, which reads the migrations the pull request adds (the ones in `migrations/` the base commit does not have) from their `migration.json`, with no server, and writes them as one chant change set. Its second is chant's `reviewAgent` in handoff mode over that change set and the pull request's diff.
- `.chant/yodel-review.md`, the instructions the model reads. chant reads them from the base branch, so a pull request that changes `rules` changes the review once it merges. They are yodel's SQL rules for the project's dialect, taken from the classes the plan note shows: a `drop` class or a destructive step loses data, and one the description does not mention is high risk; on Postgres a `rewrite` holds ACCESS EXCLUSIVE for the whole table while it runs, `validate` scans under SHARE UPDATE EXCLUSIVE, and a plain `CREATE INDEX` blocks writes for the build; on ClickHouse a `rewrite` is a mutation over every part, and a `rebuild` copies the table. Nothing in a migration says how many rows a table holds, so the model asks the author how large a rewritten or rebuilt table is. Your `rules` follow.
- The review pipeline: `yodel-review.yml` on GitHub and Forgejo, `.gitlab/yodel-review.gitlab-ci.yml` on GitLab, which `.gitlab-ci.yml` includes.

The pipeline has two jobs, both chant's:

| Forge | `yodel-review` | `yodel-review-note` |
|---|---|---|
| GitHub | `contents: read`; the steps start without the token variables; maps the `keyEnv` secret and no database secret | `pull-requests: write`, checks nothing out, posts the review as one note |
| Forgejo | the same steps; Forgejo ignores `permissions:`, and the steps still start without the token variables | the same, with the job's token |
| GitLab | in the merge request pipeline; unsets every forge token and every environment's database variables before it runs, and keeps `.chant/review` as an artifact | in a pipeline of the default branch started with `CHANT_REVIEW_NOTES=1`, with no checkout, posting the review of each open merge request with `CHANT_FORGE_TOKEN` |

The note is keyed on the Op, `<!-- chant-review:yodel-review -->`, so each push edits the same note. Set `keyEnv` from a secret on GitHub and Forgejo, and as a masked CI/CD variable on GitLab. On GitLab, also make `CHANT_FORGE_TOKEN` a protected, masked variable (a project access token with the `api` scope) and create a pipeline schedule on the default branch with `CHANT_REVIEW_NOTES` set to `1`; a review shows up on the merge request when the schedule next runs. [chant's review guide](https://intentius.io/chant/guide/review-agent/#on-gitlab) has the setup.

The model gets the pull request's title, description and diff, so a secret committed in the change reaches it. A project with no migrations yet gets a review that says the pull request adds none, and so does a declarative project, which has no migrations to read.

### Cloud login

chant's ci-identity trades the forge's OIDC token, and the sql lexicon mints the database token from what the trade leaves, so on GitHub and GitLab `yodel ci` renders chant's login in place of the steps in [Configuration](configuration.md#short-lived-tokens). Each job holding such a role runs one step, `Cloud identity (chant ci-identity: ...)`, with `ci.login` mapped to chant's trade spec. The step runs from `/`, so no file of the checkout is in reach, and leaves the cloud's variables for the later steps. GitLab's `id_tokens` are chant's (`CHANT_ID_TOKEN_AWS`, `_GCP`, `_AZURE`). `rds-iam` signs with the traded AWS keys, `cloud-sql-iam` takes the traded Google access token, and `entra` takes the database token the trade asks Entra for, so the job's image needs no `aws`, `gcloud` or `az`. `ci.login.aws.region` (default `us-east-1`) is where the role is assumed and the `AWS_REGION` the token is signed for, unless the token source names its own `region`. Each job trades only for the roles it holds: a plan job for readers, a wave job for its environment's writer. Forgejo, which gives a job no OIDC token, keeps yodel's login from the runner's token file: there is no token there to trade.

### Records on the ledger

`yodel cleanup <env>` and `yodel init --baseline <env>` ask for chant's gated request in place of a run of the migrations Op. A cleanup's request is on the cleanup gate (`approve-migrate-prod-cleanup`) and binds the environment and the cleanup digest. A baseline's is on the gate with `-baseline` (`approve-migrate-prod-baseline`) and binds the environment, the baseline's id and checksum and the record's digest. The command stops at the request (exit 3) and prints its digest for `yodel approve <env> --plan <digest>`. Someone other than the person who asked approves it, since chant never counts a requester's own approval. The next run spends the approval before it drops anything or makes the record, checks the approval on chant's ledger again under the lock, and chant records how it ended, so `chant ledger gates` lists the request, the approval, the apply and its end. `YODEL_GATED_REQUESTS=0` keeps the gate on the migrations Op, which a person working alone can approve.

A wave planned through the sql capability cites its change set on the pending fact, and `yodel report` reads two more kinds of entry from the ledger ([Reports and the audit log](audit.md)): `wave-run`, the run record of the wave job that ran the environment (`local/runs__yodel-apply.jsonl`), and `spent`, an approval an apply spent (`_gates/<op>/applied.jsonl`). An applied migration takes its wave from the run record first, and from the history row for applies made before there were run records. A ledger written before then has neither entry, and the rest of the log reads as before.

### `yodel approve`

The question at the terminal is chant's: chant shows the gate, its pending fact and the plan stored on `chant/lifecycle` that the fact cites, and asks you to type the environment's name (the tenant set's, for a set), as `chant approve` does for every product. A wrong answer exits 8 and a plan that moved while you were asked exits 4. yodel reads its plan again after the answer, and with no terminal it still approves nothing and exits 1. `YODEL_OWN_CONFIRM=1` keeps yodel's own question.

### MCP and traces

`yodel mcp` serves its tools on chant's own read-only server, `chant serve mcp --read-only`, in the same process ([Set up with a coding agent](agents.md#read-only-tools-yodel-mcp)). They are named `yodel:status`, `yodel:plan`, `yodel:lint`, `yodel:drift`, `yodel:history` and `yodel:explain`, and chant's reads of the ledger, the runs, the gates and the workspace graph sit beside them. Each tool declares itself read-only, and chant refuses to start a read-only server with a tool named as a write, as yodel's own check does first. The agent's registration stays the same. yodel's own server, with the unprefixed names, is gone from 0.12, and `YODEL_OWN_MCP=1`, which served it, is refused.

With `OTEL_EXPORTER_OTLP_ENDPOINT` set in the apply jobs, each wave job sends one trace as OTLP/JSON over HTTP through chant's exporter. The job is the first span, each wave a span below it, and each environment a span in its wave. yodel configures the exporter with the `yodel` prefix, so the attributes read `yodel.<name>`. Without the endpoint nothing is sent.

## What 0.12 no longer has

SQL Yodeler 0.11 kept its own copy of each part above for an older chant, and for the pipelines yodel 0.10 rendered. 0.12 takes chant 0.124.67 as its floor and removes them, so a project runs `yodel upgrade` before it moves to 0.12 ([Upgrading the pipelines](workflows.md#upgrading-the-pipelines-to-chant-012467)):

| Gone | In its place | A pipeline yodel 0.10 rendered, still committed |
|---|---|---|
| yodel's own pipeline generator (`render` without chant's product pipeline) | chant's product pipeline; a chant without it is refused, naming the install line | fails `yodel ci --check` on the pull request |
| the `plan` and `apply` callbacks in `yodel-waves.json` | the `sql-migrate` step | the wave jobs are refused (below) |
| `YODEL_LOCK_WAIT: '10m'` and `YODEL_STAND_DOWN: '1'` on the wave jobs, and yodel's own newer-commit check | chant's lease (exit 5) and `standDown` (exit 6); `--stand-down` at a terminal asks chant | refused by name, exit 1, pointing at `yodel upgrade` |
| yodel's own pull request note, for one environment | chant's note in yodel's words | |
| yodel's own login steps on GitHub and GitLab | chant's ci-identity trade | |
| yodel's own MCP server and `YODEL_OWN_MCP` | chant's read-only server with yodel's tools | `YODEL_OWN_MCP` is refused by name |

A tenant set keeps yodel's own note, one comment naming every tenant with the wave's one approval of the set, because chant's note would print an approve line per tenant, and approving a tenant on its own never opens the set's wave. It moves onto chant's note once chant can name the set in one approve line.

`yodel apply <env> --wave-plan` and `--wave-apply` stay: they are the engine's entry points, the commands chant's `sql-migrate` capability runs. `YODEL_LOCK_WAIT` and `YODEL_STAND_DOWN` stay only as how `yodel apply` hands `--lock-wait` and `--stand-down` to its migrations Op's steps. A project with no workspace declaration (one not upgraded yet, or a member under a declaration above it) still gets the lint job's own steps, since there are no check hooks for chant to run there.
