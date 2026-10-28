---
claims: [declarative, migrations, approval, waves]
type: concepts
---

# The two workflows

Both workflows start from the schema declared in `src/` ([Declaring the schema](schema.md)): it says what the database should be, and yodel works out how to get there. `yodel plan <env>` and `yodel apply <env>` take one of two paths, chosen by the project: the versioned path when it has a `migrations/` directory holding at least one migration, the declarative path otherwise. (A template's empty `migrations/`, with only `.gitkeep`, is still declarative.) Both apply behind an approval bound to a digest of what they would do; see [Approval](approval.md).

## Declarative: the declared schema against the live database

No migration files. `yodel plan <env>` shows the classified change from the environment's live database to the declared schema in `src/`, as `chant sql plan` reports it, and `yodel apply <env>` makes it.

`yodel apply` plans, then runs the project's `ApplyOp` for the environment with `chant run`. From the ClickHouse example:

<!-- quote: clickhouse#apply-op -->
```ts
import { ApplyOp } from "@intentius/chant/op";

// The declarative path: yodel apply dev plans src/ against dev and runs this
// Op, behind a gate bound to the plan.
export const { op: applyDev } = ApplyOp({ name: "apply-dev", env: "dev", target: "clickhouse", gate: {} });
```

The Op builds the project first with `npm run build`, so `package.json` needs a `build` script that writes chant's build output:

```json
"scripts": { "build": "chant build src --lexicon sql -o dist/schema.json" }
```

Without it the Op fails at its Build step (`npm error Missing script: "build"`).

The run below is the ClickHouse example's first apply. The Op stops at its gate and `yodel apply` exits 3 with the command that approves this plan. Today that command is `npx yodel approve dev --plan <digest>`, which shows the plan, asks you to type `dev`, and records the approval of the digest the gate waits on; the runs below were recorded before yodel printed it, so they show and run chant's `chant approve`, which records the same approval:

<!-- quote: clickhouse#declarative-apply -->
```console
$ npx yodel apply dev
Plan for dev (clickhouse 26.8.15.10 at 127.0.0.1:8123, sql.profiles.dev)

shop
  [create] object: shop
      SQLCH200 Create an object. A new database, table, view, dictionary, function, user, role or row policy is created, or a grantee gets its first grants; nothing existing changes. https://clickhouse.com/docs/sql-reference/statements/create
events (shop.events)
  [create] object: shop.events
      SQLCH200 Create an object. A new database, table, view, dictionary, function, user, role or row policy is created, or a grantee gets its first grants; nothing existing changes. https://clickhouse.com/docs/sql-reference/statements/create

2 create

Access control: not managed in dev (off by default); policies, grants, roles and users are not planned.

Running apply-dev (<tmp>/clickhouse/ops/apply-dev.op.ts)

> sql-yodeler-example-clickhouse@0.0.0 build
> chant build src --lexicon sql -o dist/schema.json


fold: 1 file folded, 0 ran

sql — environment: dev
2 missing, 0 orphan, 0 disappeared, 0 newly observed, 0 drifted, 0 unchanged
--------------------------------------------------------------------------------

MISSING (declared, provider reports not in cloud):
  - events [queried http://127.0.0.1:8123 shop.events] [definition 9f20bfc4d4ef488a683af5646837a026beea36f8affb953ecfb1e118c3f4a21a]
  - shop [queried http://127.0.0.1:8123 shop] [definition aecfb2aa109301003bbc1a7ee057c2bb2610d824e610588317907171ed70c610]
[phase] Build
  ✓ chantBuild(path=.)   728ms
[phase] Plan
  ✓ lifecycleDiff(env=dev, live=true)   747ms
    [outcome] Drift=true
[phase] Approve
  • gate:approve-apply-dev()   skipped
[phase] Apply
  • nativeApply(target=clickhouse, env=dev, output=dist/schema.json, deleteMode=never)   skipped
Op "apply-dev" is gated on "approve-apply-dev" after 2.0s
  Approve apply to dev (delete mode: never)
  plan    : jcs1-sha256:02cfabc13e5ef7d0f1d089b4a5468afc3ed5140b9c2f04afad2203b470c933e8
  approve : chant approve apply-dev approve-apply-dev --plan jcs1-sha256:02cfabc13e5ef7d0f1d089b4a5468afc3ed5140b9c2f04afad2203b470c933e8
  expires : 2026-10-12T17:21:58.086Z

apply-dev is waiting at gate "approve-apply-dev" for approval of this plan.
Approve it with:
  chant approve apply-dev approve-apply-dev --plan jcs1-sha256:02cfabc13e5ef7d0f1d089b4a5468afc3ed5140b9c2f04afad2203b470c933e8
then run npx yodel apply dev again.
[exit 3]
```

<!-- quote: clickhouse#declarative-approve -->
```console
$ npx chant approve apply-dev approve-apply-dev --plan jcs1-sha256:02cfabc13e5ef7d0f1d089b4a5468afc3ed5140b9c2f04afad2203b470c933e8
Gate "approve-apply-dev" on "apply-dev" resolved by yodel at 2026-10-10T17:21:59.886Z
This approves the plan jcs1-sha256:02cfabc13e5ef7d0f1d089b4a5468afc3ed5140b9c2f04afad2203b470c933e8, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run apply-dev` and it walks through gate "approve-apply-dev".
```

Run again, the same command applies the plan; the [example](../examples/clickhouse/README.md#1-a-declared-schema-applied-without-migrations) shows that run, which ends `Applied: dev matches the declared schema.`

What the declarative path does and does not do:

- An `ApplyOp` with no `delete` option runs with delete mode `never` (its output says `delete mode: never`): a drop stays in the plan, and `yodel apply` says so when changes remain after the Op. `delete: "owned-only"` or `"gated"` on the `ApplyOp` lets it drop (chant's `ApplyOp` options).
- A change no statement makes in place (a ClickHouse sort-key change, a Postgres column rename or type change across kinds) makes `yodel plan` exit 3, and `yodel apply` applies nothing. Those changes are steps of a migration on the versioned path ([Data migrations](steps.md)).
- It keeps no history. What the database is, is what the live catalog says; `yodel drift` compares the two ([Drift](drift.md)).
- The topology comes from `sql.profiles.<env>.topology` only ([Topology](topology.md)).
- chant marks the objects it creates with an ownership marker in their comment (`[chant managed-by=chant]`) and never touches an object the project does not declare.

### Review on a pull request

A pull request on this path gets the same review as one on the versioned path, read from the plan rather than from a migration:

```sh
npx yodel lint                # offline: the declared schema's checks
npx yodel lint --env dev      # and the planned changes against dev
npx yodel plan dev --comment  # the plan comment, with the findings and the policy
```

- `yodel lint`, with no server, runs the sql lexicon's schema checks (`SQLCH1xx`, `SQLPG1xx`), the project's own checks (`chant.config.ts` `lint.policies`) and `lint.naming` over the build of `src/`. With `--env <env>` it also plans `src/` against that environment and checks each planned change against the rules that read a change's rule and class: `destructive`, `pg-rewrite`, `pg-access`, `ch-mutation`, `ch-rebuild`, `ch-access`, and `refused-step` for a change that needs its own Op. The plan carries no statement, so `pg-lock`, `data-dependent` and `pg-signature`, which read one, are for migrations.
- Nothing is silenced here, since there is no `migration.sql` to hold a `-- yodel:allow` line. `yodel.config.ts` `lint.rules` sets a rule's level, as on the versioned path.
- `yodel plan <env>` prints chant's plan with those findings, each policy rule's outcome (`yodel.config.ts` `policy`, read at the base commit) and how the ApplyOp's gate is approved. When `yodel apply` would refuse the plan (a change that needs its own Op, a live object it could not read, or a policy denial), the approval section and `--json`'s `approval.message` say what to do instead, and there is no `approval.command`. `--comment` posts it on the pull request, updating the one posted before, with the same marker the versioned comment uses. The comment names no server address. `yodel ci` already renders the `plan-<env>` job that runs it.
- A policy rule sees one entry in `pending`, `declared`, whose steps are the planned changes (each a `statement` with its object, class, rule and `destructive`, and no `sql`), and `plan.declarative` is `true`. A rule that denies the plan makes `yodel apply` refuse (exit 7) before the ApplyOp runs. `yodel override <env> --rule <id> --reason <text>` records an override for exactly these changes, under the ApplyOp's name; it stops counting once the live database or `src/` moves, and `yodel apply` spends it once the ApplyOp applies, not when it stops at the gate. The gate still asks for its own approval.

## What each path has

| | Declarative | Versioned |
|---|---|---|
| `yodel plan`, the plan-bound gate, `yodel approve` | yes | yes |
| The plan comment (`yodel plan --comment`) | yes | yes |
| `yodel lint` | the declared schema offline, the planned changes with `--env` | every migration, offline |
| Silences (`-- yodel:allow`) | no: no `migration.sql` | yes |
| Plan policy and overrides | yes, over the planned changes | yes, over the pending migrations |
| `yodel drift` | against the declared schema | against the newest applied migration's recorded schema |
| History, resume, `yodel report`, `yodel revert` | no history | yes |
| `--allow-out-of-order`, `yodel rebase`, `yodel repair` | no: there are no migrations to order | yes |
| The replay check (`yodel lint --replay`) | no | yes |
| Data migrations: rebuild, backfill and expand-and-contract steps | no: a change that needs one exits 3 | yes |
| Waves and their gate policies (`always`, `on-destructive`, `never`) | no: a wave plans and applies migrations | yes |
| Tenant sets | no | yes |
| The apply lock and `--lock-wait` | no: chant's ApplyOp applies | yes |

A project that needs something from the versioned column moves to the versioned path ([Moving from one to the other](#moving-from-one-to-the-other)).

## Versioned: migrations written from the declared schema

The declared schema stays the source. `yodel new <name>` writes the next migration by diffing it against the schema the newest migration recorded, with no database involved. Each change goes through review as a pull request holding the edit to `src/` and the migration it produced:

```sh
$EDITOR src/schema.ts
npx yodel new add-country     # writes migrations/<timestamp>-add-country/
npx yodel lint                # offline; CI runs it on every pull request
npx yodel plan dev            # the pending migrations and the plan digest
npx yodel apply dev           # behind the migrations Op's gate
```

`yodel apply` on this path runs the pending migrations in chain order, statement by statement, recording each in the history table under a lock, and resumes a migration that failed part way at the statement that failed. A change that is not one statement (a rebuild, a backfill, an expand-and-contract column change) is a step inside the migration, recorded in the same history. [Migrations](migrations.md) has the details, and [Data migrations](steps.md) the steps.

## More than one environment

Each environment is a profile in `chant.config.ts`, with its own history. The starter templates' apply pipeline applies them in the order of `yodel.config.ts` `waves` after every push to main, one job per environment, each waiting for the one before; a wave that stops at its gate stops the ones after it. Each wave has its own gate policy (`always`, `on-destructive` or `never`), read from the commit the push merged onto, and applies only migrations the environment before it has applied: prod refuses (exit 3) a migration staging's history does not record. [Approval](approval.md#waves-a-gate-per-environment) has how a wave plans, waits and applies.

## The pipelines: yodel ci

`yodel ci` renders a project's pipelines for GitHub Actions, GitLab CI and Forgejo Actions from `chant.config.ts` (the environments), `yodel.config.ts` (`waves`, `ci`) and `ops/` (each environment's migrate and watch Ops), each declared with chant's lexicons: `yodel-pr` (lint, the replay check and the plan comment on a pull request), `yodel-apply` (the waves, after a push to main) and a `watch-<env>` per environment. The templates' `npm run ci` runs it. [Setting up each forge](forges.md) has the secrets, tokens and runner each forge needs for them.

`ci: { apply: false }` leaves out `yodel-apply` and `yodel-waves.json` on every forge, for a team that wants lint and the plan comment on pull requests before CI applies anything: [Lint and plan on pull requests only](lint-and-plan.md).

The pipelines come from the installed package, so a fix to them reaches a project when it upgrades `@intentius/sql-yodeler` and runs `yodel ci` again. `yodel ci --check` writes nothing and exits 1 naming each file that differs from what it renders; the pull request's lint job runs it, so a pipeline edited by hand, or not rendered again after an upgrade, fails the pull request until the rendered files are committed. `yodel ci --replay` runs the lint job's replay check on your machine, in a throwaway server it starts with Docker.

`ci.forges` in `yodel.config.ts` picks the forges (default all three). A project's own jobs go in the module `ci.jobs` names, declared with chant, never in the rendered files:

```ts
// ci/jobs.ts, with ci: { jobs: "ci/jobs.ts" } in yodel.config.ts
import { Job, Step } from "@intentius/chant-lexicon-github";
import { Image, Job as GitLabJob } from "@intentius/chant-lexicon-gitlab";

export const actions = {
  test: new Job({ "runs-on": "ubuntu-latest", steps: [new Step({ uses: "actions/checkout@v7" }), new Step({ run: "npm ci && npm test" })] }),
};
export const gitlab = {
  test: new GitLabJob({ stage: "test", image: new Image({ name: "node:22" }), script: ["npm ci", "npm test"] }),
};
```

`yodel ci` adds `actions` to `yodel-pr` on GitHub and Forgejo and `gitlab` to `.gitlab-ci.yml`, after its own jobs, with a GitLab job's stage after `review`, so they are there after every render. A job with the name of one of yodel's (`lint`, `plan-<env>`, `.yodel`) is refused.

By default every job runs in `node:22-bookworm` (GitHub's plan jobs on the runner, with `setup-node`) and installs the project's packages with `npm ci`. `ci.image` runs every job in the CI image instead, `ghcr.io/intentius/sql-yodeler:<version>@sha256:<digest>`, which a release publishes with Node, yodel, chant and the lexicons on it: no job runs `npm ci` or `setup-node`, and a checkout resolves chant and the lexicons from the image. It is taken only pinned by its digest, which the release's `image` job writes to its summary, so a job never runs a different image under the same tag. Use the version the project's `package.json` installs, so the image's yodel renders the same pipelines `yodel ci --check` compares; a project whose jobs need packages of their own leaves `image` unset.

### Upgrading the pipelines to chant 0.124.56

From chant 0.124.56 the pipelines run on chant's product pipeline, the one terragucci and plywood use ([SQL Yodeler on chant CI](chant-ci.md#from-chant-012456) has each part). A project made from a template before then, or one whose chant is older, moves in one commit:

1. Install SQL Yodeler's latest release, then chant and the sql lexicon at the floor, pinned as the templates pin them:

   ```sh
   npm install @intentius/sql-yodeler@latest
   npm install -E @intentius/chant@0.124.56 @intentius/chant-lexicon-sql@0.124.56
   ```

2. Run `npx yodel upgrade`. It lists the parts of chant CI the installed chant has, adds `chant.workspace.json` when the project has no workspace declaration, and renders every file `yodel ci` renders. `yodel upgrade --check` writes nothing and names the files it would write. With a chant before 0.124.56 it writes nothing, exits 1 and prints the install line above.

3. Commit what it wrote with `package.json` and `package-lock.json`, in one commit, and open a pull request.

The files that change, for each forge the project renders:

| File | What changes |
|---|---|
| `chant.workspace.json` | new, when the project had no workspace declaration: the project as the workspace, with yodel's checks in `ci.hooks.check` |
| `yodel-waves.json` | `gateName`, the `sql-migrate` step in place of the `plan` and `apply` command lines, `standDown: true`, and, when the project has steps, only the `before.plan` SQL checks in its hooks |
| `.github/workflows/yodel-apply.yml`, `.forgejo/workflows/yodel-apply.yml`, `.gitlab/yodel-apply.gitlab-ci.yml` | each wave job runs `yodel chant run wave`, with no `YODEL_LOCK_WAIT` or `YODEL_STAND_DOWN`; on GitHub and GitLab a wave job whose writer a cloud token source mints logs in through chant |
| `.github/workflows/yodel-pr.yml`, `.forgejo/workflows/yodel-pr.yml`, `.gitlab-ci.yml` | the lint job runs `yodel chant ci check --base <base>` in place of its own steps; on GitHub and GitLab a plan job whose reader a cloud token source mints logs in through chant |
| `watch-<env>.yml` on GitHub and Forgejo, `.gitlab/yodel-watch.gitlab-ci.yml` | `yodel chant run watch-<env>` |
| `yodel-apply-plans.yml`, `yodel-apply-resume.yml` (GitHub and Forgejo, when the project has them) | `yodel chant` in place of `chant` |

With `chant.workspace.json` in it the project is a workspace root, where `chant build` and `chant lint` refuse with WSP000 unless they build the root project alone. yodel's own builds pass `--root-only`; for the ones you run yourself, add `rootOnly: true` to `chant.config.ts`, as the templates have it.

chant reads the check hooks from the declaration at the pull request's base, and the upgrade's own pull request has none there, so its lint job runs no hook and says so in its log. From the next pull request on, the hooks run. The secrets, the gates and the approvals already recorded stay as they are.

## ClickHouse objects

A ClickHouse project declares these with the `sql` lexicon's tags, from `@intentius/chant-lexicon-sql/clickhouse`. Both paths plan and apply them, `yodel drift` watches them, and `yodel init --from` adopts them. The claims column names the scenario claims that run each against a server.

| Object | Tag | Claims |
| --- | --- | --- |
| Database | `database` | declarative, new, adopt |
| Table | `table` | declarative, new, adopt |
| View and materialized view | `view` | adopt |
| Dictionary | `dictionary` | declarative, adopt |
| Function (a SQL lambda) | `func` | declarative, adopt |
| User | `user` | declarative, adopt |
| Role | `role` | declarative, adopt |
| Row policy | `policy` | declarative, adopt |
| Grant | `grant` | declarative, adopt |

Dictionaries and functions:

- A dictionary's changed comment is SQLCH203. Any other change (its source, layout, lifetime, attributes) is SQLCH245, applied as one `CREATE OR REPLACE DICTIONARY`.
- A function belongs to no database. A changed lambda is SQLCH260, applied as `CREATE OR REPLACE FUNCTION`; the server prints `x * k` as `(x * k)`, and the plan asks the server's formatter before calling that a change. A function cannot carry chant's ownership marker, so it is never pruned and a function made by hand is never read. `yodel init --from` adopts the SQL functions `sql.profiles.<env>.importFunctions` names (names, or prefixes ending in `*`), and the functions those call; it warns naming each function on the server it leaves out. It also adopts a function an adopted view or column default calls: ClickHouse stores the function's body in place of the call, and chant's import matches that body to the function, so a function in use needs no entry in the list.
- Users, roles, row policies and grants are planned only where the environment manages access ([Access control](access.md#clickhouse)).

## Postgres objects

A Postgres project declares these with the `sql` lexicon's tags, and both paths plan, apply, watch for drift and adopt them. The claims column names the scenario claims that run each against a server.

| Object | Tag | Claims |
| --- | --- | --- |
| Schema | `schema` | declarative, new, adopt |
| Table | `table` | declarative, new, adopt |
| Index | `index` | declarative, new, adopt |
| Function | `func` | declarative, new, adopt |
| Procedure | `procedure` | declarative, new |
| Trigger | `trigger` | declarative, new, adopt |
| View and materialized view, sequence, enum, domain, extension | `view`, `sequence`, `type`, `domain`, `extension` | none yet |

Functions, procedures and triggers:

- A function or procedure is its name and its parameter types, so two overloads are two objects. A new body or new attributes are `CREATE OR REPLACE` (SQLPG280, metadata). A change `CREATE OR REPLACE` refuses (the result type, an output parameter, an input parameter's name, a removed default, or other parameter types between two builds) is a drop and a create in one transaction (SQLPG281); while a view, trigger, default or other routine depends on the function it is an expand change (SQLPG282), which `yodel new` writes as a manual step.
- A trigger is its name on its table. Created on a table that already exists, it takes SHARE ROW EXCLUSIVE on that table (SQLPG283, metadata); created with its table, it is part of the create (SQLPG200). A changed trigger is `CREATE OR REPLACE TRIGGER` (SQLPG284), and a dropped one is SQLPG285.
- Statements go in dependency order: a function before the trigger that runs it and after the tables its body names, and a trigger dropped before its function.
- `yodel lint` flags a migration that drops and creates a function or procedure with another signature (`pg-signature`), and one that drops a function a declared trigger still executes (`pg-routine-in-use`); see [Lint](lint.md).
- `yodel drift` reports a function replaced by hand and a declared trigger that is gone. `yodel init --from` adopts the functions, procedures and triggers in the profile's schemas with the tables.
- On the declarative path, a function or trigger on the server that the project does not declare shows in `yodel plan` as a drop, the way an undeclared table does. Only a prune makes it, and only for an object carrying chant's ownership marker. A migration never drops one unless an earlier migration declared it.
- A routine with a SQL-standard body (`RETURN ...`, `BEGIN ATOMIC`) cannot be declared: the server stores it rewritten. `init --from` leaves one out with a warning.

## Moving from one to the other

A project on the declarative path moves to the versioned one with `yodel init --from <env>`: it imports the live database into `src/`, writes the baseline migration that creates all of it, and records the baseline applied in the environment's history without running it. With `src/` already declaring the schema, `--force` lets it write over the declarations. Then the `ApplyOp` gives way to a migrations Op. Both examples start declarative and move this way; [Starting a project](adoption.md) has the run.

Going back is deleting `migrations/` and adding an `ApplyOp`. The history table stays in the database, unread.
