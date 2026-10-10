# Claims status

<!-- Written by `npm run claims:page` from scenarios/claims-record.json. Do not edit by hand. -->

Each scenario claim (`scenarios/claims/`) is a promise the docs make, run against chant's emulator. A claim runs twice: plain, where it should pass, and broken (`BREAK=1`), where the claim's own check should catch the fault it plants. `npm run claims` runs them; see the comment at the top of `scenarios/run.ts`.

The record was last written at 2026-10-10 03:08 UTC, at commit `322e789`. A row run in an earlier run keeps that run's commit and date.

A row marked "not recorded" has not been run into the record. CI does not run the template claim, which needs a Forgejo with a runner.

| Claim | Dialect | What it says | Plain | Broken | Commit | Date |
|---|---|---|---|---|---|---|
| adopt | ClickHouse | yodel init --from adopts a live database without touching it, and yodel plan then shows no change | pass | caught | `322e789` | 2026-10-10 03:08 UTC |
| adopt | Postgres | yodel init --from adopts a live database without touching it, and yodel plan then shows no change | pass | caught | `322e789` | 2026-10-10 03:08 UTC |
| new | ClickHouse | yodel new writes the next migration offline, with no dev database, and it applies | pass | caught | `322e789` | 2026-10-10 03:08 UTC |
| new | Postgres | yodel new writes the next migration offline, with no dev database, and it applies | pass | caught | `322e789` | 2026-10-10 03:08 UTC |
| lint-ci | ClickHouse | yodel lint, offline, fails a migrations directory with a fork (exit 3), naming both migrations | pass | caught | `322e789` | 2026-10-10 03:08 UTC |
| lint-ci | Postgres | yodel lint, offline, fails a migrations directory with a fork (exit 3), naming both migrations | pass | caught | `322e789` | 2026-10-10 03:08 UTC |
| pr-comment | ClickHouse | the pull request comment lists the pending migrations with each statement's class, and the digest the gate asks for | pass | caught | `322e789` | 2026-10-10 03:08 UTC |
| pr-comment | Postgres | the pull request comment lists the pending migrations with each statement's class, and the digest the gate asks for | pass | caught | `322e789` | 2026-10-10 03:08 UTC |
| approve-and-apply | ClickHouse | a pending migration applies only after chant approve of its plan digest, and the history records that digest | pass | caught | `322e789` | 2026-10-10 03:08 UTC |
| approve-and-apply | Postgres | a pending migration applies only after chant approve of its plan digest, and the history records that digest | pass | caught | `322e789` | 2026-10-10 03:08 UTC |
| digest-moved | ClickHouse | an approval is refused once the migration changed after it, and nothing is applied | pass | caught | `322e789` | 2026-10-10 03:08 UTC |
| digest-moved | Postgres | an approval is refused once the migration changed after it, and nothing is applied | pass | caught | `322e789` | 2026-10-10 03:08 UTC |
| resume | ClickHouse | a migration that failed part way resumes at the statement that failed, never resending one that ran | pass | caught | `322e789` | 2026-10-10 03:08 UTC |
| resume | Postgres | a migration that failed part way resumes at the statement that failed, never resending one that ran | pass | caught | `322e789` | 2026-10-10 03:08 UTC |
| out-of-order | ClickHouse | a migration merged late, before one already applied, is refused unless --allow-out-of-order, and never skipped | pass | caught | `322e789` | 2026-10-10 03:08 UTC |
| out-of-order | Postgres | a migration merged late, before one already applied, is refused unless --allow-out-of-order, and never skipped | pass | caught | `322e789` | 2026-10-10 03:08 UTC |
| rebuild-refused | ClickHouse | ClickHouse: a sort-key change is a rebuild step that does not run without an approval, never an ALTER or a drop | pass | caught | `322e789` | 2026-10-10 03:08 UTC |
| rebuild-as-step | ClickHouse | ClickHouse: an approved sort-key change runs as a ClickHouseRebuildOp step inside the migration, keeping every row | pass | caught | `322e789` | 2026-10-10 03:08 UTC |
| backfill-resumed | ClickHouse | a hand-written backfill step interrupted part way resumes from its receipts, running each batch once | pass | caught | `322e789` | 2026-10-10 03:08 UTC |
| backfill-resumed | Postgres | a hand-written backfill step interrupted part way resumes from its receipts, running each batch once | pass | caught | `322e789` | 2026-10-10 03:08 UTC |
| drift | ClickHouse | yodel drift reports a declared object changed out of band, naming the property, and one dropped | pass | caught | `322e789` | 2026-10-10 03:08 UTC |
| drift | Postgres | yodel drift reports a declared object changed out of band, naming the property, and one dropped | pass | caught | `322e789` | 2026-10-10 03:08 UTC |
| declarative | ClickHouse | the declarative path: yodel plan shows the change against the live server and yodel apply makes it behind the plan-bound gate | pass | caught | `322e789` | 2026-10-10 03:08 UTC |
| declarative | Postgres | the declarative path: yodel plan shows the change against the live server and yodel apply makes it behind the plan-bound gate | pass | caught | `322e789` | 2026-10-10 03:08 UTC |
| replay | ClickHouse | yodel lint --replay replays the migrations into a fresh database and each gives the schema it recorded | pass | caught | `322e789` | 2026-10-10 03:08 UTC |
| replay | Postgres | yodel lint --replay replays the migrations into a fresh database and each gives the schema it recorded | pass | caught | `322e789` | 2026-10-10 03:08 UTC |
| topology | ClickHouse | ClickHouse: one migrations directory applies to a single node and to a Replicated database, each rendered for its topology | pass | caught | `322e789` | 2026-10-10 03:08 UTC |
| template | ClickHouse | a project from the starter template, on Forgejo: apply only after approval, lint with replay and the plan comment on a pull request, and the approved change applied on merge | not recorded | not recorded | | |
| template | Postgres | a project from the starter template, on Forgejo: apply only after approval, lint with replay and the plan comment on a pull request, and the approved change applied on merge | not recorded | not recorded | | |
| template-github | ClickHouse | a project from the starter template, on GitHub Actions (act and a mock GitHub): apply only after approval, lint with replay and the plan comment on a pull request, and the approved change applied on merge | not recorded | not recorded | | |
| template-github | Postgres | a project from the starter template, on GitHub Actions (act and a mock GitHub): apply only after approval, lint with replay and the plan comment on a pull request, and the approved change applied on merge | not recorded | not recorded | | |
| template-gitlab | ClickHouse | a project from the starter template, on GitLab CI: apply only after approval, lint with replay and the plan comment on a merge request, and the approved change applied on merge | not recorded | not recorded | | |
| template-gitlab | Postgres | a project from the starter template, on GitLab CI: apply only after approval, lint with replay and the plan comment on a merge request, and the approved change applied on merge | not recorded | not recorded | | |
| lock-retry | Postgres | Postgres: a statement blocked behind another session's lock times out at lock_timeout and is retried until it succeeds | pass | caught | `322e789` | 2026-10-10 03:08 UTC |
| column-change | Postgres | Postgres: a column rename runs as a PostgresMigrationOp step (expand, backfill, switch, contract) and keeps every value | pass | caught | `322e789` | 2026-10-10 03:08 UTC |
