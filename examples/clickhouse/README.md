# ClickHouse example

A ClickHouse database taken from the declarative path to versioned migrations: adoption with `yodel init --from`, a migration, a sort-key change run as a rebuild step, a backfill step, a lint silence, an approval that stops holding, drift, and the replay check. Every command below ran against the emulator (`chant emulator up --lexicon sql`), and the output under each is what it printed. `examples/walkthrough/clickhouse.ts` holds the steps; `npx tsx examples/walkthrough/run.ts clickhouse --write` runs them again and rewrites this file and the project files from the run.

The project in this directory is what the walkthrough leaves: `src/schema.ts`, the migrations it wrote, and the two Ops. It is a finished run, with every migration already written, so running it again does not retrace the steps. To go step by step from an empty directory, start with [Your first migration](../../docs/getting-started.md).

To run it yourself, from a clone of this repository:

```sh
npm ci && npm run build          # in the repository root
npx chant emulator up --lexicon sql  # or any ClickHouse you can drop shop on
cd examples/clickhouse
npm install                      # @intentius/sql-yodeler from file:../.., this clone
export DEV_CLICKHOUSE_URL=http://127.0.0.1:8123
```

The example's `package.json` takes `@intentius/sql-yodeler` from `file:../..`, the clone it sits in, so it runs the yodel you just built rather than the release on npm. A project of your own installs it from npm instead (`npm install @intentius/sql-yodeler`; [Installing](../../docs/configuration.md#installing) has the other routes).

The run happened in a temporary copy of this directory, a git repository with a local `origin`; its path is shown as `<tmp>`. A command that exited with a code other than 0 ends with `[exit <code>]`.

## 1. A declared schema, applied without migrations

The project starts on the declarative path: `src/schema.ts` says what the database should be, and an `ApplyOp` applies it. There is no `migrations/` directory, so `yodel plan` and `yodel apply` diff the declared schema against the live database. `package.json` has a `build` script (`chant build src --lexicon sql -o dist/schema.json`), which the `ApplyOp` runs first.

`src/schema.ts`:

```ts
import { database, table } from "@intentius/chant-lexicon-sql/clickhouse";

export const shop = database`
  CREATE DATABASE shop
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

<!-- quote: clickhouse#apply-op -->
```ts
import { ApplyOp } from "@intentius/chant/op";

// The declarative path: yodel apply dev plans src/ against dev and runs this
// Op, behind a gate bound to the plan.
export const { op } = ApplyOp({ name: "apply-dev", env: "dev", target: "clickhouse", gate: {} });
```

```console
$ npx yodel plan dev
Plan for dev (clickhouse 26.8.15.10 at 127.0.0.1:8123, sql.profiles.dev, topology single (default))

shop (shop)
  [create] object: shop
      SQLCH200 Create an object. A new database, table or view is created; nothing existing changes. https://clickhouse.com/docs/sql-reference/statements/create
events (shop.events)
  [create] object: shop.events
      SQLCH200 Create an object. A new database, table or view is created; nothing existing changes. https://clickhouse.com/docs/sql-reference/statements/create

2 create
```

`yodel apply dev` runs the `ApplyOp`. It stops at the gate, which wants an approval of this exact plan, and exits 3:

<!-- quote: clickhouse#declarative-apply -->
```console
$ npx yodel apply dev
Plan for dev (clickhouse 26.8.15.10 at 127.0.0.1:8123, sql.profiles.dev)

shop (shop)
  [create] object: shop
      SQLCH200 Create an object. A new database, table or view is created; nothing existing changes. https://clickhouse.com/docs/sql-reference/statements/create
events (shop.events)
  [create] object: shop.events
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
  - events [queried http://127.0.0.1:8123 shop.events] [definition 9f20bfc4d4ef488a683af5646837a026beea36f8affb953ecfb1e118c3f4a21a]
  - shop [queried http://127.0.0.1:8123 shop] [definition aecfb2aa109301003bbc1a7ee057c2bb2610d824e610588317907171ed70c610]
[phase] Build
  ✓ chantBuild(path=.)   1.3s
[phase] Plan
  ✓ lifecycleDiff(env=dev, live=true)   1.2s
    [outcome] Drift=true
[phase] Approve
  • gate:approve-apply-dev()   skipped
[phase] Apply
  • nativeApply(target=clickhouse, env=dev, output=dist/schema.json, deleteMode=never)   skipped
Op "apply-dev" is gated on "approve-apply-dev" after 3.6s
  Approve apply to dev (delete mode: never)
  plan    : jcs1-sha256:02cfabc13e5ef7d0f1d089b4a5468afc3ed5140b9c2f04afad2203b470c933e8
  approve : chant approve apply-dev approve-apply-dev --plan jcs1-sha256:02cfabc13e5ef7d0f1d089b4a5468afc3ed5140b9c2f04afad2203b470c933e8
  expires : 2026-10-12T05:21:04.106Z

apply-dev is waiting at gate "approve-apply-dev" for approval of this plan.
Approve it with:
  chant approve apply-dev approve-apply-dev --plan jcs1-sha256:02cfabc13e5ef7d0f1d089b4a5468afc3ed5140b9c2f04afad2203b470c933e8
then run yodel apply dev again.
[exit 3]
```

The approval is a commit on the `chant/lifecycle` branch. Approve, then run the apply again:

<!-- quote: clickhouse#declarative-approve -->
```console
$ npx chant approve apply-dev approve-apply-dev --plan jcs1-sha256:02cfabc13e5ef7d0f1d089b4a5468afc3ed5140b9c2f04afad2203b470c933e8
Gate "approve-apply-dev" on "apply-dev" resolved by yodel at 2026-10-10T05:21:06.790Z
This approves the plan jcs1-sha256:02cfabc13e5ef7d0f1d089b4a5468afc3ed5140b9c2f04afad2203b470c933e8, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run apply-dev` and it walks through gate "approve-apply-dev".
```

```console
$ npx yodel apply dev
Plan for dev (clickhouse 26.8.15.10 at 127.0.0.1:8123, sql.profiles.dev)

shop (shop)
  [create] object: shop
      SQLCH200 Create an object. A new database, table or view is created; nothing existing changes. https://clickhouse.com/docs/sql-reference/statements/create
events (shop.events)
  [create] object: shop.events
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
  - events [queried http://127.0.0.1:8123 shop.events] [definition 9f20bfc4d4ef488a683af5646837a026beea36f8affb953ecfb1e118c3f4a21a]
  - shop [queried http://127.0.0.1:8123 shop] [definition aecfb2aa109301003bbc1a7ee057c2bb2610d824e610588317907171ed70c610]
CREATE DATABASE shop
  ENGINE = Atomic
  COMMENT 'The SQL Yodeler ClickHouse example [chant managed-by=chant]'
CREATE TABLE shop.events (
    id   UInt64,
    kind LowCardinality(String),
    at   DateTime
  )
  ENGINE = MergeTree
  PARTITION BY toYYYYMM(at)
  ORDER BY (kind, at) COMMENT '[chant managed-by=chant]'
created: ClickHouse::Database/shop
created: ClickHouse::Table/shop.events
[dev] applied 2 resource(s)
[phase] Build
  ✓ chantBuild(path=.)   941ms
[phase] Plan
  ✓ lifecycleDiff(env=dev, live=true)   2.2s
    [outcome] Drift=true
[phase] Approve
  ✓ gate:approve-apply-dev()   924ms
    [approved] yodel at 2026-10-10T05:21:06.790Z
[phase] Apply
  ✓ nativeApply(target=clickhouse, env=dev, output=dist/schema.json, deleteMode=never)   84ms
Op "apply-dev" completed in 5.2s

Applied: dev matches the declared schema.
```

```console
$ npx yodel plan dev
Plan for dev (clickhouse 26.8.15.10 at 127.0.0.1:8123, sql.profiles.dev, topology single (default))

No changes.
```

## 2. Adopting the database into versioned migrations

Some data arrives, six months of it, the last weeks dated in the future (scheduled events):

```sql
INSERT INTO shop.events
SELECT number, ['view', 'cart', 'buy'][number % 3 + 1], toDateTime('2026-06-01 00:00:00') + toIntervalHour(number * 7)
FROM numbers(600)
```

```sql
SELECT count() AS rows, countIf(at >= now()) AS future FROM shop.events FORMAT TSVWithNames
```

```
rows	future
600	150
```

To move to versioned migrations, `yodel init --from dev` reads the live database, writes its declarations to `src/`, checks that they plan clean against it, writes the baseline migration (the one that creates everything), and records the baseline applied in dev's history without running it. `src/schema.ts` already declares the schema, so it needs `--force` to write over it:

<!-- quote: clickhouse#adopt -->
```console
$ npx yodel init --from dev --force
read 2 object(s) from dev
wrote src/schema.ts
planned against dev: no change
wrote migrations/20261010T0521-baseline (2 statements)
lock: no KeeperMap on this server (KeeperMap is disabled because 'keeper_map_path_prefix' config is not defined. (BAD_ARGUMENTS) (version 26.8.15.10 (official build))); the lock is a file on this machine, so cross-runner locking needs Keeper (and keeper_map_path_prefix)
recorded 20261010T0521-baseline applied in yodeler.history as a baseline; none of its statements was run
Adopted dev (clickhouse): 2 objects
  Database shop
  Table shop.events

Declarations: src/schema.ts
Baseline:     migrations/20261010T0521-baseline/ (2 statements, sha256:b29a0b128fea52df5522931703828513b5999d4db2b13b5e73fb9aba757013ec)
Recorded:     applied in yodeler.history as a baseline; none of its statements was run

yodel plan dev shows no change, and yodel status dev lists the baseline applied.
```

`src/schema.ts`:

<!-- quote: clickhouse#adopt-schema -->
```ts
import { database, table } from "@intentius/chant-lexicon-sql/clickhouse";

export const shopDb = database`
  CREATE DATABASE shop
  ENGINE = Atomic
  COMMENT 'The SQL Yodeler ClickHouse example'`;

export const events = table`
  CREATE TABLE ${shopDb}.events
  (
      id UInt64,
      kind LowCardinality(String),
      at DateTime
  )
  ENGINE = MergeTree
  PARTITION BY toYYYYMM(at)
  ORDER BY (kind, at)`;
```

<!-- quote: clickhouse#adopt-status -->
```console
$ npx yodel status dev
Migrations in dev (clickhouse 26.8.15.10 at 127.0.0.1:8123, history yodeler.history, topology single (default))

Applied (1):
  20261010T0521-baseline  2026-10-10 05:21:21.438403 by yodel@example

Pending: none
```

From here `yodel apply dev` takes the versioned path, which runs a migrations Op: a Plan step that prints the plan digest, a gate bound to it, and an Apply step. The `ApplyOp` goes, and `ops/migrate-dev.op.ts` comes in:

```console
$ git rm -q ops/apply-dev.op.ts
```

`ops/migrate-dev.op.ts`:

<!-- quote: clickhouse#migrations-op -->
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

export const shopDb = database`
  CREATE DATABASE shop
  ENGINE = Atomic
  COMMENT 'The SQL Yodeler ClickHouse example'`;

export const events = table`
  CREATE TABLE ${shopDb}.events
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
Wrote migrations/20261010T0521-add-country/ (1 statement; follows 20261010T0521-baseline)
```

`migrations/20261010T0521-add-country/migration.sql`:

<!-- quote: clickhouse#add-country-sql -->
```sql
-- yodel migration 20261010T0521-add-country
-- parent: 20261010T0521-baseline

-- events (shop.events): SQLCH201 metadata
ALTER TABLE `shop`.`events` ADD COLUMN country LowCardinality(String) DEFAULT '' AFTER `at`;
```

```console
$ npx yodel lint
2 migrations: 0 errors, 0 warnings, 0 silenced.
```

<!-- quote: clickhouse#plan -->
```console
$ npx yodel plan dev
Plan for dev (clickhouse 26.8.15.10 at 127.0.0.1:8123, history yodeler.history (single (default))): 1 applied, 1 pending

20261010T0521-add-country
  0  statement  SQLCH201 metadata  shop.events
       ALTER TABLE `shop`.`events` ADD COLUMN country LowCardinality(String) DEFAULT '' AFTER `at`

Plan digest: jcs1-sha256:8f73c4f9a14d6343a433b3724fed15990c116f6f28c7bc561173a1387fa09f3b
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:8f73c4f9a14d6343a433b3724fed15990c116f6f28c7bc561173a1387fa09f3b

Not approved yet. Approving binds exactly this digest; if anything it covers changes before the apply runs, the gate asks again and nothing is applied.
```

```console
$ npx yodel apply dev
Migrations in dev (clickhouse 26.8.15.10 at 127.0.0.1:8123, history yodeler.history, topology single (default))

Applied (1):
  20261010T0521-baseline  2026-10-10 05:21:21.438403 by yodel@example

Pending (1):
  20261010T0521-add-country

Plan digest: jcs1-sha256:8f73c4f9a14d6343a433b3724fed15990c116f6f28c7bc561173a1387fa09f3b

Running migrate-dev (<tmp>/clickhouse/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   21.4s
[phase] Approve
  • gate:approve-migrate-dev()   skipped
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 29.2s
  plan    : jcs1-sha256:8f73c4f9a14d6343a433b3724fed15990c116f6f28c7bc561173a1387fa09f3b
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:8f73c4f9a14d6343a433b3724fed15990c116f6f28c7bc561173a1387fa09f3b
  expires : 2026-10-12T05:22:09.703Z

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:8f73c4f9a14d6343a433b3724fed15990c116f6f28c7bc561173a1387fa09f3b).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:8f73c4f9a14d6343a433b3724fed15990c116f6f28c7bc561173a1387fa09f3b
then run yodel apply dev again.
[exit 3]
```

<!-- quote: clickhouse#approve -->
```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:8f73c4f9a14d6343a433b3724fed15990c116f6f28c7bc561173a1387fa09f3b
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-10T05:22:26.084Z
This approves the plan jcs1-sha256:8f73c4f9a14d6343a433b3724fed15990c116f6f28c7bc561173a1387fa09f3b, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

The emulator has no Keeper, so the apply lock is a file on this machine, and the run says so. On a server with Keeper and `keeper_map_path_prefix` the lock is a row in a KeeperMap table, shared by every runner.

<!-- quote: clickhouse#apply -->
<!-- quote: clickhouse#apply -->
```console
$ npx yodel apply dev
Migrations in dev (clickhouse 26.8.15.10 at 127.0.0.1:8123, history yodeler.history, topology single (default))

Applied (1):
  20261010T0521-baseline  2026-10-10 05:21:21.438403 by yodel@example

Pending (1):
  20261010T0521-add-country

Plan digest: jcs1-sha256:8f73c4f9a14d6343a433b3724fed15990c116f6f28c7bc561173a1387fa09f3b

Running migrate-dev (<tmp>/clickhouse/ops/migrate-dev.op.ts)
lock: no KeeperMap on this server (KeeperMap is disabled because 'keeper_map_path_prefix' config is not defined. (BAD_ARGUMENTS) (version 26.8.15.10 (official build))); the lock is a file on this machine, so cross-runner locking needs Keeper (and keeper_map_path_prefix)
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:8f73c4f9a14d6343a433b3724fed15990c116f6f28c7bc561173a1387fa09f3b, by yodel at 2026-10-10T05:22:26.084Z
20261010T0521-add-country: applying
  statement 0: ok (SQLCH201 metadata, shop.events)
20261010T0521-add-country: applied

[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   3.1s
[phase] Approve
  ✓ gate:approve-migrate-dev()   498ms
    [approved] yodel at 2026-10-10T05:22:26.084Z
[phase] Apply
  ✓ shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":"jcs1-sha256:8f73c4f9a14d6343a433b3724fed15990c116f6f28c7bc561173a1387fa09f3b"})   6.5s
Op "migrate-dev" completed in 10.4s

Applied: 20261010T0521-add-country.
```

<!-- quote: clickhouse#status -->
```console
$ npx yodel status dev
Migrations in dev (clickhouse 26.8.15.10 at 127.0.0.1:8123, history yodeler.history, topology single (default))

Applied (2):
  20261010T0521-baseline  2026-10-10 05:21:21.438403 by yodel@example
  20261010T0521-add-country  2026-10-10 05:22:43.085473 by yodel@example

Pending: none
```

## 4. A sort-key change: a rebuild step

ClickHouse cannot change a table's sort key with `ALTER`. Change it in the declared schema:

`src/schema.ts` now:

```ts
import { database, table } from "@intentius/chant-lexicon-sql/clickhouse";

export const shopDb = database`
  CREATE DATABASE shop
  ENGINE = Atomic
  COMMENT 'The SQL Yodeler ClickHouse example'`;

export const events = table`
  CREATE TABLE ${shopDb}.events
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

`yodel new` writes the change as a `ClickHouseRebuildOp` step: a new table with the new key, a materialized view that writes rows at or after a cut-over time into it, a backfill of every row already in the table, partition by partition (a receipt per partition), a verification of every row, and a swap. Rows dated at or after the cut-over, like the future ones here, are copied too.

<!-- quote: clickhouse#rebuild-new -->
```console
$ npx yodel new events-by-id
Wrote migrations/20261010T0522-events-by-id/ (0 statements; follows 20261010T0521-add-country)
  This migration contains an Op step: ClickHouseRebuildOp for events (shop.events), SQLCH220.
    It is not SQL. migration.json holds the Op's declaration:
    export const { op } = ClickHouseRebuildOp({ name: "rebuild-shop-events", env: "<env>", table: "shop.events", dualWrite: { mode: "materialized-view", cutoverColumn: "at" } });
```

`migrations/20261010T0522-events-by-id/migration.sql`:

```sql
-- yodel migration 20261010T0522-events-by-id
-- parent: 20261010T0521-add-country
-- This migration contains an Op step, not only SQL:
--   ClickHouseRebuildOp for events (shop.events), SQLCH220: not SQL; migration.json holds its declaration

-- events (shop.events): SQLCH220 made by ClickHouseRebuildOp, not a statement:
--   export const { op } = ClickHouseRebuildOp({ name: "rebuild-shop-events", env: "<env>", table: "shop.events", dualWrite: { mode: "materialized-view", cutoverColumn: "at" } });
```

`yodel lint` flags a rebuild as an error (`ch-rebuild`):

```console
$ npx yodel lint
20261010T0522-events-by-id
  error    ch-rebuild: step 0: ClickHouseRebuildOp rebuilds shop.events: every row is copied into a new table and swapped in, for SQLCH220 Change the sorting key (orderBy)

A statement rule can be silenced for one statement, with a reason the history records when it applies:
  a line `-- yodel:allow <rule> <reason>` above the statement in migration.sql

3 migrations: 1 error, 0 warnings, 0 silenced.
[exit 3]
```

The table is small, so the rebuild is fine. Silence the rule for this step with a reason, on the line above it in `migration.sql`:

`migrations/20261010T0522-events-by-id/migration.sql` now:

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

The edit changes the migration's checksum, which lint reports, and the migration has not been applied anywhere, so record the new one:

<!-- quote: clickhouse#checksum -->
```console
$ npx yodel lint
20261010T0522-events-by-id
  error    checksum: 20261010T0522-events-by-id: its files hash to sha256:0321359f62f444627464d99bef4d1420f31a8518fa4f6b7bf217c731482e46b4, but migration.json records sha256:2226293d0e9cb4c669437ae86595d8def34aaba6d1ce9ac7a609e502030fe254; if it is not applied in any environment, record its new checksum with yodel lint --update-checksum 20261010T0522-events-by-id; if it is, undo the edit, or record it with yodel repair 20261010T0522-events-by-id --reason ... <env>
  silenced ch-rebuild: step 0: ClickHouseRebuildOp rebuilds shop.events: every row is copied into a new table and swapped in, for SQLCH220 Change the sorting key (orderBy)
           reason: 600 rows; the copy takes seconds

3 migrations: 1 error, 0 warnings, 1 silenced.
[exit 3]
```

```console
$ npx yodel lint --update-checksum 20261010T0522-events-by-id
20261010T0522-events-by-id: checksum sha256:2226293d0e9cb4c669437ae86595d8def34aaba6d1ce9ac7a609e502030fe254 is now sha256:0321359f62f444627464d99bef4d1420f31a8518fa4f6b7bf217c731482e46b4
20261010T0522-events-by-id
  silenced ch-rebuild: step 0: ClickHouseRebuildOp rebuilds shop.events: every row is copied into a new table and swapped in, for SQLCH220 Change the sorting key (orderBy)
           reason: 600 rows; the copy takes seconds

3 migrations: 0 errors, 0 warnings, 1 silenced.
```

The pull request comment (`yodel plan dev --comment` in CI) is this Markdown:

<!-- quote: clickhouse#comment -->
````console
$ npx yodel plan dev --format markdown
<!-- yodel:plan env=dev -->
### yodel plan: `dev`

ClickHouse, history `yodeler.history (single (default))`: 2 applied, **1 pending**.

#### `20261010T0522-events-by-id`

| # | Step | Rule | Class | Object |
|---|---|---|---|---|
| 0 | **Op ClickHouseRebuildOp** | SQLCH220 | rebuild | `shop.events` |

Op steps:
- step 0, `shop.events`: made by Op `ClickHouseRebuildOp` (SQLCH220 rebuild orderBy). yodel apply runs it as this step.

  <details><summary>ClickHouseRebuildOp for events</summary>

  ```text
  needs a rebuild, which ALTER cannot make: SQLCH220 Change the sorting key on orderBy (( kind , at ) -> ( kind , id )): The sorting key is the on-disk order of every part (and in ReplacingMergeTree the deduplication identity); beyond appending new columns (SQLCH216) it cannot change in place. https://clickhouse.com/docs/sql-reference/statements/alter/order-by. Run it as the rebuild migration Op: ClickHouseRebuildOp({ table: "shop.events", ... }) from @intentius/chant-lexicon-sql/clickhouse
  ```

  ```ts
  export const { op } = ClickHouseRebuildOp({ name: "rebuild-shop-events", env: "<env>", table: "shop.events", dualWrite: { mode: "materialized-view", cutoverColumn: "at" } });
  ```

  </details>

#### Approval

Plan digest the apply gate binds: `jcs1-sha256:6b6cd61948bd060182ffc3de080343ea86b7336ab96c4a1af7d08e6f3036577c`

Approve it with:

```sh
chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:6b6cd61948bd060182ffc3de080343ea86b7336ab96c4a1af7d08e6f3036577c
```

The newest approval of `approve-migrate-dev`, by yodel at 2026-10-10T05:22:26.084Z, is for `jcs1-sha256:8f73c4f9a14d6343a433b3724fed15990c116f6f28c7bc561173a1387fa09f3b`, not this plan; it does not hold.
What moved (as far as yodel can tell): history changed: applied since: 20261010T0521-add-country (by yodel@example at 2026-10-10 05:22:43.085473); pending migrations changed: committed to since approval: 20261010T0522-events-by-id (048aec0 at 2026-10-09T23:22:54-06:00); live schema changed: as expected after the history change above: applying a migration changes the live schema, and yodel cannot rebuild the live schema as it was at approval, so it cannot confirm that nothing else in it changed.

<!-- yodel:subject eyJlbnZpcm9ubWVudCI6ImRldiIsImhpc3RvcnlEYXRhYmFzZSI6InlvZGVsZXIiLCJ0b3BvbG9neSI6eyJraW5kIjoic2luZ2xlIn0sImFwcGxpZWQiOlt7ImlkIjoiMjAyNjEwMTBUMDUyMS1iYXNlbGluZSIsImNoZWNrc3VtIjoic2hhMjU2OmIyOWEwYjEyOGZlYTUyZGY1NTIyOTMxNzAzODI4NTEzYjU5OTlkNGRiMmIxM2I1ZTczZmI5YWJhNzU3MDEzZWMifSx7ImlkIjoiMjAyNjEwMTBUMDUyMS1hZGQtY291bnRyeSIsImNoZWNrc3VtIjoic2hhMjU2OjZkMjNmY2U0YmE5YmExOTFkODIxM2VhMzU2ZDM1ODUxODFkNGEzZWFlZWQ5ZWVmNDAyNjI2YWYzOTljMDIyYzUifV0sInBlbmRpbmciOlt7ImlkIjoiMjAyNjEwMTBUMDUyMi1ldmVudHMtYnktaWQiLCJjaGVja3N1bSI6InNoYTI1NjowMzIxMzU5ZjYyZjQ0NDYyNzQ2NGQ5OWJlZjRkMTQyMGYzMWE4NTE4ZmE0ZjZiN2JmMjE3YzczMTQ4MmU0NmI0IiwiZG9uZSI6W119XSwibGl2ZSI6InNoYTI1NjpiYTA4MzBmYjk2NjkzNWMzYTNiNmQ1Nzg3ODIwNGJhMzMzMzQxMTg2YzJkMzk4M2E3YTMwN2IxMjk4MmFiMmY1In0 -->
````

```console
$ npx yodel apply dev
Migrations in dev (clickhouse 26.8.15.10 at 127.0.0.1:8123, history yodeler.history, topology single (default))

Applied (2):
  20261010T0521-baseline  2026-10-10 05:21:21.438403 by yodel@example
  20261010T0521-add-country  2026-10-10 05:22:43.085473 by yodel@example

Pending (1):
  20261010T0522-events-by-id  (step 0: ClickHouseRebuildOp for events (shop.events))

Plan digest: jcs1-sha256:6b6cd61948bd060182ffc3de080343ea86b7336ab96c4a1af7d08e6f3036577c

Running migrate-dev (<tmp>/clickhouse/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   889ms
[phase] Approve
  • gate:approve-migrate-dev()   skipped
    [refused] Gate "approve-migrate-dev" is approved, but not for this plan. approved: jcs1-sha256:8f73c4f9a14d6343a433b3724fed15990c116f6f28c7bc561173a1387fa09f3b (by yodel at 2026-10-10T05:22:26.084Z); planned: jcs1-sha256:6b6cd61948bd060182ffc3de080343ea86b7336ab96c4a1af7d08e6f3036577c. The configuration or the live system changed between that approval and this plan, so it needs a fresh one: chant approve migrate-dev approve-migrate-dev
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 1.7s
  plan    : jcs1-sha256:6b6cd61948bd060182ffc3de080343ea86b7336ab96c4a1af7d08e6f3036577c
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:6b6cd61948bd060182ffc3de080343ea86b7336ab96c4a1af7d08e6f3036577c
  expires : 2026-10-12T05:22:57.970Z

Nothing was applied. The approval of jcs1-sha256:8f73c4f9a14d6343a433b3724fed15990c116f6f28c7bc561173a1387fa09f3b (by yodel at 2026-10-10T05:22:26.084Z) does not hold: the plan moved since. What moved, as far as yodel can tell: history changed: applied since: 20261010T0521-add-country (by yodel@example at 2026-10-10 05:22:43.085473); pending migrations changed: committed to since approval: 20261010T0522-events-by-id (048aec0 at 2026-10-09T23:22:54-06:00); live schema changed: as expected after the history change above: applying a migration changes the live schema, and yodel cannot rebuild the live schema as it was at approval, so it cannot confirm that nothing else in it changed.

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:6b6cd61948bd060182ffc3de080343ea86b7336ab96c4a1af7d08e6f3036577c).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:6b6cd61948bd060182ffc3de080343ea86b7336ab96c4a1af7d08e6f3036577c
then run yodel apply dev again.
[exit 3]
```

```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:6b6cd61948bd060182ffc3de080343ea86b7336ab96c4a1af7d08e6f3036577c
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-10T05:23:00.481Z
This approves the plan jcs1-sha256:6b6cd61948bd060182ffc3de080343ea86b7336ab96c4a1af7d08e6f3036577c, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

The rebuild waits a minute for its cut-over before the backfill:

<!-- quote: clickhouse#rebuild-apply -->
```console
$ npx yodel apply dev
Migrations in dev (clickhouse 26.8.15.10 at 127.0.0.1:8123, history yodeler.history, topology single (default))

Applied (2):
  20261010T0521-baseline  2026-10-10 05:21:21.438403 by yodel@example
  20261010T0521-add-country  2026-10-10 05:22:43.085473 by yodel@example

Pending (1):
  20261010T0522-events-by-id  (step 0: ClickHouseRebuildOp for events (shop.events))

Plan digest: jcs1-sha256:6b6cd61948bd060182ffc3de080343ea86b7336ab96c4a1af7d08e6f3036577c

Running migrate-dev (<tmp>/clickhouse/ops/migrate-dev.op.ts)
lock: no KeeperMap on this server (KeeperMap is disabled because 'keeper_map_path_prefix' config is not defined. (BAD_ARGUMENTS) (version 26.8.15.10 (official build))); the lock is a file on this machine, so cross-runner locking needs Keeper (and keeper_map_path_prefix)
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:6b6cd61948bd060182ffc3de080343ea86b7336ab96c4a1af7d08e6f3036577c, by yodel at 2026-10-10T05:23:00.481Z
20261010T0522-events-by-id: applying
  step 0: ClickHouseRebuildOp for events (shop.events)
  step 0: ok {"op":"ClickHouseRebuildOp","table":"shop.events","state":"rebuild","partitions":6,"copied":6,"skipped":0,"cleared":0,"repaired":0,"verifiedRows":600,"swapped":true,"oldTable":"shop.events__chant_old","retainUntil":"2026-10-17T05:24:05.237Z"}
20261010T0522-events-by-id: applied

[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   929ms
[phase] Approve
  ✓ gate:approve-migrate-dev()   247ms
    [approved] yodel at 2026-10-10T05:23:00.481Z
[phase] Apply
  ✓ shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":"jcs1-sha256:6b6cd61948bd060182ffc3de080343ea86b7336ab96c4a1af7d08e6f3036577c"})   61.8s
Op "migrate-dev" completed in 63.1s

Applied: 20261010T0522-events-by-id.
```

```sql
SELECT sorting_key, total_rows FROM system.tables WHERE database = 'shop' AND name LIKE 'events%' ORDER BY name FORMAT TSVWithNames
```

```
sorting_key	total_rows
kind, id	600
kind, at	600
```

Every row is in the new table, the future-dated ones too:

```sql
SELECT count() AS rows, countIf(at >= now()) AS future FROM shop.events FORMAT TSVWithNames
```

```
rows	future
600	150
```

The old table stays as `events__chant_old` until the date in the step's note (7 days).

## 5. A backfill step

`country` is empty for the rows already there. A backfill is a data migration in the same history as the DDL: an Op of `effect()` batches, each with its own receipt, so a run that stops part way resumes at the first batch without one. `yodel new --backfill <file>` writes a template when the file does not exist:

<!-- quote: clickhouse#backfill-template -->
```console
$ npx yodel new fill-country --backfill backfills/country.ts
Wrote a backfill template at backfills/country.ts. Write its batches, then run yodel new fill-country --backfill backfills/country.ts again. No migration written.
```

Write the batches, one month each:

`backfills/country.ts`:

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

<!-- quote: clickhouse#backfill-new -->
```console
$ npx yodel new fill-country --backfill backfills/country.ts
Wrote migrations/20261010T0524-fill-country/ (0 statements; follows 20261010T0522-events-by-id)
  This migration ends with a backfill step: the Op backfill.ts exports, copied into the migration's directory.
    yodel apply runs its effect() batches after the statements before it, resuming from their receipts after a failure.
```

`migrations/20261010T0524-fill-country/migration.sql`:

<!-- quote: clickhouse#backfill-sql -->
```sql
-- yodel migration 20261010T0524-fill-country
-- parent: 20261010T0522-events-by-id
-- This migration contains an Op step, not only SQL:
--   a backfill: the Op backfill.ts exports, its effect() batches resumable from their receipts

-- backfill (fill-country): made by the Op backfill.ts exports, not a statement
```

```console
$ npx yodel lint
20261010T0522-events-by-id
  silenced ch-rebuild: step 0: ClickHouseRebuildOp rebuilds shop.events: every row is copied into a new table and swapped in, for SQLCH220 Change the sorting key (orderBy)
           reason: 600 rows; the copy takes seconds

4 migrations: 0 errors, 0 warnings, 1 silenced.
```

The pull request comment lists the step under the Op steps apply runs, with the backfill's module:

````console
$ npx yodel plan dev --format markdown
<!-- yodel:plan env=dev -->
### yodel plan: `dev`

ClickHouse, history `yodeler.history (single (default))`: 3 applied, **1 pending**.

#### `20261010T0524-fill-country`

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

  </details>

#### Approval

Plan digest the apply gate binds: `jcs1-sha256:939dad30058556bc3a978732c63276c1cb3f598b77338a9de122bfdaba1b89e9`

Approve it with:

```sh
chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:939dad30058556bc3a978732c63276c1cb3f598b77338a9de122bfdaba1b89e9
```

The newest approval of `approve-migrate-dev`, by yodel at 2026-10-10T05:23:00.481Z, is for `jcs1-sha256:6b6cd61948bd060182ffc3de080343ea86b7336ab96c4a1af7d08e6f3036577c`, not this plan; it does not hold.
What moved (as far as yodel can tell): history changed: applied since: 20261010T0522-events-by-id (by yodel@example at 2026-10-10 05:24:05.258311); live schema changed: as expected after the history change above: applying a migration changes the live schema, and yodel cannot rebuild the live schema as it was at approval, so it cannot confirm that nothing else in it changed.

<!-- yodel:subject eyJlbnZpcm9ubWVudCI6ImRldiIsImhpc3RvcnlEYXRhYmFzZSI6InlvZGVsZXIiLCJ0b3BvbG9neSI6eyJraW5kIjoic2luZ2xlIn0sImFwcGxpZWQiOlt7ImlkIjoiMjAyNjEwMTBUMDUyMS1iYXNlbGluZSIsImNoZWNrc3VtIjoic2hhMjU2OmIyOWEwYjEyOGZlYTUyZGY1NTIyOTMxNzAzODI4NTEzYjU5OTlkNGRiMmIxM2I1ZTczZmI5YWJhNzU3MDEzZWMifSx7ImlkIjoiMjAyNjEwMTBUMDUyMS1hZGQtY291bnRyeSIsImNoZWNrc3VtIjoic2hhMjU2OjZkMjNmY2U0YmE5YmExOTFkODIxM2VhMzU2ZDM1ODUxODFkNGEzZWFlZWQ5ZWVmNDAyNjI2YWYzOTljMDIyYzUifSx7ImlkIjoiMjAyNjEwMTBUMDUyMi1ldmVudHMtYnktaWQiLCJjaGVja3N1bSI6InNoYTI1NjowMzIxMzU5ZjYyZjQ0NDYyNzQ2NGQ5OWJlZjRkMTQyMGYzMWE4NTE4ZmE0ZjZiN2JmMjE3YzczMTQ4MmU0NmI0In1dLCJwZW5kaW5nIjpbeyJpZCI6IjIwMjYxMDEwVDA1MjQtZmlsbC1jb3VudHJ5IiwiY2hlY2tzdW0iOiJzaGEyNTY6MDZlZWEzMmE1MTNlNzk0M2MyZDZkMTg5YWUxNmM4NWY0ZWUxMTUxM2Y1MGU1YzRlMTg1NTQ0NmE0Njc5ZTExZCIsImRvbmUiOltdfV0sImxpdmUiOiJzaGEyNTY6MTZmYmE3NDFmMGUwMTM3MGU2NGUzYTE2NWYzZmViNmI0YzQzMDEzMGFjNzMzNGViZGEwYmJhNWM1YWE4MDBlMSJ9 -->
````

```console
$ npx yodel apply dev
Migrations in dev (clickhouse 26.8.15.10 at 127.0.0.1:8123, history yodeler.history, topology single (default))

Applied (3):
  20261010T0521-baseline  2026-10-10 05:21:21.438403 by yodel@example
  20261010T0521-add-country  2026-10-10 05:22:43.085473 by yodel@example
  20261010T0522-events-by-id  2026-10-10 05:24:05.258311 by yodel@example

Pending (1):
  20261010T0524-fill-country  (step 0: backfill backfill.ts)

Plan digest: jcs1-sha256:939dad30058556bc3a978732c63276c1cb3f598b77338a9de122bfdaba1b89e9

Running migrate-dev (<tmp>/clickhouse/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   971ms
[phase] Approve
  • gate:approve-migrate-dev()   skipped
    [refused] Gate "approve-migrate-dev" is approved, but not for this plan. approved: jcs1-sha256:6b6cd61948bd060182ffc3de080343ea86b7336ab96c4a1af7d08e6f3036577c (by yodel at 2026-10-10T05:23:00.481Z); planned: jcs1-sha256:939dad30058556bc3a978732c63276c1cb3f598b77338a9de122bfdaba1b89e9. The configuration or the live system changed between that approval and this plan, so it needs a fresh one: chant approve migrate-dev approve-migrate-dev
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 1.7s
  plan    : jcs1-sha256:939dad30058556bc3a978732c63276c1cb3f598b77338a9de122bfdaba1b89e9
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:939dad30058556bc3a978732c63276c1cb3f598b77338a9de122bfdaba1b89e9
  expires : 2026-10-12T05:24:13.445Z

Nothing was applied. The approval of jcs1-sha256:6b6cd61948bd060182ffc3de080343ea86b7336ab96c4a1af7d08e6f3036577c (by yodel at 2026-10-10T05:23:00.481Z) does not hold: the plan moved since. What moved, as far as yodel can tell: history changed: applied since: 20261010T0522-events-by-id (by yodel@example at 2026-10-10 05:24:05.258311); pending migrations changed: committed to since approval: 20261010T0524-fill-country (dd3edac at 2026-10-09T23:24:11-06:00); live schema changed: as expected after the history change above: applying a migration changes the live schema, and yodel cannot rebuild the live schema as it was at approval, so it cannot confirm that nothing else in it changed.

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:939dad30058556bc3a978732c63276c1cb3f598b77338a9de122bfdaba1b89e9).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:939dad30058556bc3a978732c63276c1cb3f598b77338a9de122bfdaba1b89e9
then run yodel apply dev again.
[exit 3]
```

```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:939dad30058556bc3a978732c63276c1cb3f598b77338a9de122bfdaba1b89e9
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-10T05:24:15.830Z
This approves the plan jcs1-sha256:939dad30058556bc3a978732c63276c1cb3f598b77338a9de122bfdaba1b89e9, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

<!-- quote: clickhouse#backfill-apply -->
```console
$ npx yodel apply dev
Migrations in dev (clickhouse 26.8.15.10 at 127.0.0.1:8123, history yodeler.history, topology single (default))

Applied (3):
  20261010T0521-baseline  2026-10-10 05:21:21.438403 by yodel@example
  20261010T0521-add-country  2026-10-10 05:22:43.085473 by yodel@example
  20261010T0522-events-by-id  2026-10-10 05:24:05.258311 by yodel@example

Pending (1):
  20261010T0524-fill-country  (step 0: backfill backfill.ts)

Plan digest: jcs1-sha256:939dad30058556bc3a978732c63276c1cb3f598b77338a9de122bfdaba1b89e9

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

[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   868ms
[phase] Approve
  ✓ gate:approve-migrate-dev()   217ms
    [approved] yodel at 2026-10-10T05:24:15.830Z
[phase] Apply
  ✓ shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":"jcs1-sha256:939dad30058556bc3a978732c63276c1cb3f598b77338a9de122bfdaba1b89e9"})   1.8s
Op "migrate-dev" completed in 3.1s

Applied: 20261010T0524-fill-country.
```

```sql
SELECT country, count() AS rows FROM shop.events GROUP BY country ORDER BY country FORMAT TSVWithNames
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
FROM yodeler.history
WHERE migration_id LIKE '%events-by-id' OR migration_id LIKE '%fill-country'
ORDER BY seq FORMAT Vertical
```

<!-- quote: clickhouse#history-rows -->
```
Row 1:
──────
migration_id:    20261010T0522-events-by-id
kind:            migration
statement_index: -1
status:          started
note:            
silences:        [{"step":0,"rule":"ch-rebuild","reason":"600 rows; the copy takes seconds"}]

Row 2:
──────
migration_id:    20261010T0522-events-by-id
kind:            step
statement_index: 0
status:          started
note:            
silences:        [{"step":0,"rule":"ch-rebuild","reason":"600 rows; the copy takes seconds"}]

Row 3:
──────
migration_id:    20261010T0522-events-by-id
kind:            step
statement_index: 0
status:          succeeded
note:            {"op":"ClickHouseRebuildOp","table":"shop.events","state":"rebuild","partitions":6,"copied":6,"skipped":0,"cleared":0,"repaired":0,"verifiedRows":600,"swapped":true,"oldTable":"shop.events__chant_old","retainUntil":"2026-10-17T05:24:05.237Z"}
silences:        [{"step":0,"rule":"ch-rebuild","reason":"600 rows; the copy takes seconds"}]

Row 4:
──────
migration_id:    20261010T0522-events-by-id
kind:            migration
statement_index: -1
status:          succeeded
note:            
silences:        [{"step":0,"rule":"ch-rebuild","reason":"600 rows; the copy takes seconds"}]

Row 5:
──────
migration_id:    20261010T0524-fill-country
kind:            migration
statement_index: -1
status:          started
note:            
silences:        []

Row 6:
──────
migration_id:    20261010T0524-fill-country
kind:            step
statement_index: 0
status:          started
note:            
silences:        []

Row 7:
──────
migration_id:    20261010T0524-fill-country
kind:            step
statement_index: 0
status:          succeeded
note:            {"op":"backfill","file":"backfill.ts","name":"backfill-fill-country","effects":6,"skipped":0,"ran":6}
silences:        []

Row 8:
──────
migration_id:    20261010T0524-fill-country
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

export const shopDb = database`
  CREATE DATABASE shop
  ENGINE = Atomic
  COMMENT 'The SQL Yodeler ClickHouse example'`;

export const events = table`
  CREATE TABLE ${shopDb}.events
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
Wrote migrations/20261010T0524-add-source/ (1 statement; follows 20261010T0524-fill-country)
```

<!-- quote: clickhouse#plan-add-source -->
```console
$ npx yodel plan dev
Plan for dev (clickhouse 26.8.15.10 at 127.0.0.1:8123, history yodeler.history (single (default))): 4 applied, 1 pending

20261010T0524-add-source
  0  statement  SQLCH201 metadata  shop.events
       ALTER TABLE `shop`.`events` ADD COLUMN source LowCardinality(String) DEFAULT 'web' AFTER `country`

Plan digest: jcs1-sha256:bca6651328f214c8a0b5be2ca786cd1ed1a533f06fa90610956e832da129a965
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:bca6651328f214c8a0b5be2ca786cd1ed1a533f06fa90610956e832da129a965

The newest approval of approve-migrate-dev, by yodel at 2026-10-10T05:24:15.830Z, is for jcs1-sha256:939dad30058556bc3a978732c63276c1cb3f598b77338a9de122bfdaba1b89e9, not this plan; it does not hold.
What moved: history changed: applied since: 20261010T0524-fill-country (by yodel@example at 2026-10-10 05:24:19.672518); pending migrations changed: new pending migration: 20261010T0524-add-source.
```

Approve the plan, as a reviewer would from the pull request comment:

<!-- quote: clickhouse#approve-add-source -->
```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:bca6651328f214c8a0b5be2ca786cd1ed1a533f06fa90610956e832da129a965
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-10T05:24:23.872Z
This approves the plan jcs1-sha256:bca6651328f214c8a0b5be2ca786cd1ed1a533f06fa90610956e832da129a965, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

Before the apply runs, someone adds a column by hand:

```sql
ALTER TABLE shop.events ADD COLUMN debug String DEFAULT ''
```

The plan digest covers the live schema, so the approval no longer holds. The apply stops at the gate, applies nothing, and says what moved:

<!-- quote: clickhouse#moved -->
```console
$ npx yodel apply dev
Migrations in dev (clickhouse 26.8.15.10 at 127.0.0.1:8123, history yodeler.history, topology single (default))

Applied (4):
  20261010T0521-baseline  2026-10-10 05:21:21.438403 by yodel@example
  20261010T0521-add-country  2026-10-10 05:22:43.085473 by yodel@example
  20261010T0522-events-by-id  2026-10-10 05:24:05.258311 by yodel@example
  20261010T0524-fill-country  2026-10-10 05:24:19.672518 by yodel@example

Pending (1):
  20261010T0524-add-source

Plan digest: jcs1-sha256:2e8073454ea979bef82b3ea2aa511b1d2d1b6aab024ab63d4b03c523229df796

Running migrate-dev (<tmp>/clickhouse/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   859ms
[phase] Approve
  • gate:approve-migrate-dev()   skipped
    [refused] Gate "approve-migrate-dev" is approved, but not for this plan. approved: jcs1-sha256:bca6651328f214c8a0b5be2ca786cd1ed1a533f06fa90610956e832da129a965 (by yodel at 2026-10-10T05:24:23.872Z); planned: jcs1-sha256:2e8073454ea979bef82b3ea2aa511b1d2d1b6aab024ab63d4b03c523229df796. The configuration or the live system changed between that approval and this plan, so it needs a fresh one: chant approve migrate-dev approve-migrate-dev
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 1.5s
  plan    : jcs1-sha256:2e8073454ea979bef82b3ea2aa511b1d2d1b6aab024ab63d4b03c523229df796
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:2e8073454ea979bef82b3ea2aa511b1d2d1b6aab024ab63d4b03c523229df796
  expires : 2026-10-12T05:24:26.269Z

Nothing was applied. The approval of jcs1-sha256:bca6651328f214c8a0b5be2ca786cd1ed1a533f06fa90610956e832da129a965 (by yodel at 2026-10-10T05:24:23.872Z) does not hold: the plan moved since. What moved, as far as yodel can tell: live schema changed: no state yodel can rebuild from the history and git hashes to the approved digest with today's live schema, so an object in the environment's live schema (a table, view, index, dictionary, database or schema) changed since approval (or a part yodel cannot rebuild did).

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:2e8073454ea979bef82b3ea2aa511b1d2d1b6aab024ab63d4b03c523229df796).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:2e8073454ea979bef82b3ea2aa511b1d2d1b6aab024ab63d4b03c523229df796
then run yodel apply dev again.
[exit 3]
```

The column was a mistake. Drop it, and approve again:

```sql
ALTER TABLE shop.events DROP COLUMN debug
```

<!-- quote: clickhouse#asked-again-plan -->
```console
$ npx yodel plan dev
Plan for dev (clickhouse 26.8.15.10 at 127.0.0.1:8123, history yodeler.history (single (default))): 4 applied, 1 pending

20261010T0524-add-source
  0  statement  SQLCH201 metadata  shop.events
       ALTER TABLE `shop`.`events` ADD COLUMN source LowCardinality(String) DEFAULT 'web' AFTER `country`

Plan digest: jcs1-sha256:bca6651328f214c8a0b5be2ca786cd1ed1a533f06fa90610956e832da129a965
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:bca6651328f214c8a0b5be2ca786cd1ed1a533f06fa90610956e832da129a965

The newest approval of approve-migrate-dev, by yodel at 2026-10-10T05:24:23.872Z, is for this plan's digest, but approval was asked for again after it at 2026-10-10T05:24:26.269Z (a run holding jcs1-sha256:2e8073454ea979bef82b3ea2aa511b1d2d1b6aab024ab63d4b03c523229df796), so it does not hold; approve this plan again.
```

The digest is the approved one again, but the refused run asked for approval after that approval was given, and an approval holds only when it is newer than the latest request. The apply stops at the gate again:

<!-- quote: clickhouse#asked-again-apply -->
```console
$ npx yodel apply dev
Migrations in dev (clickhouse 26.8.15.10 at 127.0.0.1:8123, history yodeler.history, topology single (default))

Applied (4):
  20261010T0521-baseline  2026-10-10 05:21:21.438403 by yodel@example
  20261010T0521-add-country  2026-10-10 05:22:43.085473 by yodel@example
  20261010T0522-events-by-id  2026-10-10 05:24:05.258311 by yodel@example
  20261010T0524-fill-country  2026-10-10 05:24:19.672518 by yodel@example

Pending (1):
  20261010T0524-add-source

Plan digest: jcs1-sha256:bca6651328f214c8a0b5be2ca786cd1ed1a533f06fa90610956e832da129a965

Running migrate-dev (<tmp>/clickhouse/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   849ms
[phase] Approve
  • gate:approve-migrate-dev()   skipped
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 1.4s
  plan    : jcs1-sha256:bca6651328f214c8a0b5be2ca786cd1ed1a533f06fa90610956e832da129a965
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:bca6651328f214c8a0b5be2ca786cd1ed1a533f06fa90610956e832da129a965
  expires : 2026-10-12T05:24:30.377Z

Nothing was applied. The approval of jcs1-sha256:bca6651328f214c8a0b5be2ca786cd1ed1a533f06fa90610956e832da129a965 (by yodel at 2026-10-10T05:24:23.872Z) is for this plan's digest, but approval was asked for again after it at 2026-10-10T05:24:26.269Z (a run holding jcs1-sha256:2e8073454ea979bef82b3ea2aa511b1d2d1b6aab024ab63d4b03c523229df796), so it does not hold; approve this plan again.

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:bca6651328f214c8a0b5be2ca786cd1ed1a533f06fa90610956e832da129a965).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:bca6651328f214c8a0b5be2ca786cd1ed1a533f06fa90610956e832da129a965
then run yodel apply dev again.
[exit 3]
```

```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:bca6651328f214c8a0b5be2ca786cd1ed1a533f06fa90610956e832da129a965
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-10T05:24:32.334Z
This approves the plan jcs1-sha256:bca6651328f214c8a0b5be2ca786cd1ed1a533f06fa90610956e832da129a965, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

```console
$ npx yodel apply dev
Migrations in dev (clickhouse 26.8.15.10 at 127.0.0.1:8123, history yodeler.history, topology single (default))

Applied (4):
  20261010T0521-baseline  2026-10-10 05:21:21.438403 by yodel@example
  20261010T0521-add-country  2026-10-10 05:22:43.085473 by yodel@example
  20261010T0522-events-by-id  2026-10-10 05:24:05.258311 by yodel@example
  20261010T0524-fill-country  2026-10-10 05:24:19.672518 by yodel@example

Pending (1):
  20261010T0524-add-source

Plan digest: jcs1-sha256:bca6651328f214c8a0b5be2ca786cd1ed1a533f06fa90610956e832da129a965

Running migrate-dev (<tmp>/clickhouse/ops/migrate-dev.op.ts)
lock: no KeeperMap on this server (KeeperMap is disabled because 'keeper_map_path_prefix' config is not defined. (BAD_ARGUMENTS) (version 26.8.15.10 (official build))); the lock is a file on this machine, so cross-runner locking needs Keeper (and keeper_map_path_prefix)
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:bca6651328f214c8a0b5be2ca786cd1ed1a533f06fa90610956e832da129a965, by yodel at 2026-10-10T05:24:32.334Z
20261010T0524-add-source: applying
  statement 0: ok (SQLCH201 metadata, shop.events)
20261010T0524-add-source: applied

[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   850ms
[phase] Approve
  ✓ gate:approve-migrate-dev()   189ms
    [approved] yodel at 2026-10-10T05:24:32.334Z
[phase] Apply
  ✓ shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":"jcs1-sha256:bca6651328f214c8a0b5be2ca786cd1ed1a533f06fa90610956e832da129a965"})   1.0s
Op "migrate-dev" completed in 2.2s

Applied: 20261010T0524-add-source.
```

## 7. Drift

Someone changes a default by hand:

```sql
ALTER TABLE shop.events MODIFY COLUMN source LowCardinality(String) DEFAULT 'app'
```

`yodel drift dev` compares the declared objects with the live ones and exits 2 on drift:

<!-- quote: clickhouse#drift -->
```console
$ npx yodel drift dev
Drift in dev (clickhouse 26.8.15.10 at 127.0.0.1:8123)

Changed out of band:
  events (ClickHouse::Table)
    column source default.expr: declared 'web', live 'app'
[exit 2]
```

`ops/watch-dev.op.ts` is the same check as a `WatchOp` on a schedule. Run once by hand:

`ops/watch-dev.op.ts`:

<!-- quote: clickhouse#watch-op -->
```ts
import { WatchOp } from "@intentius/chant/op";

// Every hour at :17, read dev and report drift: a declared object changed out
// of band, or gone. Objects src/ does not declare are never reported.
// `chant run watch-dev` runs it once, by hand.
export const { op } = WatchOp({ name: "watch-dev", env: "dev", schedule: "17 * * * *" });
```

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

`chant run` exits 0 when the watch completes, drift or not; the drift is the run's `Drift` outcome. The starter templates' `scripts/watch-outcome.ts` turns it into a failed CI job. Put the default back:

```sql
ALTER TABLE shop.events MODIFY COLUMN source LowCardinality(String) DEFAULT 'web'
```

<!-- quote: clickhouse#no-drift -->
```console
$ npx yodel drift dev
Drift in dev (clickhouse 26.8.15.10 at 127.0.0.1:8123)

No drift: every declared object matches the server.
```

## 8. The replay check

`yodel lint --replay replay` replays every migration, in order, into the server the `replay` profile names and compares each with the schema it recorded. Here that profile points at the same emulator as dev, which already holds `shop`, so it refuses:

<!-- quote: clickhouse#replay-refused -->
```console
$ npx yodel lint --replay replay
yodel lint: refused: the replay needs a fresh database, and http://127.0.0.1:8123 (sql.profiles.replay) already holds shop. Point the replay at a throwaway emulator (chant emulator up --lexicon sql), or pass reset to drop it first. Nothing was run.
[exit 4]
```

`--reset` drops the database first. In CI the profile points at a throwaway server the job starts; here it empties dev's database, so it runs last:

<!-- quote: clickhouse#replay -->
<!-- quote: clickhouse#replay-rebuild -->
```console
$ npx yodel lint --replay replay --reset
replay: emptying shop on http://127.0.0.1:8123 (sql.profiles.replay)
replay: 20261010T0521-baseline: replaying
replay: 20261010T0521-baseline: matches its recorded schema
replay: 20261010T0521-add-country: replaying
replay: 20261010T0521-add-country: matches its recorded schema
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
replay: 20261010T0524-fill-country: replaying
replay: 20261010T0524-fill-country: matches its recorded schema
replay: 20261010T0524-add-source: replaying
replay: 20261010T0524-add-source: matches its recorded schema
Replay of 5 migrations (clickhouse) into http://127.0.0.1:8123 (sql.profiles.replay)
  databases: shop (emptied first)
  ok      20261010T0521-baseline (2 statements)
  ok      20261010T0521-add-country (1 statement)
  ok      20261010T0522-events-by-id (0 statements; ran step 0: ClickHouseRebuildOp for events (shop.events) (swapped))
  ok      20261010T0524-fill-country (0 statements; skipped step 0: backfill backfill.ts (moves data; the replayed database has none))
  ok      20261010T0524-add-source (1 statement)
Every migration replays to its recorded schema.

20261010T0522-events-by-id
  silenced ch-rebuild: step 0: ClickHouseRebuildOp rebuilds shop.events: every row is copied into a new table and swapped in, for SQLCH220 Change the sorting key (orderBy)
           reason: 600 rows; the copy takes seconds

5 migrations: 0 errors, 0 warnings, 1 silenced.
```
