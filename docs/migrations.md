---
claims: [new, resume, out-of-order, lock-retry]
---

# Migrations

On the versioned path, `migrations/` holds the history of the schema as reviewed steps, and a table in each environment's database records what ran there. This page covers both, how `yodel apply` uses them, and what to do when they disagree. The output quoted here is from the two examples' runs; `...` marks lines of a command's output left out.

## The directory

Each migration is a directory, `migrations/<YYYYMMDDTHHMM>-<name>/`, named by `yodel new <name>` with the UTC time it was written. The name is lowercase letters and digits, words joined by `-` or `_`. It holds:

- `migration.sql`: the statements, each after a comment naming its object, the classifier's rule and the change's class. A step that is not SQL (a rebuild, a backfill, an expand-and-contract change, a manual step) appears as a comment only.
- `migration.json`: the migration's id, its parent's id, its checksum, when it was written, its dialect, its steps (each statement with its SQL, rule and class, and each Op step with the Op's declaration and options), and the recorded schema: chant's build of the declared schema as it stood after this migration.
- any file a step names: a backfill step's `backfill.ts`.

From the ClickHouse example:

<!-- quote: clickhouse#add-country-sql -->
```sql
-- yodel migration 20261010T0528-add-country
-- parent: 20261010T0528-baseline

-- events (shop.events): SQLCH201 metadata
ALTER TABLE `shop`.`events` ADD COLUMN country LowCardinality(String) DEFAULT '' AFTER `at`;
```

The order migrations run in is the chain of parent ids. The timestamp in an id is for people reading a listing; it never decides the order. The first migration has no parent (`"parent": null`).

### Checksums

A migration's checksum covers its own files and nothing else: `migration.sql` with its line endings normalized, `migration.json` as parsed JSON without its `checksum` field (so whitespace and key order do not count, but every value does, the parent and the recorded schema included), and every other file in its directory. Adding, editing or removing another migration never changes it. Two branches that each add a migration therefore never conflict over a shared file; they fork the chain instead, which `yodel lint` reports ([below](#forks-and-yodel-rebase)).

`yodel lint` checks each migration's files against its `checksum` field (rule `checksum`). `yodel status` and `yodel apply` check each applied migration's files against the checksum the history recorded when it ran, and refuse on a mismatch.

## Writing one: yodel new

`yodel new <name>` diffs the newest migration's recorded schema (an empty schema for the first) against a fresh build of `src/`, and writes the next migration. It reads no database. When nothing changed it writes nothing and exits 0:

<!-- quote: postgres#new-check -->
```console
$ npx yodel new check
No changes: the declared schema matches the newest migration's recorded schema (20261010T0532-rename-email). Nothing written.
```

(From the Postgres example's run, just after it writes `rename-email`; `run.ts postgres --write` rewrites this quote with the README. The committed-example check in `examples/walkthrough/run.ts` runs `yodel new check` in each example, so a declared schema that drifts from its migrations fails the e2e test.)

It refuses (exit 1) when the directory is not one chain (a fork, a missing parent) or a migration of that id is already there. `yodel new <name> --backfill <file>` ends the migration with a backfill step ([Steps](steps.md#backfills)).

## The history table

Each environment's history is a table in its own database: `<history database>.history` on ClickHouse, `<history schema>.history` on Postgres, where the history database (schema) is `yodel.config.ts`'s `environments.<env>.history.database`, else `YODEL_HISTORY_DATABASE`, else `yodeler`. `yodel apply` (or `yodel init`, or `yodel repair`) creates it when it is not there. It is never part of the declared schema. The plan digest covers what it records (the applied migrations and their checksums) but not the table itself, so recording a run does not move the digest.

It is append-only: one row per event, never updated or deleted.

| Column | What it holds |
|---|---|
| `seq` | the event's order: taken under the apply lock, one more than the highest, so it orders rows across runs without trusting a clock |
| `run_id` | the `yodel apply` run that wrote the row |
| `kind` | `migration` (a migration started, succeeded or failed; `statement_index` -1), `statement`, or `step` (an Op step) |
| `migration_id`, `parent`, `checksum` | the migration, its parent, and the checksum its files had |
| `statement_index`, `statement_sha` | which step of the migration, and the hash of the statement as written (before topology rendering) |
| `status` | `started`, `succeeded` or `failed` |
| `error` | why it failed |
| `applied_by` | who ran it (`yodel@example` in the examples) |
| `plan_digest` | the digest the run was approved under |
| `silences` | the migration's `yodel:allow` silences, as JSON ([Lint](lint.md#silencing-a-finding)) |
| `note` | a step's summary as JSON; a statement's topology (`topology=single`); `baseline: ...` on a baseline `yodel init` recorded; a repair's reason |
| `recorded_at` | the server's time, for people |

The state of a migration or a statement is its row with the highest `seq`. The ClickHouse example's rows for its rebuild and its backfill:

```sql
SELECT migration_id, kind, statement_index, status, note, silences
FROM yodeler.history
WHERE migration_id LIKE '%events-by-id' OR migration_id LIKE '%fill-country'
ORDER BY seq FORMAT Vertical
```

<!-- quote: clickhouse#history-rows -->
```
Row 1:
──────
migration_id:    20261010T0528-events-by-id
kind:            migration
statement_index: -1
status:          started
note:            
silences:        [{"step":0,"rule":"ch-rebuild","reason":"600 rows; the copy takes seconds"}]

Row 2:
──────
migration_id:    20261010T0528-events-by-id
kind:            step
statement_index: 0
status:          started
note:            
silences:        [{"step":0,"rule":"ch-rebuild","reason":"600 rows; the copy takes seconds"}]

Row 3:
──────
migration_id:    20261010T0528-events-by-id
kind:            step
statement_index: 0
status:          succeeded
note:            {"op":"ClickHouseRebuildOp","table":"shop.events","state":"rebuild","partitions":6,"copied":6,"skipped":0,"cleared":0,"repaired":0,"verifiedRows":600,"swapped":true,"oldTable":"shop.events__chant_old","retainUntil":"2026-10-17T05:30:05.216Z"}
silences:        [{"step":0,"rule":"ch-rebuild","reason":"600 rows; the copy takes seconds"}]

Row 4:
──────
migration_id:    20261010T0528-events-by-id
kind:            migration
statement_index: -1
status:          succeeded
note:            
silences:        [{"step":0,"rule":"ch-rebuild","reason":"600 rows; the copy takes seconds"}]

Row 5:
──────
migration_id:    20261010T0530-fill-country
kind:            migration
statement_index: -1
status:          started
note:            
silences:        []

Row 6:
──────
migration_id:    20261010T0530-fill-country
kind:            step
statement_index: 0
status:          started
note:            
silences:        []

Row 7:
──────
migration_id:    20261010T0530-fill-country
kind:            step
statement_index: 0
status:          succeeded
note:            {"op":"backfill","file":"backfill.ts","name":"backfill-fill-country","effects":6,"skipped":0,"ran":6}
silences:        []

Row 8:
──────
migration_id:    20261010T0530-fill-country
kind:            migration
statement_index: -1
status:          succeeded
note:            
silences:        []
```

## The apply lock

One apply runs at a time per environment.

- ClickHouse: a row in `<history database>.lock`, a `KeeperMap` table, so it lives in Keeper and every runner on any host sees it. It needs Keeper and the server setting `keeper_map_path_prefix`. The holder renews it while it works; a lock left by a dead runner expires after its TTL (`lockTtl`, `YODEL_LOCK_TTL`, default 900 seconds). A single node without Keeper gets a lock file on the runner's machine instead, which serializes applies from that machine only, and the run says so (`lock: no KeeperMap on this server ...; the lock is a file on this machine, so cross-runner locking needs Keeper`). A cluster, a `Replicated` database and Cloud refuse rather than fall back.
- Postgres: a session advisory lock on a connection of its own, keyed by the history schema (`lock: held in Postgres advisory lock (...) for history schema yodeler`). Postgres releases it when the session ends, however it ends, so it needs no expiry.

A run that finds the lock taken exits 5 and names the holder. To clear a lock by hand, once you know nothing is applying: on ClickHouse `ALTER TABLE <history database>.lock DELETE WHERE name = 'apply'` (or remove the lock file the refusal names); on Postgres end the holding session, `SELECT pg_terminate_backend(<pid>)`. `yodel status` and `yodel plan` take no lock.

## Applying

`yodel apply <env>` runs the project's migrations Op ([Approval](approval.md)). Under the lock, its Apply step checks the plan digest again, checks every applied migration's checksum, then runs the pending migrations in chain order, statement by statement, writing a `started` row before each and a `succeeded` or `failed` row after. From the ClickHouse example:

<!-- quote: clickhouse#apply -->
```console
$ npx yodel apply dev
Migrations in dev (clickhouse 26.8.15.10 at 127.0.0.1:8123, history yodeler.history, topology single (default))

Applied (1):
  20261010T0528-baseline  2026-10-10 05:28:36.291790 by yodel@example

Pending (1):
  20261010T0528-add-country

Plan digest: jcs1-sha256:62d246010143e51e9ba1c8a4988836dd44017840392ce4a211ac4407b1081c2e

Running migrate-dev (<tmp>/clickhouse/ops/migrate-dev.op.ts)
lock: no KeeperMap on this server (KeeperMap is disabled because 'keeper_map_path_prefix' config is not defined. (BAD_ARGUMENTS) (version 26.8.15.10 (official build))); the lock is a file on this machine, so cross-runner locking needs Keeper (and keeper_map_path_prefix)
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:62d246010143e51e9ba1c8a4988836dd44017840392ce4a211ac4407b1081c2e, by yodel at 2026-10-10T05:28:45.812Z
20261010T0528-add-country: applying
  statement 0: ok (SQLCH201 metadata, shop.events)
20261010T0528-add-country: applied

[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   932ms
[phase] Approve
  ✓ gate:approve-migrate-dev()   234ms
    [approved] yodel at 2026-10-10T05:28:45.812Z
[phase] Apply
  ✓ shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":"jcs1-sha256:62d246010143e51e9ba1c8a4988836dd44017840392ce4a211ac4407b1081c2e"})   1.7s
Op "migrate-dev" completed in 3.0s

Applied: 20261010T0528-add-country.
```

On ClickHouse each statement is rendered for the environment's topology as it is sent ([Topology](topology.md)). On Postgres:

- A statement that can run in a transaction runs in one of its own, with its `succeeded` row, so the two commit together or not at all.
- `CREATE INDEX CONCURRENTLY` and the other statements that cannot run in a transaction run alone, with their row written right after. Before each attempt at a `CONCURRENTLY` build, an INVALID index of that name left by an earlier failed attempt is dropped; a valid one is never touched.
- Every statement runs under `lock_timeout` (the profile's `lockTimeoutMs`, default 5 s) and a `statement_timeout` (`statementTimeoutMs`, default 60 s, for a catalog change; `scanTimeoutMs`, default none, for one that reads or rewrites rows). A statement that times out waiting for a lock is tried again after a pause that doubles from 250 ms, up to `YODEL_LOCK_RETRIES` more times (default 5); any other error fails it at once.

## Pre-migration checks

Some migrations are only safe when the data looks a certain way: a table is empty before it is dropped, a column has no NULLs before it becomes NOT NULL. A migration says so with `checks` in its `migration.json`, read-only queries that run against the environment before its first statement. Write one with `yodel new`:

```sh
npx yodel new drop-legacy --check "legacy-empty: SELECT 1 FROM shop.legacy LIMIT 1"
```

`--check` is repeatable. Written `<name>: <sql>` the check takes that name; otherwise it is `check-1`, `check-2` and so on. In `migration.json` it looks like this:

```json
"checks": [
  { "name": "legacy-empty", "sql": "SELECT 1 FROM shop.legacy LIMIT 1" }
]
```

What a check must return is its `expect`:

| `expect` | passes when the query returns |
|---|---|
| `"empty"` (the default, and what `--check` writes) | no rows |
| `"true"` | one row whose first column is true or 1 |
| `{ "min": 1, "max": 1000000 }` (either bound may be left out) | one row whose first column is a number within the bounds, inclusive |

A bare table name means the migration's default database (ClickHouse) or schema (Postgres). A check runs read-only: on ClickHouse with `readonly = 2`, on Postgres in a `READ ONLY` transaction that is rolled back, under the profile's `lockTimeoutMs` and `scanTimeoutMs`.

`yodel apply <env>` runs the first pending migration's checks before it runs the migrations Op, so a run that would be refused stops before anyone is asked to approve it. The Op's Apply step runs every pending migration's checks again under the lock, just before that migration's first statement, when earlier migrations in the same run have already applied. A check that fails, or whose query the server refuses, refuses the apply with exit 4 and names the check; nothing of that migration is sent. Under the lock the history records the outcome: the migration's `started` row carries the checks' results in `note`, and a refusal is a `failed` migration row whose `error` names the check. A migration resuming part way does not run its checks again, since they held before its first statement.

The checks are part of `migration.json`, so of the checksum and the plan digest: adding, editing or removing one moves the digest, and the plan is approved again. To change a check of a migration not yet applied anywhere, edit it and run `yodel lint --update-checksum <id>`. `yodel plan` lists each pending migration's checks, and the pull request comment shows them in a table under the migration's steps.

## Resuming a migration that failed part way

A statement whose latest row is `succeeded` is never sent again. So when a statement fails, the next `yodel apply` resumes the migration at that statement. (A statement whose latest row is `started`, because the runner stopped while it ran, is sent again: the history cannot tell whether the server ran it.) An Op step that failed resumes from its receipts ([Steps](steps.md)).

In the Postgres example a migration's second statement, `VALIDATE CONSTRAINT`, fails on a row the constraint does not allow. The part of the run after the gate:

<!-- quote: postgres#failed -->
```console
$ npx yodel apply dev
...
lock: held in Postgres advisory lock (1498367052, 748638931) for history schema yodeler
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:00bfc43c33f4a97624882160220fb78b7e747ea1e602cd3c1d3557f6e0a12476, by yodel at 2026-10-10T05:32:28.879Z
20261010T0532-validate-amount: applying
  statement 0: ok (SQLPG201 metadata, shop.orders)
  statement 1: failed: check constraint "orders_amount_positive" of relation "orders" is violated by some row
yodel apply: 20261010T0532-validate-amount failed at statement 1: check constraint "orders_amount_positive" of relation "orders" is violated by some row
Fix the cause (on the server, or that statement in the migration's files), then run yodel apply again: it resumes at statement 1 and never sends again the statements that succeeded.
...
[exit 1]
```

`yodel status` shows where it stopped, and exits 3 (pending):

<!-- quote: postgres#failed-status -->
```console
$ npx yodel status dev
Migrations in dev (postgres 18.6 at 127.0.0.1:5432/postgres, history yodeler.history)

Applied (2):
  20261010T0531-baseline  2026-10-10 05:31:59.965821 by yodel@example
  20261010T0532-coupons  2026-10-10 05:32:19.532446 by yodel@example

Pending (1):
  20261010T0532-validate-amount  (failed part way at statement 1; resumes at statement 1)
      error: statement 1: check constraint "orders_amount_positive" of relation "orders" is violated by some row

Plan digest: jcs1-sha256:00316318758c0e81b1db8cc977b56bba0639fb987f94a1a96332df5505f19c9c
[exit 3]
```

The history changed since the approval (statement 0 ran), so the plan digest moved and the gate asks for a new approval. After fixing the row and approving again, the next run sends only statement 1:

<!-- quote: postgres#resumed -->
```console
$ npx yodel apply dev
...
Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
lock: held in Postgres advisory lock (1498367052, 748638931) for history schema yodeler
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:00316318758c0e81b1db8cc977b56bba0639fb987f94a1a96332df5505f19c9c, by yodel at 2026-10-10T05:32:45.303Z
20261010T0532-validate-amount: resuming at statement 1
  statement 0: succeeded in an earlier run; not sent
  statement 1: ok (SQLPG220 validate, shop.orders)
20261010T0532-validate-amount: applied
...
```

## yodel status

`yodel status <env>` lists the environment's migrations against its history: applied, pending, out of order, failed part way (with the statement it resumes at), and checksum mismatches, and prints the plan digest `yodel apply` would ask approval for. It reads only and takes no lock. Exit codes: 0 every migration applied, 3 migrations pending, 4 a checksum mismatch or an out-of-order migration, 2 a pending migration has a step `yodel apply` does not run, 1 the status could not be read. `--json` prints it as JSON.

<!-- quote: postgres#status -->
```console
$ npx yodel status dev
Migrations in dev (postgres 18.6 at 127.0.0.1:5432/postgres, history yodeler.history)

Applied (7):
  20261010T0531-baseline  2026-10-10 05:31:59.965821 by yodel@example
  20261010T0532-coupons  2026-10-10 05:32:19.532446 by yodel@example
  20261010T0532-validate-amount  2026-10-10 05:32:49.686972 by yodel@example
  20261010T0532-rename-email  2026-10-10 05:33:05.861373 by yodel@example
  20261010T0533-drop-coupon  2026-10-10 05:33:24.090984 by yodel@example
  20261010T0533-add-gift  2026-10-10 05:34:45.624482 by yodel@example
  20261010T0533-index-placed-at  2026-10-10 05:34:22.041695 by yodel@example
      repaired 2026-10-10 05:34:32.012861 by yodel@example: rebased onto add-gift after it ran on dev

Pending: none
```

## Out-of-order migrations

A pending migration that the chain puts before one already applied is out of order. It can happen when a migration that ran in an environment is moved in the chain afterwards, as below. `yodel apply` refuses it (exit 4) and never skips it:

<!-- quote: postgres#out-of-order -->
```console
$ npx yodel apply dev
yodel apply: refused: 20261010T0533-add-gift is out of order: the chain puts it before 20261010T0533-index-placed-at, which is already applied. Nothing was applied. Pass --allow-out-of-order to apply it now (in chain order); it is never skipped.
[exit 4]
```

`--allow-out-of-order` applies it, in chain order, behind the same approval as any other run:

<!-- quote: postgres#out-of-order-apply -->
```console
$ npx yodel apply dev --allow-out-of-order
...
Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
lock: held in Postgres advisory lock (1498367052, 748638931) for history schema yodeler
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:1878c0839ddffd3f080512d43843abb8604befc6e1fcab3a1f0c2a52e6b72768, by yodel at 2026-10-10T05:34:41.015Z
20261010T0533-add-gift: applying (out of order, allowed)
  statement 0: ok (SQLPG201 metadata, shop.orders)
20261010T0533-add-gift: applied
...
```

## Forks and yodel rebase

Two branches that each add a migration give one parent two children. Merged together, `yodel lint` fails on the fork (an error that cannot be lowered), naming both:

<!-- quote: postgres#fork -->
```console
$ npx yodel lint
migrations/
  error    fork: 20261010T0533-add-gift and 20261010T0533-index-placed-at both follow 20261010T0533-drop-coupon; rebase one onto the other

20261010T0533-drop-coupon
  silenced destructive: step 0: SQLPG204 Drop a column on shop.orders: removes data that cannot be recovered
           reason: no order ever had a coupon; checked on dev

7 migrations: 1 error, 0 warnings, 1 silenced.
[exit 3]
```

`yodel rebase [<id>] [--onto <parent>]` moves a migration onto a new parent: its change (its recorded schema against its old parent's) is applied to the new parent's recorded schema, its statements are diffed again, and its files and checksum are written again. Migrations after it move with it. Ids do not change. With no `<id>` it resolves the directory's one fork by moving the newer of the two (by the timestamp in its id) onto the end of the other's branch.

A migration that ran somewhere must not be rebased: its statements already ran in that order. `--env <env>` (repeatable) reads each environment's history first and refuses to move a migration it records:

<!-- quote: postgres#rebase-refused -->
```console
$ npx yodel rebase 20261010T0533-index-placed-at --onto 20261010T0533-add-gift --env dev
yodel rebase: refused: dev's history records 20261010T0533-index-placed-at (applied). Nothing was written. A migration that ran is never rebased: its statements already ran in that order. Rebase the other branch onto it instead (yodel rebase <the other> --onto <the end of this one>).
[exit 4]
```

The fix it names is to move the other migration instead: here `yodel rebase <add-gift> --onto <index-placed-at> --env dev`. Without `--env`, no history is checked, and the rebase says so:

<!-- quote: postgres#rebase -->
```console
$ npx yodel rebase 20261010T0533-index-placed-at --onto 20261010T0533-add-gift
Rebased 20261010T0533-index-placed-at onto 20261010T0533-add-gift (it followed 20261010T0533-drop-coupon).
  20261010T0533-index-placed-at: follows 20261010T0533-add-gift; 2 statements; checksum sha256:410404006edaf140669995ff0d58a50107c7c942b1a584969ea26f4f93495f27 -> sha256:cee769c87a775fc8908095c799c7a93f0f6ba16aaac3ba2e13464d09ff0f071d
No history was checked (--env): make sure none of these ran anywhere before merging.
```

`yodel rebase` also refuses (exit 4, nothing written) when both branches change the same object differently (resolve it by hand: delete the migration and run `yodel new` again), when a migration it would rewrite was edited by hand (unless `--force`, which drops the edits), or when the moved migration adds nothing on its new parent. A `-- yodel:allow` line ([Lint](lint.md)) does not count as an edit by hand: the rebase writes it again above the same statement, and says how many it carried over. When the statement a line silenced is gone from the rebased migration or changed, the rebase refuses (exit 4, nothing written) and names the line; remove it, record the checksum with `yodel lint --update-checksum <id>`, rebase, and silence what the new statements need.

## yodel repair

An applied migration whose files changed no longer matches the checksum its history recorded, and `yodel status` and `yodel apply` refuse:

<!-- quote: postgres#checksum-refused -->
```console
$ npx yodel apply dev
yodel apply: refused: the history does not match the migrations directory; nothing was applied:
  20261010T0533-index-placed-at was applied with checksum sha256:410404006edaf140669995ff0d58a50107c7c942b1a584969ea26f4f93495f27, but its files now hash to sha256:cee769c87a775fc8908095c799c7a93f0f6ba16aaac3ba2e13464d09ff0f071d; if the edit is intended, record it with yodel repair 20261010T0533-index-placed-at --reason ... <env>
[exit 4]
```

When the edit is intended (here, the rebase above; or a statement edited after a server upgrade made it invalid), `yodel repair <id> --reason "<text>" <env>` appends a row with the files' new checksum and the reason, under the apply lock. Nothing runs on the server: the edit is recorded, not applied. Repair each environment the migration ran in.

<!-- quote: postgres#repair -->
```console
$ npx yodel repair 20261010T0533-index-placed-at --reason 'rebased onto add-gift after it ran on dev' dev
Repaired 20261010T0533-index-placed-at in dev's history (yodeler).
  old checksum: sha256:410404006edaf140669995ff0d58a50107c7c942b1a584969ea26f4f93495f27
  new checksum: sha256:cee769c87a775fc8908095c799c7a93f0f6ba16aaac3ba2e13464d09ff0f071d
  reason: rebased onto add-gift after it ran on dev
```

`yodel status` then lists the migration with the time it was applied and who applied it, and the repair (when, by whom, and why) under it, as in [yodel status](#yodel-status) below. It refuses (exit 4) when the migration is not applied in that environment, when its files already match, or when it is gone from the directory. When the edit is to a migration applied nowhere yet, there is no history to repair: `yodel lint --update-checksum <id>` writes the new checksum into its `migration.json` ([Lint](lint.md)).
