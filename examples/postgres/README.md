# Postgres example

A Postgres schema taken from the declarative path to versioned migrations: adoption with `yodel init --from`, lint findings and a silence, a migration that fails part way and resumes, a column rename run as a `PostgresMigrationOp` step, two branches that fork the history (rebase, repair, out of order), drift, and the replay check. Every command below ran against the emulator (`chant emulator up --lexicon sql`), and the output under each is what it printed. `examples/walkthrough/postgres.ts` holds the steps; `npx tsx examples/walkthrough/run.ts postgres --write` runs them again and rewrites this file and the project files from the run.

The project in this directory is what the walkthrough leaves: `src/schema.ts`, the migrations it wrote, and the two Ops.

To run it yourself, from a clone of this repository:

```sh
npm ci && npm run build          # in the repository root
chant emulator up --lexicon sql  # or any Postgres you can drop schema shop on
cd examples/postgres
npm install                      # @intentius/sql-yodeler from file:../.., this clone
export DEV_POSTGRES_URL=postgres://127.0.0.1:5432/postgres DEV_POSTGRES_USER=postgres DEV_POSTGRES_PASSWORD=...
```

The example's `package.json` takes `@intentius/sql-yodeler` from `file:../..`, the clone it sits in, so it runs the yodel you just built rather than the release on npm. A project of your own installs it from npm instead (`npm install @intentius/sql-yodeler`; [Installing](../../docs/configuration.md#installing) has the other routes).

The run happened in a temporary copy of this directory, a git repository with a local `origin`; its path is shown as `<tmp>`. A command that exited with a code other than 0 ends with `[exit <code>]`.

## 1. A declared schema, applied without migrations

The project starts on the declarative path: `src/schema.ts` says what the schema should be, and an `ApplyOp` applies it. There is no `migrations/` directory, so `yodel plan` and `yodel apply` diff the declared schema against the live database. `package.json` has a `build` script (`chant build src --lexicon sql -o dist/schema.json`), which the `ApplyOp` runs first.

`src/schema.ts`:

```ts
import { index, schema, table } from "@intentius/chant-lexicon-sql/postgres";

export const shop = schema`
  CREATE SCHEMA shop;
  COMMENT ON SCHEMA shop IS 'The SQL Yodeler Postgres example'`;

export const orders = table`
  CREATE TABLE ${shop}.orders (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_email text NOT NULL,
    status         text NOT NULL DEFAULT 'placed',
    amount         numeric(12, 2) NOT NULL,
    placed_at      timestamptz NOT NULL DEFAULT now()
  )`;

export const ordersStatus = index`
  CREATE INDEX orders_status_idx ON ${orders} (${orders.columns.status})`;
```

`ops/apply-dev.op.ts`:

```ts
import { ApplyOp } from "@intentius/chant/op";

// The declarative path: yodel apply dev plans src/ against dev and runs this
// Op, behind a gate bound to the plan.
export const { op } = ApplyOp({ name: "apply-dev", env: "dev", target: "postgres", gate: {} });
```

```console
$ npx yodel plan dev
Plan for dev (postgres, sql.profiles.dev)

shop (shop)
  [create] schema: shop
      SQLPG200 Create an object. A new object is created; nothing existing changes. A table created in the same plan as its indexes needs no CONCURRENTLY. https://www.postgresql.org/docs/18/sql-createtable.html
orders (shop.orders)
  [create] table: shop.orders
      SQLPG200 Create an object. A new object is created; nothing existing changes. A table created in the same plan as its indexes needs no CONCURRENTLY. https://www.postgresql.org/docs/18/sql-createtable.html
ordersStatus (shop.orders_status_idx)
  [create] index: shop.orders_status_idx
      SQLPG200 Create an object. A new object is created; nothing existing changes. A table created in the same plan as its indexes needs no CONCURRENTLY. https://www.postgresql.org/docs/18/sql-createtable.html

3 create
```

`yodel apply dev` stops at the `ApplyOp`'s gate, which wants an approval of this exact plan, and exits 3:

```console
$ npx yodel apply dev
Plan for dev (postgres, sql.profiles.dev)

shop (shop)
  [create] schema: shop
      SQLPG200 Create an object. A new object is created; nothing existing changes. A table created in the same plan as its indexes needs no CONCURRENTLY. https://www.postgresql.org/docs/18/sql-createtable.html
orders (shop.orders)
  [create] table: shop.orders
      SQLPG200 Create an object. A new object is created; nothing existing changes. A table created in the same plan as its indexes needs no CONCURRENTLY. https://www.postgresql.org/docs/18/sql-createtable.html
ordersStatus (shop.orders_status_idx)
  [create] index: shop.orders_status_idx
      SQLPG200 Create an object. A new object is created; nothing existing changes. A table created in the same plan as its indexes needs no CONCURRENTLY. https://www.postgresql.org/docs/18/sql-createtable.html

3 create

Running apply-dev (<tmp>/postgres/ops/apply-dev.op.ts)

> sql-yodeler-example-postgres@0.0.0 build
> chant build src --lexicon sql -o dist/schema.json


fold: 1 file folded, 0 ran
warning: [orders] orders.customer_email looks like a secret or personal data and neither it nor shop.orders has a COMMENT; say what it holds and how it is protected (sql)

sql — environment: dev
3 missing, 0 orphan, 0 disappeared, 0 newly observed, 0 drifted, 0 unchanged
--------------------------------------------------------------------------------

MISSING (declared, provider reports not in cloud):
  - orders [queried postgres://127.0.0.1:5432/postgres shop.orders] [definition 8ed6b02691e26ed92625e85a760b47f0f94b8463ed8c03907e1084493bf25fdb]
  - ordersStatus [queried postgres://127.0.0.1:5432/postgres shop.orders_status_idx] [definition 43817c370f4f1f919210c38167fc87d9d14321d22c0a7f97446d54ed4e6a91b3]
  - shop [queried postgres://127.0.0.1:5432/postgres shop] [definition 15cd10e0615ca05c24a8ce682bbd997c7486fce45e30dce04bdd9887f7da0f06]
[phase] Build
  ✓ chantBuild(path=.)   1.4s
[phase] Plan
  ✓ lifecycleDiff(env=dev, live=true)   1.4s
    [outcome] Drift=true
[phase] Approve
  • gate:approve-apply-dev()   skipped
[phase] Apply
  • nativeApply(target=postgres, env=dev, output=dist/schema.json, deleteMode=never)   skipped
Op "apply-dev" is gated on "approve-apply-dev" after 5.0s
  Approve apply to dev (delete mode: never)
  plan    : jcs1-sha256:6c5f32d5c2462c62193c80e3063c26376476d51dcd60d54f281fe80a443187f3
  approve : chant approve apply-dev approve-apply-dev --plan jcs1-sha256:6c5f32d5c2462c62193c80e3063c26376476d51dcd60d54f281fe80a443187f3
  expires : 2026-10-12T04:42:18.829Z

apply-dev is waiting at gate "approve-apply-dev" for approval of this plan.
Approve it with:
  chant approve apply-dev approve-apply-dev --plan jcs1-sha256:6c5f32d5c2462c62193c80e3063c26376476d51dcd60d54f281fe80a443187f3
then run yodel apply dev again.
[exit 3]
```

```console
$ npx chant approve apply-dev approve-apply-dev --plan jcs1-sha256:6c5f32d5c2462c62193c80e3063c26376476d51dcd60d54f281fe80a443187f3
Gate "approve-apply-dev" on "apply-dev" resolved by yodel at 2026-10-10T04:42:24.242Z
This approves the plan jcs1-sha256:6c5f32d5c2462c62193c80e3063c26376476d51dcd60d54f281fe80a443187f3, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run apply-dev` and it walks through gate "approve-apply-dev".
```

```console
$ npx yodel apply dev
Plan for dev (postgres, sql.profiles.dev)

shop (shop)
  [create] schema: shop
      SQLPG200 Create an object. A new object is created; nothing existing changes. A table created in the same plan as its indexes needs no CONCURRENTLY. https://www.postgresql.org/docs/18/sql-createtable.html
orders (shop.orders)
  [create] table: shop.orders
      SQLPG200 Create an object. A new object is created; nothing existing changes. A table created in the same plan as its indexes needs no CONCURRENTLY. https://www.postgresql.org/docs/18/sql-createtable.html
ordersStatus (shop.orders_status_idx)
  [create] index: shop.orders_status_idx
      SQLPG200 Create an object. A new object is created; nothing existing changes. A table created in the same plan as its indexes needs no CONCURRENTLY. https://www.postgresql.org/docs/18/sql-createtable.html

3 create

Running apply-dev (<tmp>/postgres/ops/apply-dev.op.ts)

> sql-yodeler-example-postgres@0.0.0 build
> chant build src --lexicon sql -o dist/schema.json


fold: 1 file folded, 0 ran
warning: [orders] orders.customer_email looks like a secret or personal data and neither it nor shop.orders has a COMMENT; say what it holds and how it is protected (sql)

sql — environment: dev
3 missing, 0 orphan, 0 disappeared, 0 newly observed, 0 drifted, 0 unchanged
--------------------------------------------------------------------------------

MISSING (declared, provider reports not in cloud):
  - orders [queried postgres://127.0.0.1:5432/postgres shop.orders] [definition 8ed6b02691e26ed92625e85a760b47f0f94b8463ed8c03907e1084493bf25fdb]
  - ordersStatus [queried postgres://127.0.0.1:5432/postgres shop.orders_status_idx] [definition 43817c370f4f1f919210c38167fc87d9d14321d22c0a7f97446d54ed4e6a91b3]
  - shop [queried postgres://127.0.0.1:5432/postgres shop] [definition 15cd10e0615ca05c24a8ce682bbd997c7486fce45e30dce04bdd9887f7da0f06]
BEGIN
SET LOCAL lock_timeout = '5000ms'
SET LOCAL statement_timeout = '60000ms'
CREATE SCHEMA shop
SET LOCAL lock_timeout = '5000ms'
SET LOCAL statement_timeout = '60000ms'
COMMENT ON SCHEMA shop IS 'The SQL Yodeler Postgres example [chant managed-by=chant]'
SET LOCAL lock_timeout = '5000ms'
SET LOCAL statement_timeout = '60000ms'
CREATE TABLE shop.orders (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_email text NOT NULL,
    status         text NOT NULL DEFAULT 'placed',
    amount         numeric(12, 2) NOT NULL,
    placed_at      timestamptz NOT NULL DEFAULT now()
  )
SET LOCAL lock_timeout = '5000ms'
SET LOCAL statement_timeout = '60000ms'
COMMENT ON TABLE shop.orders IS '[chant managed-by=chant]'
SET LOCAL lock_timeout = '5000ms'
SET LOCAL statement_timeout = '60000ms'
CREATE INDEX orders_status_idx ON shop.orders (status)
SET LOCAL lock_timeout = '5000ms'
SET LOCAL statement_timeout = '60000ms'
COMMENT ON INDEX shop.orders_status_idx IS '[chant managed-by=chant]'
COMMIT
created: Postgres::Schema/shop
created: Postgres::Table/shop.orders
created: Postgres::Index/shop.orders_status_idx
[dev] applied 3 resource(s)
[phase] Build
  ✓ chantBuild(path=.)   1.0s
[phase] Plan
  ✓ lifecycleDiff(env=dev, live=true)   1.2s
    [outcome] Drift=true
[phase] Approve
  ✓ gate:approve-apply-dev()   326ms
    [approved] yodel at 2026-10-10T04:42:24.242Z
[phase] Apply
  ✓ nativeApply(target=postgres, env=dev, output=dist/schema.json, deleteMode=never)   89ms
Op "apply-dev" completed in 2.9s

Applied: dev matches the declared schema.
```

## 2. Adopting the schema into versioned migrations

Orders arrive, one of them a free sample with an amount of 0:

```sql
INSERT INTO shop.orders (customer_email, status, amount, placed_at)
SELECT 'customer' || (n % 40) || '@example.com', (ARRAY['placed', 'paid', 'shipped'])[n % 3 + 1], (n * 7 % 500) + 0.99, timestamptz '2026-06-01' + n * interval '5 hours'
FROM generate_series(1, 300) AS n;
INSERT INTO shop.orders (customer_email, amount) VALUES ('sample@example.com', 0)
```

`yodel init --from dev` reads the live schema, writes its declarations to `src/`, checks they plan clean, writes the baseline migration and records it applied in dev's history without running it. `--force` because `src/schema.ts` is already there:

```console
$ npx yodel init --from dev --force
read 3 object(s) from dev
wrote src/schema.ts
planned against dev: no change
wrote migrations/20261010T0442-baseline (6 statements)
recorded 20261010T0442-baseline applied in yodeler.history as a baseline; none of its statements was run
Adopted dev (postgres): 3 objects
  Schema shop
  Table shop.orders
  Index shop.orders_status_idx

Declarations: src/schema.ts
Baseline:     migrations/20261010T0442-baseline/ (6 statements, sha256:2714434c56c34640b526d084365866742f765113afc9f6a29e9cad33085d8d07)
Recorded:     applied in yodeler.history as a baseline; none of its statements was run

yodel plan dev shows no change, and yodel status dev lists the baseline applied.
```

`src/schema.ts`:

```ts
import { index, schema, table } from "@intentius/chant-lexicon-sql/postgres";

export const shopSchema = schema`
  CREATE SCHEMA shop;
  COMMENT ON SCHEMA shop IS 'The SQL Yodeler Postgres example'`;

export const orders = table`
  CREATE TABLE ${shopSchema}.orders (
      id bigint GENERATED ALWAYS AS IDENTITY,
      customer_email text NOT NULL,
      status text DEFAULT 'placed'::text NOT NULL,
      amount numeric(12,2) NOT NULL,
      placed_at timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT orders_pkey PRIMARY KEY (id)
  )`;

export const ordersStatusIdx = index`
  CREATE INDEX orders_status_idx ON ${orders} USING btree (status)`;
```

```console
$ npx yodel status dev
Migrations in dev (history yodeler.history)

Applied (1):
  20261010T0442-baseline  2026-10-10 04:42:32.772462 by yodel@example

Pending: none
```

The versioned path runs a migrations Op, so `ops/apply-dev.op.ts` gives way to `ops/migrate-dev.op.ts`:

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

## 3. Lint catches a full-table lock

Add a column and a CHECK constraint:

`src/schema.ts` now:

```ts
import { index, schema, table } from "@intentius/chant-lexicon-sql/postgres";

export const shopSchema = schema`
  CREATE SCHEMA shop;
  COMMENT ON SCHEMA shop IS 'The SQL Yodeler Postgres example'`;

export const orders = table`
  CREATE TABLE ${shopSchema}.orders (
      id bigint GENERATED ALWAYS AS IDENTITY,
      customer_email text NOT NULL,
      status text DEFAULT 'placed'::text NOT NULL,
      amount numeric(12,2) NOT NULL,
      placed_at timestamp with time zone DEFAULT now() NOT NULL,
      coupon text,
      CONSTRAINT orders_pkey PRIMARY KEY (id),
      CONSTRAINT orders_amount_positive CHECK (amount > 0)
  )`;

export const ordersStatusIdx = index`
  CREATE INDEX orders_status_idx ON ${orders} USING btree (status)`;
```

```console
$ npx yodel new coupons
Wrote migrations/20261010T0442-coupons/ (2 statements; follows 20261010T0442-baseline)
```

<!-- quote: postgres#pg-rewrite -->
```console
$ npx yodel lint
20261010T0442-coupons
  error    pg-rewrite: step 1: SQLPG218 Add a CHECK constraint on shop.orders: blocks reads and writes on the table while it runs (ADD CONSTRAINT ... CHECK reads every row under ACCESS EXCLUSIVE. Declare it NOT VALID, then remove NOT VALID to validate it under SHARE UPDATE EXCLUSIVE (SQLPG220).)

A statement rule can be silenced for one statement, with a reason the history records when it applies:
  a line `-- yodel:allow <rule> <reason>` above the statement in migration.sql

2 migrations: 1 error, 0 warnings, 0 silenced.
[exit 3]
```

Do as the finding says: delete the migration, declare the constraint `NOT VALID`, and write it again:

```console
$ rm -r migrations/20261010T0442-coupons
```

```console
$ npx yodel new coupons
Wrote migrations/20261010T0442-coupons/ (2 statements; follows 20261010T0442-baseline)
```

`migrations/20261010T0442-coupons/migration.sql`:

```sql
-- yodel migration 20261010T0442-coupons
-- parent: 20261010T0442-baseline

-- orders (shop.orders): SQLPG201 metadata
ALTER TABLE shop.orders ADD COLUMN coupon text;

-- orders (shop.orders): SQLPG217 metadata
ALTER TABLE shop.orders ADD CONSTRAINT orders_amount_positive CHECK (amount > 0) NOT VALID;
```

```console
$ npx yodel lint
2 migrations: 0 errors, 0 warnings, 0 silenced.
```

```console
$ npx yodel plan dev
Plan for dev (postgres, history yodeler.history): 1 applied, 1 pending

20261010T0442-coupons
  0  statement  SQLPG201 metadata  shop.orders
       ALTER TABLE shop.orders ADD COLUMN coupon text
  1  statement  SQLPG217 metadata  shop.orders
       ALTER TABLE shop.orders ADD CONSTRAINT orders_amount_positive CHECK (amount > 0) NOT VALID

Plan digest: jcs1-sha256:4cd860945b53e7ee8d5fec63b9e325d8a554d6de3d06bd4346fbc967b949f9ba
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:4cd860945b53e7ee8d5fec63b9e325d8a554d6de3d06bd4346fbc967b949f9ba

Not approved yet. Approving binds exactly this digest; if anything it covers changes before the apply runs, the gate asks again and nothing is applied.
```

```console
$ npx yodel apply dev
Migrations in dev (history yodeler.history)

Applied (1):
  20261010T0442-baseline  2026-10-10 04:42:32.772462 by yodel@example

Pending (1):
  20261010T0442-coupons

Plan digest: jcs1-sha256:4cd860945b53e7ee8d5fec63b9e325d8a554d6de3d06bd4346fbc967b949f9ba

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   2.6s
[phase] Approve
  • gate:approve-migrate-dev()   skipped
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 3.5s
  plan    : jcs1-sha256:4cd860945b53e7ee8d5fec63b9e325d8a554d6de3d06bd4346fbc967b949f9ba
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:4cd860945b53e7ee8d5fec63b9e325d8a554d6de3d06bd4346fbc967b949f9ba
  expires : 2026-10-12T04:42:46.908Z

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:4cd860945b53e7ee8d5fec63b9e325d8a554d6de3d06bd4346fbc967b949f9ba).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:4cd860945b53e7ee8d5fec63b9e325d8a554d6de3d06bd4346fbc967b949f9ba
then run yodel apply dev again.
[exit 3]
```

```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:4cd860945b53e7ee8d5fec63b9e325d8a554d6de3d06bd4346fbc967b949f9ba
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-10T04:42:49.691Z
This approves the plan jcs1-sha256:4cd860945b53e7ee8d5fec63b9e325d8a554d6de3d06bd4346fbc967b949f9ba, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

On Postgres the apply lock is an advisory lock:

```console
$ npx yodel apply dev
Migrations in dev (history yodeler.history)

Applied (1):
  20261010T0442-baseline  2026-10-10 04:42:32.772462 by yodel@example

Pending (1):
  20261010T0442-coupons

Plan digest: jcs1-sha256:4cd860945b53e7ee8d5fec63b9e325d8a554d6de3d06bd4346fbc967b949f9ba

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
lock: held in Postgres advisory lock (1498367052, 748638931) for history schema yodeler
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:4cd860945b53e7ee8d5fec63b9e325d8a554d6de3d06bd4346fbc967b949f9ba, by yodel at 2026-10-10T04:42:49.691Z
20261010T0442-coupons: applying
  statement 0: ok (SQLPG201 metadata, shop.orders)
  statement 1: ok (SQLPG217 metadata, shop.orders)
20261010T0442-coupons: applied

[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   1.2s
[phase] Approve
  ✓ gate:approve-migrate-dev()   282ms
    [approved] yodel at 2026-10-10T04:42:49.691Z
[phase] Apply
  ✓ shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":"jcs1-sha256:4cd860945b53e7ee8d5fec63b9e325d8a554d6de3d06bd4346fbc967b949f9ba"})   1.8s
Op "migrate-dev" completed in 3.5s

Applied: 20261010T0442-coupons.
```

## 4. A migration that fails part way, and resumes

Validate the constraint, and add a column in the same migration:

`src/schema.ts` now:

```ts
import { index, schema, table } from "@intentius/chant-lexicon-sql/postgres";

export const shopSchema = schema`
  CREATE SCHEMA shop;
  COMMENT ON SCHEMA shop IS 'The SQL Yodeler Postgres example'`;

export const orders = table`
  CREATE TABLE ${shopSchema}.orders (
      id bigint GENERATED ALWAYS AS IDENTITY,
      customer_email text NOT NULL,
      status text DEFAULT 'placed'::text NOT NULL,
      amount numeric(12,2) NOT NULL,
      placed_at timestamp with time zone DEFAULT now() NOT NULL,
      coupon text,
      refunded_at timestamp with time zone,
      CONSTRAINT orders_pkey PRIMARY KEY (id),
      CONSTRAINT orders_amount_positive CHECK (amount > 0)
  )`;

export const ordersStatusIdx = index`
  CREATE INDEX orders_status_idx ON ${orders} USING btree (status)`;
```

```console
$ npx yodel new validate-amount
Wrote migrations/20261010T0442-validate-amount/ (2 statements; follows 20261010T0442-coupons)
```

`migrations/20261010T0442-validate-amount/migration.sql`:

```sql
-- yodel migration 20261010T0442-validate-amount
-- parent: 20261010T0442-coupons

-- orders (shop.orders): SQLPG201 metadata
ALTER TABLE shop.orders ADD COLUMN refunded_at timestamp with time zone;

-- orders (shop.orders): SQLPG220 validate
ALTER TABLE shop.orders VALIDATE CONSTRAINT orders_amount_positive;
```

```console
$ npx yodel apply dev
Migrations in dev (history yodeler.history)

Applied (2):
  20261010T0442-baseline  2026-10-10 04:42:32.772462 by yodel@example
  20261010T0442-coupons  2026-10-10 04:42:54.377216 by yodel@example

Pending (1):
  20261010T0442-validate-amount

Plan digest: jcs1-sha256:9c8a619b8bbc105fc465cc4ecf64abe12642552ccedd521191015509bf3cb826

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   923ms
[phase] Approve
  • gate:approve-migrate-dev()   skipped
    [refused] Gate "approve-migrate-dev" is approved, but not for this plan. approved: jcs1-sha256:4cd860945b53e7ee8d5fec63b9e325d8a554d6de3d06bd4346fbc967b949f9ba (by yodel at 2026-10-10T04:42:49.691Z); planned: jcs1-sha256:9c8a619b8bbc105fc465cc4ecf64abe12642552ccedd521191015509bf3cb826. The configuration or the live system changed between that approval and this plan, so it needs a fresh one: chant approve migrate-dev approve-migrate-dev
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 1.7s
  plan    : jcs1-sha256:9c8a619b8bbc105fc465cc4ecf64abe12642552ccedd521191015509bf3cb826
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:9c8a619b8bbc105fc465cc4ecf64abe12642552ccedd521191015509bf3cb826
  expires : 2026-10-12T04:42:59.045Z

Nothing was applied. The approval of jcs1-sha256:4cd860945b53e7ee8d5fec63b9e325d8a554d6de3d06bd4346fbc967b949f9ba (by yodel at 2026-10-10T04:42:49.691Z) does not hold: the plan moved since. What moved, as far as yodel can tell: history changed: applied since: 20261010T0442-coupons (by yodel@example at 2026-10-10 04:42:54.377216); pending migrations changed: committed to since approval: 20261010T0442-validate-amount (41acca8 at 2026-10-09T22:42:56-06:00); live schema changed: no state yodel can rebuild from the history and git hashes to the approved digest with today's live schema, so an object in the environment's live schema (a table, view, index, dictionary, database or schema) changed since approval (or a part yodel cannot rebuild did).

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:9c8a619b8bbc105fc465cc4ecf64abe12642552ccedd521191015509bf3cb826).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:9c8a619b8bbc105fc465cc4ecf64abe12642552ccedd521191015509bf3cb826
then run yodel apply dev again.
[exit 3]
```

```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:9c8a619b8bbc105fc465cc4ecf64abe12642552ccedd521191015509bf3cb826
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-10T04:43:01.447Z
This approves the plan jcs1-sha256:9c8a619b8bbc105fc465cc4ecf64abe12642552ccedd521191015509bf3cb826, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

The free sample breaks the constraint. Statement 0 ran and is recorded; statement 1 failed:

<!-- quote: postgres#failed -->
```console
$ npx yodel apply dev
Migrations in dev (history yodeler.history)

Applied (2):
  20261010T0442-baseline  2026-10-10 04:42:32.772462 by yodel@example
  20261010T0442-coupons  2026-10-10 04:42:54.377216 by yodel@example

Pending (1):
  20261010T0442-validate-amount

Plan digest: jcs1-sha256:9c8a619b8bbc105fc465cc4ecf64abe12642552ccedd521191015509bf3cb826

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   1.0s
[phase] Approve
  ✓ gate:approve-migrate-dev()   214ms
    [approved] yodel at 2026-10-10T04:43:01.447Z
[phase] Apply
  ✗ shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":"jcs1-sha256:9c8a619b8bbc105fc465cc4ecf64abe12642552ccedd521191015509bf3cb826"})   1.1s
    command exited 1 (expected 0): Command failed: yodel apply dev --execute
lock: held in Postgres advisory lock (1498367052, 748638931) for history schema yodeler
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:9c8a619b8bbc105fc465cc4ecf64abe12642552ccedd521191015509bf3cb826, by yodel at 2026-10-10T04:43:01.447Z
20261010T0442-validate-amount: applying
  statement 0: ok (SQLPG201 metadata, shop.orders)
  statement 1: failed: check constraint "orders_amount_positive" of relation "orders" is violated by some row
yodel apply: 20261010T0442-validate-amount failed at statement 1: check constraint "orders_amount_positive" of relation "orders" is violated by some row
Fix the cause (on the server, or that statement in the migration's files), then run yodel apply again: it resumes at statement 1 and never sends again the statements that succeeded.

Op "migrate-dev" failed after 2.5s
yodel apply: chant run migrate-dev failed (exit 1)

Migrations in dev (history yodeler.history)

Applied (2):
  20261010T0442-baseline  2026-10-10 04:42:32.772462 by yodel@example
  20261010T0442-coupons  2026-10-10 04:42:54.377216 by yodel@example

Pending (1):
  20261010T0442-validate-amount  (failed part way at statement 1; resumes at statement 1)
      error: statement 1: check constraint "orders_amount_positive" of relation "orders" is violated by some row

Plan digest: jcs1-sha256:bcf22ee48f757e0c502c100f72dfbf50ded56df449dce5e7e91f471b94462aca
[exit 1]
```

<!-- quote: postgres#failed-status -->
```console
$ npx yodel status dev
Migrations in dev (history yodeler.history)

Applied (2):
  20261010T0442-baseline  2026-10-10 04:42:32.772462 by yodel@example
  20261010T0442-coupons  2026-10-10 04:42:54.377216 by yodel@example

Pending (1):
  20261010T0442-validate-amount  (failed part way at statement 1; resumes at statement 1)
      error: statement 1: check constraint "orders_amount_positive" of relation "orders" is violated by some row

Plan digest: jcs1-sha256:bcf22ee48f757e0c502c100f72dfbf50ded56df449dce5e7e91f471b94462aca
[exit 3]
```

Fix the data. The history changed since the approval (statement 0 ran), so the digest moved and the gate asks again:

```sql
UPDATE shop.orders SET amount = 0.01 WHERE amount <= 0
```

```console
$ npx yodel apply dev
Migrations in dev (history yodeler.history)

Applied (2):
  20261010T0442-baseline  2026-10-10 04:42:32.772462 by yodel@example
  20261010T0442-coupons  2026-10-10 04:42:54.377216 by yodel@example

Pending (1):
  20261010T0442-validate-amount  (failed part way at statement 1; resumes at statement 1)
      error: statement 1: check constraint "orders_amount_positive" of relation "orders" is violated by some row

Plan digest: jcs1-sha256:bcf22ee48f757e0c502c100f72dfbf50ded56df449dce5e7e91f471b94462aca

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   949ms
[phase] Approve
  • gate:approve-migrate-dev()   skipped
    [refused] Gate "approve-migrate-dev" is approved, but not for this plan. approved: jcs1-sha256:9c8a619b8bbc105fc465cc4ecf64abe12642552ccedd521191015509bf3cb826 (by yodel at 2026-10-10T04:43:01.447Z); planned: jcs1-sha256:bcf22ee48f757e0c502c100f72dfbf50ded56df449dce5e7e91f471b94462aca. The configuration or the live system changed between that approval and this plan, so it needs a fresh one: chant approve migrate-dev approve-migrate-dev
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 1.8s
  plan    : jcs1-sha256:bcf22ee48f757e0c502c100f72dfbf50ded56df449dce5e7e91f471b94462aca
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:bcf22ee48f757e0c502c100f72dfbf50ded56df449dce5e7e91f471b94462aca
  expires : 2026-10-12T04:43:08.815Z

Nothing was applied. The approval of jcs1-sha256:9c8a619b8bbc105fc465cc4ecf64abe12642552ccedd521191015509bf3cb826 (by yodel at 2026-10-10T04:43:01.447Z) does not hold: the plan moved since. What moved, as far as yodel can tell: history changed: 20261010T0442-validate-amount ran part way since: statements 0 done now; live schema changed: no state yodel can rebuild from the history and git hashes to the approved digest with today's live schema, so an object in the environment's live schema (a table, view, index, dictionary, database or schema) changed since approval (or a part yodel cannot rebuild did).

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:bcf22ee48f757e0c502c100f72dfbf50ded56df449dce5e7e91f471b94462aca).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:bcf22ee48f757e0c502c100f72dfbf50ded56df449dce5e7e91f471b94462aca
then run yodel apply dev again.
[exit 3]
```

```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:bcf22ee48f757e0c502c100f72dfbf50ded56df449dce5e7e91f471b94462aca
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-10T04:43:11.157Z
This approves the plan jcs1-sha256:bcf22ee48f757e0c502c100f72dfbf50ded56df449dce5e7e91f471b94462aca, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

<!-- quote: postgres#resumed -->
```console
$ npx yodel apply dev
Migrations in dev (history yodeler.history)

Applied (2):
  20261010T0442-baseline  2026-10-10 04:42:32.772462 by yodel@example
  20261010T0442-coupons  2026-10-10 04:42:54.377216 by yodel@example

Pending (1):
  20261010T0442-validate-amount  (failed part way at statement 1; resumes at statement 1)
      error: statement 1: check constraint "orders_amount_positive" of relation "orders" is violated by some row

Plan digest: jcs1-sha256:bcf22ee48f757e0c502c100f72dfbf50ded56df449dce5e7e91f471b94462aca

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
lock: held in Postgres advisory lock (1498367052, 748638931) for history schema yodeler
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:bcf22ee48f757e0c502c100f72dfbf50ded56df449dce5e7e91f471b94462aca, by yodel at 2026-10-10T04:43:11.157Z
20261010T0442-validate-amount: resuming at statement 1
  statement 0: succeeded in an earlier run; not sent
  statement 1: ok (SQLPG220 validate, shop.orders)
20261010T0442-validate-amount: applied

[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   897ms
[phase] Approve
  ✓ gate:approve-migrate-dev()   200ms
    [approved] yodel at 2026-10-10T04:43:11.157Z
[phase] Apply
  ✓ shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":"jcs1-sha256:bcf22ee48f757e0c502c100f72dfbf50ded56df449dce5e7e91f471b94462aca"})   1.0s
Op "migrate-dev" completed in 2.3s

Applied: 20261010T0442-validate-amount.
```

## 5. A column rename: a PostgresMigrationOp step

Renaming `customer_email` to `email` in place would break every reader still using the old name. Declare the new name with `-- previously: <old name>` on its line, and `yodel new` writes the change as a `PostgresMigrationOp` step: add the new column, keep both written with a trigger, backfill, verify, switch, and drop the old column. The new name stays where the old one was declared:

`yodel new` cannot tell a rename from a dropped column and an added one unless the declaration says so. Without the line, the change is a manual step, with a hint:

<!-- quote: postgres#rename-hint -->
```console
$ npx yodel new rename-email
Wrote migrations/20261010T0443-rename-email/ (0 statements; follows 20261010T0442-validate-amount)
  This migration contains a manual step: orders (shop.orders), SQLPG203, SQLPG204. No statement and no Op makes it:
    shop.orders needs expand and contract, which no in-place statement makes, so nothing was sent for it. SQLPG203 Add a NOT NULL column with no default (columns.email - -> email text): ADD COLUMN ... NOT NULL with no default fails on a table that has rows. Add it nullable, backfill it, then set NOT NULL. https://www.postgresql.org/docs/18/sql-altertable.html No migration Op makes this change yet: make it by hand as expand and contract (add the new, write both, backfill, move readers, then drop the old).
  hint: orders: customer_email is dropped and email added with the same type in the same place; if it is a rename, write -- previously: customer_email on its line
```

```console
$ rm -r migrations/20261010T0443-rename-email
```

With the line:

`src/schema.ts` now:

```ts
import { index, schema, table } from "@intentius/chant-lexicon-sql/postgres";

export const shopSchema = schema`
  CREATE SCHEMA shop;
  COMMENT ON SCHEMA shop IS 'The SQL Yodeler Postgres example'`;

export const orders = table`
  CREATE TABLE ${shopSchema}.orders (
      id bigint GENERATED ALWAYS AS IDENTITY,
      email text NOT NULL, -- previously: customer_email
      status text DEFAULT 'placed'::text NOT NULL,
      amount numeric(12,2) NOT NULL,
      placed_at timestamp with time zone DEFAULT now() NOT NULL,
      coupon text,
      refunded_at timestamp with time zone,
      CONSTRAINT orders_pkey PRIMARY KEY (id),
      CONSTRAINT orders_amount_positive CHECK (amount > 0)
  )`;

export const ordersStatusIdx = index`
  CREATE INDEX orders_status_idx ON ${orders} USING btree (status)`;
```

<!-- quote: postgres#rename-new -->
```console
$ npx yodel new rename-email
Wrote migrations/20261010T0443-rename-email/ (0 statements; follows 20261010T0442-validate-amount)
  This migration contains an Op step: PostgresMigrationOp for orders (shop.orders), SQLPG205.
    It is not SQL. migration.json holds the Op's declaration:
    export const { op } = PostgresMigrationOp({ name: "migrate-shop-orders-email", env: "<env>", table: "shop.orders", column: "email" });
```

`migrations/20261010T0443-rename-email/migration.sql`:

<!-- quote: postgres#rename-sql -->
```sql
-- yodel migration 20261010T0443-rename-email
-- parent: 20261010T0442-validate-amount
-- This migration contains an Op step, not only SQL:
--   PostgresMigrationOp for orders (shop.orders), SQLPG205: not SQL; migration.json holds its declaration

-- orders (shop.orders): SQLPG205 made by PostgresMigrationOp, not a statement:
--   export const { op } = PostgresMigrationOp({ name: "migrate-shop-orders-email", env: "<env>", table: "shop.orders", column: "email" });
```

`src/schema.ts` and the newest migration now agree, so a second `yodel new` writes nothing:

<!-- quote: postgres#new-check -->
```console
$ npx yodel new check
No changes: the declared schema matches the newest migration's recorded schema (20261010T0443-rename-email). Nothing written.
```

```console
$ npx yodel plan dev
Plan for dev (postgres, history yodeler.history): 3 applied, 1 pending

20261010T0443-rename-email
  0  Op PostgresMigrationOp  SQLPG205 expand  shop.orders
       shop.orders needs expand and contract, which no in-place statement makes, so nothing was sent for it. SQLPG205 Rename a column (columns.email customer_email -> email): RENAME COLUMN is a catalog change, but every reader still using the old name fails the moment it runs: add the new column, write both, move readers, drop the old. https://www.postgresql.org/docs/18/sql-altertable.html Run it as the expand-and-contract migration Op: PostgresMigrationOp({ table: "shop.orders", column: "email", ... }) from @intentius/chant-lexicon-sql/postgres (add the new column, write both, backfill, switch readers, then drop the old).
       yodel apply runs it as this step

Plan digest: jcs1-sha256:04127b524e81abdb0b801bd3e1ae914cf2e56d055c1dd0d634b75ad000a41e0d
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:04127b524e81abdb0b801bd3e1ae914cf2e56d055c1dd0d634b75ad000a41e0d

The newest approval of approve-migrate-dev, by yodel at 2026-10-10T04:43:11.157Z, is for jcs1-sha256:bcf22ee48f757e0c502c100f72dfbf50ded56df449dce5e7e91f471b94462aca, not this plan; it does not hold.
What moved (as far as yodel can tell): history changed: applied since: 20261010T0442-validate-amount (by yodel@example at 2026-10-10 04:43:14.954814); live schema changed: no state yodel can rebuild from the history and git hashes to the approved digest with today's live schema, so an object in the environment's live schema (a table, view, index, dictionary, database or schema) changed since approval (or a part yodel cannot rebuild did).
```

```console
$ npx yodel apply dev
Migrations in dev (history yodeler.history)

Applied (3):
  20261010T0442-baseline  2026-10-10 04:42:32.772462 by yodel@example
  20261010T0442-coupons  2026-10-10 04:42:54.377216 by yodel@example
  20261010T0442-validate-amount  2026-10-10 04:43:14.954814 by yodel@example

Pending (1):
  20261010T0443-rename-email  (step 0: PostgresMigrationOp for orders (shop.orders))

Plan digest: jcs1-sha256:04127b524e81abdb0b801bd3e1ae914cf2e56d055c1dd0d634b75ad000a41e0d

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   930ms
[phase] Approve
  • gate:approve-migrate-dev()   skipped
    [refused] Gate "approve-migrate-dev" is approved, but not for this plan. approved: jcs1-sha256:bcf22ee48f757e0c502c100f72dfbf50ded56df449dce5e7e91f471b94462aca (by yodel at 2026-10-10T04:43:11.157Z); planned: jcs1-sha256:04127b524e81abdb0b801bd3e1ae914cf2e56d055c1dd0d634b75ad000a41e0d. The configuration or the live system changed between that approval and this plan, so it needs a fresh one: chant approve migrate-dev approve-migrate-dev
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 1.7s
  plan    : jcs1-sha256:04127b524e81abdb0b801bd3e1ae914cf2e56d055c1dd0d634b75ad000a41e0d
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:04127b524e81abdb0b801bd3e1ae914cf2e56d055c1dd0d634b75ad000a41e0d
  expires : 2026-10-12T04:43:23.061Z

Nothing was applied. The approval of jcs1-sha256:bcf22ee48f757e0c502c100f72dfbf50ded56df449dce5e7e91f471b94462aca (by yodel at 2026-10-10T04:43:11.157Z) does not hold: the plan moved since. What moved, as far as yodel can tell: history changed: applied since: 20261010T0442-validate-amount (by yodel@example at 2026-10-10 04:43:14.954814); pending migrations changed: committed to since approval: 20261010T0443-rename-email (93467bf at 2026-10-09T22:43:20-06:00); live schema changed: no state yodel can rebuild from the history and git hashes to the approved digest with today's live schema, so an object in the environment's live schema (a table, view, index, dictionary, database or schema) changed since approval (or a part yodel cannot rebuild did).

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:04127b524e81abdb0b801bd3e1ae914cf2e56d055c1dd0d634b75ad000a41e0d).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:04127b524e81abdb0b801bd3e1ae914cf2e56d055c1dd0d634b75ad000a41e0d
then run yodel apply dev again.
[exit 3]
```

```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:04127b524e81abdb0b801bd3e1ae914cf2e56d055c1dd0d634b75ad000a41e0d
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-10T04:43:25.333Z
This approves the plan jcs1-sha256:04127b524e81abdb0b801bd3e1ae914cf2e56d055c1dd0d634b75ad000a41e0d, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

<!-- quote: postgres#rename-apply -->
```console
$ npx yodel apply dev
Migrations in dev (history yodeler.history)

Applied (3):
  20261010T0442-baseline  2026-10-10 04:42:32.772462 by yodel@example
  20261010T0442-coupons  2026-10-10 04:42:54.377216 by yodel@example
  20261010T0442-validate-amount  2026-10-10 04:43:14.954814 by yodel@example

Pending (1):
  20261010T0443-rename-email  (step 0: PostgresMigrationOp for orders (shop.orders))

Plan digest: jcs1-sha256:04127b524e81abdb0b801bd3e1ae914cf2e56d055c1dd0d634b75ad000a41e0d

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
lock: held in Postgres advisory lock (1498367052, 748638931) for history schema yodeler
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:04127b524e81abdb0b801bd3e1ae914cf2e56d055c1dd0d634b75ad000a41e0d, by yodel at 2026-10-10T04:43:25.333Z
20261010T0443-rename-email: applying
  step 0: PostgresMigrationOp for orders (shop.orders)
  step 0: ok {"op":"PostgresMigrationOp","table":"shop.orders","column":"email","state":"migrate","change":"rename","filled":1,"skipped":0,"backfilledRows":301,"carried":0,"verifiedRows":301,"switched":true,"oldColumn":"shop.orders.customer_email","retainUntil":"2026-10-10T04:43:29.545Z","dropped":true}
20261010T0443-rename-email: applied

[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   936ms
[phase] Approve
  ✓ gate:approve-migrate-dev()   211ms
    [approved] yodel at 2026-10-10T04:43:25.333Z
[phase] Apply
  ✓ shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":"jcs1-sha256:04127b524e81abdb0b801bd3e1ae914cf2e56d055c1dd0d634b75ad000a41e0d"})   2.2s
Op "migrate-dev" completed in 3.5s

Applied: 20261010T0443-rename-email.
```

The expand added `email` at the end of the table, and Postgres has no `ALTER` that moves a column, so the live order is not the declared one. Drift compares the columns by name, so that is not drift:

```sql
SELECT string_agg(column_name, ', ' ORDER BY ordinal_position) AS live_columns FROM information_schema.columns WHERE table_schema = 'shop' AND table_name = 'orders'
```

```
live_columns
id, status, amount, placed_at, coupon, refunded_at, email
```

```console
$ npx yodel drift dev
Drift in dev

No drift: every declared object matches the server.
```

## 6. A destructive change, silenced with a reason

```console
$ npx yodel new drop-coupon
Wrote migrations/20261010T0443-drop-coupon/ (1 statement; follows 20261010T0443-rename-email)
```

<!-- quote: postgres#destructive -->
```console
$ npx yodel lint
20261010T0443-drop-coupon
  error    destructive: step 0: SQLPG204 Drop a column on shop.orders: removes data that cannot be recovered

A statement rule can be silenced for one statement, with a reason the history records when it applies:
  a line `-- yodel:allow <rule> <reason>` above the statement in migration.sql

5 migrations: 1 error, 0 warnings, 0 silenced.
[exit 3]
```

Nothing ever wrote a coupon. Say so above the statement:

`migrations/20261010T0443-drop-coupon/migration.sql` now:

<!-- quote: postgres#silence-sql -->
```sql
-- yodel migration 20261010T0443-drop-coupon
-- parent: 20261010T0443-rename-email

-- orders (shop.orders): SQLPG204 metadata, destructive
-- yodel:allow destructive no order ever had a coupon; checked on dev
ALTER TABLE shop.orders DROP COLUMN coupon;
```

<!-- quote: postgres#update-checksum -->
```console
$ npx yodel lint --update-checksum 20261010T0443-drop-coupon
20261010T0443-drop-coupon: checksum sha256:44ea94e36fb3bc45e6f483173097ddbe78a783f87c65de8177e481a84f15934b is now sha256:35d19c96b7a8de6eb8ba35da68a63ee33555cb8719b92be23955c1d12b504878
20261010T0443-drop-coupon
  silenced destructive: step 0: SQLPG204 Drop a column on shop.orders: removes data that cannot be recovered
           reason: no order ever had a coupon; checked on dev

5 migrations: 0 errors, 0 warnings, 1 silenced.
```

The pull request comment (`yodel plan dev --comment` in CI) is this Markdown:

````console
$ npx yodel plan dev --format markdown
<!-- yodel:plan env=dev -->
### yodel plan: `dev`

Postgres, history `yodeler.history`: 4 applied, **1 pending**.

#### `20261010T0443-drop-coupon`

| # | Step | Rule | Class | Object |
|---|---|---|---|---|
| 0 | statement | SQLPG204 | metadata, destructive | `shop.orders` |

<details><summary>Statements (1)</summary>

```sql
-- 0: SQLPG204 metadata, shop.orders
ALTER TABLE shop.orders DROP COLUMN coupon;
```

</details>

#### Approval

Plan digest the apply gate binds: `jcs1-sha256:58ac52bc46ac260e0ce28b881126cb00ddfdaa6af7fe6d32c96154ba35987d6c`

Approve it with:

```sh
chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:58ac52bc46ac260e0ce28b881126cb00ddfdaa6af7fe6d32c96154ba35987d6c
```

The newest approval of `approve-migrate-dev`, by yodel at 2026-10-10T04:43:25.333Z, is for `jcs1-sha256:04127b524e81abdb0b801bd3e1ae914cf2e56d055c1dd0d634b75ad000a41e0d`, not this plan; it does not hold.
What moved (as far as yodel can tell): history changed: applied since: 20261010T0443-rename-email (by yodel@example at 2026-10-10 04:43:29.626167); pending migrations changed: committed to since approval: 20261010T0443-drop-coupon (11167dc at 2026-10-09T22:43:34-06:00); live schema changed: no state yodel can rebuild from the history and git hashes to the approved digest with today's live schema, so an object in the environment's live schema (a table, view, index, dictionary, database or schema) changed since approval (or a part yodel cannot rebuild did).

<!-- yodel:subject eyJlbnZpcm9ubWVudCI6ImRldiIsImhpc3RvcnlEYXRhYmFzZSI6InlvZGVsZXIiLCJ0b3BvbG9neSI6eyJraW5kIjoic2luZ2xlIn0sImFwcGxpZWQiOlt7ImlkIjoiMjAyNjEwMTBUMDQ0Mi1iYXNlbGluZSIsImNoZWNrc3VtIjoic2hhMjU2OjI3MTQ0MzRjNTZjMzQ2NDBiNTI2ZDA4NDM2NTg2Njc0MmY3NjUxMTNhZmM5ZjZhMjllOWNhZDMzMDg1ZDhkMDcifSx7ImlkIjoiMjAyNjEwMTBUMDQ0Mi1jb3Vwb25zIiwiY2hlY2tzdW0iOiJzaGEyNTY6ZGZjNmNlN2Q0ZDYzZjU3MzY4ZTE1N2VkYmQ0YjNiNDRjYjBiZGYwOGUzNDgzODM2NmFjMjcwMTFkNWFkMjI3MyJ9LHsiaWQiOiIyMDI2MTAxMFQwNDQyLXZhbGlkYXRlLWFtb3VudCIsImNoZWNrc3VtIjoic2hhMjU2OjU3ZGVjZGJkNTE4NWIyMzE0MmNhN2I0ODYzOTgwNzY4YzNiNmRiNjEwOTcyZDg5MmY3OTNmNDJhYWMzMjQxOTcifSx7ImlkIjoiMjAyNjEwMTBUMDQ0My1yZW5hbWUtZW1haWwiLCJjaGVja3N1bSI6InNoYTI1Njo4ZWI2NDJjNDhiNjIyZGUwNWQ3NTAwZmI5YzdmZWZjZTk4MDljOTAwMmJhNTIzZjUwNjBlY2Y2YTE4NmYzM2U2In1dLCJwZW5kaW5nIjpbeyJpZCI6IjIwMjYxMDEwVDA0NDMtZHJvcC1jb3Vwb24iLCJjaGVja3N1bSI6InNoYTI1NjozNWQxOWM5NmI3YThkZTZlYjhiYTM1ZGE2OGE2M2VlMzM1NTVjYjg3MTliOTJiZTIzOTU1YzFkMTJiNTA0ODc4IiwiZG9uZSI6W119XSwibGl2ZSI6InNoYTI1NjpmMmIwMTE3Zjc3ZmFmZGI0MzBmNGMzNzc1MjcxNTMzODVhNDQzMTZiMTQwYzhkZTA0NzMzMTc5YTQ2ZDUzOWE5In0 -->
````

```console
$ npx yodel apply dev
Migrations in dev (history yodeler.history)

Applied (4):
  20261010T0442-baseline  2026-10-10 04:42:32.772462 by yodel@example
  20261010T0442-coupons  2026-10-10 04:42:54.377216 by yodel@example
  20261010T0442-validate-amount  2026-10-10 04:43:14.954814 by yodel@example
  20261010T0443-rename-email  2026-10-10 04:43:29.626167 by yodel@example

Pending (1):
  20261010T0443-drop-coupon

Plan digest: jcs1-sha256:58ac52bc46ac260e0ce28b881126cb00ddfdaa6af7fe6d32c96154ba35987d6c

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   896ms
[phase] Approve
  • gate:approve-migrate-dev()   skipped
    [refused] Gate "approve-migrate-dev" is approved, but not for this plan. approved: jcs1-sha256:04127b524e81abdb0b801bd3e1ae914cf2e56d055c1dd0d634b75ad000a41e0d (by yodel at 2026-10-10T04:43:25.333Z); planned: jcs1-sha256:58ac52bc46ac260e0ce28b881126cb00ddfdaa6af7fe6d32c96154ba35987d6c. The configuration or the live system changed between that approval and this plan, so it needs a fresh one: chant approve migrate-dev approve-migrate-dev
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 1.7s
  plan    : jcs1-sha256:58ac52bc46ac260e0ce28b881126cb00ddfdaa6af7fe6d32c96154ba35987d6c
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:58ac52bc46ac260e0ce28b881126cb00ddfdaa6af7fe6d32c96154ba35987d6c
  expires : 2026-10-12T04:43:38.067Z

Nothing was applied. The approval of jcs1-sha256:04127b524e81abdb0b801bd3e1ae914cf2e56d055c1dd0d634b75ad000a41e0d (by yodel at 2026-10-10T04:43:25.333Z) does not hold: the plan moved since. What moved, as far as yodel can tell: history changed: applied since: 20261010T0443-rename-email (by yodel@example at 2026-10-10 04:43:29.626167); pending migrations changed: committed to since approval: 20261010T0443-drop-coupon (11167dc at 2026-10-09T22:43:34-06:00); live schema changed: no state yodel can rebuild from the history and git hashes to the approved digest with today's live schema, so an object in the environment's live schema (a table, view, index, dictionary, database or schema) changed since approval (or a part yodel cannot rebuild did).

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:58ac52bc46ac260e0ce28b881126cb00ddfdaa6af7fe6d32c96154ba35987d6c).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:58ac52bc46ac260e0ce28b881126cb00ddfdaa6af7fe6d32c96154ba35987d6c
then run yodel apply dev again.
[exit 3]
```

```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:58ac52bc46ac260e0ce28b881126cb00ddfdaa6af7fe6d32c96154ba35987d6c
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-10T04:43:40.541Z
This approves the plan jcs1-sha256:58ac52bc46ac260e0ce28b881126cb00ddfdaa6af7fe6d32c96154ba35987d6c, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

```console
$ npx yodel apply dev
Migrations in dev (history yodeler.history)

Applied (4):
  20261010T0442-baseline  2026-10-10 04:42:32.772462 by yodel@example
  20261010T0442-coupons  2026-10-10 04:42:54.377216 by yodel@example
  20261010T0442-validate-amount  2026-10-10 04:43:14.954814 by yodel@example
  20261010T0443-rename-email  2026-10-10 04:43:29.626167 by yodel@example

Pending (1):
  20261010T0443-drop-coupon

Plan digest: jcs1-sha256:58ac52bc46ac260e0ce28b881126cb00ddfdaa6af7fe6d32c96154ba35987d6c

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
lock: held in Postgres advisory lock (1498367052, 748638931) for history schema yodeler
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:58ac52bc46ac260e0ce28b881126cb00ddfdaa6af7fe6d32c96154ba35987d6c, by yodel at 2026-10-10T04:43:40.541Z
20261010T0443-drop-coupon: applying
  statement 0: ok (SQLPG204 metadata, shop.orders)
20261010T0443-drop-coupon: applied

[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   858ms
[phase] Approve
  ✓ gate:approve-migrate-dev()   188ms
    [approved] yodel at 2026-10-10T04:43:40.541Z
[phase] Apply
  ✓ shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":"jcs1-sha256:58ac52bc46ac260e0ce28b881126cb00ddfdaa6af7fe6d32c96154ba35987d6c"})   1.0s
Op "migrate-dev" completed in 2.2s

Applied: 20261010T0443-drop-coupon.
```

Every history row the migration wrote records the silence:

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

## 7. Two branches, a fork, a rebase and a repair

Two changes are made on two branches. The first adds a column:

```console
$ git switch -q -c gift
```

```console
$ npx yodel new add-gift
Wrote migrations/20261010T0443-add-gift/ (1 statement; follows 20261010T0443-drop-coupon)
```

```console
$ git add -A && git commit -q -m 'feat: orders.gift' && git switch -q main
```

The second, from main, adds an index:

```console
$ git switch -q -c placed-at-index
```

```console
$ npx yodel new index-placed-at
Wrote migrations/20261010T0443-index-placed-at/ (2 statements; follows 20261010T0443-drop-coupon)
```

<!-- quote: postgres#pg-lock -->
```console
$ npx yodel lint
20261010T0443-drop-coupon
  silenced destructive: step 0: SQLPG204 Drop a column on shop.orders: removes data that cannot be recovered
           reason: no order ever had a coupon; checked on dev

20261010T0443-index-placed-at
  error    pg-lock: step 0: SQLPG241 Create an index without CONCURRENTLY on shop.orders_placed_at_idx: builds an index without CONCURRENTLY: SHARE on the table, blocking every write until the build ends; declare the index CONCURRENTLY

A statement rule can be silenced for one statement, with a reason the history records when it applies:
  a line `-- yodel:allow <rule> <reason>` above the statement in migration.sql

6 migrations: 1 error, 0 warnings, 1 silenced.
[exit 3]
```

```console
$ rm -r migrations/20261010T0443-index-placed-at
```

`src/schema.ts` now:

```ts
import { index, schema, table } from "@intentius/chant-lexicon-sql/postgres";

export const shopSchema = schema`
  CREATE SCHEMA shop;
  COMMENT ON SCHEMA shop IS 'The SQL Yodeler Postgres example'`;

export const orders = table`
  CREATE TABLE ${shopSchema}.orders (
      id bigint GENERATED ALWAYS AS IDENTITY,
      email text NOT NULL, -- previously: customer_email
      status text DEFAULT 'placed'::text NOT NULL,
      amount numeric(12,2) NOT NULL,
      placed_at timestamp with time zone DEFAULT now() NOT NULL,
      refunded_at timestamp with time zone,
      CONSTRAINT orders_pkey PRIMARY KEY (id),
      CONSTRAINT orders_amount_positive CHECK (amount > 0)
  )`;

export const ordersStatusIdx = index`
  CREATE INDEX orders_status_idx ON ${orders} USING btree (status)`;

export const ordersPlacedAt = index`
  CREATE INDEX CONCURRENTLY orders_placed_at_idx ON ${orders} (placed_at)`;
```

```console
$ npx yodel new index-placed-at
Wrote migrations/20261010T0443-index-placed-at/ (2 statements; follows 20261010T0443-drop-coupon)
```

`migrations/20261010T0443-index-placed-at/migration.sql`:

```sql
-- yodel migration 20261010T0443-index-placed-at
-- parent: 20261010T0443-drop-coupon

-- ordersPlacedAt (shop.orders_placed_at_idx): SQLPG240 concurrently, outside a transaction
CREATE INDEX CONCURRENTLY orders_placed_at_idx ON shop.orders (placed_at);

-- ordersPlacedAt (shop.orders_placed_at_idx): SQLPG240 concurrently
COMMENT ON INDEX shop.orders_placed_at_idx IS '[chant managed-by=chant]';
```

```console
$ npx yodel lint
20261010T0443-drop-coupon
  silenced destructive: step 0: SQLPG204 Drop a column on shop.orders: removes data that cannot be recovered
           reason: no order ever had a coupon; checked on dev

6 migrations: 0 errors, 0 warnings, 1 silenced.
```

```console
$ git add -A && git commit -q -m 'feat: index orders by placed_at'
```

Someone applies the index branch to dev to try it:

```console
$ npx yodel apply dev
Migrations in dev (history yodeler.history)

Applied (5):
  20261010T0442-baseline  2026-10-10 04:42:32.772462 by yodel@example
  20261010T0442-coupons  2026-10-10 04:42:54.377216 by yodel@example
  20261010T0442-validate-amount  2026-10-10 04:43:14.954814 by yodel@example
  20261010T0443-rename-email  2026-10-10 04:43:29.626167 by yodel@example
  20261010T0443-drop-coupon  2026-10-10 04:43:44.185649 by yodel@example

Pending (1):
  20261010T0443-index-placed-at

Plan digest: jcs1-sha256:dc284a1c7fc0398f271c96ba71563c0e8b884d8d487bcb206f0a13dcd60e25f2

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   952ms
[phase] Approve
  • gate:approve-migrate-dev()   skipped
    [refused] Gate "approve-migrate-dev" is approved, but not for this plan. approved: jcs1-sha256:58ac52bc46ac260e0ce28b881126cb00ddfdaa6af7fe6d32c96154ba35987d6c (by yodel at 2026-10-10T04:43:40.541Z); planned: jcs1-sha256:dc284a1c7fc0398f271c96ba71563c0e8b884d8d487bcb206f0a13dcd60e25f2. The configuration or the live system changed between that approval and this plan, so it needs a fresh one: chant approve migrate-dev approve-migrate-dev
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 1.7s
  plan    : jcs1-sha256:dc284a1c7fc0398f271c96ba71563c0e8b884d8d487bcb206f0a13dcd60e25f2
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:dc284a1c7fc0398f271c96ba71563c0e8b884d8d487bcb206f0a13dcd60e25f2
  expires : 2026-10-12T04:43:52.155Z

Nothing was applied. The approval of jcs1-sha256:58ac52bc46ac260e0ce28b881126cb00ddfdaa6af7fe6d32c96154ba35987d6c (by yodel at 2026-10-10T04:43:40.541Z) does not hold: the plan moved since. What moved, as far as yodel can tell: history changed: applied since: 20261010T0443-drop-coupon (by yodel@example at 2026-10-10 04:43:44.185649); pending migrations changed: committed to since approval: 20261010T0443-index-placed-at (5f4d056 at 2026-10-09T22:43:49-06:00); live schema changed: no state yodel can rebuild from the history and git hashes to the approved digest with today's live schema, so an object in the environment's live schema (a table, view, index, dictionary, database or schema) changed since approval (or a part yodel cannot rebuild did).

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:dc284a1c7fc0398f271c96ba71563c0e8b884d8d487bcb206f0a13dcd60e25f2).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:dc284a1c7fc0398f271c96ba71563c0e8b884d8d487bcb206f0a13dcd60e25f2
then run yodel apply dev again.
[exit 3]
```

```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:dc284a1c7fc0398f271c96ba71563c0e8b884d8d487bcb206f0a13dcd60e25f2
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-10T04:43:54.673Z
This approves the plan jcs1-sha256:dc284a1c7fc0398f271c96ba71563c0e8b884d8d487bcb206f0a13dcd60e25f2, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

```console
$ npx yodel apply dev
Migrations in dev (history yodeler.history)

Applied (5):
  20261010T0442-baseline  2026-10-10 04:42:32.772462 by yodel@example
  20261010T0442-coupons  2026-10-10 04:42:54.377216 by yodel@example
  20261010T0442-validate-amount  2026-10-10 04:43:14.954814 by yodel@example
  20261010T0443-rename-email  2026-10-10 04:43:29.626167 by yodel@example
  20261010T0443-drop-coupon  2026-10-10 04:43:44.185649 by yodel@example

Pending (1):
  20261010T0443-index-placed-at

Plan digest: jcs1-sha256:dc284a1c7fc0398f271c96ba71563c0e8b884d8d487bcb206f0a13dcd60e25f2

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
lock: held in Postgres advisory lock (1498367052, 748638931) for history schema yodeler
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:dc284a1c7fc0398f271c96ba71563c0e8b884d8d487bcb206f0a13dcd60e25f2, by yodel at 2026-10-10T04:43:54.673Z
20261010T0443-index-placed-at: applying
  statement 0: ok (SQLPG240 concurrently, shop.orders_placed_at_idx)
  statement 1: ok (SQLPG240 concurrently, shop.orders_placed_at_idx)
20261010T0443-index-placed-at: applied

[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   846ms
[phase] Approve
  ✓ gate:approve-migrate-dev()   197ms
    [approved] yodel at 2026-10-10T04:43:54.673Z
[phase] Apply
  ✓ shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":"jcs1-sha256:dc284a1c7fc0398f271c96ba71563c0e8b884d8d487bcb206f0a13dcd60e25f2"})   1.0s
Op "migrate-dev" completed in 2.2s

Applied: 20261010T0443-index-placed-at.
```

Both branches merge. Each migration follows `drop-coupon`, so the history forks, and lint says so:

```console
$ git switch -q main && git merge -q --no-edit gift && git merge -q --no-edit placed-at-index
Auto-merging src/schema.ts
```

<!-- quote: postgres#fork -->
```console
$ npx yodel lint
migrations/
  error    fork: fork: 20261010T0443-add-gift and 20261010T0443-index-placed-at both follow 20261010T0443-drop-coupon; rebase one onto the other

20261010T0443-drop-coupon
  silenced destructive: step 0: SQLPG204 Drop a column on shop.orders: removes data that cannot be recovered
           reason: no order ever had a coupon; checked on dev

7 migrations: 1 error, 0 warnings, 1 silenced.
[exit 3]
```

`yodel rebase` moves one migration onto the other and writes its statements and recorded schema again. With `--env dev` it reads dev's history first, and refuses to move a migration that ran there:

<!-- quote: postgres#rebase-refused -->
```console
$ npx yodel rebase 20261010T0443-index-placed-at --onto 20261010T0443-add-gift --env dev
yodel rebase: refused: dev's history records 20261010T0443-index-placed-at (applied). Nothing was written. A migration that ran is never rebased: its statements already ran in that order. Rebase the other branch onto it instead (yodel rebase <the other> --onto <the end of this one>).
[exit 4]
```

The clean fix is the one it names: move `add-gift` after `index-placed-at`. To show what yodel does when a migration that ran is moved anyway (a rebase run without `--env`), this walkthrough moves `index-placed-at`:

<!-- quote: postgres#rebase -->
```console
$ npx yodel rebase 20261010T0443-index-placed-at --onto 20261010T0443-add-gift
Rebased 20261010T0443-index-placed-at onto 20261010T0443-add-gift (it followed 20261010T0443-drop-coupon).
  20261010T0443-index-placed-at: follows 20261010T0443-add-gift; 2 statements; checksum sha256:af051aa4ebc4a38c1b6db624bc88021cfc4ba3e6e5537ceab1f0df81556993d9 -> sha256:00832bdc5b8181480fc1a614e12d70388cb5510eb885963b606c81881879ca12
No history was checked (--env): make sure none of these ran anywhere before merging.
```

Its files changed after it ran on dev, so dev's history no longer matches them. `yodel status` and `yodel apply` refuse (exit 4):

```console
$ npx yodel status dev
Migrations in dev (history yodeler.history)

Applied (6):
  20261010T0442-baseline  2026-10-10 04:42:32.772462 by yodel@example
  20261010T0442-coupons  2026-10-10 04:42:54.377216 by yodel@example
  20261010T0442-validate-amount  2026-10-10 04:43:14.954814 by yodel@example
  20261010T0443-rename-email  2026-10-10 04:43:29.626167 by yodel@example
  20261010T0443-drop-coupon  2026-10-10 04:43:44.185649 by yodel@example
  20261010T0443-index-placed-at  2026-10-10 04:43:58.394117 by yodel@example

Pending (1):
  20261010T0443-add-gift  (out of order)

Out of order (1): 20261010T0443-add-gift; apply with --allow-out-of-order

Checksum mismatches (1):
  20261010T0443-index-placed-at was applied with checksum sha256:af051aa4ebc4a38c1b6db624bc88021cfc4ba3e6e5537ceab1f0df81556993d9, but its files now hash to sha256:00832bdc5b8181480fc1a614e12d70388cb5510eb885963b606c81881879ca12; if the edit is intended, record it with yodel repair 20261010T0443-index-placed-at --reason ... <env>
[exit 4]
```

<!-- quote: postgres#checksum-refused -->
```console
$ npx yodel apply dev
yodel apply: refused: the history does not match the migrations directory; nothing was applied:
  20261010T0443-index-placed-at was applied with checksum sha256:af051aa4ebc4a38c1b6db624bc88021cfc4ba3e6e5537ceab1f0df81556993d9, but its files now hash to sha256:00832bdc5b8181480fc1a614e12d70388cb5510eb885963b606c81881879ca12; if the edit is intended, record it with yodel repair 20261010T0443-index-placed-at --reason ... <env>
[exit 4]
```

The edit is intended: its statements are the same, only its parent changed. `yodel repair` records the new checksum, with the reason, in dev's history. Nothing runs on the server:

<!-- quote: postgres#repair -->
```console
$ npx yodel repair 20261010T0443-index-placed-at --reason 'rebased onto add-gift after it ran on dev' dev
Repaired 20261010T0443-index-placed-at in dev's history (yodeler).
  old checksum: sha256:af051aa4ebc4a38c1b6db624bc88021cfc4ba3e6e5537ceab1f0df81556993d9
  new checksum: sha256:00832bdc5b8181480fc1a614e12d70388cb5510eb885963b606c81881879ca12
  reason: rebased onto add-gift after it ran on dev
```

Now `add-gift` comes before a migration dev has applied. It is out of order, and apply refuses it rather than skip it:

```console
$ npx yodel status dev
Migrations in dev (history yodeler.history)

Applied (6):
  20261010T0442-baseline  2026-10-10 04:42:32.772462 by yodel@example
  20261010T0442-coupons  2026-10-10 04:42:54.377216 by yodel@example
  20261010T0442-validate-amount  2026-10-10 04:43:14.954814 by yodel@example
  20261010T0443-rename-email  2026-10-10 04:43:29.626167 by yodel@example
  20261010T0443-drop-coupon  2026-10-10 04:43:44.185649 by yodel@example
  20261010T0443-index-placed-at  2026-10-10 04:43:58.394117 by yodel@example
      repaired 2026-10-10 04:44:03.067699 by yodel@example: rebased onto add-gift after it ran on dev

Pending (1):
  20261010T0443-add-gift  (out of order)

Out of order (1): 20261010T0443-add-gift; apply with --allow-out-of-order
[exit 4]
```

<!-- quote: postgres#out-of-order -->
```console
$ npx yodel apply dev
yodel apply: refused: 20261010T0443-add-gift is out of order: the chain puts it before 20261010T0443-index-placed-at, which is already applied. Nothing was applied. Pass --allow-out-of-order to apply it now (in chain order); it is never skipped.
[exit 4]
```

Adding a column after the index changes nothing the index needs, so apply it out of order:

```console
$ npx yodel apply dev --allow-out-of-order
Migrations in dev (history yodeler.history)

Applied (6):
  20261010T0442-baseline  2026-10-10 04:42:32.772462 by yodel@example
  20261010T0442-coupons  2026-10-10 04:42:54.377216 by yodel@example
  20261010T0442-validate-amount  2026-10-10 04:43:14.954814 by yodel@example
  20261010T0443-rename-email  2026-10-10 04:43:29.626167 by yodel@example
  20261010T0443-drop-coupon  2026-10-10 04:43:44.185649 by yodel@example
  20261010T0443-index-placed-at  2026-10-10 04:43:58.394117 by yodel@example
      repaired 2026-10-10 04:44:03.067699 by yodel@example: rebased onto add-gift after it ran on dev

Pending (1):
  20261010T0443-add-gift  (out of order)

Out of order (1): 20261010T0443-add-gift; apply with --allow-out-of-order

Plan digest: jcs1-sha256:cff4cd946019b414655ac1cbde1fb30a59b8b628429bb3ae15e48e3e9efcbbcd

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   3.1s
[phase] Approve
  • gate:approve-migrate-dev()   skipped
    [refused] Gate "approve-migrate-dev" is approved, but not for this plan. approved: jcs1-sha256:dc284a1c7fc0398f271c96ba71563c0e8b884d8d487bcb206f0a13dcd60e25f2 (by yodel at 2026-10-10T04:43:54.673Z); planned: jcs1-sha256:cff4cd946019b414655ac1cbde1fb30a59b8b628429bb3ae15e48e3e9efcbbcd. The configuration or the live system changed between that approval and this plan, so it needs a fresh one: chant approve migrate-dev approve-migrate-dev
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 4.6s
  plan    : jcs1-sha256:cff4cd946019b414655ac1cbde1fb30a59b8b628429bb3ae15e48e3e9efcbbcd
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:cff4cd946019b414655ac1cbde1fb30a59b8b628429bb3ae15e48e3e9efcbbcd
  expires : 2026-10-12T04:44:10.167Z

Nothing was applied. The approval of jcs1-sha256:dc284a1c7fc0398f271c96ba71563c0e8b884d8d487bcb206f0a13dcd60e25f2 (by yodel at 2026-10-10T04:43:54.673Z) does not hold: the plan moved since. What moved, as far as yodel can tell: history changed: applied since: 20261010T0443-index-placed-at (by yodel@example at 2026-10-10 04:43:58.394117); pending migrations changed: committed to since approval: 20261010T0443-index-placed-at (3b1ee77 at 2026-10-09T22:44:00-06:00); live schema changed: no state yodel can rebuild from the history and git hashes to the approved digest with today's live schema, so an object in the environment's live schema (a table, view, index, dictionary, database or schema) changed since approval (or a part yodel cannot rebuild did).

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:cff4cd946019b414655ac1cbde1fb30a59b8b628429bb3ae15e48e3e9efcbbcd).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:cff4cd946019b414655ac1cbde1fb30a59b8b628429bb3ae15e48e3e9efcbbcd
then run yodel apply dev again.
[exit 3]
```

```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:cff4cd946019b414655ac1cbde1fb30a59b8b628429bb3ae15e48e3e9efcbbcd
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-10T04:44:13.787Z
This approves the plan jcs1-sha256:cff4cd946019b414655ac1cbde1fb30a59b8b628429bb3ae15e48e3e9efcbbcd, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

<!-- quote: postgres#out-of-order-apply -->
```console
$ npx yodel apply dev --allow-out-of-order
Migrations in dev (history yodeler.history)

Applied (6):
  20261010T0442-baseline  2026-10-10 04:42:32.772462 by yodel@example
  20261010T0442-coupons  2026-10-10 04:42:54.377216 by yodel@example
  20261010T0442-validate-amount  2026-10-10 04:43:14.954814 by yodel@example
  20261010T0443-rename-email  2026-10-10 04:43:29.626167 by yodel@example
  20261010T0443-drop-coupon  2026-10-10 04:43:44.185649 by yodel@example
  20261010T0443-index-placed-at  2026-10-10 04:43:58.394117 by yodel@example
      repaired 2026-10-10 04:44:03.067699 by yodel@example: rebased onto add-gift after it ran on dev

Pending (1):
  20261010T0443-add-gift  (out of order)

Out of order (1): 20261010T0443-add-gift; apply with --allow-out-of-order

Plan digest: jcs1-sha256:cff4cd946019b414655ac1cbde1fb30a59b8b628429bb3ae15e48e3e9efcbbcd

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
lock: held in Postgres advisory lock (1498367052, 748638931) for history schema yodeler
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:cff4cd946019b414655ac1cbde1fb30a59b8b628429bb3ae15e48e3e9efcbbcd, by yodel at 2026-10-10T04:44:13.787Z
20261010T0443-add-gift: applying (out of order, allowed)
  statement 0: ok (SQLPG201 metadata, shop.orders)
20261010T0443-add-gift: applied

[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   881ms
[phase] Approve
  ✓ gate:approve-migrate-dev()   244ms
    [approved] yodel at 2026-10-10T04:44:13.787Z
[phase] Apply
  ✓ shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":"jcs1-sha256:cff4cd946019b414655ac1cbde1fb30a59b8b628429bb3ae15e48e3e9efcbbcd"})   1.2s
Op "migrate-dev" completed in 2.5s

Applied: 20261010T0443-add-gift.
```

`yodel status` lists `index-placed-at` as applied when it ran, and the repair under it:

<!-- quote: postgres#status -->
```console
$ npx yodel status dev
Migrations in dev (history yodeler.history)

Applied (7):
  20261010T0442-baseline  2026-10-10 04:42:32.772462 by yodel@example
  20261010T0442-coupons  2026-10-10 04:42:54.377216 by yodel@example
  20261010T0442-validate-amount  2026-10-10 04:43:14.954814 by yodel@example
  20261010T0443-rename-email  2026-10-10 04:43:29.626167 by yodel@example
  20261010T0443-drop-coupon  2026-10-10 04:43:44.185649 by yodel@example
  20261010T0443-add-gift  2026-10-10 04:44:17.785624 by yodel@example
  20261010T0443-index-placed-at  2026-10-10 04:43:58.394117 by yodel@example
      repaired 2026-10-10 04:44:03.067699 by yodel@example: rebased onto add-gift after it ran on dev

Pending: none
```

## 8. Drift

Someone changes a default by hand:

```sql
ALTER TABLE shop.orders ALTER COLUMN status SET DEFAULT 'new'
```

```console
$ npx yodel drift dev
Drift in dev

Changed out of band:
  orders (Postgres::Table)
    columns[2].default: declared 'placed'::text, live 'new'::text
[exit 2]
```

`ops/watch-dev.op.ts` runs the same check as a `WatchOp` on a schedule. Run once by hand:

```console
$ npx chant run watch-dev
Snapshot saved to chant/lifecycle (sql(4))

sql — environment: dev
0 missing, 0 orphan, 0 disappeared, 0 newly observed, 0 drifted, 4 unchanged
--------------------------------------------------------------------------------

sql (properties)
1 property drift across 1 resource(s), 0 accepted, 3 unchanged
--------------------------------------------------------------------------------

PROPERTY DRIFT (declared vs live; baseline shown where one exists):
  - orders (Postgres::Table)
      columns[2].default: 'placed'::text → 'new'::text [from: authored]
[phase] Snapshot
  ✓ lifecycleSnapshot(env=dev)   1.0s
[phase] Diff
  ✓ lifecycleDiff(env=dev, live=true)   771ms
    [outcome] Drift=true
Op "watch-dev" completed in 1.9s
```

`chant run` exits 0 when the watch completes, drift or not; the drift is the run's `Drift` outcome. Put the default back:

```sql
ALTER TABLE shop.orders ALTER COLUMN status SET DEFAULT 'placed'
```

```console
$ npx yodel drift dev
Drift in dev

No drift: every declared object matches the server.
```

## 9. The replay check

`yodel lint --replay replay --reset` replays every migration, in order, into the server the `replay` profile names, and compares each with the schema it recorded. In CI that profile points at a throwaway server the job starts. Here it points at the same emulator as dev, so `--reset` drops dev's schema, and the check runs last:

```console
$ npx yodel lint --replay replay --reset
replay: emptying shop on postgres://127.0.0.1:5432/postgres (sql.profiles.replay)
replay: 20261010T0442-baseline: replaying
replay: 20261010T0442-baseline: matches its recorded schema
replay: 20261010T0442-coupons: replaying
replay: 20261010T0442-coupons: matches its recorded schema
replay: 20261010T0442-validate-amount: replaying
replay: 20261010T0442-validate-amount: matches its recorded schema
replay: 20261010T0443-rename-email: replaying
-- shop.orders.email needs expand and contract (SQLPG205 Rename a column): customer_email renamed to email, batched by id
--   SQLPG205 columns.email: customer_email -> email
ALTER TABLE shop.orders ADD COLUMN email text
COMMENT ON COLUMN shop.orders.email IS 'chant migration of shop.orders.email: the new name of customer_email [chant managed-by=chant migration=shop.orders.email role=new]'
CREATE OR REPLACE FUNCTION shop.orders__email__chant_sync() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $chant$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.email IS NULL THEN NEW.email := NEW.customer_email; ELSE NEW.customer_email := NEW.email; END IF;
  ELSIF NEW.email IS DISTINCT FROM OLD.email THEN
    NEW.customer_email := NEW.email;
  ELSE
    NEW.email := NEW.customer_email;
  END IF;
  RETURN NEW;
END
$chant$
COMMENT ON FUNCTION shop.orders__email__chant_sync() IS 'chant migration of shop.orders.email: keeps the new column written [chant managed-by=chant migration=shop.orders.email role=dual]'
DROP TRIGGER IF EXISTS email__chant_sync ON shop.orders
CREATE TRIGGER email__chant_sync BEFORE INSERT OR UPDATE ON shop.orders FOR EACH ROW EXECUTE FUNCTION shop.orders__email__chant_sync()
COMMENT ON TRIGGER email__chant_sync ON shop.orders IS 'chant migration of shop.orders.email: keeps the new column written [chant managed-by=chant migration=shop.orders.email role=dual]'
-- backfill of shop.orders.email: 0 batch(es), 0 filled (0 row(s)), 0 already filled
SELECT count(*)::text AS rows, count(*) FILTER (WHERE email IS DISTINCT FROM (customer_email))::text AS mismatched,
                count(*) FILTER (WHERE email IS NULL)::text AS nulls,
                COALESCE(sum(pg_catalog.hashtextextended(email::text, 0)), 0)::text AS checksum,
                COALESCE(sum(pg_catalog.hashtextextended((customer_email)::text, 0)), 0)::text AS expected
         FROM shop.orders
-- shop.orders.email: 0 row(s), email equal to customer_email in every one (checksum 0)
ALTER TABLE shop.orders ADD CONSTRAINT email__chant_nn CHECK (email IS NOT NULL) NOT VALID
COMMENT ON CONSTRAINT email__chant_nn ON shop.orders IS 'chant migration of shop.orders.email: proves email NOT NULL [chant managed-by=chant migration=shop.orders.email role=nn]'
ALTER TABLE shop.orders VALIDATE CONSTRAINT email__chant_nn
ALTER TABLE shop.orders ALTER COLUMN email SET NOT NULL
ALTER TABLE shop.orders DROP CONSTRAINT email__chant_nn
COMMENT ON COLUMN shop.orders.email IS NULL
COMMENT ON COLUMN shop.orders.customer_email IS 'chant migration of shop.orders.email: the old name, kept until 2026-10-10T04:44:26.146Z [chant managed-by=chant migration=shop.orders.email role=old retain-until=2026-10-10T04%3A44%3A26.146Z]'
DROP TRIGGER email__chant_sync ON shop.orders
DROP FUNCTION shop.orders__email__chant_sync()
ALTER TABLE shop.orders DROP COLUMN customer_email
replay: 20261010T0443-rename-email: matches its recorded schema
replay: 20261010T0443-drop-coupon: replaying
replay: 20261010T0443-drop-coupon: matches its recorded schema
replay: 20261010T0443-add-gift: replaying
replay: 20261010T0443-add-gift: matches its recorded schema
replay: 20261010T0443-index-placed-at: replaying
replay: 20261010T0443-index-placed-at: matches its recorded schema
Replay of 7 migrations (postgres) into postgres://127.0.0.1:5432/postgres (sql.profiles.replay)
  schemas: shop (emptied first)
  ok      20261010T0442-baseline (6 statements)
  ok      20261010T0442-coupons (2 statements)
  ok      20261010T0442-validate-amount (2 statements)
  ok      20261010T0443-rename-email (0 statements; ran step 0: PostgresMigrationOp for orders (shop.orders) (switched, old column dropped))
  ok      20261010T0443-drop-coupon (1 statement)
  ok      20261010T0443-add-gift (1 statement)
  ok      20261010T0443-index-placed-at (2 statements)
Every migration replays to its recorded schema.

20261010T0443-drop-coupon
  silenced destructive: step 0: SQLPG204 Drop a column on shop.orders: removes data that cannot be recovered
           reason: no order ever had a coupon; checked on dev

7 migrations: 0 errors, 0 warnings, 1 silenced.
```
