---
claims: [declarative]
type: concepts
---

# Drift

Drift is a declared object changed out of band (by hand, by another tool) or gone. `yodel drift <env>` compares the declared objects with the live ones, through chant (`chant lifecycle diff <env> --live`). An object the project does not declare is never reported.

What the server is compared with (`--against`):

- `history`, the default when the project has migrations: the schema recorded by the newest migration the environment's history records as applied (`migration.json`'s `schema`). A migration merged but not applied yet, waiting at its gate or refused, is not drift; a change made by hand is. With no migration applied yet there is no recorded schema, and nothing is reported.
- `src`, the default without migrations: the declared schema in `src/`.

Objects on the server of a kind yodel cannot declare (an operator, a foreign table, a publication, and the others [Adopting a database](adoption.md#what-adopts-and-what-refuses) names) are reported apart, under "Unmanaged", and in `--json` as `unmanaged`. They never count as drift.

Exit codes: 0 no drift, 2 drift, 1 the drift could not be read, or a declared object could not be read (its state is then unknown, not clean). `--json` prints the report as JSON, with what it was compared with (`against`) and a `fingerprint` of the drift: a hash of the environment and what drifted, the same for the same drift, which the tracking issue uses to tell an unchanged drift from a new one.

In the ClickHouse example, someone changes a column default by hand:

```sql
ALTER TABLE shop.events MODIFY COLUMN source LowCardinality(String) DEFAULT 'app'
```

<!-- quote: clickhouse#drift -->
```console
$ npx yodel drift dev
Drift in dev (clickhouse 26.8.15.10 at 127.0.0.1:8123)

Compared with the schema 20261010T1723-add-source records, the newest migration the history records as applied.

Changed out of band:
  events (ClickHouse::Table)
    column source default.expr: declared 'web', live 'app'
[exit 2]
```

Put back, there is none:

<!-- quote: clickhouse#no-drift -->
```console
$ npx yodel drift dev
Drift in dev (clickhouse 26.8.15.10 at 127.0.0.1:8123)

Compared with the schema 20261010T1723-add-source records, the newest migration the history records as applied.

No drift: every declared object matches the server.
```

The output quoted here is from the examples' runs.

## On a schedule: the WatchOp

`ops/watch-<env>.op.ts` declares the same check as a chant `WatchOp` with a cron schedule. The watch only reads. With the [resume job](approval.md#the-scheduled-resume-job), it is all yodel runs on a schedule.

<!-- quote: clickhouse#watch-op -->
```ts
import { WatchOp } from "@intentius/chant/op";

// Every hour at :17, read dev and report drift: a declared object changed out
// of band, or gone. Objects src/ does not declare are never reported.
// `chant run watch-dev` runs it once, by hand.
export const { op: watchDev } = WatchOp({ name: "watch-dev", env: "dev", schedule: "17 * * * *" });
```

The watch job in the template's pipelines runs it on its schedule (`chant run watch-dev`, underneath). A run takes a snapshot, diffs declared against live, and reports:

<!-- quote: clickhouse#watch-run -->
```console
$ npx chant run watch-dev
Snapshot saved to chant/lifecycle (sql(2))

sql — environment: dev
0 missing, 0 orphan, 0 disappeared, 0 newly observed, 0 drifted, 2 unchanged
--------------------------------------------------------------------------------

sql (properties)
1 property drift across 1 resource(s), 0 accepted, 1 unchanged
--------------------------------------------------------------------------------

PROPERTY DRIFT (declared vs live; baseline shown where one exists):
  - events (ClickHouse::Table)
      columns[4].default.expr: 'web' → 'app' [from: authored]
[phase] Snapshot
  ✓ lifecycleSnapshot(env=dev)   923ms
[phase] Diff
  ✓ lifecycleDiff(env=dev, live=true)   781ms
    [outcome] Drift=true
Op "watch-dev" completed in 1.8s
```

`chant run` exits 0 when the watch completes, drift or not. The drift is the run's `Drift` outcome, in its run record on the local `chant/lifecycle` branch. The WatchOp compares with `src/`, so in the starter templates' watch job it is followed by `yodel drift <env> --issue`, which compares with the history, fails the job on drift, and keeps the tracking issue below.

The starter templates render a scheduled pipeline per watch for each forge (`npm run ci` writes them from `ops/`): a GitHub Actions or Forgejo Actions workflow on the watch's cron, and a GitLab CI job run by a pipeline schedule you create with the cron the file notes (GitLab keeps no cron in the file). The job reads with the reader's credentials and never pushes: its snapshot and run record stay in the job. Its token writes only issues: GitHub's job token gets `issues: write`, Forgejo's can write already, and GitLab uses `GITLAB_TOKEN`, the project access token the plan comment uses.

## The tracking issue

`yodel drift <env> --issue` keeps one issue for the project and environment on the forge, found again by a marker in its body (`<!-- yodel:drift project=<dir> env=<env> -->`, where `<dir>` is the project's directory in its repository, `.` at the root):

- drift found and no issue open: it opens one, titled with the environment and the objects (`Drift in dev: events, daily`), its body the report as markdown, what it was compared with, the CI run that found it and the fingerprint;
- drift found and the issue open: it updates the issue when the fingerprint changed, and leaves it when it did not;
- no drift: it comments that the drift is gone and closes the issue. Drift found again later opens a new one;
- the drift could not be read, or a declared object could not be (exit 1): it leaves the issue as it is, and says so.

The forge, repository and token come from the CI job's environment, as for `yodel plan --comment` ([Approval](approval.md)): `GITHUB_TOKEN` on GitHub Actions, `GITLAB_TOKEN` on GitLab CI, `FORGEJO_TOKEN` or `GITHUB_TOKEN` on Forgejo Actions, each after its `CHANT_<FORGE>_TOKEN` (and `GH_TOKEN` on GitHub and Forgejo). The issue counts as current while its title is the same and its body still carries the drift's fingerprint, so a scheduled run that finds the same drift leaves it alone. `--forge`, `--repo`, `--api-url` and `--token-env` set them outside CI. `yodel drift` prints what it did to the issue on stderr, and `--json` adds it as `issue` (`opened`, `updated`, `unchanged`, `closed`, `none` or `left`, with the number and link). An issue the forge refuses fails the run with exit 1 unless it found drift (exit 2).

The Postgres example's drift and watch are in [its section 8](../examples/postgres/README.md#8-drift).
