# ClickHouse example

A ClickHouse database taken from the declarative path to versioned migrations: adoption with `yodel init --from`, a migration, a sort-key change run as a rebuild step, a backfill step, a lint silence, an approval that stops holding, drift, and the replay check. Every command below ran against the emulator (`chant emulator up --lexicon sql`), and the output under each is what it printed. `examples/walkthrough/clickhouse.ts` holds the steps; `npx tsx examples/walkthrough/run.ts clickhouse --write` runs them again and rewrites this file and the project files from the run.

The project in this directory is what the walkthrough leaves: `src/schema.ts`, the migrations it wrote, and the two Ops.

To run it yourself, from a clone of this repository:

```sh
npm ci && npm run build          # in the repository root
chant emulator up --lexicon sql  # or any ClickHouse you can drop yodel_18_shop on
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
  ✓ chantBuild(path=.)   889ms
[phase] Plan
  ✓ lifecycleDiff(env=dev, live=true)   804ms
    [outcome] Drift=true
[phase] Approve
  • gate:approve-apply-dev()   skipped
[phase] Apply
  • nativeApply(target=clickhouse, env=dev, output=dist/schema.json, deleteMode=never)   skipped
Op "apply-dev" is gated on "approve-apply-dev" after 2.3s
  Approve apply to dev (delete mode: never)
  plan    : jcs1-sha256:9f3ff42832188c693979a158c11d5fe50bee60ebb0dc48162ed791178c2b1263
  approve : chant approve apply-dev approve-apply-dev --plan jcs1-sha256:9f3ff42832188c693979a158c11d5fe50bee60ebb0dc48162ed791178c2b1263
  expires : 2026-10-12T02:57:16.305Z

apply-dev is waiting at gate "approve-apply-dev" for approval of this plan.
Approve it with:
  chant approve apply-dev approve-apply-dev --plan jcs1-sha256:9f3ff42832188c693979a158c11d5fe50bee60ebb0dc48162ed791178c2b1263
then run yodel apply dev again.
[exit 3]
```

The approval is a commit on the `chant/lifecycle` branch. Approve, then run the apply again:

```console
$ npx chant approve apply-dev approve-apply-dev --plan jcs1-sha256:9f3ff42832188c693979a158c11d5fe50bee60ebb0dc48162ed791178c2b1263
Gate "approve-apply-dev" on "apply-dev" resolved by yodel at 2026-10-10T02:57:18.336Z
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
  ✓ chantBuild(path=.)   752ms
[phase] Plan
  ✓ lifecycleDiff(env=dev, live=true)   803ms
    [outcome] Drift=true
[phase] Approve
  ✓ gate:approve-apply-dev()   227ms
    [approved] yodel at 2026-10-10T02:57:18.336Z
[phase] Apply
  ✓ nativeApply(target=clickhouse, env=dev, output=dist/schema.json, deleteMode=never)   29ms
Op "apply-dev" completed in 2.0s

Applied: dev matches the declared schema.
```

```console
$ npx yodel plan dev
Plan for dev (clickhouse, sql.profiles.dev, topology single (default))

No changes.
```

## 2. Adopting the database into versioned migrations

Some data arrives, six months of it, the last weeks dated in the future (scheduled events):

```sql
INSERT INTO yodel_18_shop.events
SELECT number, ['view', 'cart', 'buy'][number % 3 + 1], toDateTime('2026-06-01 00:00:00') + toIntervalHour(number * 7)
FROM numbers(600)
```

```sql
SELECT count() AS rows, countIf(at >= now()) AS future FROM yodel_18_shop.events FORMAT TSVWithNames
```

```
rows	future
600	150
```

To move to versioned migrations, `yodel init --from dev` reads the live database, writes its declarations to `src/`, checks that they plan clean against it, writes the baseline migration (the one that creates everything), and records the baseline applied in dev's history without running it. `src/schema.ts` already declares the schema, so it needs `--force` to write over it:

```console
$ npx yodel init --from dev --force
read 2 object(s) from dev
wrote src/schema.ts
planned against dev: no change
wrote migrations/20261010T0257-baseline (2 statements)
lock: no KeeperMap on this server (KeeperMap is disabled because 'keeper_map_path_prefix' config is not defined. (BAD_ARGUMENTS) (version 26.8.15.10 (official build))); the lock is a file on this machine, so cross-runner locking needs Keeper (and keeper_map_path_prefix)
recorded 20261010T0257-baseline applied in yodel_18_history.history as a baseline; none of its statements was run
Adopted dev (clickhouse): 2 objects
  Database yodel_18_shop
  Table yodel_18_shop.events

Declarations: src/schema.ts
Baseline:     migrations/20261010T0257-baseline/ (2 statements, sha256:6b713090359bcc6a3b33eaf55f0fec6a0d56346eff452d091a56a78f4f816c72)
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
  20261010T0257-baseline  2026-10-10 02:57:25.955211 by yodel@example

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
Wrote migrations/20261010T0257-add-country/ (1 statement; follows 20261010T0257-baseline)
```

`migrations/20261010T0257-add-country/migration.sql`:

```sql
-- yodel migration 20261010T0257-add-country
-- parent: 20261010T0257-baseline

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

20261010T0257-add-country
  0  statement  SQLCH201 metadata  yodel_18_shop.events
       ALTER TABLE `yodel_18_shop`.`events` ADD COLUMN country LowCardinality(String) DEFAULT '' AFTER `at`

Plan digest: jcs1-sha256:e21e7a089e5041480f810c5bb3d1af1e194876c0d7fd688e2bef84f0db152be2
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:e21e7a089e5041480f810c5bb3d1af1e194876c0d7fd688e2bef84f0db152be2

Not approved yet. Approving binds exactly this digest; if anything it covers changes before the apply runs, the gate asks again and nothing is applied.
```

```console
$ npx yodel apply dev
Migrations in dev (history yodel_18_history.history, topology single (default))

Applied (1):
  20261010T0257-baseline  2026-10-10 02:57:25.955211 by yodel@example

Pending (1):
  20261010T0257-add-country

Plan digest: jcs1-sha256:e21e7a089e5041480f810c5bb3d1af1e194876c0d7fd688e2bef84f0db152be2

Running migrate-dev (<tmp>/clickhouse/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   8.1s
[phase] Approve
  • gate:approve-migrate-dev()   skipped
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 9.4s
  plan    : jcs1-sha256:e21e7a089e5041480f810c5bb3d1af1e194876c0d7fd688e2bef84f0db152be2
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:e21e7a089e5041480f810c5bb3d1af1e194876c0d7fd688e2bef84f0db152be2
  expires : 2026-10-12T02:57:41.753Z

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:e21e7a089e5041480f810c5bb3d1af1e194876c0d7fd688e2bef84f0db152be2).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:e21e7a089e5041480f810c5bb3d1af1e194876c0d7fd688e2bef84f0db152be2
then run yodel apply dev again.
[exit 3]
```

```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:e21e7a089e5041480f810c5bb3d1af1e194876c0d7fd688e2bef84f0db152be2
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-10T02:57:45.365Z
This approves the plan jcs1-sha256:e21e7a089e5041480f810c5bb3d1af1e194876c0d7fd688e2bef84f0db152be2, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

The emulator has no Keeper, so the apply lock is a file on this machine, and the run says so. On a server with Keeper and `keeper_map_path_prefix` the lock is a row in a KeeperMap table, shared by every runner.

```console
$ npx yodel apply dev
Migrations in dev (history yodel_18_history.history, topology single (default))

Applied (1):
  20261010T0257-baseline  2026-10-10 02:57:25.955211 by yodel@example

Pending (1):
  20261010T0257-add-country

Plan digest: jcs1-sha256:e21e7a089e5041480f810c5bb3d1af1e194876c0d7fd688e2bef84f0db152be2

Running migrate-dev (<tmp>/clickhouse/ops/migrate-dev.op.ts)
lock: no KeeperMap on this server (KeeperMap is disabled because 'keeper_map_path_prefix' config is not defined. (BAD_ARGUMENTS) (version 26.8.15.10 (official build))); the lock is a file on this machine, so cross-runner locking needs Keeper (and keeper_map_path_prefix)
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:e21e7a089e5041480f810c5bb3d1af1e194876c0d7fd688e2bef84f0db152be2, by yodel at 2026-10-10T02:57:45.365Z
20261010T0257-add-country: applying
  statement 0: ok (SQLCH201 metadata, yodel_18_shop.events)
20261010T0257-add-country: applied

[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   1.1s
[phase] Approve
  ✓ gate:approve-migrate-dev()   254ms
    [approved] yodel at 2026-10-10T02:57:45.365Z
[phase] Apply
  ✓ shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":"jcs1-sha256:e21e7a089e5041480f810c5bb3d1af1e194876c0d7fd688e2bef84f0db152be2"})   2.2s
Op "migrate-dev" completed in 3.7s

Applied: 20261010T0257-add-country.
```

```console
$ npx yodel status dev
Migrations in dev (history yodel_18_history.history, topology single (default))

Applied (2):
  20261010T0257-baseline  2026-10-10 02:57:25.955211 by yodel@example
  20261010T0257-add-country  2026-10-10 02:57:50.505117 by yodel@example

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

`yodel new` writes the change as a `ClickHouseRebuildOp` step: a new table with the new key, a materialized view that writes rows at or after a cut-over time into it, a backfill of every row already in the table, partition by partition (a receipt per partition), a verification of every row, and a swap. Rows dated at or after the cut-over, like the future ones here, are copied too.

```console
$ npx yodel new events-by-id
Wrote migrations/20261010T0257-events-by-id/ (0 statements; follows 20261010T0257-add-country)
  This migration contains an Op step: ClickHouseRebuildOp for events (yodel_18_shop.events), SQLCH220.
    It is not SQL. migration.json holds the Op's declaration:
    export const { op } = ClickHouseRebuildOp({ name: "rebuild-yodel-18-shop-events", env: "<env>", table: "yodel_18_shop.events", dualWrite: { mode: "materialized-view", cutoverColumn: "at" } });
```

`migrations/20261010T0257-events-by-id/migration.sql`:

```sql
-- yodel migration 20261010T0257-events-by-id
-- parent: 20261010T0257-add-country
-- This migration contains an Op step, not only SQL:
--   ClickHouseRebuildOp for events (yodel_18_shop.events), SQLCH220: not SQL; migration.json holds its declaration

-- events (yodel_18_shop.events): SQLCH220 made by ClickHouseRebuildOp, not a statement:
--   export const { op } = ClickHouseRebuildOp({ name: "rebuild-yodel-18-shop-events", env: "<env>", table: "yodel_18_shop.events", dualWrite: { mode: "materialized-view", cutoverColumn: "at" } });
```

`yodel lint` flags a rebuild as an error (`ch-rebuild`):

```console
$ npx yodel lint
20261010T0257-events-by-id
  error    ch-rebuild: step 0: ClickHouseRebuildOp rebuilds yodel_18_shop.events: every row is copied into a new table and swapped in, for SQLCH220 Change the sorting key (orderBy)

A statement rule can be silenced for one statement, with a reason the history records when it applies:
  a line `-- yodel:allow <rule> <reason>` above the statement in migration.sql

3 migrations: 1 error, 0 warnings, 0 silenced.
[exit 3]
```

The table is small, so the rebuild is fine. Silence the rule for this step with a reason, on the line above it in `migration.sql`:

`migrations/20261010T0257-events-by-id/migration.sql` now:

```sql
-- yodel migration 20261010T0257-events-by-id
-- parent: 20261010T0257-add-country
-- This migration contains an Op step, not only SQL:
--   ClickHouseRebuildOp for events (yodel_18_shop.events), SQLCH220: not SQL; migration.json holds its declaration

-- yodel:allow ch-rebuild 600 rows; the copy takes seconds
-- events (yodel_18_shop.events): SQLCH220 made by ClickHouseRebuildOp, not a statement:
--   export const { op } = ClickHouseRebuildOp({ name: "rebuild-yodel-18-shop-events", env: "<env>", table: "yodel_18_shop.events", dualWrite: { mode: "materialized-view", cutoverColumn: "at" } });
```

The edit changes the migration's checksum, which lint reports, and the migration has not been applied anywhere, so record the new one:

```console
$ npx yodel lint
20261010T0257-events-by-id
  error    checksum: 20261010T0257-events-by-id: its files hash to sha256:11001f5099e320a3d5231aca3b27d01dc396e4f61df85cf6450139c50b66a553, but migration.json records sha256:b0e0b7ad5b2d37777501962a5bc5d949f78503c19df80c6b1fe4848d2daf2055; if it is not applied in any environment, record its new checksum with yodel lint --update-checksum 20261010T0257-events-by-id; if it is, undo the edit, or record it with yodel repair 20261010T0257-events-by-id --reason ... <env>
  silenced ch-rebuild: step 0: ClickHouseRebuildOp rebuilds yodel_18_shop.events: every row is copied into a new table and swapped in, for SQLCH220 Change the sorting key (orderBy)
           reason: 600 rows; the copy takes seconds

3 migrations: 1 error, 0 warnings, 1 silenced.
[exit 3]
```

```console
$ npx yodel lint --update-checksum 20261010T0257-events-by-id
20261010T0257-events-by-id: checksum sha256:b0e0b7ad5b2d37777501962a5bc5d949f78503c19df80c6b1fe4848d2daf2055 is now sha256:11001f5099e320a3d5231aca3b27d01dc396e4f61df85cf6450139c50b66a553
20261010T0257-events-by-id
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

#### `20261010T0257-events-by-id`

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

Plan digest the apply gate binds: `jcs1-sha256:3c444c50af973edfa4a6dde7019f5b674f56d367a597acd4b00d7e5a8bf25616`

Approve it with:

```sh
chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:3c444c50af973edfa4a6dde7019f5b674f56d367a597acd4b00d7e5a8bf25616
```

The newest approval of `approve-migrate-dev`, by yodel at 2026-10-10T02:57:45.365Z, is for `jcs1-sha256:e21e7a089e5041480f810c5bb3d1af1e194876c0d7fd688e2bef84f0db152be2`, not this plan; it does not hold.
What moved (as far as yodel can tell): history changed: applied since: 20261010T0257-add-country (by yodel@example at 2026-10-10 02:57:50.505117); pending migrations changed: committed to since approval: 20261010T0257-events-by-id (0b1ec44 at 2026-10-09T20:57:56-06:00); live schema changed: no state yodel can rebuild from the history and git hashes to the approved digest with today's live schema, so an object in the environment's live schema (a table, view, index, dictionary, database or schema) changed since approval (or a part yodel cannot rebuild did).

<!-- yodel:subject eyJlbnZpcm9ubWVudCI6ImRldiIsImhpc3RvcnlEYXRhYmFzZSI6InlvZGVsXzE4X2hpc3RvcnkiLCJ0b3BvbG9neSI6eyJraW5kIjoic2luZ2xlIn0sImFwcGxpZWQiOlt7ImlkIjoiMjAyNjEwMTBUMDI1Ny1iYXNlbGluZSIsImNoZWNrc3VtIjoic2hhMjU2OjZiNzEzMDkwMzU5YmNjNmEzYjMzZWFmNTVmMGZlYzZhMGQ1NjM0NmVmZjQ1MmQwOTFhNTZhNzhmNGY4MTZjNzIifSx7ImlkIjoiMjAyNjEwMTBUMDI1Ny1hZGQtY291bnRyeSIsImNoZWNrc3VtIjoic2hhMjU2OjVlM2YxZjFlZWI5Yzk2ODYyOWQyMGUxZjQ4YWU3MGI1MmU4NTRjNTE5MzE5MjVmMmMxM2U2MjkwZDQ2Mzc2YTQifV0sInBlbmRpbmciOlt7ImlkIjoiMjAyNjEwMTBUMDI1Ny1ldmVudHMtYnktaWQiLCJjaGVja3N1bSI6InNoYTI1NjoxMTAwMWY1MDk5ZTMyMGEzZDUyMzFhY2EzYjI3ZDAxZGMzOTZlNGY2MWRmODVjZjY0NTAxMzljNTBiNjZhNTUzIiwiZG9uZSI6W119XSwibGl2ZSI6InNoYTI1Njo0NTFkZjRjMDM4ODMxZWUyM2E0OGQxYzk3OTI1NmM0MWFjN2Y1NjA0ZTFhNTE4ZTY4NDA5NjJlNDRjYWYxMDk4In0 -->
````

```console
$ npx yodel apply dev
Migrations in dev (history yodel_18_history.history, topology single (default))

Applied (2):
  20261010T0257-baseline  2026-10-10 02:57:25.955211 by yodel@example
  20261010T0257-add-country  2026-10-10 02:57:50.505117 by yodel@example

Pending (1):
  20261010T0257-events-by-id  (step 0: ClickHouseRebuildOp for events (yodel_18_shop.events))

Plan digest: jcs1-sha256:3c444c50af973edfa4a6dde7019f5b674f56d367a597acd4b00d7e5a8bf25616

Running migrate-dev (<tmp>/clickhouse/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   1.1s
[phase] Approve
  • gate:approve-migrate-dev()   skipped
    [refused] Gate "approve-migrate-dev" is approved, but not for this plan. approved: jcs1-sha256:e21e7a089e5041480f810c5bb3d1af1e194876c0d7fd688e2bef84f0db152be2 (by yodel at 2026-10-10T02:57:45.365Z); planned: jcs1-sha256:3c444c50af973edfa4a6dde7019f5b674f56d367a597acd4b00d7e5a8bf25616. The configuration or the live system changed between that approval and this plan, so it needs a fresh one: chant approve migrate-dev approve-migrate-dev
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 3.2s
  plan    : jcs1-sha256:3c444c50af973edfa4a6dde7019f5b674f56d367a597acd4b00d7e5a8bf25616
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:3c444c50af973edfa4a6dde7019f5b674f56d367a597acd4b00d7e5a8bf25616
  expires : 2026-10-12T02:58:00.160Z

Nothing was applied. The approval of jcs1-sha256:e21e7a089e5041480f810c5bb3d1af1e194876c0d7fd688e2bef84f0db152be2 (by yodel at 2026-10-10T02:57:45.365Z) does not hold: the plan moved since. What moved, as far as yodel can tell: history changed: applied since: 20261010T0257-add-country (by yodel@example at 2026-10-10 02:57:50.505117); pending migrations changed: committed to since approval: 20261010T0257-events-by-id (0b1ec44 at 2026-10-09T20:57:56-06:00); live schema changed: no state yodel can rebuild from the history and git hashes to the approved digest with today's live schema, so an object in the environment's live schema (a table, view, index, dictionary, database or schema) changed since approval (or a part yodel cannot rebuild did).

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:3c444c50af973edfa4a6dde7019f5b674f56d367a597acd4b00d7e5a8bf25616).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:3c444c50af973edfa4a6dde7019f5b674f56d367a597acd4b00d7e5a8bf25616
then run yodel apply dev again.
[exit 3]
```

```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:3c444c50af973edfa4a6dde7019f5b674f56d367a597acd4b00d7e5a8bf25616
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-10T02:58:09.295Z
This approves the plan jcs1-sha256:3c444c50af973edfa4a6dde7019f5b674f56d367a597acd4b00d7e5a8bf25616, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

The rebuild waits a minute for its cut-over before the backfill:

```console
$ npx yodel apply dev
Migrations in dev (history yodel_18_history.history, topology single (default))

Applied (2):
  20261010T0257-baseline  2026-10-10 02:57:25.955211 by yodel@example
  20261010T0257-add-country  2026-10-10 02:57:50.505117 by yodel@example

Pending (1):
  20261010T0257-events-by-id  (step 0: ClickHouseRebuildOp for events (yodel_18_shop.events))

Plan digest: jcs1-sha256:3c444c50af973edfa4a6dde7019f5b674f56d367a597acd4b00d7e5a8bf25616

Running migrate-dev (<tmp>/clickhouse/ops/migrate-dev.op.ts)
lock: no KeeperMap on this server (KeeperMap is disabled because 'keeper_map_path_prefix' config is not defined. (BAD_ARGUMENTS) (version 26.8.15.10 (official build))); the lock is a file on this machine, so cross-runner locking needs Keeper (and keeper_map_path_prefix)
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:3c444c50af973edfa4a6dde7019f5b674f56d367a597acd4b00d7e5a8bf25616, by yodel at 2026-10-10T02:58:09.295Z
20261010T0257-events-by-id: applying
  step 0: ClickHouseRebuildOp for events (yodel_18_shop.events)
  step 0: ok {"op":"ClickHouseRebuildOp","table":"yodel_18_shop.events","state":"rebuild","partitions":6,"copied":6,"skipped":0,"cleared":0,"repaired":0,"verifiedRows":600,"swapped":true,"oldTable":"yodel_18_shop.events__chant_old","retainUntil":"2026-10-17T02:59:28.444Z"}
20261010T0257-events-by-id: applied

[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   4.3s
[phase] Approve
  ✓ gate:approve-migrate-dev()   1.0s
    [approved] yodel at 2026-10-10T02:58:09.295Z
[phase] Apply
  ✓ shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":"jcs1-sha256:3c444c50af973edfa4a6dde7019f5b674f56d367a597acd4b00d7e5a8bf25616"})   66.7s
Op "migrate-dev" completed in 72.3s

Applied: 20261010T0257-events-by-id.
```

```sql
SELECT sorting_key, total_rows FROM system.tables WHERE database = 'yodel_18_shop' AND name LIKE 'events%' ORDER BY name FORMAT TSVWithNames
```

```
sorting_key	total_rows
kind, id	600
kind, at	600
```

Every row is in the new table, the future-dated ones too:

```sql
SELECT count() AS rows, countIf(at >= now()) AS future FROM yodel_18_shop.events FORMAT TSVWithNames
```

```
rows	future
600	150
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

const months = ["202606", "202607", "202608", "202609", "202610", "202611"];

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
Wrote migrations/20261010T0259-fill-country/ (0 statements; follows 20261010T0257-events-by-id)
  This migration ends with a backfill step: the Op backfill.ts exports, copied into the migration's directory.
    yodel apply runs its effect() batches after the statements before it, resuming from their receipts after a failure.
```

`migrations/20261010T0259-fill-country/migration.sql`:

```sql
-- yodel migration 20261010T0259-fill-country
-- parent: 20261010T0257-events-by-id
-- This migration contains an Op step, not only SQL:
--   a backfill: the Op backfill.ts exports, its effect() batches resumable from their receipts

-- backfill (fill-country): made by the Op backfill.ts exports, not a statement
```

```console
$ npx yodel lint
20261010T0257-events-by-id
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

#### `20261010T0259-fill-country`

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

Plan digest the apply gate binds: `jcs1-sha256:0ce50928a039f7659b5483901d1c4f6b21b1c525ce7ea188b279c75c9af19db3`

Approve it with:

```sh
chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:0ce50928a039f7659b5483901d1c4f6b21b1c525ce7ea188b279c75c9af19db3
```

The newest approval of `approve-migrate-dev`, by yodel at 2026-10-10T02:58:09.295Z, is for `jcs1-sha256:3c444c50af973edfa4a6dde7019f5b674f56d367a597acd4b00d7e5a8bf25616`, not this plan; it does not hold.
What moved (as far as yodel can tell): history changed: applied since: 20261010T0257-events-by-id (by yodel@example at 2026-10-10 02:59:28.488309); live schema changed: no state yodel can rebuild from the history and git hashes to the approved digest with today's live schema, so an object in the environment's live schema (a table, view, index, dictionary, database or schema) changed since approval (or a part yodel cannot rebuild did).

<!-- yodel:subject eyJlbnZpcm9ubWVudCI6ImRldiIsImhpc3RvcnlEYXRhYmFzZSI6InlvZGVsXzE4X2hpc3RvcnkiLCJ0b3BvbG9neSI6eyJraW5kIjoic2luZ2xlIn0sImFwcGxpZWQiOlt7ImlkIjoiMjAyNjEwMTBUMDI1Ny1iYXNlbGluZSIsImNoZWNrc3VtIjoic2hhMjU2OjZiNzEzMDkwMzU5YmNjNmEzYjMzZWFmNTVmMGZlYzZhMGQ1NjM0NmVmZjQ1MmQwOTFhNTZhNzhmNGY4MTZjNzIifSx7ImlkIjoiMjAyNjEwMTBUMDI1Ny1hZGQtY291bnRyeSIsImNoZWNrc3VtIjoic2hhMjU2OjVlM2YxZjFlZWI5Yzk2ODYyOWQyMGUxZjQ4YWU3MGI1MmU4NTRjNTE5MzE5MjVmMmMxM2U2MjkwZDQ2Mzc2YTQifSx7ImlkIjoiMjAyNjEwMTBUMDI1Ny1ldmVudHMtYnktaWQiLCJjaGVja3N1bSI6InNoYTI1NjoxMTAwMWY1MDk5ZTMyMGEzZDUyMzFhY2EzYjI3ZDAxZGMzOTZlNGY2MWRmODVjZjY0NTAxMzljNTBiNjZhNTUzIn1dLCJwZW5kaW5nIjpbeyJpZCI6IjIwMjYxMDEwVDAyNTktZmlsbC1jb3VudHJ5IiwiY2hlY2tzdW0iOiJzaGEyNTY6ZDBjNmJmODIwNDIzODA4ZWI1ZWY3YjJkNWIzZDc5N2FiNDE3MjBlYzY0YWM2MDYyMTg0M2JlYzA5MmE4MzQyNSIsImRvbmUiOltdfV0sImxpdmUiOiJzaGEyNTY6NzhiMjQ0ZGMyZTE0ZGUxOTdkN2QzMjg2ZWVmNmZhZDMyNjQ3NDI0MmZmMDkzYjM5ZGVmNDZkNzQ3ODU2YmQzZCJ9 -->
````

```console
$ npx yodel apply dev
Migrations in dev (history yodel_18_history.history, topology single (default))

Applied (3):
  20261010T0257-baseline  2026-10-10 02:57:25.955211 by yodel@example
  20261010T0257-add-country  2026-10-10 02:57:50.505117 by yodel@example
  20261010T0257-events-by-id  2026-10-10 02:59:28.488309 by yodel@example

Pending (1):
  20261010T0259-fill-country  (step 0: backfill backfill.ts)

Plan digest: jcs1-sha256:0ce50928a039f7659b5483901d1c4f6b21b1c525ce7ea188b279c75c9af19db3

Running migrate-dev (<tmp>/clickhouse/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   1.0s
[phase] Approve
  • gate:approve-migrate-dev()   skipped
    [refused] Gate "approve-migrate-dev" is approved, but not for this plan. approved: jcs1-sha256:3c444c50af973edfa4a6dde7019f5b674f56d367a597acd4b00d7e5a8bf25616 (by yodel at 2026-10-10T02:58:09.295Z); planned: jcs1-sha256:0ce50928a039f7659b5483901d1c4f6b21b1c525ce7ea188b279c75c9af19db3. The configuration or the live system changed between that approval and this plan, so it needs a fresh one: chant approve migrate-dev approve-migrate-dev
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 2.0s
  plan    : jcs1-sha256:0ce50928a039f7659b5483901d1c4f6b21b1c525ce7ea188b279c75c9af19db3
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:0ce50928a039f7659b5483901d1c4f6b21b1c525ce7ea188b279c75c9af19db3
  expires : 2026-10-12T02:59:37.967Z

Nothing was applied. The approval of jcs1-sha256:3c444c50af973edfa4a6dde7019f5b674f56d367a597acd4b00d7e5a8bf25616 (by yodel at 2026-10-10T02:58:09.295Z) does not hold: the plan moved since. What moved, as far as yodel can tell: history changed: applied since: 20261010T0257-events-by-id (by yodel@example at 2026-10-10 02:59:28.488309); pending migrations changed: committed to since approval: 20261010T0259-fill-country (5e836f1 at 2026-10-09T20:59:35-06:00); live schema changed: no state yodel can rebuild from the history and git hashes to the approved digest with today's live schema, so an object in the environment's live schema (a table, view, index, dictionary, database or schema) changed since approval (or a part yodel cannot rebuild did).

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:0ce50928a039f7659b5483901d1c4f6b21b1c525ce7ea188b279c75c9af19db3).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:0ce50928a039f7659b5483901d1c4f6b21b1c525ce7ea188b279c75c9af19db3
then run yodel apply dev again.
[exit 3]
```

```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:0ce50928a039f7659b5483901d1c4f6b21b1c525ce7ea188b279c75c9af19db3
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-10T02:59:41.014Z
This approves the plan jcs1-sha256:0ce50928a039f7659b5483901d1c4f6b21b1c525ce7ea188b279c75c9af19db3, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

```console
$ npx yodel apply dev
Migrations in dev (history yodel_18_history.history, topology single (default))

Applied (3):
  20261010T0257-baseline  2026-10-10 02:57:25.955211 by yodel@example
  20261010T0257-add-country  2026-10-10 02:57:50.505117 by yodel@example
  20261010T0257-events-by-id  2026-10-10 02:59:28.488309 by yodel@example

Pending (1):
  20261010T0259-fill-country  (step 0: backfill backfill.ts)

Plan digest: jcs1-sha256:0ce50928a039f7659b5483901d1c4f6b21b1c525ce7ea188b279c75c9af19db3

Running migrate-dev (<tmp>/clickhouse/ops/migrate-dev.op.ts)
lock: no KeeperMap on this server (KeeperMap is disabled because 'keeper_map_path_prefix' config is not defined. (BAD_ARGUMENTS) (version 26.8.15.10 (official build))); the lock is a file on this machine, so cross-runner locking needs Keeper (and keeper_map_path_prefix)
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:0ce50928a039f7659b5483901d1c4f6b21b1c525ce7ea188b279c75c9af19db3, by yodel at 2026-10-10T02:59:41.014Z
20261010T0259-fill-country: applying
  step 0: backfill backfill.ts
    ALTER TABLE yodel_18_shop.events UPDATE country = ['DE', 'FR', 'US'][id % 3 + 1] WHERE toYYYYMM(at) = 202606 AND country = ''
    ALTER TABLE yodel_18_shop.events UPDATE country = ['DE', 'FR', 'US'][id % 3 + 1] WHERE toYYYYMM(at) = 202607 AND country = ''
    ALTER TABLE yodel_18_shop.events UPDATE country = ['DE', 'FR', 'US'][id % 3 + 1] WHERE toYYYYMM(at) = 202608 AND country = ''
    ALTER TABLE yodel_18_shop.events UPDATE country = ['DE', 'FR', 'US'][id % 3 + 1] WHERE toYYYYMM(at) = 202609 AND country = ''
    ALTER TABLE yodel_18_shop.events UPDATE country = ['DE', 'FR', 'US'][id % 3 + 1] WHERE toYYYYMM(at) = 202610 AND country = ''
    ALTER TABLE yodel_18_shop.events UPDATE country = ['DE', 'FR', 'US'][id % 3 + 1] WHERE toYYYYMM(at) = 202611 AND country = ''
  step 0: ok {"op":"backfill","file":"backfill.ts","name":"backfill-fill-country","effects":6,"skipped":0,"ran":6}
20261010T0259-fill-country: applied

[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   1.1s
[phase] Approve
  ✓ gate:approve-migrate-dev()   337ms
    [approved] yodel at 2026-10-10T02:59:41.014Z
[phase] Apply
  ✓ shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":"jcs1-sha256:0ce50928a039f7659b5483901d1c4f6b21b1c525ce7ea188b279c75c9af19db3"})   2.7s
Op "migrate-dev" completed in 4.4s

Applied: 20261010T0259-fill-country.
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
migration_id:    20261010T0257-events-by-id
kind:            migration
statement_index: -1
status:          started
note:            
silences:        [{"step":0,"rule":"ch-rebuild","reason":"600 rows; the copy takes seconds"}]

Row 2:
──────
migration_id:    20261010T0257-events-by-id
kind:            step
statement_index: 0
status:          started
note:            
silences:        [{"step":0,"rule":"ch-rebuild","reason":"600 rows; the copy takes seconds"}]

Row 3:
──────
migration_id:    20261010T0257-events-by-id
kind:            step
statement_index: 0
status:          succeeded
note:            {"op":"ClickHouseRebuildOp","table":"yodel_18_shop.events","state":"rebuild","partitions":6,"copied":6,"skipped":0,"cleared":0,"repaired":0,"verifiedRows":600,"swapped":true,"oldTable":"yodel_18_shop.events__chant_old","retainUntil":"2026-10-17T02:59:28.444Z"}
silences:        [{"step":0,"rule":"ch-rebuild","reason":"600 rows; the copy takes seconds"}]

Row 4:
──────
migration_id:    20261010T0257-events-by-id
kind:            migration
statement_index: -1
status:          succeeded
note:            
silences:        [{"step":0,"rule":"ch-rebuild","reason":"600 rows; the copy takes seconds"}]

Row 5:
──────
migration_id:    20261010T0259-fill-country
kind:            migration
statement_index: -1
status:          started
note:            
silences:        []

Row 6:
──────
migration_id:    20261010T0259-fill-country
kind:            step
statement_index: 0
status:          started
note:            
silences:        []

Row 7:
──────
migration_id:    20261010T0259-fill-country
kind:            step
statement_index: 0
status:          succeeded
note:            {"op":"backfill","file":"backfill.ts","name":"backfill-fill-country","effects":6,"skipped":0,"ran":6}
silences:        []

Row 8:
──────
migration_id:    20261010T0259-fill-country
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
Wrote migrations/20261010T0259-add-source/ (1 statement; follows 20261010T0259-fill-country)
```

```console
$ npx yodel plan dev
Plan for dev (clickhouse, history yodel_18_history.history (single (default))): 4 applied, 1 pending

20261010T0259-add-source
  0  statement  SQLCH201 metadata  yodel_18_shop.events
       ALTER TABLE `yodel_18_shop`.`events` ADD COLUMN source LowCardinality(String) DEFAULT 'web' AFTER `country`

Plan digest: jcs1-sha256:9a322006b7eee5142b076c8ed8b46fcfbdff6d41595a3d193224568797b2f619
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:9a322006b7eee5142b076c8ed8b46fcfbdff6d41595a3d193224568797b2f619

The newest approval of approve-migrate-dev, by yodel at 2026-10-10T02:59:41.014Z, is for jcs1-sha256:0ce50928a039f7659b5483901d1c4f6b21b1c525ce7ea188b279c75c9af19db3, not this plan; it does not hold.
What moved: history changed: applied since: 20261010T0259-fill-country (by yodel@example at 2026-10-10 02:59:46.100222); pending migrations changed: new pending migration: 20261010T0259-add-source.
```

Approve the plan, as a reviewer would from the pull request comment:

```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:9a322006b7eee5142b076c8ed8b46fcfbdff6d41595a3d193224568797b2f619
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-10T02:59:52.721Z
This approves the plan jcs1-sha256:9a322006b7eee5142b076c8ed8b46fcfbdff6d41595a3d193224568797b2f619, and only that plan. A run whose fresh plan differs refuses rather than applying it.
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
  20261010T0257-baseline  2026-10-10 02:57:25.955211 by yodel@example
  20261010T0257-add-country  2026-10-10 02:57:50.505117 by yodel@example
  20261010T0257-events-by-id  2026-10-10 02:59:28.488309 by yodel@example
  20261010T0259-fill-country  2026-10-10 02:59:46.100222 by yodel@example

Pending (1):
  20261010T0259-add-source

Plan digest: jcs1-sha256:cfa2d1678390b736269cac286efd4d7d74ab84da57ba915c6cd12d23ce0c4ee1

Running migrate-dev (<tmp>/clickhouse/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   1.0s
[phase] Approve
  • gate:approve-migrate-dev()   skipped
    [refused] Gate "approve-migrate-dev" is approved, but not for this plan. approved: jcs1-sha256:9a322006b7eee5142b076c8ed8b46fcfbdff6d41595a3d193224568797b2f619 (by yodel at 2026-10-10T02:59:52.721Z); planned: jcs1-sha256:cfa2d1678390b736269cac286efd4d7d74ab84da57ba915c6cd12d23ce0c4ee1. The configuration or the live system changed between that approval and this plan, so it needs a fresh one: chant approve migrate-dev approve-migrate-dev
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 1.8s
  plan    : jcs1-sha256:cfa2d1678390b736269cac286efd4d7d74ab84da57ba915c6cd12d23ce0c4ee1
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:cfa2d1678390b736269cac286efd4d7d74ab84da57ba915c6cd12d23ce0c4ee1
  expires : 2026-10-12T02:59:55.858Z

Nothing was applied. The approval of jcs1-sha256:9a322006b7eee5142b076c8ed8b46fcfbdff6d41595a3d193224568797b2f619 (by yodel at 2026-10-10T02:59:52.721Z) does not hold: the plan moved since. What moved, as far as yodel can tell: live schema changed: no state yodel can rebuild from the history and git hashes to the approved digest with today's live schema, so an object in the environment's live schema (a table, view, index, dictionary, database or schema) changed since approval (or a part yodel cannot rebuild did).

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:cfa2d1678390b736269cac286efd4d7d74ab84da57ba915c6cd12d23ce0c4ee1).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:cfa2d1678390b736269cac286efd4d7d74ab84da57ba915c6cd12d23ce0c4ee1
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

20261010T0259-add-source
  0  statement  SQLCH201 metadata  yodel_18_shop.events
       ALTER TABLE `yodel_18_shop`.`events` ADD COLUMN source LowCardinality(String) DEFAULT 'web' AFTER `country`

Plan digest: jcs1-sha256:9a322006b7eee5142b076c8ed8b46fcfbdff6d41595a3d193224568797b2f619
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:9a322006b7eee5142b076c8ed8b46fcfbdff6d41595a3d193224568797b2f619

The newest approval of approve-migrate-dev, by yodel at 2026-10-10T02:59:52.721Z, is for this plan's digest, but approval was asked for again after it at 2026-10-10T02:59:55.858Z (a run holding jcs1-sha256:cfa2d1678390b736269cac286efd4d7d74ab84da57ba915c6cd12d23ce0c4ee1), so it does not hold; approve this plan again.
```

The digest is the approved one again, but the refused run asked for approval after that approval was given, and an approval holds only when it is newer than the latest request. The apply stops at the gate again:

```console
$ npx yodel apply dev
Migrations in dev (history yodel_18_history.history, topology single (default))

Applied (4):
  20261010T0257-baseline  2026-10-10 02:57:25.955211 by yodel@example
  20261010T0257-add-country  2026-10-10 02:57:50.505117 by yodel@example
  20261010T0257-events-by-id  2026-10-10 02:59:28.488309 by yodel@example
  20261010T0259-fill-country  2026-10-10 02:59:46.100222 by yodel@example

Pending (1):
  20261010T0259-add-source

Plan digest: jcs1-sha256:9a322006b7eee5142b076c8ed8b46fcfbdff6d41595a3d193224568797b2f619

Running migrate-dev (<tmp>/clickhouse/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   970ms
[phase] Approve
  • gate:approve-migrate-dev()   skipped
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 1.8s
  plan    : jcs1-sha256:9a322006b7eee5142b076c8ed8b46fcfbdff6d41595a3d193224568797b2f619
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:9a322006b7eee5142b076c8ed8b46fcfbdff6d41595a3d193224568797b2f619
  expires : 2026-10-12T03:00:00.474Z

Nothing was applied. The approval of jcs1-sha256:9a322006b7eee5142b076c8ed8b46fcfbdff6d41595a3d193224568797b2f619 (by yodel at 2026-10-10T02:59:52.721Z) is for this plan's digest, but approval was asked for again after it at 2026-10-10T02:59:55.858Z (a run holding jcs1-sha256:cfa2d1678390b736269cac286efd4d7d74ab84da57ba915c6cd12d23ce0c4ee1), so it does not hold; approve this plan again.

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:9a322006b7eee5142b076c8ed8b46fcfbdff6d41595a3d193224568797b2f619).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:9a322006b7eee5142b076c8ed8b46fcfbdff6d41595a3d193224568797b2f619
then run yodel apply dev again.
[exit 3]
```

```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:9a322006b7eee5142b076c8ed8b46fcfbdff6d41595a3d193224568797b2f619
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-10T03:00:03.073Z
This approves the plan jcs1-sha256:9a322006b7eee5142b076c8ed8b46fcfbdff6d41595a3d193224568797b2f619, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

```console
$ npx yodel apply dev
Migrations in dev (history yodel_18_history.history, topology single (default))

Applied (4):
  20261010T0257-baseline  2026-10-10 02:57:25.955211 by yodel@example
  20261010T0257-add-country  2026-10-10 02:57:50.505117 by yodel@example
  20261010T0257-events-by-id  2026-10-10 02:59:28.488309 by yodel@example
  20261010T0259-fill-country  2026-10-10 02:59:46.100222 by yodel@example

Pending (1):
  20261010T0259-add-source

Plan digest: jcs1-sha256:9a322006b7eee5142b076c8ed8b46fcfbdff6d41595a3d193224568797b2f619

Running migrate-dev (<tmp>/clickhouse/ops/migrate-dev.op.ts)
lock: no KeeperMap on this server (KeeperMap is disabled because 'keeper_map_path_prefix' config is not defined. (BAD_ARGUMENTS) (version 26.8.15.10 (official build))); the lock is a file on this machine, so cross-runner locking needs Keeper (and keeper_map_path_prefix)
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:9a322006b7eee5142b076c8ed8b46fcfbdff6d41595a3d193224568797b2f619, by yodel at 2026-10-10T03:00:03.073Z
20261010T0259-add-source: applying
  statement 0: ok (SQLCH201 metadata, yodel_18_shop.events)
20261010T0259-add-source: applied

[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   926ms
[phase] Approve
  ✓ gate:approve-migrate-dev()   239ms
    [approved] yodel at 2026-10-10T03:00:03.073Z
[phase] Apply
  ✓ shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":"jcs1-sha256:9a322006b7eee5142b076c8ed8b46fcfbdff6d41595a3d193224568797b2f619"})   1.2s
Op "migrate-dev" completed in 2.6s

Applied: 20261010T0259-add-source.
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
  ✓ lifecycleSnapshot(env=dev)   977ms
[phase] Diff
  ✓ lifecycleDiff(env=dev, live=true)   795ms
    [outcome] Drift=true
Op "watch-dev" completed in 1.9s
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
replay: 20261010T0257-baseline: replaying
replay: 20261010T0257-baseline: matches its recorded schema
replay: 20261010T0257-add-country: replaying
replay: 20261010T0257-add-country: matches its recorded schema
replay: 20261010T0257-events-by-id: replaying
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
CREATE MATERIALIZED VIEW `yodel_18_shop`.`events__chant_dual` TO `yodel_18_shop`.`events__chant_new` AS SELECT `id`, `kind`, `at`, `country` FROM `yodel_18_shop`.`events` WHERE `at` >= toDateTime64('2026-10-10 03:01:16.000', 3, 'UTC') COMMENT 'chant rebuild of yodel_18_shop.events: rows at or after the cut-over [chant managed-by=chant rebuild=yodel_18_shop.events role=dual cutover=2026-10-10T03%3A01%3A16.000Z]'
-- waiting 61s for the cut-over at 2026-10-10T03:01:16.000Z
-- waiting 51s for the cut-over at 2026-10-10T03:01:16.000Z
-- waiting 41s for the cut-over at 2026-10-10T03:01:16.000Z
-- waiting 31s for the cut-over at 2026-10-10T03:01:16.000Z
-- waiting 21s for the cut-over at 2026-10-10T03:01:16.000Z
-- waiting 11s for the cut-over at 2026-10-10T03:01:16.000Z
-- waiting 1s for the cut-over at 2026-10-10T03:01:16.000Z
-- backfill of yodel_18_shop.events: 0 partition(s), 0 copied, 0 already copied, 0 cleared first
-- yodel_18_shop.events: 0 partition(s), 0 row(s) (0 of them before the cut-over at 2026-10-10T03:01:16.000Z), counts and checksums equal in the old and new tables
EXCHANGE TABLES `yodel_18_shop`.`events` AND `yodel_18_shop`.`events__chant_new`
DROP VIEW `yodel_18_shop`.`events__chant_dual` SYNC
RENAME TABLE `yodel_18_shop`.`events__chant_new` TO `yodel_18_shop`.`events__chant_old`
ALTER TABLE `yodel_18_shop`.`events__chant_old` MODIFY COMMENT 'chant rebuild of yodel_18_shop.events: the old table, kept until 2026-10-17T03:01:16.162Z [chant managed-by=chant rebuild=yodel_18_shop.events role=old retain-until=2026-10-17T03%3A01%3A16.162Z]'
ALTER TABLE `yodel_18_shop`.`events` MODIFY COMMENT '[chant managed-by=chant]'
replay: 20261010T0257-events-by-id: matches its recorded schema
replay: 20261010T0259-fill-country: replaying
replay: 20261010T0259-fill-country: matches its recorded schema
replay: 20261010T0259-add-source: replaying
replay: 20261010T0259-add-source: matches its recorded schema
Replay of 5 migrations (clickhouse) into http://192.168.14.189:8123 (sql.profiles.replay)
  databases: yodel_18_shop (emptied first)
  ok      20261010T0257-baseline (2 statements)
  ok      20261010T0257-add-country (1 statement)
  ok      20261010T0257-events-by-id (0 statements; ran step 0: ClickHouseRebuildOp for events (yodel_18_shop.events) (swapped))
  ok      20261010T0259-fill-country (0 statements; skipped step 0: backfill backfill.ts (moves data; the replayed database has none))
  ok      20261010T0259-add-source (1 statement)
Every migration replays to its recorded schema.

20261010T0257-events-by-id
  silenced ch-rebuild: step 0: ClickHouseRebuildOp rebuilds yodel_18_shop.events: every row is copied into a new table and swapped in, for SQLCH220 Change the sorting key (orderBy)
           reason: 600 rows; the copy takes seconds

5 migrations: 0 errors, 0 warnings, 1 silenced.
```
