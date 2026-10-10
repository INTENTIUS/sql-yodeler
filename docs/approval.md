# Approval

`yodel apply` applies only a plan someone approved, on both paths. The approval is chant's (the [Glossary](glossary.md) has the terms): a gate in an Op, bound to a plan digest, resolved with `chant approve`, and kept on the `chant/lifecycle` branch of the project's git repository. yodel keeps no approval store of its own. The output quoted here is from the examples' runs; `...` marks lines left out.

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

It is chant's plan digest (`jcs1-sha256:...`), so `chant approve <op> <gate> --plan <digest>` takes it. `yodel plan <env>` prints it with the command that approves it:

<!-- quote: clickhouse#plan -->
```console
$ npx yodel plan dev
Plan for dev (clickhouse 26.8.15.10 at 127.0.0.1:8123, history yodeler.history (single (default))): 1 applied, 1 pending

20261010T0521-add-country
  0  statement  SQLCH201 metadata  shop.events
       ALTER TABLE `shop`.`events` ADD COLUMN country LowCardinality(String) DEFAULT '' AFTER `at`

Plan digest: jcs1-sha256:8f73c4f9a14d6343a433b3724fed15990c116f6f28c7bc561173a1387fa09f3b
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:8f73c4f9a14d6343a433b3724fed15990c116f6f28c7bc561173a1387fa09f3b

Not approved yet. Approving binds exactly this digest; if anything it covers changes before the apply runs, the gate asks again and nothing is applied.
```

`yodel status <env>` prints it too, and `yodel apply <env> --plan` prints the pending migrations and the digest without applying.

## Approving

<!-- quote: clickhouse#approve -->
```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:8f73c4f9a14d6343a433b3724fed15990c116f6f28c7bc561173a1387fa09f3b
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-10T05:22:26.084Z
This approves the plan jcs1-sha256:8f73c4f9a14d6343a433b3724fed15990c116f6f28c7bc561173a1387fa09f3b, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

The approval is a commit on the local `chant/lifecycle` branch. Push it (`git push origin chant/lifecycle`) so CI sees it: every job in the starter templates fetches that branch first. In the templates, the pull request comment ends with the approve command; approve before merging, and the apply job after the merge goes through. A merge with nothing approved applies nothing and fails with the command to run; approve, push, and run the apply job again.

Then `yodel apply` runs through the gate:

<!-- quote: clickhouse#apply -->
```console
$ npx yodel apply dev
...
Running migrate-dev (<tmp>/clickhouse/ops/migrate-dev.op.ts)
lock: no KeeperMap on this server (KeeperMap is disabled because 'keeper_map_path_prefix' config is not defined. (BAD_ARGUMENTS) (version 26.8.15.10 (official build))); the lock is a file on this machine, so cross-runner locking needs Keeper (and keeper_map_path_prefix)
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:8f73c4f9a14d6343a433b3724fed15990c116f6f28c7bc561173a1387fa09f3b, by yodel at 2026-10-10T05:22:26.084Z
20261010T0521-add-country: applying
  statement 0: ok (SQLCH201 metadata, shop.events)
20261010T0521-add-country: applied
...
```

### On your own machine

yodel prints the approve command as `chant approve ...`. In a project, chant is installed in `node_modules`, so run it with `npx` in front. To skip copying the digest, let `yodel apply <env> --digest` print it into the command:

```sh
npx chant approve migrate-dev approve-migrate-dev --plan "$(npx yodel apply dev --digest)"
npx yodel apply dev
```

It is the same approval, bound to the plan as it is when you run it. In a repository with no remote, chant warns that the approval (and the pending record `yodel apply` writes at the gate) was not pushed; on your own machine that is expected.

## The pull request comment

`yodel plan <env> --comment` posts the plan as one comment per environment on the pull (merge) request, and updates that comment on the next push rather than adding another. `--format markdown` prints the same Markdown without posting. From the ClickHouse example, for its rebuild:

<!-- quote: clickhouse#comment -->
````console
$ npx yodel plan dev --format markdown
<!-- yodel:plan env=dev -->
### yodel plan: `dev`

ClickHouse, history `yodeler.history (single (default))`: 2 applied, **1 pending**.

#### `20261010T0522-events-by-id`

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

Plan digest the apply gate binds: `jcs1-sha256:6b6cd61948bd060182ffc3de080343ea86b7336ab96c4a1af7d08e6f3036577c`

Approve it with:

```sh
chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:6b6cd61948bd060182ffc3de080343ea86b7336ab96c4a1af7d08e6f3036577c
```

The newest approval of `approve-migrate-dev`, by yodel at 2026-10-10T05:22:26.084Z, is for `jcs1-sha256:8f73c4f9a14d6343a433b3724fed15990c116f6f28c7bc561173a1387fa09f3b`, not this plan; it does not hold.
What moved (as far as yodel can tell): history changed: applied since: 20261010T0521-add-country (by yodel@example at 2026-10-10 05:22:43.085473); pending migrations changed: committed to since approval: 20261010T0522-events-by-id (048aec0 at 2026-10-09T23:22:54-06:00); live schema changed: as expected after the history change above: applying a migration changes the live schema, and yodel cannot rebuild the live schema as it was at approval, so it cannot confirm that nothing else in it changed.

<!-- yodel:subject eyJlbnZpcm9ubWVudCI6ImRldiIsImhpc3RvcnlEYXRhYmFzZSI6InlvZGVsZXIiLCJ0b3BvbG9neSI6eyJraW5kIjoic2luZ2xlIn0sImFwcGxpZWQiOlt7ImlkIjoiMjAyNjEwMTBUMDUyMS1iYXNlbGluZSIsImNoZWNrc3VtIjoic2hhMjU2OmIyOWEwYjEyOGZlYTUyZGY1NTIyOTMxNzAzODI4NTEzYjU5OTlkNGRiMmIxM2I1ZTczZmI5YWJhNzU3MDEzZWMifSx7ImlkIjoiMjAyNjEwMTBUMDUyMS1hZGQtY291bnRyeSIsImNoZWNrc3VtIjoic2hhMjU2OjZkMjNmY2U0YmE5YmExOTFkODIxM2VhMzU2ZDM1ODUxODFkNGEzZWFlZWQ5ZWVmNDAyNjI2YWYzOTljMDIyYzUifV0sInBlbmRpbmciOlt7ImlkIjoiMjAyNjEwMTBUMDUyMi1ldmVudHMtYnktaWQiLCJjaGVja3N1bSI6InNoYTI1NjowMzIxMzU5ZjYyZjQ0NDYyNzQ2NGQ5OWJlZjRkMTQyMGYzMWE4NTE4ZmE0ZjZiN2JmMjE3YzczMTQ4MmU0NmI0IiwiZG9uZSI6W119XSwibGl2ZSI6InNoYTI1NjpiYTA4MzBmYjk2NjkzNWMzYTNiNmQ1Nzg3ODIwNGJhMzMzMzQxMTg2YzJkMzk4M2E3YTMwN2IxMjk4MmFiMmY1In0 -->
````

The hidden `yodel:subject` line at the end records the state the plan was made from; the next `--comment` run reads it from the comment it updates, to say what moved. The forge, the repository, the request and the API come from the CI job's environment:

| Forge | Detected by | Token |
|---|---|---|
| GitHub Actions | `GITHUB_ACTIONS=true` | `GITHUB_TOKEN`, with `pull-requests: write` |
| GitLab CI | `GITLAB_CI=true` | `GITLAB_TOKEN`: a project or personal access token with `api` scope (`CI_JOB_TOKEN` cannot write merge request notes) |
| Forgejo Actions | `FORGEJO_ACTIONS=true` or `GITEA_ACTIONS=true` (or a GitHub-style job whose API URL ends in `/api/v1`) | `FORGEJO_TOKEN`, else `GITHUB_TOKEN` |

Outside those, or to override them: `--forge github|gitlab|forgejo`, `--repo`, `--pr`, `--api-url`, and `--token-env <VAR>` for the variable that holds the token. The token is never a flag and never printed. The comment job needs only read credentials for the database; the starter templates give it the reader.

## When the digest moves

Anything the digest covers that changes after the approval (another migration, an edited one, another run applying first, a table changed out of band) makes a new digest, and the approval does not carry over. The gate asks again, nothing is applied, and yodel says what moved, as far as it can tell from the history and git.

In the ClickHouse example a plan is approved, then someone adds a column by hand before the apply runs:

<!-- quote: clickhouse#plan-add-source -->
```console
$ npx yodel plan dev
Plan for dev (clickhouse 26.8.15.10 at 127.0.0.1:8123, history yodeler.history (single (default))): 4 applied, 1 pending

20261010T0524-add-source
  0  statement  SQLCH201 metadata  shop.events
       ALTER TABLE `shop`.`events` ADD COLUMN source LowCardinality(String) DEFAULT 'web' AFTER `country`

Plan digest: jcs1-sha256:bca6651328f214c8a0b5be2ca786cd1ed1a533f06fa90610956e832da129a965
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:bca6651328f214c8a0b5be2ca786cd1ed1a533f06fa90610956e832da129a965

The newest approval of approve-migrate-dev, by yodel at 2026-10-10T05:24:15.830Z, is for jcs1-sha256:939dad30058556bc3a978732c63276c1cb3f598b77338a9de122bfdaba1b89e9, not this plan; it does not hold.
What moved: history changed: applied since: 20261010T0524-fill-country (by yodel@example at 2026-10-10 05:24:19.672518); pending migrations changed: new pending migration: 20261010T0524-add-source.
```

<!-- quote: clickhouse#approve-add-source -->
```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:bca6651328f214c8a0b5be2ca786cd1ed1a533f06fa90610956e832da129a965
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-10T05:24:23.872Z
This approves the plan jcs1-sha256:bca6651328f214c8a0b5be2ca786cd1ed1a533f06fa90610956e832da129a965, and only that plan. A run whose fresh plan differs refuses rather than applying it.
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
  ✓ shellCmd(cmd=yodel apply dev --digest)   859ms
[phase] Approve
  • gate:approve-migrate-dev()   skipped
    [refused] Gate "approve-migrate-dev" is approved, but not for this plan. approved: jcs1-sha256:bca6651328f214c8a0b5be2ca786cd1ed1a533f06fa90610956e832da129a965 (by yodel at 2026-10-10T05:24:23.872Z); planned: jcs1-sha256:2e8073454ea979bef82b3ea2aa511b1d2d1b6aab024ab63d4b03c523229df796. The configuration or the live system changed between that approval and this plan, so it needs a fresh one: chant approve migrate-dev approve-migrate-dev
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 1.5s
  plan    : jcs1-sha256:2e8073454ea979bef82b3ea2aa511b1d2d1b6aab024ab63d4b03c523229df796
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:2e8073454ea979bef82b3ea2aa511b1d2d1b6aab024ab63d4b03c523229df796
  expires : 2026-10-12T05:24:26.269Z

Nothing was applied. The approval of jcs1-sha256:bca6651328f214c8a0b5be2ca786cd1ed1a533f06fa90610956e832da129a965 (by yodel at 2026-10-10T05:24:23.872Z) does not hold: the plan moved since. What moved, as far as yodel can tell: live schema changed: no state yodel can rebuild from the history and git hashes to the approved digest with today's live schema, so an object in the environment's live schema (a table, view, index, dictionary, database or schema) changed since approval (or a part yodel cannot rebuild did).

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:2e8073454ea979bef82b3ea2aa511b1d2d1b6aab024ab63d4b03c523229df796).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:2e8073454ea979bef82b3ea2aa511b1d2d1b6aab024ab63d4b03c523229df796
then run yodel apply dev again.
[exit 3]
```

Dropping the column puts the live schema back, and the digest is the approved one again. The gate still asks again, because the refused run asked for approval after that approval was given; an approval holds only when it is newer than the latest request. `yodel plan` and `yodel apply` say so:

<!-- quote: clickhouse#asked-again-plan -->
```console
$ npx yodel plan dev
Plan for dev (clickhouse 26.8.15.10 at 127.0.0.1:8123, history yodeler.history (single (default))): 4 applied, 1 pending

20261010T0524-add-source
  0  statement  SQLCH201 metadata  shop.events
       ALTER TABLE `shop`.`events` ADD COLUMN source LowCardinality(String) DEFAULT 'web' AFTER `country`

Plan digest: jcs1-sha256:bca6651328f214c8a0b5be2ca786cd1ed1a533f06fa90610956e832da129a965
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:bca6651328f214c8a0b5be2ca786cd1ed1a533f06fa90610956e832da129a965

The newest approval of approve-migrate-dev, by yodel at 2026-10-10T05:24:23.872Z, is for this plan's digest, but approval was asked for again after it at 2026-10-10T05:24:26.269Z (a run holding jcs1-sha256:2e8073454ea979bef82b3ea2aa511b1d2d1b6aab024ab63d4b03c523229df796), so it does not hold; approve this plan again.
```

<!-- quote: clickhouse#asked-again-apply -->
```console
$ npx yodel apply dev
...
Op "migrate-dev" is gated on "approve-migrate-dev" after 1.4s
  plan    : jcs1-sha256:bca6651328f214c8a0b5be2ca786cd1ed1a533f06fa90610956e832da129a965
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:bca6651328f214c8a0b5be2ca786cd1ed1a533f06fa90610956e832da129a965
  expires : 2026-10-12T05:24:30.377Z

Nothing was applied. The approval of jcs1-sha256:bca6651328f214c8a0b5be2ca786cd1ed1a533f06fa90610956e832da129a965 (by yodel at 2026-10-10T05:24:23.872Z) is for this plan's digest, but approval was asked for again after it at 2026-10-10T05:24:26.269Z (a run holding jcs1-sha256:2e8073454ea979bef82b3ea2aa511b1d2d1b6aab024ab63d4b03c523229df796), so it does not hold; approve this plan again.

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:bca6651328f214c8a0b5be2ca786cd1ed1a533f06fa90610956e832da129a965).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:bca6651328f214c8a0b5be2ca786cd1ed1a533f06fa90610956e832da129a965
then run yodel apply dev again.
[exit 3]
```

After a new `chant approve`, the apply goes through. A migration that failed part way moves the digest too, since the statements that succeeded are part of it; the [Postgres example](../examples/postgres/README.md#4-a-migration-that-fails-part-way-and-resumes) approves again before resuming.
