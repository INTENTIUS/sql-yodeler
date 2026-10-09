# ClickHouse example

A ClickHouse database taken from the declarative path to versioned migrations: adoption with `yodel init --from`, a migration, a sort-key change run as a rebuild step, a backfill step, a lint silence, an approval that stops holding, drift, and the replay check. Every command below ran against the emulator (`chant emulator up --lexicon sql`), and the output under each is what it printed. `examples/walkthrough/clickhouse.ts` holds the steps; `npx tsx examples/walkthrough/run.ts clickhouse --write` runs them again and rewrites this file and the project files from the run.

The project in this directory is what the walkthrough leaves: `src/schema.ts`, the migrations it wrote, and the two Ops.

To run it yourself, from a clone of this repository:

```sh
npm ci && npm run build          # in the repository root
chant emulator up --lexicon sql  # or any ClickHouse you can drop yodel_18_shop on
cd examples/clickhouse
npm install                      # takes @intentius/sql-yodeler from ../..
export DEV_CLICKHOUSE_URL=http://127.0.0.1:8123
```

The run happened in a temporary copy of this directory, a git repository with a local `origin`; its path is shown as `<tmp>`. A command that exited with a code other than 0 ends with `[exit <code>]`.

## 1. A declared schema, applied without migrations

The project starts on the declarative path: `src/schema.ts` says what the database should be, and an `ApplyOp` applies it. There is no `migrations/` directory, so `yodel plan` and `yodel apply` diff the declared schema against the live database. `package.json` has a `build` script (`chant build src --lexicon sql -o dist/schema.json`), which the `ApplyOp` runs first.

`src/schema.ts`:

```ts
import { database, table } from "@intentius/chant-lexicon-sql/clickhouse";

export const shop = database`
  CREATE DATABASE yodel_18_shop
  ENGINE = Atomic
  COMMENT 'The SQL Yodeler ClickHouse example'`;

export const events = table`
  CREATE TABLE ${shop}.events (
    id   UInt64,
    kind LowCardinality(String),
    at   DateTime
  )
  ENGINE = MergeTree
  PARTITION BY toYYYYMM(at)
  ORDER BY (kind, at)`;
```

`ops/apply-dev.op.ts`:

```ts
import { ApplyOp } from "@intentius/chant/op";

// The declarative path: yodel apply dev plans src/ against dev and runs this
// Op, behind a gate bound to the plan.
export const { op } = ApplyOp({ name: "apply-dev", env: "dev", target: "clickhouse", gate: {} });
```

```console
$ npx yodel plan dev
Plan for dev (clickhouse, sql.profiles.dev, topology single (default))

shop (yodel_18_shop)
  [create] object: yodel_18_shop
      SQLCH200 Create an object. A new database, table or view is created; nothing existing changes. https://clickhouse.com/docs/sql-reference/statements/create
events (yodel_18_shop.events)
  [create] object: yodel_18_shop.events
      SQLCH200 Create an object. A new database, table or view is created; nothing existing changes. https://clickhouse.com/docs/sql-reference/statements/create

2 create
```

`yodel apply dev` runs the `ApplyOp`. It stops at the gate, which wants an approval of this exact plan, and exits 3:

```console
$ npx yodel apply dev
Plan for dev (clickhouse, sql.profiles.dev)

shop (yodel_18_shop)
  [create] object: yodel_18_shop
      SQLCH200 Create an object. A new database, table or view is created; nothing existing changes. https://clickhouse.com/docs/sql-reference/statements/create
events (yodel_18_shop.events)
  [create] object: yodel_18_shop.events
      SQLCH200 Create an object. A new database, table or view is created; nothing existing changes. https://clickhouse.com/docs/sql-reference/statements/create

2 create

Running apply-dev (<tmp>/clickhouse/ops/apply-dev.op.ts)

> sql-yodeler-example-clickhouse@0.0.0 build
> chant build src --lexicon sql -o dist/schema.json


fold: 1 file folded, 0 ran

sql — environment: dev
2 missing, 0 orphan, 0 disappeared, 0 newly observed, 0 drifted, 0 unchanged
--------------------------------------------------------------------------------

MISSING (declared, provider reports not in cloud):
  - events [queried http://192.168.14.189:8123 yodel_18_shop.events] [definition 4df0ec958ca149f9d5e482606258feb8ab4820f0dbff84efa26e4b94c1b657eb]
  - shop [queried http://192.168.14.189:8123 yodel_18_shop] [definition 9753d576a549332582784b40e5a42ded207e362694a6c40ae17e65dfc511e4bc]
[phase] Build
  ✓ chantBuild(path=.)   1.4s
[phase] Plan
  ✓ lifecycleDiff(env=dev, live=true)   1.2s
    [outcome] Drift=true
[phase] Approve
  • gate:approve-apply-dev()   skipped
[phase] Apply
  • nativeApply(target=clickhouse, env=dev, output=dist/schema.json, deleteMode=never)   skipped
Op "apply-dev" is gated on "approve-apply-dev" after 3.7s
  Approve apply to dev (delete mode: never)
  plan    : jcs1-sha256:9f3ff42832188c693979a158c11d5fe50bee60ebb0dc48162ed791178c2b1263
  approve : chant approve apply-dev approve-apply-dev --plan jcs1-sha256:9f3ff42832188c693979a158c11d5fe50bee60ebb0dc48162ed791178c2b1263
  expires : 2026-10-11T20:36:37.561Z

apply-dev is waiting at gate "approve-apply-dev" for approval of this plan.
Approve it with:
  chant approve apply-dev approve-apply-dev --plan jcs1-sha256:9f3ff42832188c693979a158c11d5fe50bee60ebb0dc48162ed791178c2b1263
then run yodel apply dev again.
[exit 3]
```

The approval is a commit on the `chant/lifecycle` branch. Approve, then run the apply again:

```console
$ npx chant approve apply-dev approve-apply-dev --plan jcs1-sha256:9f3ff42832188c693979a158c11d5fe50bee60ebb0dc48162ed791178c2b1263
Gate "approve-apply-dev" on "apply-dev" resolved by yodel at 2026-10-09T20:36:40.363Z
This approves the plan jcs1-sha256:9f3ff42832188c693979a158c11d5fe50bee60ebb0dc48162ed791178c2b1263, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run apply-dev` and it walks through gate "approve-apply-dev".
```

```console
$ npx yodel apply dev
Plan for dev (clickhouse, sql.profiles.dev)

shop (yodel_18_shop)
  [create] object: yodel_18_shop
      SQLCH200 Create an object. A new database, table or view is created; nothing existing changes. https://clickhouse.com/docs/sql-reference/statements/create
events (yodel_18_shop.events)
  [create] object: yodel_18_shop.events
      SQLCH200 Create an object. A new database, table or view is created; nothing existing changes. https://clickhouse.com/docs/sql-reference/statements/create

2 create

Running apply-dev (<tmp>/clickhouse/ops/apply-dev.op.ts)

> sql-yodeler-example-clickhouse@0.0.0 build
> chant build src --lexicon sql -o dist/schema.json


fold: 1 file folded, 0 ran

sql — environment: dev
2 missing, 0 orphan, 0 disappeared, 0 newly observed, 0 drifted, 0 unchanged
--------------------------------------------------------------------------------

MISSING (declared, provider reports not in cloud):
  - events [queried http://192.168.14.189:8123 yodel_18_shop.events] [definition 4df0ec958ca149f9d5e482606258feb8ab4820f0dbff84efa26e4b94c1b657eb]
  - shop [queried http://192.168.14.189:8123 yodel_18_shop] [definition 9753d576a549332582784b40e5a42ded207e362694a6c40ae17e65dfc511e4bc]
CREATE DATABASE yodel_18_shop
  ENGINE = Atomic
  COMMENT 'The SQL Yodeler ClickHouse example [chant managed-by=chant]'
CREATE TABLE yodel_18_shop.events (
    id   UInt64,
    kind LowCardinality(String),
    at   DateTime
  )
  ENGINE = MergeTree
  PARTITION BY toYYYYMM(at)
  ORDER BY (kind, at) COMMENT '[chant managed-by=chant]'
created: ClickHouse::Database/yodel_18_shop
created: ClickHouse::Table/yodel_18_shop.events
[dev] applied 2 resource(s)
[phase] Build
  ✓ chantBuild(path=.)   1.1s
[phase] Plan
  ✓ lifecycleDiff(env=dev, live=true)   1.1s
    [outcome] Drift=true
[phase] Approve
  ✓ gate:approve-apply-dev()   334ms
    [approved] yodel at 2026-10-09T20:36:40.363Z
[phase] Apply
  ✓ nativeApply(target=clickhouse, env=dev, output=dist/schema.json, deleteMode=never)   37ms
Op "apply-dev" completed in 2.8s

Applied: dev matches the declared schema.
```

```console
$ npx yodel plan dev
Plan for dev (clickhouse, sql.profiles.dev, topology single (default))

No changes.
```

## 2. Adopting the database into versioned migrations

Some data arrives:

```sql
INSERT INTO yodel_18_shop.events
SELECT number, ['view', 'cart', 'buy'][number % 3 + 1], toDateTime('2026-03-01 00:00:00') + toIntervalHour(number * 7)
FROM numbers(600)
```

To move to versioned migrations, `yodel init --from dev` reads the live database, writes its declarations to `src/`, checks that they plan clean against it, writes the baseline migration (the one that creates everything), and records the baseline applied in dev's history without running it. `src/schema.ts` already declares the schema, so it needs `--force` to write over it:

```console
$ npx yodel init --from dev --force
read 2 object(s) from dev
wrote src/schema.ts
planned against dev: no change
wrote migrations/20261009T2036-baseline (2 statements)
lock: no KeeperMap on this server (KeeperMap is disabled because 'keeper_map_path_prefix' config is not defined. (BAD_ARGUMENTS) (version 26.8.15.10 (official build))); the lock is a file on this machine, so cross-runner locking needs Keeper (and keeper_map_path_prefix)
recorded 20261009T2036-baseline applied in yodel_18_history.history as a baseline; none of its statements was run
Adopted dev (clickhouse): 2 objects
  Database yodel_18_shop
  Table yodel_18_shop.events

Declarations: src/schema.ts
Baseline:     migrations/20261009T2036-baseline/ (2 statements, sha256:9353189519b18681df1e8b476555b2a6ed37472c0956494543ec627821df75b2)
Recorded:     applied in yodel_18_history.history as a baseline; none of its statements was run

yodel plan dev shows no change, and yodel status dev lists the baseline applied.
```

`src/schema.ts`:

```ts
import { database, table } from "@intentius/chant-lexicon-sql/clickhouse";

export const yodel18ShopDb = database`
  CREATE DATABASE yodel_18_shop
  ENGINE = Atomic
  COMMENT 'The SQL Yodeler ClickHouse example'`;

export const events = table`
  CREATE TABLE ${yodel18ShopDb}.events
  (
      id UInt64,
      kind LowCardinality(String),
      at DateTime
  )
  ENGINE = MergeTree
  PARTITION BY toYYYYMM(at)
  ORDER BY (kind, at)`;
```

```console
$ npx yodel status dev
Migrations in dev (history yodel_18_history.history, topology single (default))

Applied (1):
  20261009T2036-baseline  2026-10-09 20:36:52.078218 by yodel@example

Pending: none
```

From here `yodel apply dev` takes the versioned path, which runs a migrations Op: a Plan step that prints the plan digest, a gate bound to it, and an Apply step. The `ApplyOp` goes, and `ops/migrate-dev.op.ts` comes in:

```console
$ git rm -q ops/apply-dev.op.ts
```

`ops/migrate-dev.op.ts`:

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

## 3. A migration

Add a column to the declared schema:

`src/schema.ts` now:

```ts
import { database, table } from "@intentius/chant-lexicon-sql/clickhouse";

export const yodel18ShopDb = database`
  CREATE DATABASE yodel_18_shop
  ENGINE = Atomic
  COMMENT 'The SQL Yodeler ClickHouse example'`;

export const events = table`
  CREATE TABLE ${yodel18ShopDb}.events
  (
      id UInt64,
      kind LowCardinality(String),
      at DateTime,
      country LowCardinality(String) DEFAULT ''
  )
  ENGINE = MergeTree
  PARTITION BY toYYYYMM(at)
  ORDER BY (kind, at)`;
```

`yodel new` diffs the declared schema against the schema the newest migration recorded. It reads no database.

```console
$ npx yodel new add-country
Wrote migrations/20261009T2037-add-country/ (1 statement; follows 20261009T2036-baseline)
```

`migrations/20261009T2037-add-country/migration.sql`:

```sql
-- yodel migration 20261009T2037-add-country
-- parent: 20261009T2036-baseline

-- events (yodel_18_shop.events): SQLCH201 metadata
ALTER TABLE `yodel_18_shop`.`events` ADD COLUMN country LowCardinality(String) DEFAULT '' AFTER `at`;
```

```console
$ npx yodel lint
2 migrations: 0 errors, 0 warnings, 0 silenced.
```

```console
$ npx yodel plan dev
Plan for dev (clickhouse, history yodel_18_history.history (single (default))): 1 applied, 1 pending

20261009T2037-add-country
  0  statement  SQLCH201 metadata  yodel_18_shop.events
       ALTER TABLE `yodel_18_shop`.`events` ADD COLUMN country LowCardinality(String) DEFAULT '' AFTER `at`

Plan digest: jcs1-sha256:422f8f3965409785957d82d21c3a2744f59bed9e24b5a31ad60451762e1bba59
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:422f8f3965409785957d82d21c3a2744f59bed9e24b5a31ad60451762e1bba59

Not approved yet. Approving binds exactly this digest; if anything it covers changes before the apply runs, the gate asks again and nothing is applied.
```

```console
$ npx yodel apply dev
Migrations in dev (history yodel_18_history.history, topology single (default))

Applied (1):
  20261009T2036-baseline  2026-10-09 20:36:52.078218 by yodel@example

Pending (1):
  20261009T2037-add-country

Plan digest: jcs1-sha256:422f8f3965409785957d82d21c3a2744f59bed9e24b5a31ad60451762e1bba59

Running migrate-dev (<tmp>/clickhouse/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   4.2s
[phase] Approve
  • gate:approve-migrate-dev()   skipped
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 5.3s
  plan    : jcs1-sha256:422f8f3965409785957d82d21c3a2744f59bed9e24b5a31ad60451762e1bba59
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:422f8f3965409785957d82d21c3a2744f59bed9e24b5a31ad60451762e1bba59
  expires : 2026-10-11T20:37:34.570Z

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:422f8f3965409785957d82d21c3a2744f59bed9e24b5a31ad60451762e1bba59).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:422f8f3965409785957d82d21c3a2744f59bed9e24b5a31ad60451762e1bba59
then run yodel apply dev again.
[exit 3]
```

```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:422f8f3965409785957d82d21c3a2744f59bed9e24b5a31ad60451762e1bba59
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-09T20:37:37.954Z
This approves the plan jcs1-sha256:422f8f3965409785957d82d21c3a2744f59bed9e24b5a31ad60451762e1bba59, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

The emulator has no Keeper, so the apply lock is a file on this machine, and the run says so. On a server with Keeper and `keeper_map_path_prefix` the lock is a row in a KeeperMap table, shared by every runner.

```console
$ npx yodel apply dev
Migrations in dev (history yodel_18_history.history, topology single (default))

Applied (1):
  20261009T2036-baseline  2026-10-09 20:36:52.078218 by yodel@example

Pending (1):
  20261009T2037-add-country

Plan digest: jcs1-sha256:422f8f3965409785957d82d21c3a2744f59bed9e24b5a31ad60451762e1bba59

Running migrate-dev (<tmp>/clickhouse/ops/migrate-dev.op.ts)
lock: no KeeperMap on this server (KeeperMap is disabled because 'keeper_map_path_prefix' config is not defined. (BAD_ARGUMENTS) (version 26.8.15.10 (official build))); the lock is a file on this machine, so cross-runner locking needs Keeper (and keeper_map_path_prefix)
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:422f8f3965409785957d82d21c3a2744f59bed9e24b5a31ad60451762e1bba59, by yodel at 2026-10-09T20:37:37.954Z
20261009T2037-add-country: applying
  statement 0: ok (SQLCH201 metadata, yodel_18_shop.events)
20261009T2037-add-country: applied

[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   1.4s
[phase] Approve
  ✓ gate:approve-migrate-dev()   375ms
    [approved] yodel at 2026-10-09T20:37:37.954Z
[phase] Apply
  ✓ shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":"jcs1-sha256:422f8f3965409785957d82d21c3a2744f59bed9e24b5a31ad60451762e1bba59"})   3.3s
Op "migrate-dev" completed in 5.3s

Applied: 20261009T2037-add-country.
```

```console
$ npx yodel status dev
Migrations in dev (history yodel_18_history.history, topology single (default))

Applied (2):
  20261009T2036-baseline  2026-10-09 20:36:52.078218 by yodel@example
  20261009T2037-add-country  2026-10-09 20:37:44.119758 by yodel@example

Pending: none
```

## 4. A sort-key change: a rebuild step

ClickHouse cannot change a table's sort key with `ALTER`. Change it in the declared schema:

`src/schema.ts` now:

```ts
import { database, table } from "@intentius/chant-lexicon-sql/clickhouse";

export const yodel18ShopDb = database`
  CREATE DATABASE yodel_18_shop
  ENGINE = Atomic
  COMMENT 'The SQL Yodeler ClickHouse example'`;

export const events = table`
  CREATE TABLE ${yodel18ShopDb}.events
  (
      id UInt64,
      kind LowCardinality(String),
      at DateTime,
      country LowCardinality(String) DEFAULT ''
  )
  ENGINE = MergeTree
  PARTITION BY toYYYYMM(at)
  ORDER BY (kind, id)`;
```

`yodel new` writes the change as a `ClickHouseRebuildOp` step: a new table with the new key, a materialized view that writes rows at or after a cut-over time into it, a backfill of the rows before the cut-over partition by partition (a receipt per partition), a verification, and a swap.

```console
$ npx yodel new events-by-id
Wrote migrations/20261009T2037-events-by-id/ (0 statements; follows 20261009T2037-add-country)
  This migration contains an Op step: ClickHouseRebuildOp for events (yodel_18_shop.events), SQLCH220.
    It is not SQL. migration.json holds the Op's declaration:
    export const { op } = ClickHouseRebuildOp({ name: "rebuild-yodel-18-shop-events", env: "<env>", table: "yodel_18_shop.events", dualWrite: { mode: "materialized-view", cutoverColumn: "at" } });
```

`migrations/20261009T2037-events-by-id/migration.sql`:

```sql
-- yodel migration 20261009T2037-events-by-id
-- parent: 20261009T2037-add-country
-- This migration contains an Op step, not only SQL:
--   ClickHouseRebuildOp for events (yodel_18_shop.events), SQLCH220: not SQL; migration.json holds its declaration

-- events (yodel_18_shop.events): SQLCH220 made by ClickHouseRebuildOp, not a statement:
--   export const { op } = ClickHouseRebuildOp({ name: "rebuild-yodel-18-shop-events", env: "<env>", table: "yodel_18_shop.events", dualWrite: { mode: "materialized-view", cutoverColumn: "at" } });
```

`yodel lint` flags a rebuild as an error (`ch-rebuild`):

```console
$ npx yodel lint
20261009T2037-events-by-id
  error    ch-rebuild: step 0: ClickHouseRebuildOp rebuilds yodel_18_shop.events: every row is copied into a new table and swapped in, for SQLCH220 Change the sorting key (orderBy)

A statement rule can be silenced for one statement, with a reason the history records when it applies:
  a line `-- yodel:allow <rule> <reason>` above the statement in migration.sql

3 migrations: 1 error, 0 warnings, 0 silenced.
[exit 3]
```

The table is small, so the rebuild is fine. Silence the rule for this step with a reason, on the line above it in `migration.sql`:

`migrations/20261009T2037-events-by-id/migration.sql` now:

```sql
-- yodel migration 20261009T2037-events-by-id
-- parent: 20261009T2037-add-country
-- This migration contains an Op step, not only SQL:
--   ClickHouseRebuildOp for events (yodel_18_shop.events), SQLCH220: not SQL; migration.json holds its declaration

-- yodel:allow ch-rebuild 600 rows; the copy takes seconds
-- events (yodel_18_shop.events): SQLCH220 made by ClickHouseRebuildOp, not a statement:
--   export const { op } = ClickHouseRebuildOp({ name: "rebuild-yodel-18-shop-events", env: "<env>", table: "yodel_18_shop.events", dualWrite: { mode: "materialized-view", cutoverColumn: "at" } });
```

The edit changes the migration's checksum, which lint reports, and the migration has not been applied anywhere, so record the new one:

```console
$ npx yodel lint
20261009T2037-events-by-id
  error    checksum: 20261009T2037-events-by-id: its files hash to sha256:ae876bda3c522b1ad17e12f610ef998efbd99a2e76520e1bfa330eb610c2f652, but migration.json records sha256:527bd001468ad3101a7552c3d2aa1ccf10dba756e4a9d8bd5fb2ac2fb7fbb35d; if it is not applied in any environment, record its new checksum with yodel lint --update-checksum 20261009T2037-events-by-id; if it is, undo the edit, or record it with yodel repair 20261009T2037-events-by-id --reason ... <env>
  silenced ch-rebuild: step 0: ClickHouseRebuildOp rebuilds yodel_18_shop.events: every row is copied into a new table and swapped in, for SQLCH220 Change the sorting key (orderBy)
           reason: 600 rows; the copy takes seconds

3 migrations: 1 error, 0 warnings, 1 silenced.
[exit 3]
```

```console
$ npx yodel lint --update-checksum 20261009T2037-events-by-id
20261009T2037-events-by-id: checksum sha256:527bd001468ad3101a7552c3d2aa1ccf10dba756e4a9d8bd5fb2ac2fb7fbb35d is now sha256:ae876bda3c522b1ad17e12f610ef998efbd99a2e76520e1bfa330eb610c2f652
20261009T2037-events-by-id
  silenced ch-rebuild: step 0: ClickHouseRebuildOp rebuilds yodel_18_shop.events: every row is copied into a new table and swapped in, for SQLCH220 Change the sorting key (orderBy)
           reason: 600 rows; the copy takes seconds

3 migrations: 0 errors, 0 warnings, 1 silenced.
```

The pull request comment (`yodel plan dev --comment` in CI) is this Markdown:

````console
$ npx yodel plan dev --format markdown
<!-- yodel:plan env=dev -->
### yodel plan: `dev`

ClickHouse, history `yodel_18_history.history (single (default))`: 2 applied, **1 pending**.

#### `20261009T2037-events-by-id`

| # | Step | Rule | Class | Object |
|---|---|---|---|---|
| 0 | **Op ClickHouseRebuildOp** | SQLCH220 | rebuild | `yodel_18_shop.events` |

Op steps:
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

Plan digest the apply gate binds: `jcs1-sha256:1956d6b1748a90c3114a31c4b5f9e827970c8c5c0097deb5cb9dd9642a44d3e5`

Approve it with:

```sh
chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:1956d6b1748a90c3114a31c4b5f9e827970c8c5c0097deb5cb9dd9642a44d3e5
```

The newest approval of `approve-migrate-dev`, by yodel at 2026-10-09T20:37:37.954Z, is for `jcs1-sha256:422f8f3965409785957d82d21c3a2744f59bed9e24b5a31ad60451762e1bba59`, not this plan; it does not hold.
What moved (as far as yodel can tell): history changed: applied since: 20261009T2037-add-country (by yodel@example at 2026-10-09 20:37:44.119758); pending migrations changed: committed to since approval: 20261009T2037-events-by-id (1192ba8 at 2026-10-09T14:37:52-06:00); live schema changed: no state yodel can rebuild from the history and git hashes to the approved digest with today's live schema, so an object in the environment's live schema (a table, view, index, dictionary, database or schema) changed since approval (or a part yodel cannot rebuild did).

<!-- yodel:subject eyJlbnZpcm9ubWVudCI6ImRldiIsImhpc3RvcnlEYXRhYmFzZSI6InlvZGVsXzE4X2hpc3RvcnkiLCJ0b3BvbG9neSI6eyJraW5kIjoic2luZ2xlIn0sImFwcGxpZWQiOlt7ImlkIjoiMjAyNjEwMDlUMjAzNi1iYXNlbGluZSIsImNoZWNrc3VtIjoic2hhMjU2OjkzNTMxODk1MTliMTg2ODFkZjFlOGI0NzY1NTViMmE2ZWQzNzQ3MmMwOTU2NDk0NTQzZWM2Mjc4MjFkZjc1YjIifSx7ImlkIjoiMjAyNjEwMDlUMjAzNy1hZGQtY291bnRyeSIsImNoZWNrc3VtIjoic2hhMjU2OmRlNWMwZjZkNTM5OGVhMzIzNzhmZGNlMjMwZGQwYjhlMmEwMTg4NGI3OTNkNGY2ZDc1ZDkyNTFhNDU3NWMyMTcifV0sInBlbmRpbmciOlt7ImlkIjoiMjAyNjEwMDlUMjAzNy1ldmVudHMtYnktaWQiLCJjaGVja3N1bSI6InNoYTI1NjphZTg3NmJkYTNjNTIyYjFhZDE3ZTEyZjYxMGVmOTk4ZWZiZDk5YTJlNzY1MjBlMWJmYTMzMGViNjEwYzJmNjUyIiwiZG9uZSI6W119XSwibGl2ZSI6InNoYTI1Njo0NTFkZjRjMDM4ODMxZWUyM2E0OGQxYzk3OTI1NmM0MWFjN2Y1NjA0ZTFhNTE4ZTY4NDA5NjJlNDRjYWYxMDk4In0 -->
````

```console
$ npx yodel apply dev
Migrations in dev (history yodel_18_history.history, topology single (default))

Applied (2):
  20261009T2036-baseline  2026-10-09 20:36:52.078218 by yodel@example
  20261009T2037-add-country  2026-10-09 20:37:44.119758 by yodel@example

Pending (1):
  20261009T2037-events-by-id  (step 0: ClickHouseRebuildOp for events (yodel_18_shop.events))

Plan digest: jcs1-sha256:1956d6b1748a90c3114a31c4b5f9e827970c8c5c0097deb5cb9dd9642a44d3e5

Running migrate-dev (<tmp>/clickhouse/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   1.1s
[phase] Approve
  • gate:approve-migrate-dev()   skipped
    [refused] Gate "approve-migrate-dev" is approved, but not for this plan. approved: jcs1-sha256:422f8f3965409785957d82d21c3a2744f59bed9e24b5a31ad60451762e1bba59 (by yodel at 2026-10-09T20:37:37.954Z); planned: jcs1-sha256:1956d6b1748a90c3114a31c4b5f9e827970c8c5c0097deb5cb9dd9642a44d3e5. The configuration or the live system changed between that approval and this plan, so it needs a fresh one: chant approve migrate-dev approve-migrate-dev
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 2.0s
  plan    : jcs1-sha256:1956d6b1748a90c3114a31c4b5f9e827970c8c5c0097deb5cb9dd9642a44d3e5
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:1956d6b1748a90c3114a31c4b5f9e827970c8c5c0097deb5cb9dd9642a44d3e5
  expires : 2026-10-11T20:37:57.507Z

Nothing was applied. The approval of jcs1-sha256:422f8f3965409785957d82d21c3a2744f59bed9e24b5a31ad60451762e1bba59 (by yodel at 2026-10-09T20:37:37.954Z) does not hold: the plan moved since. What moved, as far as yodel can tell: history changed: applied since: 20261009T2037-add-country (by yodel@example at 2026-10-09 20:37:44.119758); pending migrations changed: committed to since approval: 20261009T2037-events-by-id (1192ba8 at 2026-10-09T14:37:52-06:00); live schema changed: no state yodel can rebuild from the history and git hashes to the approved digest with today's live schema, so an object in the environment's live schema (a table, view, index, dictionary, database or schema) changed since approval (or a part yodel cannot rebuild did).

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:1956d6b1748a90c3114a31c4b5f9e827970c8c5c0097deb5cb9dd9642a44d3e5).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:1956d6b1748a90c3114a31c4b5f9e827970c8c5c0097deb5cb9dd9642a44d3e5
then run yodel apply dev again.
[exit 3]
```

```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:1956d6b1748a90c3114a31c4b5f9e827970c8c5c0097deb5cb9dd9642a44d3e5
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-09T20:38:00.313Z
This approves the plan jcs1-sha256:1956d6b1748a90c3114a31c4b5f9e827970c8c5c0097deb5cb9dd9642a44d3e5, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

The rebuild waits a minute for its cut-over before the backfill:

```console
$ npx yodel apply dev
Migrations in dev (history yodel_18_history.history, topology single (default))

Applied (2):
  20261009T2036-baseline  2026-10-09 20:36:52.078218 by yodel@example
  20261009T2037-add-country  2026-10-09 20:37:44.119758 by yodel@example

Pending (1):
  20261009T2037-events-by-id  (step 0: ClickHouseRebuildOp for events (yodel_18_shop.events))

Plan digest: jcs1-sha256:1956d6b1748a90c3114a31c4b5f9e827970c8c5c0097deb5cb9dd9642a44d3e5

Running migrate-dev (<tmp>/clickhouse/ops/migrate-dev.op.ts)
lock: no KeeperMap on this server (KeeperMap is disabled because 'keeper_map_path_prefix' config is not defined. (BAD_ARGUMENTS) (version 26.8.15.10 (official build))); the lock is a file on this machine, so cross-runner locking needs Keeper (and keeper_map_path_prefix)
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:1956d6b1748a90c3114a31c4b5f9e827970c8c5c0097deb5cb9dd9642a44d3e5, by yodel at 2026-10-09T20:38:00.313Z
20261009T2037-events-by-id: applying
  step 0: ClickHouseRebuildOp for events (yodel_18_shop.events)
  step 0: ok {"op":"ClickHouseRebuildOp","table":"yodel_18_shop.events","state":"rebuild","partitions":6,"copied":6,"skipped":0,"cleared":0,"verifiedRows":600,"swapped":true,"oldTable":"yodel_18_shop.events__chant_old","retainUntil":"2026-10-16T20:39:05.097Z"}
20261009T2037-events-by-id: applied

[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   1.1s
[phase] Approve
  ✓ gate:approve-migrate-dev()   266ms
    [approved] yodel at 2026-10-09T20:38:00.313Z
[phase] Apply
  ✓ shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":"jcs1-sha256:1956d6b1748a90c3114a31c4b5f9e827970c8c5c0097deb5cb9dd9642a44d3e5"})   61.7s
Op "migrate-dev" completed in 63.4s

Applied: 20261009T2037-events-by-id.
```

```sql
SELECT sorting_key, total_rows FROM system.tables WHERE database = 'yodel_18_shop' AND name LIKE 'events%' ORDER BY name FORMAT TSVWithNames
```

```
sorting_key	total_rows
kind, id	600
kind, at	600
```

The old table stays as `events__chant_old` until the date in the step's note (7 days).

## 5. A backfill step

`country` is empty for the rows already there. A backfill is a data migration in the same history as the DDL: an Op of `effect()` batches, each with its own receipt, so a run that stops part way resumes at the first batch without one. `yodel new --backfill <file>` writes a template when the file does not exist:

```console
$ npx yodel new fill-country --backfill backfills/country.ts
Wrote a backfill template at backfills/country.ts. Write its batches, then run yodel new fill-country --backfill backfills/country.ts again. No migration written.
```

Write the batches, one month each:

`backfills/country.ts`:

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

```console
$ npx yodel new fill-country --backfill backfills/country.ts
Wrote migrations/20261009T2039-fill-country/ (0 statements; follows 20261009T2037-events-by-id)
  This migration ends with a backfill step: the Op backfill.ts exports, copied into the migration's directory.
    yodel apply runs its effect() batches after the statements before it, resuming from their receipts after a failure.
```

`migrations/20261009T2039-fill-country/migration.sql`:

```sql
-- yodel migration 20261009T2039-fill-country
-- parent: 20261009T2037-events-by-id
-- This migration contains an Op step, not only SQL:
--   a backfill: the Op backfill.ts exports, its effect() batches resumable from their receipts

-- backfill (fill-country): made by the Op backfill.ts exports, not a statement
```

```console
$ npx yodel lint
20261009T2037-events-by-id
  silenced ch-rebuild: step 0: ClickHouseRebuildOp rebuilds yodel_18_shop.events: every row is copied into a new table and swapped in, for SQLCH220 Change the sorting key (orderBy)
           reason: 600 rows; the copy takes seconds

4 migrations: 0 errors, 0 warnings, 1 silenced.
```

The pull request comment lists the step under the Op steps apply runs, with the backfill's module:

````console
$ npx yodel plan dev --format markdown
<!-- yodel:plan env=dev -->
### yodel plan: `dev`

ClickHouse, history `yodel_18_history.history (single (default))`: 3 applied, **1 pending**.

#### `20261009T2039-fill-country`

| # | Step | Rule | Class | Object |
|---|---|---|---|---|
| 0 | **Op backfill** |  |  | `fill-country` |

Op steps:
- step 0, `fill-country`: made by Op `backfill` (backfill.ts). yodel apply runs it as this step.

  <details><summary>backfill: backfill.ts</summary>

  ```text
  a data backfill: the effect() steps of the Op in backfill.ts, each a batch with its own receipt; yodel apply runs it after the statements before it and resumes it from its receipts
  ```

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

  </details>

#### Approval

Plan digest the apply gate binds: `jcs1-sha256:eaf4af6d1b7133e0863c24b0f42df7b08d673aaca833ba6b159f33052ff8a88f`

Approve it with:

```sh
chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:eaf4af6d1b7133e0863c24b0f42df7b08d673aaca833ba6b159f33052ff8a88f
```

The newest approval of `approve-migrate-dev`, by yodel at 2026-10-09T20:38:00.313Z, is for `jcs1-sha256:1956d6b1748a90c3114a31c4b5f9e827970c8c5c0097deb5cb9dd9642a44d3e5`, not this plan; it does not hold.
What moved (as far as yodel can tell): history changed: applied since: 20261009T2037-events-by-id (by yodel@example at 2026-10-09 20:39:05.207672); live schema changed: no state yodel can rebuild from the history and git hashes to the approved digest with today's live schema, so an object in the environment's live schema (a table, view, index, dictionary, database or schema) changed since approval (or a part yodel cannot rebuild did).

<!-- yodel:subject eyJlbnZpcm9ubWVudCI6ImRldiIsImhpc3RvcnlEYXRhYmFzZSI6InlvZGVsXzE4X2hpc3RvcnkiLCJ0b3BvbG9neSI6eyJraW5kIjoic2luZ2xlIn0sImFwcGxpZWQiOlt7ImlkIjoiMjAyNjEwMDlUMjAzNi1iYXNlbGluZSIsImNoZWNrc3VtIjoic2hhMjU2OjkzNTMxODk1MTliMTg2ODFkZjFlOGI0NzY1NTViMmE2ZWQzNzQ3MmMwOTU2NDk0NTQzZWM2Mjc4MjFkZjc1YjIifSx7ImlkIjoiMjAyNjEwMDlUMjAzNy1hZGQtY291bnRyeSIsImNoZWNrc3VtIjoic2hhMjU2OmRlNWMwZjZkNTM5OGVhMzIzNzhmZGNlMjMwZGQwYjhlMmEwMTg4NGI3OTNkNGY2ZDc1ZDkyNTFhNDU3NWMyMTcifSx7ImlkIjoiMjAyNjEwMDlUMjAzNy1ldmVudHMtYnktaWQiLCJjaGVja3N1bSI6InNoYTI1NjphZTg3NmJkYTNjNTIyYjFhZDE3ZTEyZjYxMGVmOTk4ZWZiZDk5YTJlNzY1MjBlMWJmYTMzMGViNjEwYzJmNjUyIn1dLCJwZW5kaW5nIjpbeyJpZCI6IjIwMjYxMDA5VDIwMzktZmlsbC1jb3VudHJ5IiwiY2hlY2tzdW0iOiJzaGEyNTY6NjNkZTM5MTM0ODljOGQ1OTMyNjY3MmQ2MGNjY2MzNTllMTFiODJkOTViYjVjYWE4Yjc5MDJjMjlhYmUzNTk5ZCIsImRvbmUiOltdfV0sImxpdmUiOiJzaGEyNTY6YzJjNDY3MWRhMDg4ZTVmMDc5NjM2ZWYzZWNjYWVlYWM2OTM5MDAzYmRmNTkxN2M3MzQ4Mjg1ZDMyNDA2MmQ1NCJ9 -->
````

```console
$ npx yodel apply dev
Migrations in dev (history yodel_18_history.history, topology single (default))

Applied (3):
  20261009T2036-baseline  2026-10-09 20:36:52.078218 by yodel@example
  20261009T2037-add-country  2026-10-09 20:37:44.119758 by yodel@example
  20261009T2037-events-by-id  2026-10-09 20:39:05.207672 by yodel@example

Pending (1):
  20261009T2039-fill-country  (step 0: backfill backfill.ts)

Plan digest: jcs1-sha256:eaf4af6d1b7133e0863c24b0f42df7b08d673aaca833ba6b159f33052ff8a88f

Running migrate-dev (<tmp>/clickhouse/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   1.2s
[phase] Approve
  • gate:approve-migrate-dev()   skipped
    [refused] Gate "approve-migrate-dev" is approved, but not for this plan. approved: jcs1-sha256:1956d6b1748a90c3114a31c4b5f9e827970c8c5c0097deb5cb9dd9642a44d3e5 (by yodel at 2026-10-09T20:38:00.313Z); planned: jcs1-sha256:eaf4af6d1b7133e0863c24b0f42df7b08d673aaca833ba6b159f33052ff8a88f. The configuration or the live system changed between that approval and this plan, so it needs a fresh one: chant approve migrate-dev approve-migrate-dev
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 2.6s
  plan    : jcs1-sha256:eaf4af6d1b7133e0863c24b0f42df7b08d673aaca833ba6b159f33052ff8a88f
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:eaf4af6d1b7133e0863c24b0f42df7b08d673aaca833ba6b159f33052ff8a88f
  expires : 2026-10-11T20:39:15.955Z

Nothing was applied. The approval of jcs1-sha256:1956d6b1748a90c3114a31c4b5f9e827970c8c5c0097deb5cb9dd9642a44d3e5 (by yodel at 2026-10-09T20:38:00.313Z) does not hold: the plan moved since. What moved, as far as yodel can tell: history changed: applied since: 20261009T2037-events-by-id (by yodel@example at 2026-10-09 20:39:05.207672); pending migrations changed: committed to since approval: 20261009T2039-fill-country (a3d3c3d at 2026-10-09T14:39:11-06:00); live schema changed: no state yodel can rebuild from the history and git hashes to the approved digest with today's live schema, so an object in the environment's live schema (a table, view, index, dictionary, database or schema) changed since approval (or a part yodel cannot rebuild did).

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:eaf4af6d1b7133e0863c24b0f42df7b08d673aaca833ba6b159f33052ff8a88f).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:eaf4af6d1b7133e0863c24b0f42df7b08d673aaca833ba6b159f33052ff8a88f
then run yodel apply dev again.
[exit 3]
```

```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:eaf4af6d1b7133e0863c24b0f42df7b08d673aaca833ba6b159f33052ff8a88f
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-09T20:39:20.182Z
This approves the plan jcs1-sha256:eaf4af6d1b7133e0863c24b0f42df7b08d673aaca833ba6b159f33052ff8a88f, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

```console
$ npx yodel apply dev
Migrations in dev (history yodel_18_history.history, topology single (default))

Applied (3):
  20261009T2036-baseline  2026-10-09 20:36:52.078218 by yodel@example
  20261009T2037-add-country  2026-10-09 20:37:44.119758 by yodel@example
  20261009T2037-events-by-id  2026-10-09 20:39:05.207672 by yodel@example

Pending (1):
  20261009T2039-fill-country  (step 0: backfill backfill.ts)

Plan digest: jcs1-sha256:eaf4af6d1b7133e0863c24b0f42df7b08d673aaca833ba6b159f33052ff8a88f

Running migrate-dev (<tmp>/clickhouse/ops/migrate-dev.op.ts)
lock: no KeeperMap on this server (KeeperMap is disabled because 'keeper_map_path_prefix' config is not defined. (BAD_ARGUMENTS) (version 26.8.15.10 (official build))); the lock is a file on this machine, so cross-runner locking needs Keeper (and keeper_map_path_prefix)
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:eaf4af6d1b7133e0863c24b0f42df7b08d673aaca833ba6b159f33052ff8a88f, by yodel at 2026-10-09T20:39:20.182Z
20261009T2039-fill-country: applying
  step 0: backfill backfill.ts
    ALTER TABLE yodel_18_shop.events UPDATE country = ['DE', 'FR', 'US'][id % 3 + 1] WHERE toYYYYMM(at) = 202603 AND country = ''
    ALTER TABLE yodel_18_shop.events UPDATE country = ['DE', 'FR', 'US'][id % 3 + 1] WHERE toYYYYMM(at) = 202604 AND country = ''
    ALTER TABLE yodel_18_shop.events UPDATE country = ['DE', 'FR', 'US'][id % 3 + 1] WHERE toYYYYMM(at) = 202605 AND country = ''
    ALTER TABLE yodel_18_shop.events UPDATE country = ['DE', 'FR', 'US'][id % 3 + 1] WHERE toYYYYMM(at) = 202606 AND country = ''
    ALTER TABLE yodel_18_shop.events UPDATE country = ['DE', 'FR', 'US'][id % 3 + 1] WHERE toYYYYMM(at) = 202607 AND country = ''
    ALTER TABLE yodel_18_shop.events UPDATE country = ['DE', 'FR', 'US'][id % 3 + 1] WHERE toYYYYMM(at) = 202608 AND country = ''
  step 0: ok {"op":"backfill","file":"backfill.ts","name":"backfill-fill-country","effects":6,"skipped":0,"ran":6}
20261009T2039-fill-country: applied

[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   1.3s
[phase] Approve
  ✓ gate:approve-migrate-dev()   330ms
    [approved] yodel at 2026-10-09T20:39:20.182Z
[phase] Apply
  ✓ shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":"jcs1-sha256:eaf4af6d1b7133e0863c24b0f42df7b08d673aaca833ba6b159f33052ff8a88f"})   2.0s
Op "migrate-dev" completed in 3.9s

Applied: 20261009T2039-fill-country.
```

```sql
SELECT country, count() AS rows FROM yodel_18_shop.events GROUP BY country ORDER BY country FORMAT TSVWithNames
```

```
country	rows
DE	200
FR	200
US	200
```

The history has a row per migration event, statement and step, never updated or deleted. The rebuild's rows carry the silence:

```sql
SELECT migration_id, kind, statement_index, status, note, silences
FROM yodel_18_history.history
WHERE migration_id LIKE '%events-by-id' OR migration_id LIKE '%fill-country'
ORDER BY seq FORMAT Vertical
```

```
Row 1:
──────
migration_id:    20261009T2037-events-by-id
kind:            migration
statement_index: -1
status:          started
note:            
silences:        [{"step":0,"rule":"ch-rebuild","reason":"600 rows; the copy takes seconds"}]

Row 2:
──────
migration_id:    20261009T2037-events-by-id
kind:            step
statement_index: 0
status:          started
note:            
silences:        [{"step":0,"rule":"ch-rebuild","reason":"600 rows; the copy takes seconds"}]

Row 3:
──────
migration_id:    20261009T2037-events-by-id
kind:            step
statement_index: 0
status:          succeeded
note:            {"op":"ClickHouseRebuildOp","table":"yodel_18_shop.events","state":"rebuild","partitions":6,"copied":6,"skipped":0,"cleared":0,"verifiedRows":600,"swapped":true,"oldTable":"yodel_18_shop.events__chant_old","retainUntil":"2026-10-16T20:39:05.097Z"}
silences:        [{"step":0,"rule":"ch-rebuild","reason":"600 rows; the copy takes seconds"}]

Row 4:
──────
migration_id:    20261009T2037-events-by-id
kind:            migration
statement_index: -1
status:          succeeded
note:            
silences:        [{"step":0,"rule":"ch-rebuild","reason":"600 rows; the copy takes seconds"}]

Row 5:
──────
migration_id:    20261009T2039-fill-country
kind:            migration
statement_index: -1
status:          started
note:            
silences:        []

Row 6:
──────
migration_id:    20261009T2039-fill-country
kind:            step
statement_index: 0
status:          started
note:            
silences:        []

Row 7:
──────
migration_id:    20261009T2039-fill-country
kind:            step
statement_index: 0
status:          succeeded
note:            {"op":"backfill","file":"backfill.ts","name":"backfill-fill-country","effects":6,"skipped":0,"ran":6}
silences:        []

Row 8:
──────
migration_id:    20261009T2039-fill-country
kind:            migration
statement_index: -1
status:          succeeded
note:            
silences:        []
```

## 6. An approval, then a change out of band

`src/schema.ts` now:

```ts
import { database, table } from "@intentius/chant-lexicon-sql/clickhouse";

export const yodel18ShopDb = database`
  CREATE DATABASE yodel_18_shop
  ENGINE = Atomic
  COMMENT 'The SQL Yodeler ClickHouse example'`;

export const events = table`
  CREATE TABLE ${yodel18ShopDb}.events
  (
      id UInt64,
      kind LowCardinality(String),
      at DateTime,
      country LowCardinality(String) DEFAULT '',
      source LowCardinality(String) DEFAULT 'web'
  )
  ENGINE = MergeTree
  PARTITION BY toYYYYMM(at)
  ORDER BY (kind, id)`;
```

```console
$ npx yodel new add-source
Wrote migrations/20261009T2039-add-source/ (1 statement; follows 20261009T2039-fill-country)
```

```console
$ npx yodel plan dev
Plan for dev (clickhouse, history yodel_18_history.history (single (default))): 4 applied, 1 pending

20261009T2039-add-source
  0  statement  SQLCH201 metadata  yodel_18_shop.events
       ALTER TABLE `yodel_18_shop`.`events` ADD COLUMN source LowCardinality(String) DEFAULT 'web' AFTER `country`

Plan digest: jcs1-sha256:dcf7aa04721d9929b7ec9a3b993e065cab6022e607f9def76d1fb540198ff786
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:dcf7aa04721d9929b7ec9a3b993e065cab6022e607f9def76d1fb540198ff786

The newest approval of approve-migrate-dev, by yodel at 2026-10-09T20:39:20.182Z, is for jcs1-sha256:eaf4af6d1b7133e0863c24b0f42df7b08d673aaca833ba6b159f33052ff8a88f, not this plan; it does not hold.
What moved: history changed: applied since: 20261009T2039-fill-country (by yodel@example at 2026-10-09 20:39:25.926988); pending migrations changed: new pending migration: 20261009T2039-add-source.
```

Approve the plan, as a reviewer would from the pull request comment:

```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:dcf7aa04721d9929b7ec9a3b993e065cab6022e607f9def76d1fb540198ff786
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-09T20:39:31.138Z
This approves the plan jcs1-sha256:dcf7aa04721d9929b7ec9a3b993e065cab6022e607f9def76d1fb540198ff786, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

Before the apply runs, someone adds a column by hand:

```sql
ALTER TABLE yodel_18_shop.events ADD COLUMN debug String DEFAULT ''
```

The plan digest covers the live schema, so the approval no longer holds. The apply stops at the gate, applies nothing, and says what moved:

```console
$ npx yodel apply dev
Migrations in dev (history yodel_18_history.history, topology single (default))

Applied (4):
  20261009T2036-baseline  2026-10-09 20:36:52.078218 by yodel@example
  20261009T2037-add-country  2026-10-09 20:37:44.119758 by yodel@example
  20261009T2037-events-by-id  2026-10-09 20:39:05.207672 by yodel@example
  20261009T2039-fill-country  2026-10-09 20:39:25.926988 by yodel@example

Pending (1):
  20261009T2039-add-source

Plan digest: jcs1-sha256:aa6fe01c797eada5fdaf21d4fabf717be4f2626d4cb4bfe13c824cfa5b0aaa00

Running migrate-dev (<tmp>/clickhouse/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   1.2s
[phase] Approve
  • gate:approve-migrate-dev()   skipped
    [refused] Gate "approve-migrate-dev" is approved, but not for this plan. approved: jcs1-sha256:dcf7aa04721d9929b7ec9a3b993e065cab6022e607f9def76d1fb540198ff786 (by yodel at 2026-10-09T20:39:31.138Z); planned: jcs1-sha256:aa6fe01c797eada5fdaf21d4fabf717be4f2626d4cb4bfe13c824cfa5b0aaa00. The configuration or the live system changed between that approval and this plan, so it needs a fresh one: chant approve migrate-dev approve-migrate-dev
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 2.1s
  plan    : jcs1-sha256:aa6fe01c797eada5fdaf21d4fabf717be4f2626d4cb4bfe13c824cfa5b0aaa00
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:aa6fe01c797eada5fdaf21d4fabf717be4f2626d4cb4bfe13c824cfa5b0aaa00
  expires : 2026-10-11T20:39:34.373Z

Nothing was applied. The approval of jcs1-sha256:dcf7aa04721d9929b7ec9a3b993e065cab6022e607f9def76d1fb540198ff786 (by yodel at 2026-10-09T20:39:31.138Z) does not hold: the plan moved since. What moved, as far as yodel can tell: live schema changed: no state yodel can rebuild from the history and git hashes to the approved digest with today's live schema, so an object in the environment's live schema (a table, view, index, dictionary, database or schema) changed since approval (or a part yodel cannot rebuild did).

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:aa6fe01c797eada5fdaf21d4fabf717be4f2626d4cb4bfe13c824cfa5b0aaa00).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:aa6fe01c797eada5fdaf21d4fabf717be4f2626d4cb4bfe13c824cfa5b0aaa00
then run yodel apply dev again.
[exit 3]
```

The column was a mistake. Drop it, and approve again:

```sql
ALTER TABLE yodel_18_shop.events DROP COLUMN debug
```

```console
$ npx yodel plan dev
Plan for dev (clickhouse, history yodel_18_history.history (single (default))): 4 applied, 1 pending

20261009T2039-add-source
  0  statement  SQLCH201 metadata  yodel_18_shop.events
       ALTER TABLE `yodel_18_shop`.`events` ADD COLUMN source LowCardinality(String) DEFAULT 'web' AFTER `country`

Plan digest: jcs1-sha256:dcf7aa04721d9929b7ec9a3b993e065cab6022e607f9def76d1fb540198ff786
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:dcf7aa04721d9929b7ec9a3b993e065cab6022e607f9def76d1fb540198ff786

The newest approval of approve-migrate-dev, by yodel at 2026-10-09T20:39:31.138Z, is for this plan's digest, but approval was asked for again after it at 2026-10-09T20:39:34.373Z (a run holding jcs1-sha256:aa6fe01c797eada5fdaf21d4fabf717be4f2626d4cb4bfe13c824cfa5b0aaa00), so it does not hold; approve this plan again.
```

The digest is the approved one again, but the refused run asked for approval after that approval was given, and an approval holds only when it is newer than the latest request. The apply stops at the gate again:

```console
$ npx yodel apply dev
Migrations in dev (history yodel_18_history.history, topology single (default))

Applied (4):
  20261009T2036-baseline  2026-10-09 20:36:52.078218 by yodel@example
  20261009T2037-add-country  2026-10-09 20:37:44.119758 by yodel@example
  20261009T2037-events-by-id  2026-10-09 20:39:05.207672 by yodel@example
  20261009T2039-fill-country  2026-10-09 20:39:25.926988 by yodel@example

Pending (1):
  20261009T2039-add-source

Plan digest: jcs1-sha256:dcf7aa04721d9929b7ec9a3b993e065cab6022e607f9def76d1fb540198ff786

Running migrate-dev (<tmp>/clickhouse/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   1.1s
[phase] Approve
  • gate:approve-migrate-dev()   skipped
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 1.9s
  plan    : jcs1-sha256:dcf7aa04721d9929b7ec9a3b993e065cab6022e607f9def76d1fb540198ff786
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:dcf7aa04721d9929b7ec9a3b993e065cab6022e607f9def76d1fb540198ff786
  expires : 2026-10-11T20:39:39.862Z

Nothing was applied. The approval of jcs1-sha256:dcf7aa04721d9929b7ec9a3b993e065cab6022e607f9def76d1fb540198ff786 (by yodel at 2026-10-09T20:39:31.138Z) is for this plan's digest, but approval was asked for again after it at 2026-10-09T20:39:34.373Z (a run holding jcs1-sha256:aa6fe01c797eada5fdaf21d4fabf717be4f2626d4cb4bfe13c824cfa5b0aaa00), so it does not hold; approve this plan again.

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:dcf7aa04721d9929b7ec9a3b993e065cab6022e607f9def76d1fb540198ff786).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:dcf7aa04721d9929b7ec9a3b993e065cab6022e607f9def76d1fb540198ff786
then run yodel apply dev again.
[exit 3]
```

```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:dcf7aa04721d9929b7ec9a3b993e065cab6022e607f9def76d1fb540198ff786
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-09T20:39:42.458Z
This approves the plan jcs1-sha256:dcf7aa04721d9929b7ec9a3b993e065cab6022e607f9def76d1fb540198ff786, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

```console
$ npx yodel apply dev
Migrations in dev (history yodel_18_history.history, topology single (default))

Applied (4):
  20261009T2036-baseline  2026-10-09 20:36:52.078218 by yodel@example
  20261009T2037-add-country  2026-10-09 20:37:44.119758 by yodel@example
  20261009T2037-events-by-id  2026-10-09 20:39:05.207672 by yodel@example
  20261009T2039-fill-country  2026-10-09 20:39:25.926988 by yodel@example

Pending (1):
  20261009T2039-add-source

Plan digest: jcs1-sha256:dcf7aa04721d9929b7ec9a3b993e065cab6022e607f9def76d1fb540198ff786

Running migrate-dev (<tmp>/clickhouse/ops/migrate-dev.op.ts)
lock: no KeeperMap on this server (KeeperMap is disabled because 'keeper_map_path_prefix' config is not defined. (BAD_ARGUMENTS) (version 26.8.15.10 (official build))); the lock is a file on this machine, so cross-runner locking needs Keeper (and keeper_map_path_prefix)
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:dcf7aa04721d9929b7ec9a3b993e065cab6022e607f9def76d1fb540198ff786, by yodel at 2026-10-09T20:39:42.458Z
20261009T2039-add-source: applying
  statement 0: ok (SQLCH201 metadata, yodel_18_shop.events)
20261009T2039-add-source: applied

[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   937ms
[phase] Approve
  ✓ gate:approve-migrate-dev()   275ms
    [approved] yodel at 2026-10-09T20:39:42.458Z
[phase] Apply
  ✓ shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":"jcs1-sha256:dcf7aa04721d9929b7ec9a3b993e065cab6022e607f9def76d1fb540198ff786"})   1.1s
Op "migrate-dev" completed in 2.5s

Applied: 20261009T2039-add-source.
```

## 7. Drift

Someone changes a default by hand:

```sql
ALTER TABLE yodel_18_shop.events MODIFY COLUMN source LowCardinality(String) DEFAULT 'app'
```

`yodel drift dev` compares the declared objects with the live ones and exits 2 on drift:

```console
$ npx yodel drift dev
Drift in dev

Changed out of band:
  events (ClickHouse::Table)
    columns[4].default.expr: declared 'web', live 'app'
[exit 2]
```

`ops/watch-dev.op.ts` is the same check as a `WatchOp` on a schedule. Run once by hand:

`ops/watch-dev.op.ts`:

```ts
import { WatchOp } from "@intentius/chant/op";

// Every hour at :17, read dev and report drift: a declared object changed out
// of band, or gone. Objects src/ does not declare are never reported.
// `chant run watch-dev` runs it once, by hand.
export const { op } = WatchOp({ name: "watch-dev", env: "dev", schedule: "17 * * * *" });
```

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
  ✓ lifecycleSnapshot(env=dev)   1.1s
[phase] Diff
  ✓ lifecycleDiff(env=dev, live=true)   975ms
    [outcome] Drift=true
Op "watch-dev" completed in 2.2s
```

`chant run` exits 0 when the watch completes, drift or not; the drift is the run's `Drift` outcome. The starter templates' `scripts/watch-outcome.ts` turns it into a failed CI job. Put the default back:

```sql
ALTER TABLE yodel_18_shop.events MODIFY COLUMN source LowCardinality(String) DEFAULT 'web'
```

```console
$ npx yodel drift dev
Drift in dev

No drift: every declared object matches the server.
```

## 8. The replay check

`yodel lint --replay replay` replays every migration, in order, into the server the `replay` profile names and compares each with the schema it recorded. Here that profile points at the same emulator as dev, which already holds `yodel_18_shop`, so it refuses:

```console
$ npx yodel lint --replay replay
yodel lint: refused: the replay needs a fresh database, and http://192.168.14.189:8123 (sql.profiles.replay) already holds yodel_18_shop. Point the replay at a throwaway emulator (chant emulator up --lexicon sql), or pass reset to drop it first. Nothing was run.
[exit 4]
```

`--reset` drops the database first. In CI the profile points at a throwaway server the job starts; here it empties dev's database, so it runs last:

```console
$ npx yodel lint --replay replay --reset
replay: emptying yodel_18_shop on http://192.168.14.189:8123 (sql.profiles.replay)
replay: 20261009T2036-baseline: replaying
replay: 20261009T2036-baseline: matches its recorded schema
replay: 20261009T2037-add-country: replaying
replay: 20261009T2037-add-country: matches its recorded schema
replay: 20261009T2037-events-by-id: replaying
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
CREATE MATERIALIZED VIEW `yodel_18_shop`.`events__chant_dual` TO `yodel_18_shop`.`events__chant_new` AS SELECT `id`, `kind`, `at`, `country` FROM `yodel_18_shop`.`events` WHERE `at` >= toDateTime64('2026-10-09 20:40:55.029', 3, 'UTC') COMMENT 'chant rebuild of yodel_18_shop.events: rows at or after the cut-over [chant managed-by=chant rebuild=yodel_18_shop.events role=dual cutover=2026-10-09T20%3A40%3A55.029Z]'
-- waiting 60s for the cut-over at 2026-10-09T20:40:55.029Z
-- waiting 50s for the cut-over at 2026-10-09T20:40:55.029Z
-- waiting 40s for the cut-over at 2026-10-09T20:40:55.029Z
-- waiting 30s for the cut-over at 2026-10-09T20:40:55.029Z
-- waiting 20s for the cut-over at 2026-10-09T20:40:55.029Z
-- waiting 10s for the cut-over at 2026-10-09T20:40:55.029Z
-- backfill of yodel_18_shop.events: 0 partition(s), 0 copied, 0 already copied, 0 cleared first
-- yodel_18_shop.events: 0 partition(s), 0 row(s) before the cut-over at 2026-10-09T20:40:55.029Z, counts and checksums equal in the old and new tables
EXCHANGE TABLES `yodel_18_shop`.`events` AND `yodel_18_shop`.`events__chant_new`
DROP VIEW `yodel_18_shop`.`events__chant_dual` SYNC
RENAME TABLE `yodel_18_shop`.`events__chant_new` TO `yodel_18_shop`.`events__chant_old`
ALTER TABLE `yodel_18_shop`.`events__chant_old` MODIFY COMMENT 'chant rebuild of yodel_18_shop.events: the old table, kept until 2026-10-16T20:40:55.165Z [chant managed-by=chant rebuild=yodel_18_shop.events role=old retain-until=2026-10-16T20%3A40%3A55.165Z]'
ALTER TABLE `yodel_18_shop`.`events` MODIFY COMMENT '[chant managed-by=chant]'
replay: 20261009T2037-events-by-id: matches its recorded schema
replay: 20261009T2039-fill-country: replaying
replay: 20261009T2039-fill-country: matches its recorded schema
replay: 20261009T2039-add-source: replaying
replay: 20261009T2039-add-source: matches its recorded schema
Replay of 5 migrations (clickhouse) into http://192.168.14.189:8123 (sql.profiles.replay)
  databases: yodel_18_shop (emptied first)
  ok      20261009T2036-baseline (2 statements)
  ok      20261009T2037-add-country (1 statement)
  ok      20261009T2037-events-by-id (0 statements; ran step 0: ClickHouseRebuildOp for events (yodel_18_shop.events) (swapped))
  ok      20261009T2039-fill-country (0 statements; skipped step 0: backfill backfill.ts (moves data; the replayed database has none))
  ok      20261009T2039-add-source (1 statement)
Every migration replays to its recorded schema.

20261009T2037-events-by-id
  silenced ch-rebuild: step 0: ClickHouseRebuildOp rebuilds yodel_18_shop.events: every row is copied into a new table and swapped in, for SQLCH220 Change the sorting key (orderBy)
           reason: 600 rows; the copy takes seconds

5 migrations: 0 errors, 0 warnings, 1 silenced.
```
