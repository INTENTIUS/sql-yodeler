# Approval

`yodel apply` applies only a plan someone approved, on both paths. The approval is chant's: a gate in an Op, bound to a plan digest, resolved with `chant approve`, and kept on the `chant/lifecycle` branch of the project's git repository. yodel keeps no approval store of its own. The output quoted here is from the examples' runs; `...` marks lines left out.

## The migrations Op

On the versioned path, `yodel apply <env>` runs the project's migrations Op for the environment with `chant run`. It is an ordinary chant Op with three phases, which the starter templates and the examples declare in `ops/migrate-<env>.op.ts`:

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

```console
$ npx yodel plan dev
Plan for dev (clickhouse, history yodel_18_history.history (single (default))): 1 applied, 1 pending

20261009T2003-add-country
  0  statement  SQLCH201 metadata  yodel_18_shop.events
       ALTER TABLE `yodel_18_shop`.`events` ADD COLUMN country LowCardinality(String) DEFAULT '' AFTER `at`

Plan digest: jcs1-sha256:875069551819e5f50526a6f69799d917d2f7af9c7b18d7a82409014f7c764fa3
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:875069551819e5f50526a6f69799d917d2f7af9c7b18d7a82409014f7c764fa3

Not approved yet. Approving binds exactly this digest; if anything it covers changes before the apply runs, the gate asks again and nothing is applied.
```

`yodel status <env>` prints it too, and `yodel apply <env> --plan` prints the pending migrations and the digest without applying.

## Approving

```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:875069551819e5f50526a6f69799d917d2f7af9c7b18d7a82409014f7c764fa3
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-09T20:03:58.130Z
This approves the plan jcs1-sha256:875069551819e5f50526a6f69799d917d2f7af9c7b18d7a82409014f7c764fa3, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

The approval is a commit on the local `chant/lifecycle` branch. Push it (`git push origin chant/lifecycle`) so CI sees it: every job in the starter templates fetches that branch first. In the templates, the pull request comment ends with the approve command; approve before merging, and the apply job after the merge goes through. A merge with nothing approved applies nothing and fails with the command to run; approve, push, and run the apply job again.

Then `yodel apply` runs through the gate:

```console
$ npx yodel apply dev
...
Running migrate-dev (<tmp>/clickhouse/ops/migrate-dev.op.ts)
lock: no KeeperMap on this server (KeeperMap is disabled because 'keeper_map_path_prefix' config is not defined. (BAD_ARGUMENTS) (version 26.8.15.10 (official build))); the lock is a file on this machine, so cross-runner locking needs Keeper (and keeper_map_path_prefix)
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:875069551819e5f50526a6f69799d917d2f7af9c7b18d7a82409014f7c764fa3, by yodel at 2026-10-09T20:03:58.130Z
20261009T2003-add-country: applying
  statement 0: ok (SQLCH201 metadata, yodel_18_shop.events)
20261009T2003-add-country: applied
...
```

## The pull request comment

`yodel plan <env> --comment` posts the plan as one comment per environment on the pull (merge) request, and updates that comment on the next push rather than adding another. `--format markdown` prints the same Markdown without posting. From the ClickHouse example, for its rebuild:

````console
$ npx yodel plan dev --format markdown
<!-- yodel:plan env=dev -->
### yodel plan: `dev`

ClickHouse, history `yodel_18_history.history (single (default))`: 2 applied, **1 pending**.

#### `20261009T2004-events-by-id`

| # | Step | Rule | Class | Object |
|---|---|---|---|---|
| 0 | **Op ClickHouseRebuildOp** | SQLCH220 | rebuild | `yodel_18_shop.events` |

Refused changes:
- step 0, `yodel_18_shop.events`: made by Op `ClickHouseRebuildOp` (SQLCH220 rebuild orderBy). yodel apply runs it as this step.

  <details><summary>ClickHouseRebuildOp for events</summary>

  ```text
  needs a rebuild, which ALTER cannot make: SQLCH220 Change the sorting key on orderBy (( kind , at ) -> ( kind , id )): The sorting key is the on-disk order of every part (and in ReplacingMergeTree the deduplication identity); beyond appending new columns (SQLCH216) it cannot change in place. https://clickhouse.com/docs/sql-reference/statements/alter/order-by. Run it as the rebuild migration Op: ClickHouseRebuildOp({ table: "yodel_18_shop.events", ... }) from @intentius/chant-lexicon-sql/clickhouse
  ```

  ```ts
  export const { op } = ClickHouseRebuildOp({ name: "rebuild-yodel-18-shop-events", env: "<env>", table: "yodel_18_shop.events", dualWrite: { mode: "materialized-view", cutoverColumn: "at" } });
  ```

  </details>

#### Approval

Plan digest the apply gate binds: `jcs1-sha256:9e6a127906c8b962f0a8f9e58ed2a55e8227903412fd6fdd79d13a414f75d56b`

Approve it with:

```sh
chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:9e6a127906c8b962f0a8f9e58ed2a55e8227903412fd6fdd79d13a414f75d56b
```

The newest approval of `approve-migrate-dev`, by yodel at 2026-10-09T20:03:58.130Z, is for `jcs1-sha256:875069551819e5f50526a6f69799d917d2f7af9c7b18d7a82409014f7c764fa3`, not this plan; it does not hold.
What moved (as far as yodel can tell): history changed: applied since: 20261009T2003-add-country (by yodel@Mac at 2026-10-09 20:04:03.139327); pending migrations changed: committed to since approval: 20261009T2004-events-by-id (d2974fc at 2026-10-09T14:04:09-06:00); live schema changed: no state yodel can rebuild from the history and git hashes to the approved digest with today's live schema, so an object in the environment's live schema (a table, view, index, dictionary, database or schema) changed since approval (or a part yodel cannot rebuild did).

<!-- yodel:subject eyJlbnZpcm9ubWVudCI6ImRldiIsImhpc3RvcnlEYXRhYmFzZSI6InlvZGVsXzE4X2hpc3RvcnkiLCJ0b3BvbG9neSI6eyJraW5kIjoic2luZ2xlIn0sImFwcGxpZWQiOlt7ImlkIjoiMjAyNjEwMDlUMjAwMy1iYXNlbGluZSIsImNoZWNrc3VtIjoic2hhMjU2Ojc5ZDk3MmVmMDY4MTJmODc5MjkxYjRkMzFlZmFhYTBiMjY3ZTA4YjNmZjU4ZDdlYWMyZTYyODUyZGEwN2M1OTkifSx7ImlkIjoiMjAyNjEwMDlUMjAwMy1hZGQtY291bnRyeSIsImNoZWNrc3VtIjoic2hhMjU2OmIyYTU4NzhkZDJlODg1ZjUzODJhNjBiZDE4MjdhM2YyYjg0MzViNjNiN2E5MmQ5MmIwOGY4OTY2YTEzY2E3ZjMifV0sInBlbmRpbmciOlt7ImlkIjoiMjAyNjEwMDlUMjAwNC1ldmVudHMtYnktaWQiLCJjaGVja3N1bSI6InNoYTI1NjpmNWYwYzFmZTcwY2RjN2UwODg4ZTFlNWQ5NmIzNmNjMjMyZDQ4ZjU4YTczNzExNDEyY2I4OWE5MDZkMzE5ZjIxIiwiZG9uZSI6W119XSwibGl2ZSI6InNoYTI1Njo0NTFkZjRjMDM4ODMxZWUyM2E0OGQxYzk3OTI1NmM0MWFjN2Y1NjA0ZTFhNTE4ZTY4NDA5NjJlNDRjYWYxMDk4In0 -->
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

```console
$ npx yodel plan dev
Plan for dev (clickhouse, history yodel_18_history.history (single (default))): 4 applied, 1 pending

20261009T2005-add-source
  0  statement  SQLCH201 metadata  yodel_18_shop.events
       ALTER TABLE `yodel_18_shop`.`events` ADD COLUMN source LowCardinality(String) DEFAULT 'web' AFTER `country`

Plan digest: jcs1-sha256:978d664b32fb1689e76d5d9d6ecb00a0764b3f7a839c0439c4ab9f340af76fa6
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:978d664b32fb1689e76d5d9d6ecb00a0764b3f7a839c0439c4ab9f340af76fa6

The newest approval of approve-migrate-dev, by yodel at 2026-10-09T20:05:32.684Z, is for jcs1-sha256:1b18f082bd6328299e7efdf79c2e31be2bdbb1363fad93106b0e6a884cf0cc9f, not this plan; it does not hold.
What moved: history changed: applied since: 20261009T2005-fill-country (by yodel@Mac at 2026-10-09 20:05:37.758143); pending migrations changed: new pending migration: 20261009T2005-add-source.
```

```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:978d664b32fb1689e76d5d9d6ecb00a0764b3f7a839c0439c4ab9f340af76fa6
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-09T20:05:42.886Z
This approves the plan jcs1-sha256:978d664b32fb1689e76d5d9d6ecb00a0764b3f7a839c0439c4ab9f340af76fa6, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

```sql
ALTER TABLE yodel_18_shop.events ADD COLUMN debug String DEFAULT ''
```

```console
$ npx yodel apply dev
...
Running migrate-dev (<tmp>/clickhouse/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   1.1s
[phase] Approve
  • gate:approve-migrate-dev()   skipped
    [refused] Gate "approve-migrate-dev" is approved, but not for this plan. approved: jcs1-sha256:978d664b32fb1689e76d5d9d6ecb00a0764b3f7a839c0439c4ab9f340af76fa6 (by yodel at 2026-10-09T20:05:42.886Z); planned: jcs1-sha256:ec01593ce59fbfbc879b2b566a13ec3b270561dde0a7211c8d483e001cb57689. The configuration or the live system changed between that approval and this plan, so it needs a fresh one: chant approve migrate-dev approve-migrate-dev
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 2.0s
  plan    : jcs1-sha256:ec01593ce59fbfbc879b2b566a13ec3b270561dde0a7211c8d483e001cb57689
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:ec01593ce59fbfbc879b2b566a13ec3b270561dde0a7211c8d483e001cb57689
  expires : 2026-10-11T20:05:45.931Z

Nothing was applied. The approval of jcs1-sha256:978d664b32fb1689e76d5d9d6ecb00a0764b3f7a839c0439c4ab9f340af76fa6 (by yodel at 2026-10-09T20:05:42.886Z) does not hold: the plan moved since. What moved, as far as yodel can tell: live schema changed: no state yodel can rebuild from the history and git hashes to the approved digest with today's live schema, so an object in the environment's live schema (a table, view, index, dictionary, database or schema) changed since approval (or a part yodel cannot rebuild did).

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:ec01593ce59fbfbc879b2b566a13ec3b270561dde0a7211c8d483e001cb57689).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:ec01593ce59fbfbc879b2b566a13ec3b270561dde0a7211c8d483e001cb57689
then run yodel apply dev again.
[exit 3]
```

Dropping the column puts the live schema back, and the digest is the approved one again. The gate still asks again, because the refused run asked for approval after that approval was given; an approval holds only when it is newer than the latest request. (The run's "What moved: nothing moved" under "the plan moved since" is [issue #46](https://github.com/INTENTIUS/sql-yodeler/issues/46).)

```console
$ npx yodel apply dev
...
Op "migrate-dev" is gated on "approve-migrate-dev" after 1.8s
  plan    : jcs1-sha256:978d664b32fb1689e76d5d9d6ecb00a0764b3f7a839c0439c4ab9f340af76fa6
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:978d664b32fb1689e76d5d9d6ecb00a0764b3f7a839c0439c4ab9f340af76fa6
  expires : 2026-10-11T20:05:50.171Z

Nothing was applied. The approval of jcs1-sha256:978d664b32fb1689e76d5d9d6ecb00a0764b3f7a839c0439c4ab9f340af76fa6 (by yodel at 2026-10-09T20:05:42.886Z) does not hold: the plan moved since. What moved: nothing moved.

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:978d664b32fb1689e76d5d9d6ecb00a0764b3f7a839c0439c4ab9f340af76fa6).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:978d664b32fb1689e76d5d9d6ecb00a0764b3f7a839c0439c4ab9f340af76fa6
then run yodel apply dev again.
[exit 3]
```

After a new `chant approve`, the apply goes through. A migration that failed part way moves the digest too, since the statements that succeeded are part of it; the [Postgres example](../examples/postgres/README.md#4-a-migration-that-fails-part-way-and-resumes) approves again before resuming.
