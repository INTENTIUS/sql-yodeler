---
claims: []
---

# Claims status

<!-- Written by `npm run claims:page` from scenarios/claims-record.json. Do not edit by hand. -->

Each scenario claim (`scenarios/claims/`) is a promise the docs make, run against chant's emulator. A claim runs twice: plain, where it should pass, and broken (`BREAK=1`), where the claim's own check should catch the fault it plants. `npm run claims` runs them; see the comment at the top of `scenarios/run.ts`.

The record was last written at 2026-10-10 06:38 UTC, at commit `856a189`. A row run in an earlier run keeps that run's commit and date.

A row marked "not recorded" has not been run into the record. CI does not run the template claim, which needs a Forgejo with a runner.

Each docs page names the claims that prove it, and `npm run check` fails when a page that is not a draft names one that does not pass plain and get caught broken here. The last column lists those pages.

| Claim | Dialect | What it says | Plain | Broken | Commit | Date | Pages |
|---|---|---|---|---|---|---|---|
| adopt | ClickHouse | yodel init --from adopts a live database without touching it, and yodel plan then shows no change | pass | caught | `322e789` | 2026-10-10 03:08 UTC | [adoption](adoption.md) |
| adopt | Postgres | yodel init --from adopts a live database without touching it, and yodel plan then shows no change | pass | caught | `322e789` | 2026-10-10 03:08 UTC | [adoption](adoption.md) |
| new | ClickHouse | yodel new writes the next migration offline, with no dev database, and it applies | pass | caught | `322e789` | 2026-10-10 03:08 UTC | [adoption](adoption.md), [getting-started](getting-started.md), [migrations](migrations.md), [workflows](workflows.md) |
| new | Postgres | yodel new writes the next migration offline, with no dev database, and it applies | pass | caught | `322e789` | 2026-10-10 03:08 UTC | [adoption](adoption.md), [getting-started](getting-started.md), [migrations](migrations.md), [workflows](workflows.md) |
| lint-ci | ClickHouse | yodel lint, offline, fails a migrations directory with a fork (exit 3), naming both migrations | pass | caught | `322e789` | 2026-10-10 03:08 UTC | [getting-started](getting-started.md), [lint](lint.md) |
| lint-ci | Postgres | yodel lint, offline, fails a migrations directory with a fork (exit 3), naming both migrations | pass | caught | `322e789` | 2026-10-10 03:08 UTC | [getting-started](getting-started.md), [lint](lint.md) |
| pr-comment | ClickHouse | the pull request comment lists the pending migrations with each statement's class, and the digest the gate asks for | pass | caught | `322e789` | 2026-10-10 03:08 UTC | [approval](approval.md) |
| pr-comment | Postgres | the pull request comment lists the pending migrations with each statement's class, and the digest the gate asks for | pass | caught | `322e789` | 2026-10-10 03:08 UTC | [approval](approval.md) |
| approve-and-apply | ClickHouse | a pending migration applies only after chant approve of its plan digest, and the history records that digest | pass | caught | `322e789` | 2026-10-10 03:08 UTC | [approval](approval.md), [getting-started](getting-started.md), [migrations](migrations.md), [workflows](workflows.md) |
| approve-and-apply | Postgres | a pending migration applies only after chant approve of its plan digest, and the history records that digest | pass | caught | `322e789` | 2026-10-10 03:08 UTC | [approval](approval.md), [getting-started](getting-started.md), [migrations](migrations.md), [workflows](workflows.md) |
| digest-moved | ClickHouse | an approval is refused once the migration changed after it, and nothing is applied | pass | caught | `322e789` | 2026-10-10 03:08 UTC | [approval](approval.md) |
| digest-moved | Postgres | an approval is refused once the migration changed after it, and nothing is applied | pass | caught | `322e789` | 2026-10-10 03:08 UTC | [approval](approval.md) |
| resume | ClickHouse | a migration that failed part way resumes at the statement that failed, never resending one that ran | pass | caught | `322e789` | 2026-10-10 03:08 UTC | [migrations](migrations.md) |
| resume | Postgres | a migration that failed part way resumes at the statement that failed, never resending one that ran | pass | caught | `322e789` | 2026-10-10 03:08 UTC | [migrations](migrations.md) |
| out-of-order | ClickHouse | a migration merged late, before one already applied, is refused unless --allow-out-of-order, and never skipped | pass | caught | `322e789` | 2026-10-10 03:08 UTC | [migrations](migrations.md) |
| out-of-order | Postgres | a migration merged late, before one already applied, is refused unless --allow-out-of-order, and never skipped | pass | caught | `322e789` | 2026-10-10 03:08 UTC | [migrations](migrations.md) |
| rebuild-refused | ClickHouse | ClickHouse: a sort-key change is a rebuild step that does not run without an approval, never an ALTER or a drop | pass | caught | `322e789` | 2026-10-10 03:08 UTC | [steps](steps.md) |
| rebuild-as-step | ClickHouse | ClickHouse: an approved sort-key change runs as a ClickHouseRebuildOp step inside the migration, keeping every row | pass | caught | `322e789` | 2026-10-10 03:08 UTC | [steps](steps.md) |
| backfill-resumed | ClickHouse | a hand-written backfill step interrupted part way resumes from its receipts, running each batch once | pass | caught | `322e789` | 2026-10-10 03:08 UTC | [steps](steps.md) |
| backfill-resumed | Postgres | a hand-written backfill step interrupted part way resumes from its receipts, running each batch once | pass | caught | `322e789` | 2026-10-10 03:08 UTC | [steps](steps.md) |
| drift | ClickHouse | yodel drift reports a declared object changed out of band, naming the property, and one dropped | pass | caught | `322e789` | 2026-10-10 03:08 UTC | [drift](drift.md), [getting-started](getting-started.md) |
| drift | Postgres | yodel drift reports a declared object changed out of band, naming the property, and one dropped | pass | caught | `322e789` | 2026-10-10 03:08 UTC | [drift](drift.md), [getting-started](getting-started.md) |
| declarative | ClickHouse | the declarative path: yodel plan shows the change against the live server and yodel apply makes it behind the plan-bound gate | pass | caught | `322e789` | 2026-10-10 03:08 UTC | [workflows](workflows.md) |
| declarative | Postgres | the declarative path: yodel plan shows the change against the live server and yodel apply makes it behind the plan-bound gate | pass | caught | `322e789` | 2026-10-10 03:08 UTC | [workflows](workflows.md) |
| replay | ClickHouse | yodel lint --replay replays the migrations into a fresh database and each gives the schema it recorded | pass | caught | `322e789` | 2026-10-10 03:08 UTC | [lint](lint.md) |
| replay | Postgres | yodel lint --replay replays the migrations into a fresh database and each gives the schema it recorded | pass | caught | `322e789` | 2026-10-10 03:08 UTC | [lint](lint.md) |
| topology | ClickHouse | ClickHouse: one migrations directory applies to a single node and to a Replicated database, each rendered for its topology | pass | caught | `322e789` | 2026-10-10 03:08 UTC | [configuration](configuration.md), [topology](topology.md) |
| template | ClickHouse | a project from the starter template, on Forgejo: apply only after approval, lint with replay and the plan comment on a pull request, and the approved change applied on merge | not recorded | not recorded | | |  |
| template | Postgres | a project from the starter template, on Forgejo: apply only after approval, lint with replay and the plan comment on a pull request, and the approved change applied on merge | not recorded | not recorded | | |  |
| template-github | ClickHouse | a project from the starter template, on GitHub Actions (act and a mock GitHub): apply only after approval, lint with replay and the plan comment on a pull request, and the approved change applied on merge | not recorded | not recorded | | |  |
| template-github | Postgres | a project from the starter template, on GitHub Actions (act and a mock GitHub): apply only after approval, lint with replay and the plan comment on a pull request, and the approved change applied on merge | not recorded | not recorded | | |  |
| template-gitlab | ClickHouse | a project from the starter template, on GitLab CI: apply only after approval, lint with replay and the plan comment on a merge request, and the approved change applied on merge | not recorded | not recorded | | |  |
| template-gitlab | Postgres | a project from the starter template, on GitLab CI: apply only after approval, lint with replay and the plan comment on a merge request, and the approved change applied on merge | not recorded | not recorded | | |  |
| lock-retry | ClickHouse | Postgres: a statement blocked behind another session's lock times out at lock_timeout and is retried until it succeeds; Postgres and ClickHouse with Keeper: two applies at once never send a statement twice, the second waits naming the holder, and --stand-down steps aside for a newer commit | pass | caught | `856a189` | 2026-10-10 06:38 UTC | [migrations](migrations.md) |
| lock-retry | Postgres | Postgres: a statement blocked behind another session's lock times out at lock_timeout and is retried until it succeeds; Postgres and ClickHouse with Keeper: two applies at once never send a statement twice, the second waits naming the holder, and --stand-down steps aside for a newer commit | pass | caught | `856a189` | 2026-10-10 06:38 UTC | [migrations](migrations.md) |
| column-change | Postgres | Postgres: a column rename runs as a PostgresMigrationOp step (expand, backfill, switch, contract) and keeps every value | pass | caught | `322e789` | 2026-10-10 03:08 UTC | [steps](steps.md) |
