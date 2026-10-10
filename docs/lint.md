---
claims: [lint-ci, replay]
---

# Lint

`yodel lint` checks the migrations directory against every rule, offline: no server and no dev database. It runs in CI on every pull request; the starter templates' pull request job runs it. Every rule is free.

Exit codes: 0 no error (warnings and silenced findings do not fail), 3 at least one error, 1 lint could not run; with `--replay`, 4 when the target already holds what the history names and `--reset` was not given. `--json` prints the findings as JSON. The output quoted here is from the examples' runs.

## The rules

`yodel lint --rules` lists them with their levels (here in the ClickHouse example, which sets none):

```console
$ npx yodel lint --rules
fork               error
                   two migrations follow the same parent; rebase one onto the other (yodel rebase)
directory          error
                   the migrations directory is not one readable chain: a bad name or file, a missing parent, a cycle, another dialect
checksum           error
                   a migration's files no longer hash to its checksum: an edit after it was written, or (with --env) after it was applied
unreadable-object  error
                   an object in a recorded schema, or a step, the sql lexicon cannot read or classify; never skipped
destructive        error, silenceable
                   a statement or Op step removes data that cannot be recovered (a table or column drop)
pg-rewrite         error, silenceable, postgres
                   Postgres: rewrites or scans the whole table under ACCESS EXCLUSIVE, blocking reads and writes while it runs
pg-lock            error, silenceable, postgres
                   Postgres: holds a lock that blocks writes for a whole scan or index build (an index without CONCURRENTLY, a constraint validated in place)
ch-mutation        error, silenceable, clickhouse
                   ClickHouse: starts a mutation that rewrites existing parts in the background, with no rollback
ch-rebuild         error, silenceable, clickhouse
                   ClickHouse: a rebuild, every row copied into a new table and swapped in (ClickHouseRebuildOp)
refused-step       error
                   a step yodel apply refuses to run: a manual step, or an Op step it does not run
migration-sql      error
                   migration.sql does not hold a statement as migration.json records it; apply runs migration.json's
silence            error
                   a yodel:allow line that is malformed, names a rule no statement can silence, has no reason, or silences nothing
replay             error
                   with --replay <env>: the history, replayed into a fresh database, does not give each migration's recorded schema
```

`fork`, `directory`, `checksum` and `unreadable-object` are integrity rules: always errors. `unreadable-object` means an object in a recorded schema, or a step, that the `sql` lexicon cannot read or classify; it is never skipped. `destructive`, `pg-rewrite`, `pg-lock`, `ch-mutation` and `ch-rebuild` come from the classifier's class of each statement or step, and can be silenced one statement at a time. The `pg-` and `ch-` rules apply to their own dialect.

Findings from the Postgres example. A CHECK constraint added in place:

<!-- quote: postgres#pg-rewrite -->
```console
$ npx yodel lint
20261010T0532-coupons
  error    pg-rewrite: step 1: SQLPG218 Add a CHECK constraint on shop.orders: blocks reads and writes on the table while it runs (ADD CONSTRAINT ... CHECK reads every row under ACCESS EXCLUSIVE. Declare it NOT VALID, then remove NOT VALID to validate it under SHARE UPDATE EXCLUSIVE (SQLPG220).)

A statement rule can be silenced for one statement, with a reason the history records when it applies:
  a line `-- yodel:allow <rule> <reason>` above the statement in migration.sql

2 migrations: 1 error, 0 warnings, 0 silenced.
[exit 3]
```

an index built without `CONCURRENTLY`:

<!-- quote: postgres#pg-lock -->
```console
$ npx yodel lint
20261010T0533-drop-coupon
  silenced destructive: step 0: SQLPG204 Drop a column on shop.orders: removes data that cannot be recovered
           reason: no order ever had a coupon; checked on dev

20261010T0533-index-placed-at
  error    pg-lock: step 0: SQLPG241 Create an index without CONCURRENTLY on shop.orders_placed_at_idx: builds an index without CONCURRENTLY: SHARE on the table, blocking every write until the build ends; declare the index CONCURRENTLY

A statement rule can be silenced for one statement, with a reason the history records when it applies:
  a line `-- yodel:allow <rule> <reason>` above the statement in migration.sql

6 migrations: 1 error, 0 warnings, 1 silenced.
[exit 3]
```

and a column dropped:

<!-- quote: postgres#destructive -->
```console
$ npx yodel lint
20261010T0533-drop-coupon
  error    destructive: step 0: SQLPG204 Drop a column on shop.orders: removes data that cannot be recovered

A statement rule can be silenced for one statement, with a reason the history records when it applies:
  a line `-- yodel:allow <rule> <reason>` above the statement in migration.sql

5 migrations: 1 error, 0 warnings, 0 silenced.
[exit 3]
```

## Rule levels

`yodel.config.ts` sets a rule to `"error"`, `"warning"` or `"off"`:

```ts
export default defineConfig({
  lint: { rules: { "ch-mutation": "warning", "pg-lock": "off" } },
});
```

The integrity rules cannot be lowered.

## Silencing a finding

A line above a statement in its `migration.sql` silences one of the classifier rules for that statement:

```sql
-- yodel:allow <rule> <reason>
```

The reason is required. For an Op step, the line goes above the step's comment. From the Postgres example:

<!-- quote: postgres#silence-sql -->
```sql
-- yodel migration 20261010T0533-drop-coupon
-- parent: 20261010T0532-rename-email

-- orders (shop.orders): SQLPG204 metadata, destructive
-- yodel:allow destructive no order ever had a coupon; checked on dev
ALTER TABLE shop.orders DROP COLUMN coupon;
```

The line is part of `migration.sql`, so it changes the migration's checksum, and lint says so. In the ClickHouse example, after silencing the rebuild:

<!-- quote: clickhouse#checksum -->
```console
$ npx yodel lint
20261010T0528-events-by-id
  error    checksum: 20261010T0528-events-by-id: its files hash to sha256:e6cb32f46db79611af518459f51b4e2a45a70784a7f7d7ee4b2ddedf796c2c10, but migration.json records sha256:54254e89d129da3f9617204d714e67294518a27832828572f42086dcb0927962; if it is not applied in any environment, record its new checksum with yodel lint --update-checksum 20261010T0528-events-by-id; if it is, undo the edit, or record it with yodel repair 20261010T0528-events-by-id --reason ... <env>
  silenced ch-rebuild: step 0: ClickHouseRebuildOp rebuilds shop.events: every row is copied into a new table and swapped in, for SQLCH220 Change the sorting key (orderBy)
           reason: 600 rows; the copy takes seconds

3 migrations: 1 error, 0 warnings, 1 silenced.
[exit 3]
```

For a migration not applied anywhere yet, `--update-checksum <id>` (repeatable) writes the new checksum into its `migration.json` before linting:

<!-- quote: postgres#update-checksum -->
```console
$ npx yodel lint --update-checksum 20261010T0533-drop-coupon
20261010T0533-drop-coupon: checksum sha256:ba19680b8db2c23fe9e84b445602a4d3dec2e1910923121636ce21fde6ab3bd2 is now sha256:4d629ea6b3b71520270b61696af81a22569982c02bc55adce08d0488d9de990e
20261010T0533-drop-coupon
  silenced destructive: step 0: SQLPG204 Drop a column on shop.orders: removes data that cannot be recovered
           reason: no order ever had a coupon; checked on dev

5 migrations: 0 errors, 0 warnings, 1 silenced.
```

With `--env <env>` it refuses a migration that environment has applied. An applied migration's edit is recorded with `yodel repair` instead ([Migrations](migrations.md#yodel-repair)).

`yodel apply` records each silence (step, rule, reason) in every history row the migration writes, in the `silences` column:

```sql
SELECT kind, statement_index, status, silences FROM yodeler.history WHERE migration_id LIKE '%drop-coupon' ORDER BY seq
```

```
kind	statement_index	status	silences
migration	-1	started	[{"step":0,"rule":"destructive","reason":"no order ever had a coupon; checked on dev"}]
statement	0	started	[{"step":0,"rule":"destructive","reason":"no order ever had a coupon; checked on dev"}]
statement	0	succeeded	[{"step":0,"rule":"destructive","reason":"no order ever had a coupon; checked on dev"}]
migration	-1	succeeded	[{"step":0,"rule":"destructive","reason":"no order ever had a coupon; checked on dev"}]
```

A `yodel:allow` line that is malformed, names a rule that cannot be silenced, has no reason, or silences nothing is itself an error (rule `silence`).

`yodel rebase` keeps each `yodel:allow` line above the same statement in the migration.sql it writes again, and the new checksum covers it, so lint passes after a rebase and apply records the same step, rule and reason. When the statement a line silenced is gone from the rebased migration, or changed (the other branch already made that change, say), the rebase refuses, names the line, and writes nothing ([Migrations](migrations.md#forks-and-yodel-rebase)).

## Against an environment's history: --env

`yodel lint --env <env>` also reads that environment's history. A `checksum` finding is then an applied migration whose files changed since it ran (an error) or a pending migration's edit (a warning). It needs the server; a server that does not answer exits 1.

## The replay check: --replay

`yodel lint --replay <env>` also replays every migration, in order, into `<env>`'s server and compares the schema each one leaves with the schema it recorded. The first that differs fails the run (rule `replay`, exit 3) and is named. This is what keeps the recorded schemas, which `yodel new` diffs against, true to what the statements do.

`<env>` should be a throwaway server: the emulator (`npx chant emulator up --lexicon sql`), or in CI a service container, as the starter templates' `replay` profile is. The databases or schemas the history names must not exist there yet; otherwise it runs nothing and exits 4:

<!-- quote: clickhouse#replay-refused -->
```console
$ npx yodel lint --replay replay
yodel lint: refused: replay and dev are the same server (127.0.0.1:8123) and both name shop; the replay would drop dev's database, with or without --reset. Point replay at a throwaway server of its own (a second emulator on another port), or, to empty dev too, add --reset-shared dev. Nothing was run.
[exit 4]
```

`--reset` drops them first. Never point it at a server whose data matters. `--keep` leaves the replayed database in place to look at. Rebuild and `PostgresMigrationOp` steps run in the replay; backfills are skipped, since the replayed database has no data. The end of the ClickHouse example's run:

<!-- quote: clickhouse#replay -->
```console
$ npx yodel lint --replay replay --reset --reset-shared dev
...
Replay of 5 migrations (clickhouse) into http://127.0.0.1:8123 (sql.profiles.replay)
  databases: shop (emptied first)
  ok      20261010T0528-baseline (2 statements)
  ok      20261010T0528-add-country (1 statement)
  ok      20261010T0528-events-by-id (0 statements; ran step 0: ClickHouseRebuildOp for events (shop.events) (swapped))
  ok      20261010T0530-fill-country (0 statements; skipped step 0: backfill backfill.ts (moves data; the replayed database has none))
  ok      20261010T0530-add-source (1 statement)
Every migration replays to its recorded schema.

20261010T0528-events-by-id
  silenced ch-rebuild: step 0: ClickHouseRebuildOp rebuilds shop.events: every row is copied into a new table and swapped in, for SQLCH220 Change the sorting key (orderBy)
           reason: 600 rows; the copy takes seconds

5 migrations: 0 errors, 0 warnings, 1 silenced.
```
