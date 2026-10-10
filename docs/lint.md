---
claims: [lint, new]
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
checkpoint         error
                   a checkpoint whose recorded schema is no longer the one it was written from, its parent's, or that holds a step other than a statement
destructive        error, silenceable
                   a statement or Op step removes data that cannot be recovered (a table or column drop)
pg-rewrite         error, silenceable, postgres
                   Postgres: rewrites or scans the whole table under ACCESS EXCLUSIVE, blocking reads and writes while it runs
pg-lock            error, silenceable, postgres
                   Postgres: holds a lock that blocks writes for a whole scan or index build (an index without CONCURRENTLY, a constraint validated in place)
pg-signature       error, silenceable, postgres
                   Postgres: a function or procedure dropped and created with another signature or result; a caller written for the old one fails
pg-routine-in-use  error, postgres
                   Postgres: a function dropped while a trigger the migration's schema declares still executes it; the DROP fails
pg-access          error, silenceable, postgres
                   Postgres: takes access away: a privilege revoked, a policy dropped, or row-level security turned off or no longer forced on the table's owner
pg-rls-not-forced  warning, silenceable, postgres
                   Postgres: a table's row-level security is enabled but not forced, so the table's owner (often the role that applies) bypasses its policies
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

`fork`, `directory`, `checksum`, `unreadable-object` and `checkpoint` are integrity rules: always errors. `unreadable-object` means an object in a recorded schema, or a step, that the `sql` lexicon cannot read or classify; it is never skipped. `destructive`, `pg-rewrite`, `pg-lock`, `ch-mutation` and `ch-rebuild` come from the classifier's class of each statement or step, and can be silenced one statement at a time. The `pg-` and `ch-` rules apply to their own dialect.

Two Postgres rules are about access control ([Access control](access.md)). `pg-access` flags a statement that takes access away: a privilege revoked (SQLPG297), a policy dropped (SQLPG292), row-level security turned off or no longer forced (SQLPG293). A revoke on an object the same migration creates is left out, since nobody held the privilege. A wave with gate `on-destructive` waits on it. `pg-rls-not-forced`, a warning, flags a migration that enables a table's row-level security while its recorded schema does not force it, so the table's owner is not held to its policies.

Two Postgres rules read a step with the rest of its migration (#44). `pg-signature` flags a function or procedure dropped and created with another signature: SQLPG281 (the result type, an output parameter, an input parameter's name or a removed default, which `CREATE OR REPLACE` refuses, or other parameter types between two builds), or a routine dropped and one of the same name with other parameter types created in the same migration. A caller written for the old signature fails once it runs; it can be silenced for the statement. `pg-routine-in-use` flags a function dropped while a trigger in the migration's recorded schema still executes it, which happens when the trigger names the function in its text rather than through its declaration. The `DROP` would fail on the server, so it cannot be silenced: declare the function again, or drop the trigger in the same migration.

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

A checkpoint ([Migrations](migrations.md#checkpoints-yodel-checkpoint)) is replayed on its own: after the chain, the database is emptied again and the checkpoint's statements run into it, and the result must be its recorded schema.

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

## Tests on the replayed database: yodel test

The replay check shows each migration gives the schema it recorded. It doesn't show that the data survives a migration, that a backfill fills what it should, or that a view returns the right rows: the replayed database has no data, and the replay skips backfills. `yodel test` runs tests for those, written in `tests/*.test.ts`:

```ts
import { defineTests, expectError, expectRows, expectValue } from "@intentius/sql-yodeler";

export default defineTests([
  {
    name: "fill-country fills the country of each event in the months it covers",
    at: "20261010T0528-events-by-id",
    seed: ["INSERT INTO shop.events (id, kind, at) VALUES (1, 'view', '2026-06-03 10:00:00')"],
    expect: [expectRows("SELECT id, country FROM shop.events ORDER BY id", [[1, "FR"]])],
  },
  {
    name: "orders_amount_positive refuses an order of 0",
    expect: [expectError("INSERT INTO shop.orders (email, amount) VALUES ('c@example.com', 0)", "orders_amount_positive")],
  },
]);
```

Each case runs on a database of its own, built on `--env`'s server (default the `test` profile, else `replay`):

1. the databases (or schemas) the history names are emptied;
2. the migrations up to `at` are replayed the way the replay check replays them: statements, rebuild and `PostgresMigrationOp` steps, no backfills. Without `at`, that is every migration, and the case tests the schema the newest one leaves: a view's rows, a function's result, a constraint;
3. the `seed` statements run;
4. the migrations after `at`, up to `through` (default: the newest), run with every step, backfills included. The receipts of a backfill's batches and of a ClickHouse rebuild's partitions are kept in memory for that case only, so nothing is written to the server's receipts table and no case skips work another case did;
5. each expectation is checked, all of them even after one fails. `expectRows(sql, rows)` wants exactly those rows in that order, `expectValue(sql, value)` the first column of the first row, and `expectError(sql, match?)` a statement that fails, with a message that contains `match` (or matches it, for a pattern). Values compare as text, so `1` and `"1"` are equal and a date compares as its ISO string. The helpers only build plain objects (`{ kind: "rows", sql, rows }`, and so on), so a test file can write those objects itself and import only the `TestCase` type.

A checkpoint isn't part of the chain the cases build, as in the replay. Nothing is written to a history. At the end the databases are emptied again, unless you pass `--keep`.

`yodel test` never runs on an environment yodel applies to. If the target's history table holds a row, it refuses (exit 4), `--reset` or not. As with the replay check, it also refuses a target that already holds what the history names (unless `--reset`), and a profile that shares its server with another profile naming the same databases (unless `--reset-shared <profile>`).

The run prints each case as `pass`, `FAIL` (with each expectation that did not hold) or `ERROR` (a migration or seed statement that failed, or an unknown migration id), and exits 3 when any case did not pass. `--json` prints the outcome (`schemas/test.schema.json`), `--junit <file>` writes it as JUnit XML (one test suite per file), and `--run <regexp>` runs only the cases whose names match.

The examples have tests: `examples/clickhouse/tests/events.test.ts` covers the backfill and the rebuild with rows in the table, and `examples/postgres/tests/orders.test.ts` covers the column rename with rows, plus a constraint and a default. In a project with test files, `yodel ci` adds `yodel test --env replay --reset --junit yodel-test.xml` to the pull request's lint job, after the replay check on the same throwaway server.
