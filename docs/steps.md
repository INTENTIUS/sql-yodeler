---
claims: [rebuild, resume, column-change]
---

# Steps

Most of a migration is statements. A change that is not one statement is a step of the migration: `yodel new` writes it into `migration.json` with the Op that makes it, and into `migration.sql` as a comment. `yodel apply` runs three kinds of Op step itself, in their place among the statements (the statements before a step first, the ones after it only once it succeeded), under the same lock and behind the same approval:

| Step | Dialect | Written by `yodel new` for |
|---|---|---|
| `ClickHouseRebuildOp` | ClickHouse | a change `ALTER` cannot make: the sort key, the engine, a key column's type or name |
| backfill | ClickHouse, Postgres | `yodel new <name> --backfill`: a data migration you write, as a table, a key, a batch size and the SQL of one batch |
| `PostgresMigrationOp` | Postgres | a column rename (SQLPG205) or a type change across kinds (SQLPG208) |

A step and any file it runs are in the migration's checksum, so in the plan digest the approval binds. Its history rows have `kind = 'step'`, and the `succeeded` (or `failed`) row's `note` is the step's summary as JSON. A step that failed or was stopped runs again on the next `yodel apply` and resumes from its receipts, skipping the partitions or batches that finished. `yodel lint --replay` runs rebuild and `PostgresMigrationOp` steps in the replayed database and skips backfills, which move data the replayed database does not have.

Anything else, a manual step or an Op step `yodel apply` does not run (a rebuild in app mode), is refused before anything runs: `yodel plan` and `yodel status` exit 2, `yodel apply` exits 2 and applies nothing, and `yodel lint` reports it (rule `refused-step`). The output quoted here is from the examples' runs; `...` marks lines left out.

## ClickHouse rebuilds

Changing the sort key of the ClickHouse example's `events` table, `ORDER BY (kind, at)` to `ORDER BY (kind, id)`:

<!-- quote: clickhouse#rebuild-new -->
```console
$ npx yodel new events-by-id
Wrote migrations/20261010T1722-events-by-id/ (0 statements; follows 20261010T1722-add-country)
  This migration contains an Op step: ClickHouseRebuildOp for events (shop.events), SQLCH220.
    It is not SQL. migration.json holds the Op's declaration:
    export const { op } = ClickHouseRebuildOp({ name: "rebuild-shop-events", env: "<env>", table: "shop.events", dualWrite: { mode: "materialized-view", cutoverColumn: "at" } });
```

<!-- quote: clickhouse#rebuild-sql -->
```sql
-- yodel migration 20261010T1722-events-by-id
-- parent: 20261010T1722-add-country
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
5. compares the two tables again just before the swap, and fails with nothing swapped if a row reached only the old table since the verification; otherwise swaps the tables (`EXCHANGE TABLES`), drops the view, and keeps the old table as `<table>__chant_old` until a retention date 7 days on. [`yodel cleanup`](#cleaning-up-what-steps-kept) drops it after that date.

yodel builds the Op with `gates: "outer"`, so it has no gate and no Drop phase of its own: its approval is the migration's. The replay check runs the same step in an empty database, which shows the statements it sends:

<!-- quote: clickhouse#replay-rebuild -->
```console
$ npx yodel lint --replay replay --reset --reset-shared dev
...
replay: 20261010T1722-events-by-id: replaying
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
CREATE MATERIALIZED VIEW `shop`.`events__chant_dual` TO `shop`.`events__chant_new` AS SELECT `id`, `kind`, `at`, `country` FROM `shop`.`events` WHERE `at` >= toDateTime64('2026-10-10 17:23:41.000', 3, 'UTC') COMMENT 'chant rebuild of shop.events: rows at or after the cut-over [chant managed-by=chant rebuild=shop.events role=dual cutover=2026-10-10T17%3A23%3A41.000Z]'
-- waiting 6s for the cut-over at 2026-10-10T17:23:41.000Z
-- backfill of shop.events: 0 partition(s), 0 copied, 0 already copied, 0 cleared first
-- shop.events: 0 partition(s), 0 row(s) (0 of them before the cut-over at 2026-10-10T17:23:41.000Z), counts and checksums equal in the old and new tables
EXCHANGE TABLES `shop`.`events` AND `shop`.`events__chant_new`
DROP VIEW `shop`.`events__chant_dual` SYNC
RENAME TABLE `shop`.`events__chant_new` TO `shop`.`events__chant_old`
ALTER TABLE `shop`.`events__chant_old` MODIFY COMMENT 'chant rebuild of shop.events: the old table, kept until 2026-10-17T17:23:41.114Z [chant managed-by=chant rebuild=shop.events role=old retain-until=2026-10-17T17%3A23%3A41.114Z]'
ALTER TABLE `shop`.`events` MODIFY COMMENT '[chant managed-by=chant]'
replay: 20261010T1722-events-by-id: matches its recorded schema
...
```

In the example's apply, with 600 rows in six monthly partitions:

<!-- quote: clickhouse#rebuild-apply -->
```console
$ npx yodel apply dev
...
Running migrate-dev (<tmp>/clickhouse/ops/migrate-dev.op.ts)
lock: no KeeperMap on this server (KeeperMap is disabled because 'keeper_map_path_prefix' config is not defined. (BAD_ARGUMENTS) (version 26.8.15.10 (official build))); the lock is a file on this machine, so cross-runner locking needs Keeper (and keeper_map_path_prefix)
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:82c892052401d2b5a35d49964395124736586c6a8222858f8f0905155d29eb47, by yodel at 2026-10-10T17:22:36.240Z
20261010T1722-events-by-id: applying
  step 0: ClickHouseRebuildOp for events (shop.events)
  step 0: ok {"op":"ClickHouseRebuildOp","table":"shop.events","state":"rebuild","partitions":6,"copied":6,"skipped":0,"cleared":0,"repaired":0,"verifiedRows":600,"swapped":true,"oldTable":"shop.events__chant_old","retainUntil":"2026-10-17T17:22:47.304Z"}
20261010T1722-events-by-id: applied
...
```

The Op is also built with `onFailure: "keep"`, so a rebuild that failed or was killed keeps its new table and resumes on the next apply from the backfill's receipts: every partition with a receipt is skipped. To start it over instead, drop `<table>__chant_new` and `<table>__chant_dual` (a refusal or a failed verification names them). On a cluster of more than one shard the rebuild copies and verifies every shard; see [Topology](topology.md).

`yodel new` picks materialized-view mode when the table has a time column to cut over on. A rebuild in app mode (the application writes both tables) is refused by `yodel apply`.

The topology the rebuild renders for is the environment's, the same as the statements around it ([Topology](topology.md)). `yodel lint` reports every rebuild as `ch-rebuild`, an error unless silenced or lowered ([Lint](lint.md)).

## Backfills

A backfill is a data migration in the same history as the DDL: "fill this column, a range of ids at a time". You write it as a form of a few fields, and yodel runs it as batches, each with its own receipt, so an apply that stops part way resumes at the first batch that has none.

### Writing one

`yodel new <name> --backfill` writes a template at `backfills/<name>.json` when there is none, and no migration:

```json
{
  "table": "<database>.<table>",
  "key": "id",
  "batchSize": 100000,
  "settings": {
    "mutations_sync": "2"
  },
  "sql": "write the backfill of fill-country: ALTER TABLE <database>.<table> UPDATE <column> = <expression> WHERE id >= {from} AND id < {to}"
}
```

Fill it in. Filling `events.country` in the ClickHouse example's schema, 100,000 ids a batch:

```json
{
  "table": "shop.events",
  "key": "id",
  "batchSize": 100000,
  "settings": { "mutations_sync": "2" },
  "sql": "ALTER TABLE shop.events UPDATE country = ['DE', 'FR', 'US'][id % 3 + 1] WHERE id >= {from} AND id < {to} AND country = ''"
}
```

Run the same command again. `yodel new` checks the form, writes it into the migration's step in `migration.json` (so it counts in the checksum and the plan digest), and ends the migration with the step. With `--backfill`, a migration is written even when the declared schema has not changed. It prints:

```text
Wrote migrations/20261010T1212-fill-country/ (0 statements; follows 20261010T1212-baseline)
  This migration ends with a backfill of shop.events by id, 100000 a batch. Each batch runs:
    ALTER TABLE shop.events UPDATE country = ['DE', 'FR', 'US'][id % 3 + 1] WHERE id >= {from} AND id < {to} AND country = '';
    yodel apply runs the batches after the statements before it, each with its own receipt, and resumes from them after a failure.
```

and `migration.sql` shows the step as comments:

```sql
-- yodel migration 20261010T1212-fill-country
-- parent: 20261010T1212-baseline
-- This migration contains an Op step, not only SQL:
--   a backfill of shop.events by id, 100000 a batch, its batches resumable from their receipts

-- backfill (fill-country): a backfill of shop.events by id, 100000 a batch, not a statement; each batch runs:
--   ALTER TABLE shop.events UPDATE country = ['DE', 'FR', 'US'][id % 3 + 1] WHERE id >= {from} AND id < {to} AND country = '';
```

`yodel plan` lists the step with the table, the batches and the SQL of one batch, and the pull request comment shows the same under "Op steps", with the form as written. `--backfill <file>` reads the form from another `.json` file in the project.

### The form

| Field | |
|---|---|
| `table` | the table the backfill fills, qualified as in your SQL |
| `key`, `batchSize` | batches by ranges of an integer column: each range is `batchSize` wide, `{from}` inclusive to `{to}` exclusive |
| `batches` | instead of `key` and `batchSize`: the batches as a list, strings or numbers, each one `{batch}` in the SQL |
| `sql` | the SQL of one batch, an `UPDATE` or an `INSERT ... SELECT`: one statement, or a list run in order |
| `settings` | optional: ClickHouse query settings for each statement (`mutations_sync: "2"` makes an `ALTER TABLE ... UPDATE` finish before the batch's receipt is written); on Postgres, settings for the batch's transaction (`work_mem`) |

With `key`, the ranges come from the table's smallest and largest key when the step runs, aligned to multiples of `batchSize`, so a rerun sees the same ranges and skips the ones with a receipt. Rows added since the first run that fall in a range already done are not filled again; filter on the value still being empty (as `country = ''` does) and run the backfill as a new migration if that matters. A key that is not an integer (a date, a string) is refused when the step runs; list the batches with `batches` instead, for example one per month:

```json
{
  "table": "shop.events",
  "batches": ["202606", "202607", "202608"],
  "settings": { "mutations_sync": "2" },
  "sql": "ALTER TABLE shop.events UPDATE country = ['DE', 'FR', 'US'][id % 3 + 1] WHERE toYYYYMM(at) = {batch} AND country = ''"
}
```

`{batch}` is replaced as written, so quote it in the SQL when it is a string (`'{batch}'`).

### How it runs

`yodel apply` runs the step after the statements before it, under the migration's lock and approval. For each batch it reads the batch's receipt, skips the batch when the receipt is there, and otherwise runs the batch's statements and writes the receipt last, only when they all succeeded. A run that fails or is stopped leaves the finished batches' receipts, and the next `yodel apply` resumes at the first batch without one. The step's history note counts the batches: `{"op":"backfill","table":"shop.events","name":"backfill-fill-country","effects":3,"skipped":2,"ran":1}` is a rerun that found two batches done and ran the third.

On ClickHouse, make each batch safe to run twice: the batch that was running when a run stopped runs again on the next one. The example's `UPDATE` touches only rows still empty. On Postgres each batch is one transaction with its receipt, so a batch is never half done ([Backfills on Postgres](#backfills-on-postgres)).

The receipts are rows on the environment's server, addressed `yodel/<env>/<migration id>/<batch>`, so the same batch in two migrations is two receipts. They are kept by the sql lexicon's receipt store (`sqlReceiptStore` from `@intentius/chant-lexicon-sql/receipts`). On ClickHouse they are in `chant_receipts.receipts`, the table the rebuild keeps its partition receipts in.

### Backfills on Postgres

On Postgres the batches' SQL runs on the apply's own connection to the environment's server, and the receipts are rows in `<history schema>.__chant_receipts` (chant's Postgres receipts table, the one `PostgresMigrationOp` keeps in the migrated table's schema), in the schema yodel's history is in: `yodeler.__chant_receipts` by default.

Each batch runs in one transaction: `BEGIN` at its first statement, then its statements, then its receipt, then `COMMIT`. A batch whose statement fails is rolled back whole and leaves no receipt, and a run killed in the middle of a batch leaves neither its changes nor its receipt, so the next `yodel apply` runs that batch again from its first statement and skips every batch that committed. A Postgres batch therefore does not need to be safe to run twice, but its statements must be ones Postgres runs in a transaction block: no `CREATE INDEX CONCURRENTLY`, no `VACUUM`. Keep batches small enough that holding their row locks until the batch commits is acceptable.

The batch's transaction has `lock_timeout` and `statement_timeout` set from the environment's profile (`lockTimeoutMs`, default 5 s, and `scanTimeoutMs`, default none). A batch blocked behind another session's lock fails when the lock timeout passes; the next `yodel apply` resumes at it. The form's `settings` are set for the batch's transaction only (`set_config(name, value, true)`), for example `{ "work_mem": "256MB" }`.

A Postgres backfill filling a new column, 10,000 ids a batch:

```json
{
  "table": "shop.orders",
  "key": "id",
  "batchSize": 10000,
  "sql": "UPDATE shop.orders SET region = lower(country) WHERE id >= {from} AND id < {to}"
}
```

An `INSERT ... SELECT` works the same way, for example copying rows into a new table a range at a time: `INSERT INTO shop.orders_archive SELECT * FROM shop.orders WHERE id >= {from} AND id < {to} AND placed_at < '2025-01-01'`.

### A backfill as a chant Op

For a backfill the form cannot say (batches that are not a list or ranges of one key, a step that calls another activity, a check between batches), write the Op yourself. `yodel new <name> --backfill <file>` with a `<file>` that is not `.json` takes a module exporting a chant Op whose every step is an `effect()` batch with its own receipt, and writes a template at `<file>` when it does not exist, and no migration:

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
Wrote migrations/20261010T1722-fill-country/ (0 statements; follows 20261010T1722-events-by-id)
  This migration ends with a backfill step: the Op backfill.ts exports, copied into the migration's directory.
    yodel apply runs its effect() batches after the statements before it, resuming from their receipts after a failure.
```

<!-- quote: clickhouse#backfill-sql -->
```sql
-- yodel migration 20261010T1722-fill-country
-- parent: 20261010T1722-events-by-id
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
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:96f8f3625b2628eedd9a5567254b9b7ecf5e53ae0a22550d6da7cf3a37ff200e, by yodel at 2026-10-10T17:22:58.009Z
20261010T1722-fill-country: applying
  step 0: backfill backfill.ts
    ALTER TABLE shop.events UPDATE country = ['DE', 'FR', 'US'][id % 3 + 1] WHERE toYYYYMM(at) = 202606 AND country = ''
    ALTER TABLE shop.events UPDATE country = ['DE', 'FR', 'US'][id % 3 + 1] WHERE toYYYYMM(at) = 202607 AND country = ''
    ALTER TABLE shop.events UPDATE country = ['DE', 'FR', 'US'][id % 3 + 1] WHERE toYYYYMM(at) = 202608 AND country = ''
    ALTER TABLE shop.events UPDATE country = ['DE', 'FR', 'US'][id % 3 + 1] WHERE toYYYYMM(at) = 202609 AND country = ''
    ALTER TABLE shop.events UPDATE country = ['DE', 'FR', 'US'][id % 3 + 1] WHERE toYYYYMM(at) = 202610 AND country = ''
    ALTER TABLE shop.events UPDATE country = ['DE', 'FR', 'US'][id % 3 + 1] WHERE toYYYYMM(at) = 202611 AND country = ''
  step 0: ok {"op":"backfill","file":"backfill.ts","name":"backfill-fill-country","effects":6,"skipped":0,"ran":6}
20261010T1722-fill-country: applied
...
```

The rules for a backfill module:

- Each step is an `effect()` batch. Its SQL runs with `activity("yodelSql", { sql, settings? })`, which yodel provides, on the environment's server; any activity chant has works too.
- On ClickHouse, make each batch safe to run twice. A batch that was running when a run stopped runs again on the next one. The example's `UPDATE` touches only rows still empty. (On Postgres a batch is one transaction with its receipt; see [Backfills on Postgres](#backfills-on-postgres).)
- Import packages only, no relative paths: the copy in the migration's directory is the one that runs.
- No gates: the migration's approval covers it.
- It counts in the migration's checksum, so editing `backfill.ts` after the migration ran is a checksum mismatch.

The receipts are rows on the environment's server, addressed `yodel/<env>/<migration id>/<effect>`, so the same effect name in two migrations is two receipts. They are kept by the sql lexicon's receipt store (`sqlReceiptStore` from `@intentius/chant-lexicon-sql/receipts`). On ClickHouse they are in `chant_receipts.receipts`, the table the rebuild keeps its partition receipts in.

The template `yodel new --backfill <file>` writes in a Postgres project raises an exception (`DO $$ BEGIN RAISE EXCEPTION ... END $$`) in place of the SQL until you write it.

## Postgres: PostgresMigrationOp

Renaming a column in place breaks every reader still using the old name the moment it runs. `yodel new` cannot tell a rename from a dropped column and an added one unless the declaration says so: write `-- previously: <old name>` on the new column's line. Without it, the Postgres example's rename came out as a manual step, with a hint (from a run made while writing the example; the migration was deleted after):

<!-- quote: postgres#rename-hint -->
```console
$ npx yodel new rename-email
Wrote migrations/20261010T1724-rename-email/ (0 statements; follows 20261010T1724-refunds)
  This migration contains a manual step: orders (shop.orders), SQLPG203, SQLPG204. No statement and no Op makes it:
    shop.orders needs expand and contract, which no in-place statement makes, so nothing was sent for it. SQLPG203 Add a NOT NULL column with no default (columns.email - -> email text): ADD COLUMN ... NOT NULL with no default fails on a table that has rows. Add it nullable, backfill it, then set NOT NULL. https://www.postgresql.org/docs/18/sql-altertable.html No migration Op makes this change yet: make it by hand as expand and contract (add the new, write both, backfill, move readers, then drop the old).
  hint: orders: customer_email is dropped and email added with the same type in the same place; if it is a rename, write -- previously: customer_email on its line
```

With the line (`email text NOT NULL, -- previously: customer_email`), it is a `PostgresMigrationOp` step:

<!-- quote: postgres#rename-new -->
```console
$ npx yodel new rename-email
Wrote migrations/20261010T1724-rename-email/ (0 statements; follows 20261010T1724-refunds)
  This migration contains an Op step: PostgresMigrationOp for orders (shop.orders), SQLPG205.
    It is not SQL. migration.json holds the Op's declaration:
    export const { op } = PostgresMigrationOp({ name: "migrate-shop-orders-email", env: "<env>", table: "shop.orders", column: "email" });
    No retain: the old column is dropped in the same yodel apply, right after the switch, so anything still reading it breaks then.
    To keep it while readers move over: yodel new rename-email --replace --retain 7d
```

<!-- quote: postgres#rename-sql -->
```sql
-- yodel migration 20261010T1724-rename-email
-- parent: 20261010T1724-refunds
-- This migration contains an Op step, not only SQL:
--   PostgresMigrationOp for orders (shop.orders), SQLPG205: not SQL; migration.json holds its declaration

-- orders (shop.orders): SQLPG205 made by PostgresMigrationOp, not a statement:
--   export const { op } = PostgresMigrationOp({ name: "migrate-shop-orders-email", env: "<env>", table: "shop.orders", column: "email" });
```

The step is chant's expand-and-contract Op, built from the migration's recorded schema: Plan, Expand (add the new column), Dual write (a trigger keeps both columns written), Backfill (in batches, each receipt committed with its batch in `<schema>.__chant_receipts`), Carry over (indexes and constraints), Verify (every row's new column equals the expression over the old, and no NULL where NOT NULL is declared; a difference fails the step with nothing switched), Switch, Retain, Contract (drop the old column and the trigger, once its retention date has passed). yodel builds it with `gates: "outer"`, so the Op has neither of its two gates and the migration's approval covers the switch and the contract, and with `onFailure: "keep"`, so a failure drops nothing the step made.

<!-- quote: postgres#rename-apply -->
```console
$ npx yodel apply dev
...
Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
lock: held in Postgres advisory lock (1498367052, 748638931) for history schema yodeler
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:8fceea63a48a1227fd5ddc01089e850a7c827140ad376098c33fca9eee489eec, by yodel at 2026-10-10T17:24:43.127Z
20261010T1724-rename-email: applying
  step 0: PostgresMigrationOp for orders (shop.orders)
  step 0: ok {"op":"PostgresMigrationOp","table":"shop.orders","column":"email","state":"migrate","change":"rename","filled":1,"skipped":0,"backfilledRows":301,"carried":0,"verifiedRows":301,"switched":true,"oldColumn":"shop.orders.customer_email","retainUntil":"2026-10-10T17:24:49.958Z","dropped":true}
20261010T1724-rename-email: applied
...
```

`retainUntil` and `dropped` in the note: by default the step keeps the old column for no time, and the contract drops it in the same apply, right after the switch, as the recorded schema says it is gone. Anything still reading `customer_email` breaks at that moment, which is what `yodel new` warns about.

To keep the old column while readers move over, give the step a retention with `--retain`, when you write the migration or by writing it again before it is applied:

```sh
npx yodel new rename-email --retain 7d             # when writing it
npx yodel new rename-email --replace --retain 7d   # a migration written without it, not applied yet
```

`--retain` writes `"retain": "7d"` into the step's options in `migration.json` (and into its declaration), so it is in the checksum and the plan digest; never edit `migration.json` by hand to add it. Durations are whole numbers of `ms`, `s`, `m`, `h` or `d`. The lifecycle is then:

1. The apply expands, dual-writes, backfills, verifies and switches. Readers of `email` see the new column; the old column is still there under its old name, kept written by the dual-write trigger for a rename, and its comment says until when (`retain-until`). The step succeeds with `"dropped":false` and `retainUntil` in its note.
2. During those seven days, move the remaining readers and writers of `customer_email` over.
3. After the date, [`yodel cleanup <env>`](#cleaning-up-what-steps-kept) drops the old column, and for a rename its trigger and function, behind an approval. Before the date it drops nothing.

`--retain` sets the retention of a ClickHouse rebuild too: how long `<table>__chant_old` is kept after the swap, 7 days when the step sets none.

A `PostgresMigrationOp` step that failed or was stopped keeps the new column, its trigger and the receipts of the batches it filled, and resumes on the next apply: each phase reads the server again and does what is left, and the backfill skips every batch with a receipt (the note's `skipped`). To start over instead, drop the new column, its trigger and function (named in their comments).

The expand adds the new column at the end of the table, and no `ALTER` moves it, so the live column order differs from the declared one. `yodel drift` compares Postgres columns by name, so the order is not drift: declare the renamed column where the old one was.

## Cleaning up what steps kept

Two steps keep something on purpose after they succeed, until a retention date written in its own comment (`retain-until` in chant's trailer):

- a ClickHouse rebuild keeps the old table, `<table>__chant_old`, 7 days after the swap, or the step's `retain`;
- a Postgres rename or type change keeps the old column after the switch when the step sets `retain`, and for a rename the trigger and function that keep it written.

`yodel plan <env>` names them with their dates in a note, and so does the pull request comment. `yodel cleanup <env>` lists them, with the server's clock, and drops the ones whose date has passed. Nothing is dropped before its date.

```text
$ npx yodel cleanup prod
Kept by steps in prod (server time 2026-10-20T00:00:00.000Z):
  shop.events__chant_old (the old table of the rebuild of shop.events): kept until 2026-10-17T05:30:05.216Z, due
  shop.daily__chant_old (the old table of the rebuild of shop.daily): kept until 2026-10-27T00:00:00.000Z

Plan digest: jcs1-sha256:...
1 due; nothing dropped without an approval. Approve it with:
  chant approve migrate-prod approve-migrate-prod-cleanup --plan jcs1-sha256:...
then run yodel cleanup prod again.
```

The drop is approved the way an apply is: the digest covers each due object by its identity on the server (a table by its UUID, a column by its table and attribute number) and its date, and the approval is of that digest on the migrations Op's cleanup gate: the Op's gate name with `-cleanup` (`approve-migrate-prod-cleanup`), a gate of its own, so an apply's approval and a cleanup's never stand in for each other, and `yodel plan` never names a cleanup's approval when it explains an apply's. With it, `yodel cleanup prod` takes the apply lock, reads the objects again, checks the approval against what it reads, and drops them: a ClickHouse table with `DROP TABLE ... SYNC` (rendered for the environment's topology), a Postgres column with its trigger and function in one transaction under the lock timeout, and the column migration's receipts after it. If anything due changed since the approval (another table came due, a table was rebuilt again), the digest differs and nothing is dropped. `--list` lists and never drops; `--json` prints the list, the digest and what was dropped. It exits 3 while something due waits for its approval, so a scheduled job can run it and fail visibly. The environment's approval mode counts as it does for an apply ([Approval](approval.md)): under `sealed`, only an approval sealed with `chant approve --sign` by a key the signers file at the base commit lists for its approver drops anything, and the command `yodel cleanup` prints ends in `--sign`.

## Manual steps

A change neither a statement nor an Op makes is a manual step: `yodel new` writes it and says what it needs, and `yodel apply` refuses the migration with exit 2 until it is gone. Make the change another way (for example, split it into changes yodel can make, as `-- previously:` does for a rename), delete the migration, and write it again.

## The ownership marker

Objects yodel creates carry `[chant managed-by=chant]` at the end of their comment, on Postgres even a table that has no comment of its own (`COMMENT ON TABLE ... IS '[chant managed-by=chant]'`). chant, the library yodel declares and diffs schemas with, reads the marker to tell the objects it manages from ones it does not, and takes it off again before it compares or prints a comment, so your declared comment is what `yodel drift` and `yodel plan` compare. The working objects of a step carry more pairs in the same trailer: `<table>__chant_old` after a rebuild carries `role=old` and `retain-until=<date>`, and so does the old column after a Postgres rename. Leave the marker in place: an object whose marker was removed by hand reads as one yodel did not create, until the next apply of its declaration stamps it again.
