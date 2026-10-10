# Steps

Most of a migration is statements. A change that is not one statement is a step of the migration: `yodel new` writes it into `migration.json` with the Op that makes it, and into `migration.sql` as a comment. `yodel apply` runs three kinds of Op step itself, in their place among the statements (the statements before a step first, the ones after it only once it succeeded), under the same lock and behind the same approval:

| Step | Dialect | Written by `yodel new` for |
|---|---|---|
| `ClickHouseRebuildOp` | ClickHouse | a change `ALTER` cannot make: the sort key, the engine, a key column's type or name |
| backfill | ClickHouse, Postgres | `yodel new <name> --backfill <file>`: a data migration you write |
| `PostgresMigrationOp` | Postgres | a column rename (SQLPG205) or a type change across kinds (SQLPG208) |

A step and any file it runs are in the migration's checksum, so in the plan digest the approval binds. Its history rows have `kind = 'step'`, and the `succeeded` (or `failed`) row's `note` is the step's summary as JSON. A step that failed or was stopped runs again on the next `yodel apply` and resumes from its receipts, skipping the partitions or batches that finished. `yodel lint --replay` runs rebuild and `PostgresMigrationOp` steps in the replayed database and skips backfills, which move data the replayed database does not have.

Anything else, a manual step or an Op step `yodel apply` does not run (a rebuild in app mode), is refused before anything runs: `yodel plan` and `yodel status` exit 2, `yodel apply` exits 2 and applies nothing, and `yodel lint` reports it (rule `refused-step`). The output quoted here is from the examples' runs; `...` marks lines left out.

## ClickHouse rebuilds

Changing the sort key of the ClickHouse example's `events` table, `ORDER BY (kind, at)` to `ORDER BY (kind, id)`:

<!-- quote: clickhouse#rebuild-new -->
```console
$ npx yodel new events-by-id
Wrote migrations/20261010T0522-events-by-id/ (0 statements; follows 20261010T0521-add-country)
  This migration contains an Op step: ClickHouseRebuildOp for events (shop.events), SQLCH220.
    It is not SQL. migration.json holds the Op's declaration:
    export const { op } = ClickHouseRebuildOp({ name: "rebuild-shop-events", env: "<env>", table: "shop.events", dualWrite: { mode: "materialized-view", cutoverColumn: "at" } });
```

<!-- quote: clickhouse#rebuild-sql -->
```sql
-- yodel migration 20261010T0522-events-by-id
-- parent: 20261010T0521-add-country
-- This migration contains an Op step, not only SQL:
--   ClickHouseRebuildOp for events (shop.events), SQLCH220: not SQL; migration.json holds its declaration

-- yodel:allow ch-rebuild 600 rows; the copy takes seconds
-- events (shop.events): SQLCH220 made by ClickHouseRebuildOp, not a statement:
--   export const { op } = ClickHouseRebuildOp({ name: "rebuild-shop-events", env: "<env>", table: "shop.events", dualWrite: { mode: "materialized-view", cutoverColumn: "at" } });
```

(The `yodel:allow` line was added after `yodel lint` flagged the rebuild; see [Lint](lint.md#silencing-a-finding).)

The step is chant's `ClickHouseRebuildOp`, run by chant's local executor inside the apply, with the migration's recorded schema as its declaration (the table is rebuilt as this migration declares it, however far `src/` has moved since). In materialized-view mode it:

1. creates `<table>__chant_new` with the new definition;
2. creates a materialized view, `<table>__chant_dual`, that writes every row inserted at or after a cut-over time (now plus a minute, by the table's time column, `cutoverColumn`) into the new table;
3. waits for the cut-over, then copies the table partition by partition, writing a receipt for each partition: the rows from before the cut-over, then the rows at or after it (future timestamps) that the view has not written, so every row the table held is copied once;
4. verifies that counts and checksums of every row, per partition, match in both tables, and fails the step with nothing swapped if they do not;
5. compares the two tables again just before the swap, and fails with nothing swapped if a row reached only the old table since the verification; otherwise swaps the tables (`EXCHANGE TABLES`), drops the view, and keeps the old table as `<table>__chant_old` until a retention date 7 days on.

The rebuild's own gates are left out: its approval is the migration's. The replay check runs the same step in an empty database, which shows the statements it sends:

<!-- quote: clickhouse#replay-rebuild -->
```console
$ npx yodel lint --replay replay --reset
...
replay: 20261010T0522-events-by-id: replaying
-- shop.events needs a rebuild (SQLCH220 Change the sorting key); 4 column(s) copied
--   SQLCH220 orderBy: ( kind , at ) -> ( kind , id )
CREATE TABLE `shop`.`events__chant_new`
  (
      id UInt64,
      kind LowCardinality(String),
      at DateTime,
      country LowCardinality(String) DEFAULT ''
  )
  ENGINE = MergeTree
  PARTITION BY toYYYYMM(at)
  ORDER BY (kind, id) COMMENT '[chant managed-by=chant rebuild=shop.events role=new]'
CREATE MATERIALIZED VIEW `shop`.`events__chant_dual` TO `shop`.`events__chant_new` AS SELECT `id`, `kind`, `at`, `country` FROM `shop`.`events` WHERE `at` >= toDateTime64('2026-10-10 05:25:44.000', 3, 'UTC') COMMENT 'chant rebuild of shop.events: rows at or after the cut-over [chant managed-by=chant rebuild=shop.events role=dual cutover=2026-10-10T05%3A25%3A44.000Z]'
-- waiting 61s for the cut-over at 2026-10-10T05:25:44.000Z
-- waiting 51s for the cut-over at 2026-10-10T05:25:44.000Z
-- waiting 41s for the cut-over at 2026-10-10T05:25:44.000Z
-- waiting 31s for the cut-over at 2026-10-10T05:25:44.000Z
-- waiting 21s for the cut-over at 2026-10-10T05:25:44.000Z
-- waiting 11s for the cut-over at 2026-10-10T05:25:44.000Z
-- waiting 1s for the cut-over at 2026-10-10T05:25:44.000Z
-- backfill of shop.events: 0 partition(s), 0 copied, 0 already copied, 0 cleared first
-- shop.events: 0 partition(s), 0 row(s) (0 of them before the cut-over at 2026-10-10T05:25:44.000Z), counts and checksums equal in the old and new tables
EXCHANGE TABLES `shop`.`events` AND `shop`.`events__chant_new`
DROP VIEW `shop`.`events__chant_dual` SYNC
RENAME TABLE `shop`.`events__chant_new` TO `shop`.`events__chant_old`
ALTER TABLE `shop`.`events__chant_old` MODIFY COMMENT 'chant rebuild of shop.events: the old table, kept until 2026-10-17T05:25:44.140Z [chant managed-by=chant rebuild=shop.events role=old retain-until=2026-10-17T05%3A25%3A44.140Z]'
ALTER TABLE `shop`.`events` MODIFY COMMENT '[chant managed-by=chant]'
replay: 20261010T0522-events-by-id: matches its recorded schema
...
```

In the example's apply, with 600 rows in six monthly partitions:

<!-- quote: clickhouse#rebuild-apply -->
```console
$ npx yodel apply dev
...
Running migrate-dev (<tmp>/clickhouse/ops/migrate-dev.op.ts)
lock: no KeeperMap on this server (KeeperMap is disabled because 'keeper_map_path_prefix' config is not defined. (BAD_ARGUMENTS) (version 26.8.15.10 (official build))); the lock is a file on this machine, so cross-runner locking needs Keeper (and keeper_map_path_prefix)
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:6b6cd61948bd060182ffc3de080343ea86b7336ab96c4a1af7d08e6f3036577c, by yodel at 2026-10-10T05:23:00.481Z
20261010T0522-events-by-id: applying
  step 0: ClickHouseRebuildOp for events (shop.events)
  step 0: ok {"op":"ClickHouseRebuildOp","table":"shop.events","state":"rebuild","partitions":6,"copied":6,"skipped":0,"cleared":0,"repaired":0,"verifiedRows":600,"swapped":true,"oldTable":"shop.events__chant_old","retainUntil":"2026-10-17T05:24:05.237Z"}
20261010T0522-events-by-id: applied
...
```

A rebuild that failed or was killed resumes on the next apply from the backfill's receipts: every partition with a receipt is skipped. To start it over instead, drop `<table>__chant_new` and `<table>__chant_dual`.

`yodel new` picks materialized-view mode when the table has a time column to cut over on. A rebuild in app mode (the application writes both tables) is refused by `yodel apply`.

The topology the rebuild renders for is the environment's, the same as the statements around it ([Topology](topology.md)). `yodel lint` reports every rebuild as `ch-rebuild`, an error unless silenced or lowered ([Lint](lint.md)).

## Backfills

A backfill is a data migration in the same history as the DDL: a module exporting a chant Op whose every step is an `effect()` batch with its own receipt. `yodel new <name> --backfill <file>` writes a template at `<file>` when it does not exist, and no migration:

<!-- quote: clickhouse#backfill-template -->
```console
$ npx yodel new fill-country --backfill backfills/country.ts
Wrote a backfill template at backfills/country.ts. Write its batches, then run yodel new fill-country --backfill backfills/country.ts again. No migration written.
```

The ClickHouse example's backfill fills a column added two migrations earlier, one month per batch:

<!-- quote: clickhouse#backfill-file -->
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

const months = ["202606", "202607", "202608", "202609", "202610", "202611"];

const batch = (month: string) =>
  effect(EffectReceipt(`fill-country-${month}`, { effect: `fill-country/${month}`, flavor: "existence" }), [
    activity(
      "yodelSql",
      {
        sql: `ALTER TABLE shop.events UPDATE country = ['DE', 'FR', 'US'][id % 3 + 1] WHERE toYYYYMM(at) = ${month} AND country = ''`,
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

<!-- quote: clickhouse#backfill-new -->
```console
$ npx yodel new fill-country --backfill backfills/country.ts
Wrote migrations/20261010T0524-fill-country/ (0 statements; follows 20261010T0522-events-by-id)
  This migration ends with a backfill step: the Op backfill.ts exports, copied into the migration's directory.
    yodel apply runs its effect() batches after the statements before it, resuming from their receipts after a failure.
```

<!-- quote: clickhouse#backfill-sql -->
```sql
-- yodel migration 20261010T0524-fill-country
-- parent: 20261010T0522-events-by-id
-- This migration contains an Op step, not only SQL:
--   a backfill: the Op backfill.ts exports, its effect() batches resumable from their receipts

-- backfill (fill-country): made by the Op backfill.ts exports, not a statement
```

At apply time, chant's `effect()` cycle runs each batch: read its receipt, skip the batch if the receipt is there, otherwise run its steps and write the receipt last, only when they all succeeded.

<!-- quote: clickhouse#backfill-apply -->
```console
$ npx yodel apply dev
...
Running migrate-dev (<tmp>/clickhouse/ops/migrate-dev.op.ts)
lock: no KeeperMap on this server (KeeperMap is disabled because 'keeper_map_path_prefix' config is not defined. (BAD_ARGUMENTS) (version 26.8.15.10 (official build))); the lock is a file on this machine, so cross-runner locking needs Keeper (and keeper_map_path_prefix)
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:939dad30058556bc3a978732c63276c1cb3f598b77338a9de122bfdaba1b89e9, by yodel at 2026-10-10T05:24:15.830Z
20261010T0524-fill-country: applying
  step 0: backfill backfill.ts
    ALTER TABLE shop.events UPDATE country = ['DE', 'FR', 'US'][id % 3 + 1] WHERE toYYYYMM(at) = 202606 AND country = ''
    ALTER TABLE shop.events UPDATE country = ['DE', 'FR', 'US'][id % 3 + 1] WHERE toYYYYMM(at) = 202607 AND country = ''
    ALTER TABLE shop.events UPDATE country = ['DE', 'FR', 'US'][id % 3 + 1] WHERE toYYYYMM(at) = 202608 AND country = ''
    ALTER TABLE shop.events UPDATE country = ['DE', 'FR', 'US'][id % 3 + 1] WHERE toYYYYMM(at) = 202609 AND country = ''
    ALTER TABLE shop.events UPDATE country = ['DE', 'FR', 'US'][id % 3 + 1] WHERE toYYYYMM(at) = 202610 AND country = ''
    ALTER TABLE shop.events UPDATE country = ['DE', 'FR', 'US'][id % 3 + 1] WHERE toYYYYMM(at) = 202611 AND country = ''
  step 0: ok {"op":"backfill","file":"backfill.ts","name":"backfill-fill-country","effects":6,"skipped":0,"ran":6}
20261010T0524-fill-country: applied
...
```

The rules for a backfill module:

- Each step is an `effect()` batch. Its SQL runs with `activity("yodelSql", { sql, settings? })`, which yodel provides, on the environment's server; any activity chant has works too.
- On ClickHouse, make each batch safe to run twice. A batch that was running when a run stopped runs again on the next one. The example's `UPDATE` touches only rows still empty. (On Postgres a batch is one transaction with its receipt; see [Backfills on Postgres](#backfills-on-postgres).)
- Import packages only, no relative paths: the copy in the migration's directory is the one that runs.
- No gates: the migration's approval covers it.
- It counts in the migration's checksum, so editing `backfill.ts` after the migration ran is a checksum mismatch.

The receipts are rows on the environment's server, addressed `yodel/<env>/<migration id>/<effect>`, so the same effect name in two migrations is two receipts. On ClickHouse they are in chant's receipts table (`chant_receipts.receipts`, the one the rebuild uses).

### Backfills on Postgres

On Postgres the batches' SQL runs on the apply's own connection to the environment's server, and the receipts are rows in `<history schema>.__chant_receipts` (chant's Postgres receipts table, the one `PostgresMigrationOp` keeps in the migrated table's schema), in the schema yodel's history is in: `yodeler.__chant_receipts` by default.

Each batch runs in one transaction: `BEGIN` at its first `yodelSql` statement, then its statements, then its receipt, then `COMMIT`. A batch whose statement fails is rolled back whole and leaves no receipt, and a run killed in the middle of a batch leaves neither its changes nor its receipt, so the next `yodel apply` runs that batch again from its first statement and skips every batch that committed. A Postgres batch whose steps are all `yodelSql` therefore does not need to be safe to run twice (another activity in a batch runs outside its transaction), but its statements must be ones Postgres runs in a transaction block: no `CREATE INDEX CONCURRENTLY`, no `VACUUM`. Keep batches small enough that holding their row locks until the batch commits is acceptable.

The batch's transaction has `lock_timeout` and `statement_timeout` set from the environment's profile (`lockTimeoutMs`, default 5 s, and `scanTimeoutMs`, default none). A batch blocked behind another session's lock fails when the lock timeout passes; the next `yodel apply` resumes at it. `yodelSql`'s `settings` are set for the batch's transaction only (`set_config(name, value, true)`), for example `{ work_mem: "256MB" }`.

A Postgres backfill filling a new column, one range of ids per batch:

```ts
import { EffectReceipt } from "@intentius/chant";
import { Op, activity, effect, phase } from "@intentius/chant/op";

const ranges = [[1, 100_000], [100_001, 200_000], [200_001, 300_000]];

const batch = ([from, to]: number[]) =>
  effect(EffectReceipt(`fill-region-${String(from)}`, { effect: `fill-region/${String(from)}`, flavor: "existence" }), [
    activity("yodelSql", { sql: `UPDATE shop.orders SET region = lower(country) WHERE id BETWEEN ${String(from)} AND ${String(to)}` }, "atMostOnce"),
  ]);

export const op = Op({
  name: "backfill-fill-region",
  overview: "orders.region from the country, a range of ids at a time",
  phases: [phase("Backfill", ranges.map(batch))],
});
```

The template `yodel new --backfill` writes in a Postgres project raises an exception (`DO $$ BEGIN RAISE EXCEPTION ... END $$`) in place of the SQL until you write it.

## Postgres: PostgresMigrationOp

Renaming a column in place breaks every reader still using the old name the moment it runs. `yodel new` cannot tell a rename from a dropped column and an added one unless the declaration says so: write `-- previously: <old name>` on the new column's line. Without it, the Postgres example's rename came out as a manual step, with a hint (from a run made while writing the example; the migration was deleted after):

<!-- quote: postgres#rename-hint -->
```console
$ npx yodel new rename-email
Wrote migrations/20261010T0518-rename-email/ (0 statements; follows 20261010T0518-validate-amount)
  This migration contains a manual step: orders (shop.orders), SQLPG203, SQLPG204. No statement and no Op makes it:
    shop.orders needs expand and contract, which no in-place statement makes, so nothing was sent for it. SQLPG203 Add a NOT NULL column with no default (columns.email - -> email text): ADD COLUMN ... NOT NULL with no default fails on a table that has rows. Add it nullable, backfill it, then set NOT NULL. https://www.postgresql.org/docs/18/sql-altertable.html No migration Op makes this change yet: make it by hand as expand and contract (add the new, write both, backfill, move readers, then drop the old).
  hint: orders: customer_email is dropped and email added with the same type in the same place; if it is a rename, write -- previously: customer_email on its line
```

With the line (`email text NOT NULL, -- previously: customer_email`), it is a `PostgresMigrationOp` step:

<!-- quote: postgres#rename-new -->
```console
$ npx yodel new rename-email
Wrote migrations/20261010T0518-rename-email/ (0 statements; follows 20261010T0518-validate-amount)
  This migration contains an Op step: PostgresMigrationOp for orders (shop.orders), SQLPG205.
    It is not SQL. migration.json holds the Op's declaration:
    export const { op } = PostgresMigrationOp({ name: "migrate-shop-orders-email", env: "<env>", table: "shop.orders", column: "email" });
```

<!-- quote: postgres#rename-sql -->
```sql
-- yodel migration 20261010T0518-rename-email
-- parent: 20261010T0518-validate-amount
-- This migration contains an Op step, not only SQL:
--   PostgresMigrationOp for orders (shop.orders), SQLPG205: not SQL; migration.json holds its declaration

-- orders (shop.orders): SQLPG205 made by PostgresMigrationOp, not a statement:
--   export const { op } = PostgresMigrationOp({ name: "migrate-shop-orders-email", env: "<env>", table: "shop.orders", column: "email" });
```

The step is chant's expand-and-contract Op, built from the migration's recorded schema: Plan, Expand (add the new column), Dual write (a trigger keeps both columns written), Backfill (in batches, each receipt committed with its batch in `<schema>.__chant_receipts`), Carry over (indexes and constraints), Verify (every row's new column equals the expression over the old, and no NULL where NOT NULL is declared; a difference fails the step with nothing switched), Switch, Retain, Contract (drop the old column and the trigger). Its two gates are left out; the migration's approval covers them.

<!-- quote: postgres#rename-apply -->
```console
$ npx yodel apply dev
...
Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
lock: held in Postgres advisory lock (1498367052, 748638931) for history schema yodeler
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:360c36f3fd52a7e323ec13b51aceaf808726aa07516b710b6286645adec8ae07, by yodel at 2026-10-10T05:18:54.746Z
20261010T0518-rename-email: applying
  step 0: PostgresMigrationOp for orders (shop.orders)
  step 0: ok {"op":"PostgresMigrationOp","table":"shop.orders","column":"email","state":"migrate","change":"rename","filled":1,"skipped":0,"backfilledRows":301,"carried":0,"verifiedRows":301,"switched":true,"oldColumn":"shop.orders.customer_email","retainUntil":"2026-10-10T05:18:58.723Z","dropped":true}
20261010T0518-rename-email: applied
...
```

`retainUntil` and `dropped` in the note: with no `retain` in the step's options the old column is kept for no time, and the contract drops it in the same run, as the recorded schema says it is gone. A step with `options.retain` set keeps the old column that long and succeeds with it kept; dropping it after that date is `chant run` of the Op's declaration in `migration.json`.

A `PostgresMigrationOp` step that failed or was stopped resumes on the next apply: each phase reads the server again and does what is left. To start over instead, drop the new column, its trigger and function (named in their comments).

The expand adds the new column at the end of the table, and no `ALTER` moves it, so the live column order differs from the declared one. `yodel drift` compares Postgres columns by name, so the order is not drift: declare the renamed column where the old one was.

## Manual steps

A change neither a statement nor an Op makes is a manual step: `yodel new` writes it and says what it needs, and `yodel apply` refuses the migration with exit 2 until it is gone. Make the change another way (for example, split it into changes yodel can make, as `-- previously:` does for a rename), delete the migration, and write it again.
