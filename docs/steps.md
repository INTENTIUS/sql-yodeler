# Steps

Most of a migration is statements. A change that is not one statement is a step of the migration: `yodel new` writes it into `migration.json` with the Op that makes it, and into `migration.sql` as a comment. `yodel apply` runs three kinds of Op step itself, in their place among the statements (the statements before a step first, the ones after it only once it succeeded), under the same lock and behind the same approval:

| Step | Dialect | Written by `yodel new` for |
|---|---|---|
| `ClickHouseRebuildOp` | ClickHouse | a change `ALTER` cannot make: the sort key, the engine, a key column's type or name |
| backfill | ClickHouse | `yodel new <name> --backfill <file>`: a data migration you write |
| `PostgresMigrationOp` | Postgres | a column rename (SQLPG205) or a type change across kinds (SQLPG208) |

A step and any file it runs are in the migration's checksum, so in the plan digest the approval binds. Its history rows have `kind = 'step'`, and the `succeeded` (or `failed`) row's `note` is the step's summary as JSON. A step that failed or was stopped runs again on the next `yodel apply` and resumes from its receipts, skipping the partitions or batches that finished. `yodel lint --replay` runs rebuild and `PostgresMigrationOp` steps in the replayed database and skips backfills, which move data the replayed database does not have.

Anything else, a manual step or an Op step `yodel apply` does not run (a rebuild in app mode), is refused before anything runs: `yodel plan` and `yodel status` exit 2, `yodel apply` exits 2 and applies nothing, and `yodel lint` reports it (rule `refused-step`). The output quoted here is from the examples' runs; `...` marks lines left out.

## ClickHouse rebuilds

Changing the sort key of the ClickHouse example's `events` table, `ORDER BY (kind, at)` to `ORDER BY (kind, id)`:

```console
$ npx yodel new events-by-id
Wrote migrations/20261009T2004-events-by-id/ (0 statements; follows 20261009T2003-add-country)
  This migration contains an Op step: ClickHouseRebuildOp for events (yodel_18_shop.events), SQLCH220.
    It is not SQL. migration.json holds the Op's declaration:
    export const { op } = ClickHouseRebuildOp({ name: "rebuild-yodel-18-shop-events", env: "<env>", table: "yodel_18_shop.events", dualWrite: { mode: "materialized-view", cutoverColumn: "at" } });
```

```sql
-- yodel migration 20261009T2004-events-by-id
-- parent: 20261009T2003-add-country
-- This migration contains an Op step, not only SQL:
--   ClickHouseRebuildOp for events (yodel_18_shop.events), SQLCH220: not SQL; migration.json holds its declaration

-- yodel:allow ch-rebuild 600 rows; the copy takes seconds
-- events (yodel_18_shop.events): SQLCH220 made by ClickHouseRebuildOp, not a statement:
--   export const { op } = ClickHouseRebuildOp({ name: "rebuild-yodel-18-shop-events", env: "<env>", table: "yodel_18_shop.events", dualWrite: { mode: "materialized-view", cutoverColumn: "at" } });
```

(The `yodel:allow` line was added after `yodel lint` flagged the rebuild; see [Lint](lint.md#silencing-a-finding).)

The step is chant's `ClickHouseRebuildOp`, run by chant's local executor inside the apply, with the migration's recorded schema as its declaration (the table is rebuilt as this migration declares it, however far `src/` has moved since). In materialized-view mode it:

1. creates `<table>__chant_new` with the new definition;
2. creates a materialized view, `<table>__chant_dual`, that writes every row inserted at or after a cut-over time (now plus a minute, by the table's time column, `cutoverColumn`) into the new table;
3. waits for the cut-over, then copies the rows from before it, partition by partition, writing a receipt for each partition;
4. verifies that counts and checksums of the rows before the cut-over match in both tables, and fails the step with nothing swapped if they do not;
5. swaps the tables (`EXCHANGE TABLES`), drops the view, and keeps the old table as `<table>__chant_old` until a retention date 7 days on.

The rebuild's own gates are left out: its approval is the migration's. The replay check runs the same step in an empty database, which shows the statements it sends:

```console
$ npx yodel lint --replay replay --reset
...
replay: 20261009T2004-events-by-id: replaying
-- yodel_18_shop.events needs a rebuild (SQLCH220 Change the sorting key); 4 column(s) copied
--   SQLCH220 orderBy: ( kind , at ) -> ( kind , id )
CREATE TABLE `yodel_18_shop`.`events__chant_new`
  (
      id UInt64,
      kind LowCardinality(String),
      at DateTime,
      country LowCardinality(String) DEFAULT ''
  )
  ENGINE = MergeTree
  PARTITION BY toYYYYMM(at)
  ORDER BY (kind, id) COMMENT '[chant managed-by=chant rebuild=yodel_18_shop.events role=new]'
CREATE MATERIALIZED VIEW `yodel_18_shop`.`events__chant_dual` TO `yodel_18_shop`.`events__chant_new` AS SELECT `id`, `kind`, `at`, `country` FROM `yodel_18_shop`.`events` WHERE `at` >= toDateTime64('2026-10-09 20:07:05.346', 3, 'UTC') COMMENT 'chant rebuild of yodel_18_shop.events: rows at or after the cut-over [chant managed-by=chant rebuild=yodel_18_shop.events role=dual cutover=2026-10-09T20%3A07%3A05.346Z]'
-- waiting 60s for the cut-over at 2026-10-09T20:07:05.346Z
-- waiting 50s for the cut-over at 2026-10-09T20:07:05.346Z
-- waiting 40s for the cut-over at 2026-10-09T20:07:05.346Z
-- waiting 30s for the cut-over at 2026-10-09T20:07:05.346Z
-- waiting 20s for the cut-over at 2026-10-09T20:07:05.346Z
-- waiting 10s for the cut-over at 2026-10-09T20:07:05.346Z
-- backfill of yodel_18_shop.events: 0 partition(s), 0 copied, 0 already copied, 0 cleared first
-- yodel_18_shop.events: 0 partition(s), 0 row(s) before the cut-over at 2026-10-09T20:07:05.346Z, counts and checksums equal in the old and new tables
EXCHANGE TABLES `yodel_18_shop`.`events` AND `yodel_18_shop`.`events__chant_new`
DROP VIEW `yodel_18_shop`.`events__chant_dual` SYNC
RENAME TABLE `yodel_18_shop`.`events__chant_new` TO `yodel_18_shop`.`events__chant_old`
ALTER TABLE `yodel_18_shop`.`events__chant_old` MODIFY COMMENT 'chant rebuild of yodel_18_shop.events: the old table, kept until 2026-10-16T20:07:05.427Z [chant managed-by=chant rebuild=yodel_18_shop.events role=old retain-until=2026-10-16T20%3A07%3A05.427Z]'
ALTER TABLE `yodel_18_shop`.`events` MODIFY COMMENT '[chant managed-by=chant]'
replay: 20261009T2004-events-by-id: matches its recorded schema
...
```

In the example's apply, with 600 rows in six monthly partitions:

```console
$ npx yodel apply dev
...
Running migrate-dev (<tmp>/clickhouse/ops/migrate-dev.op.ts)
lock: no KeeperMap on this server (KeeperMap is disabled because 'keeper_map_path_prefix' config is not defined. (BAD_ARGUMENTS) (version 26.8.15.10 (official build))); the lock is a file on this machine, so cross-runner locking needs Keeper (and keeper_map_path_prefix)
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:9e6a127906c8b962f0a8f9e58ed2a55e8227903412fd6fdd79d13a414f75d56b, by yodel at 2026-10-09T20:04:17.565Z
20261009T2004-events-by-id: applying
  step 0: ClickHouseRebuildOp for events (yodel_18_shop.events)
  step 0: ok {"op":"ClickHouseRebuildOp","table":"yodel_18_shop.events","state":"rebuild","partitions":6,"copied":6,"skipped":0,"cleared":0,"verifiedRows":600,"swapped":true,"oldTable":"yodel_18_shop.events__chant_old","retainUntil":"2026-10-16T20:05:22.476Z"}
20261009T2004-events-by-id: applied
...
```

A rebuild that failed or was killed resumes on the next apply from the backfill's receipts: every partition with a receipt is skipped. To start it over instead, drop `<table>__chant_new` and `<table>__chant_dual`.

Two things to know before relying on it:

- Rows already in the table whose cut-over column is at or after the cut-over time (future timestamps) are neither copied by the backfill nor written by the view, and the verification counts only rows before the cut-over, so the swap goes ahead without them; they stay only in `__chant_old`. See [issue #45](https://github.com/INTENTIUS/sql-yodeler/issues/45). The example's rows all have past timestamps.
- `yodel new` picks materialized-view mode when the table has a time column to cut over on. A rebuild in app mode (the application writes both tables) is refused by `yodel apply`.

The topology the rebuild renders for is the environment's, the same as the statements around it ([Topology](topology.md)). `yodel lint` reports every rebuild as `ch-rebuild`, an error unless silenced or lowered ([Lint](lint.md)).

## Backfills

A backfill is a data migration in the same history as the DDL: a module exporting a chant Op whose every step is an `effect()` batch with its own receipt. `yodel new <name> --backfill <file>` writes a template at `<file>` when it does not exist, and no migration:

```console
$ npx yodel new fill-country --backfill backfills/country.ts
Wrote a backfill template at backfills/country.ts. Write its batches, then run yodel new fill-country --backfill backfills/country.ts again. No migration written.
```

The ClickHouse example's backfill fills a column added two migrations earlier, one month per batch:

```ts
/**
 * Fills events.country, one month of events per batch. Each batch is an
 * effect() with its own receipt, so a run that stops part way resumes at the
 * first month without one. The UPDATE touches only rows still empty, so a
 * batch that ran half way can run again.
 *
 * yodel new --backfill copies this file into the migration's directory as
 * backfill.ts; that copy is the one yodel apply runs, and it counts in the
 * migration's checksum.
 */
import { EffectReceipt } from "@intentius/chant";
import { Op, activity, effect, phase } from "@intentius/chant/op";

const months = ["202603", "202604", "202605", "202606", "202607", "202608"];

const batch = (month: string) =>
  effect(EffectReceipt(`fill-country-${month}`, { effect: `fill-country/${month}`, flavor: "existence" }), [
    activity(
      "yodelSql",
      {
        sql: `ALTER TABLE yodel_18_shop.events UPDATE country = ['DE', 'FR', 'US'][id % 3 + 1] WHERE toYYYYMM(at) = ${month} AND country = ''`,
        settings: { mutations_sync: "2" },
      },
      "atMostOnce",
    ),
  ]);

export const op = Op({
  name: "backfill-fill-country",
  overview: "events.country from the id, a month at a time",
  phases: [phase("Backfill", months.map(batch))],
});
```

Run again, `yodel new` copies the file into the migration's directory as `backfill.ts` and ends the migration with the step. With `--backfill`, a migration is written even when the declared schema has not changed.

```console
$ npx yodel new fill-country --backfill backfills/country.ts
Wrote migrations/20261009T2005-fill-country/ (0 statements; follows 20261009T2004-events-by-id)
  This migration ends with a backfill step: the Op backfill.ts exports, copied into the migration's directory.
    yodel apply runs its effect() batches after the statements before it, resuming from their receipts after a failure.
```

```sql
-- yodel migration 20261009T2005-fill-country
-- parent: 20261009T2004-events-by-id
-- This migration contains an Op step, not only SQL:
--   a backfill: the Op backfill.ts exports, its effect() batches resumable from their receipts

-- backfill (fill-country): made by the Op backfill.ts exports, not a statement
```

At apply time, chant's `effect()` cycle runs each batch: read its receipt, skip the batch if the receipt is there, otherwise run its steps and write the receipt last, only when they all succeeded.

```console
$ npx yodel apply dev
...
Running migrate-dev (<tmp>/clickhouse/ops/migrate-dev.op.ts)
lock: no KeeperMap on this server (KeeperMap is disabled because 'keeper_map_path_prefix' config is not defined. (BAD_ARGUMENTS) (version 26.8.15.10 (official build))); the lock is a file on this machine, so cross-runner locking needs Keeper (and keeper_map_path_prefix)
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:1b18f082bd6328299e7efdf79c2e31be2bdbb1363fad93106b0e6a884cf0cc9f, by yodel at 2026-10-09T20:05:32.684Z
20261009T2005-fill-country: applying
  step 0: backfill backfill.ts
    ALTER TABLE yodel_18_shop.events UPDATE country = ['DE', 'FR', 'US'][id % 3 + 1] WHERE toYYYYMM(at) = 202603 AND country = ''
    ALTER TABLE yodel_18_shop.events UPDATE country = ['DE', 'FR', 'US'][id % 3 + 1] WHERE toYYYYMM(at) = 202604 AND country = ''
    ALTER TABLE yodel_18_shop.events UPDATE country = ['DE', 'FR', 'US'][id % 3 + 1] WHERE toYYYYMM(at) = 202605 AND country = ''
    ALTER TABLE yodel_18_shop.events UPDATE country = ['DE', 'FR', 'US'][id % 3 + 1] WHERE toYYYYMM(at) = 202606 AND country = ''
    ALTER TABLE yodel_18_shop.events UPDATE country = ['DE', 'FR', 'US'][id % 3 + 1] WHERE toYYYYMM(at) = 202607 AND country = ''
    ALTER TABLE yodel_18_shop.events UPDATE country = ['DE', 'FR', 'US'][id % 3 + 1] WHERE toYYYYMM(at) = 202608 AND country = ''
  step 0: ok {"op":"backfill","file":"backfill.ts","name":"backfill-fill-country","effects":6,"skipped":0,"ran":6}
20261009T2005-fill-country: applied
...
```

The rules for a backfill module:

- Each step is an `effect()` batch. Its SQL runs with `activity("yodelSql", { sql, settings? })`, which yodel provides, on the environment's server; any activity chant has works too.
- Make each batch safe to run twice. A batch that was running when a run stopped runs again on the next one. The example's `UPDATE` touches only rows still empty.
- Import packages only, no relative paths: the copy in the migration's directory is the one that runs.
- No gates: the migration's approval covers it.
- It counts in the migration's checksum, so editing `backfill.ts` after the migration ran is a checksum mismatch.

The receipts are rows in chant's receipts table on the environment's server (`chant_receipts.receipts`, the one the rebuild uses), addressed `yodel/<env>/<migration id>/<effect>`, so the same effect name in two migrations is two receipts.

Backfill steps run on ClickHouse only today; on Postgres they are [issue #39](https://github.com/INTENTIUS/sql-yodeler/issues/39).

## Postgres: PostgresMigrationOp

Renaming a column in place breaks every reader still using the old name the moment it runs. `yodel new` cannot tell a rename from a dropped column and an added one unless the declaration says so: write `-- previously: <old name>` on the new column's line. Without it, the Postgres example's rename came out as a manual step, with a hint (from a run made while writing the example; the migration was deleted after):

```console
$ npx yodel new rename-email
Wrote migrations/20261009T1955-rename-email/ (0 statements; follows 20261009T1954-validate-amount)
  This migration contains a manual step: orders (yodel_18_shop.orders), SQLPG203, SQLPG204. No statement and no Op makes it:
    yodel_18_shop.orders needs expand and contract, which no in-place statement makes, so nothing was sent for it. SQLPG203 Add a NOT NULL column with no default (columns.email - -> email text): ADD COLUMN ... NOT NULL with no default fails on a table that has rows. Add it nullable, backfill it, then set NOT NULL. https://www.postgresql.org/docs/18/sql-altertable.html No migration Op makes this change yet: make it by hand as expand and contract (add the new, write both, backfill, move readers, then drop the old).
  hint: orders: customer_email is dropped and email added with the same type in the same place; if it is a rename, write -- previously: customer_email on its line
```

With the line (`email text NOT NULL, -- previously: customer_email`), it is a `PostgresMigrationOp` step:

```console
$ npx yodel new rename-email
Wrote migrations/20261009T2004-rename-email/ (0 statements; follows 20261009T2004-validate-amount)
  This migration contains an Op step: PostgresMigrationOp for orders (yodel_18_shop.orders), SQLPG205.
    It is not SQL. migration.json holds the Op's declaration:
    export const { op } = PostgresMigrationOp({ name: "migrate-yodel-18-shop-orders-email", env: "<env>", table: "yodel_18_shop.orders", column: "email" });
```

```sql
-- yodel migration 20261009T2004-rename-email
-- parent: 20261009T2004-validate-amount
-- This migration contains an Op step, not only SQL:
--   PostgresMigrationOp for orders (yodel_18_shop.orders), SQLPG205: not SQL; migration.json holds its declaration

-- orders (yodel_18_shop.orders): SQLPG205 made by PostgresMigrationOp, not a statement:
--   export const { op } = PostgresMigrationOp({ name: "migrate-yodel-18-shop-orders-email", env: "<env>", table: "yodel_18_shop.orders", column: "email" });
```

The step is chant's expand-and-contract Op, built from the migration's recorded schema: Plan, Expand (add the new column), Dual write (a trigger keeps both columns written), Backfill (in batches, each receipt committed with its batch in `<schema>.__chant_receipts`), Carry over (indexes and constraints), Verify (every row's new column equals the expression over the old, and no NULL where NOT NULL is declared; a difference fails the step with nothing switched), Switch, Retain, Contract (drop the old column and the trigger). Its two gates are left out; the migration's approval covers them.

```console
$ npx yodel apply dev
...
Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
lock: held in Postgres advisory lock (1498367052, 1669956748) for history schema yodel_18_history
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:70d06ec0abe6c155f0b4b03fc96caf13cca350aa8bfabe4c6d0afc8fe5848294, by yodel at 2026-10-09T20:04:38.924Z
20261009T2004-rename-email: applying
  step 0: PostgresMigrationOp for orders (yodel_18_shop.orders)
  step 0: ok {"op":"PostgresMigrationOp","table":"yodel_18_shop.orders","column":"email","state":"migrate","change":"rename","filled":1,"skipped":0,"backfilledRows":301,"carried":0,"verifiedRows":301,"switched":true,"oldColumn":"yodel_18_shop.orders.customer_email","retainUntil":"2026-10-09T20:04:43.744Z","dropped":true}
20261009T2004-rename-email: applied
...
```

`retainUntil` and `dropped` in the note: with no `retain` in the step's options the old column is kept for no time, and the contract drops it in the same run, as the recorded schema says it is gone. A step with `options.retain` set keeps the old column that long and succeeds with it kept; dropping it after that date is `chant run` of the Op's declaration in `migration.json`.

A `PostgresMigrationOp` step that failed or was stopped resumes on the next apply: each phase reads the server again and does what is left. To start over instead, drop the new column, its trigger and function (named in their comments).

The expand adds the new column at the end of the table. Declare the renamed column last, where it ends up; otherwise `yodel drift` reports the column order as drift after the rename ([issue #47](https://github.com/INTENTIUS/sql-yodeler/issues/47)). The example does this.

## Manual steps

A change neither a statement nor an Op makes is a manual step: `yodel new` writes it and says what it needs, and `yodel apply` refuses the migration with exit 2 until it is gone. Make the change another way (for example, split it into changes yodel can make, as `-- previously:` does for a rename), delete the migration, and write it again.
