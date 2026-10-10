# Drift

Drift is a declared object changed out of band (by hand, by another tool) or gone. `yodel drift <env>` compares the objects `src/` declares with the live ones, through chant (`chant lifecycle diff <env> --live`). An object the project does not declare is never reported.

Exit codes: 0 no drift, 2 drift, 1 the drift could not be read, or a declared object could not be read (its state is then unknown, not clean). `--json` prints the report as JSON.

In the ClickHouse example, someone changes a column default by hand:

```sql
ALTER TABLE shop.events MODIFY COLUMN source LowCardinality(String) DEFAULT 'app'
```

<!-- quote: clickhouse#drift -->
```console
$ npx yodel drift dev
Drift in dev (clickhouse 26.8.15.10 at 127.0.0.1:8123)

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

No drift: every declared object matches the server.
```

Drift compares with the declared schema in `src/`, so on the versioned path a change in `src/` whose migration has not been applied yet shows as drift too. Run it against an environment that is up to date with the branch it runs from, as the scheduled watch on `main` is after each apply. The output quoted here is from the examples' runs.

## On a schedule: the WatchOp

`ops/watch-<env>.op.ts` declares the same check as a chant `WatchOp` with a cron schedule:

<!-- quote: clickhouse#watch-op -->
```ts
import { WatchOp } from "@intentius/chant/op";

// Every hour at :17, read dev and report drift: a declared object changed out
// of band, or gone. Objects src/ does not declare are never reported.
// `chant run watch-dev` runs it once, by hand.
export const { op } = WatchOp({ name: "watch-dev", env: "dev", schedule: "17 * * * *" });
```

`npx chant run watch-dev` runs it once. It takes a snapshot, diffs declared against live, and reports:

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
  ✓ lifecycleSnapshot(env=dev)   897ms
[phase] Diff
  ✓ lifecycleDiff(env=dev, live=true)   746ms
    [outcome] Drift=true
Op "watch-dev" completed in 1.8s
```

`chant run` exits 0 when the watch completes, drift or not. The drift is the run's `Drift` outcome, in its run record on the local `chant/lifecycle` branch. The starter templates' `scripts/watch-outcome.ts` reads the newest record after `chant run` and exits 1 when the run failed or found drift, so a scheduled run that found drift shows red.

The starter templates render a scheduled pipeline per watch for each forge (`npm run ci` writes them from `ops/`): a GitHub Actions or Forgejo Actions workflow on the watch's cron, and a GitLab CI job run by a pipeline schedule you create with the cron the file notes (GitLab keeps no cron in the file). The job reads with the reader's credentials and never pushes: its snapshot and run record stay in the job, so a read-only CI token is enough.

The Postgres example's drift and watch are in [its section 8](../examples/postgres/README.md#8-drift).
