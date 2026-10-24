# Postgres example

A Postgres schema taken from the declarative path to versioned migrations: adoption with `yodel init --from`, lint findings and a silence, a migration that fails part way and resumes, a column rename run as a `PostgresMigrationOp` step, two branches that fork the history (rebase, repair, out of order), drift, and the replay check. Every command below ran against the emulator (`chant emulator up --lexicon sql`), and the output under each is what it printed. `examples/walkthrough/postgres.ts` holds the steps; `npx tsx examples/walkthrough/run.ts postgres --write` runs them again and rewrites this file and the project files from the run.

The project in this directory is what the walkthrough leaves: `src/schema.ts`, the migrations it wrote, and the two Ops. It is a finished run, with every migration already written, so running it again does not retrace the steps. To go step by step from an empty directory, start with [Your first migration](../../docs/getting-started.md).

To run it yourself, from a clone of this repository:

```sh
npm ci && npm run build          # in the repository root
npx chant emulator up --lexicon sql  # or any Postgres you can drop schema shop on
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
export const { op: applyDev } = ApplyOp({ name: "apply-dev", env: "dev", target: "postgres", gate: {} });
```

```console
$ npx yodel plan dev
Plan for dev (postgres 18.6 at 127.0.0.1:5432/postgres, sql.profiles.dev)

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

Access control: not managed in dev (off by default); policies, grants, roles and users are not planned.
```

`yodel apply dev` stops at the `ApplyOp`'s gate, which wants an approval of this exact plan, and exits 3:

```console
$ npx yodel apply dev
Plan for dev (postgres 18.6 at 127.0.0.1:5432/postgres, sql.profiles.dev)

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

Access control: not managed in dev (off by default); policies, grants, roles and users are not planned.

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
  ✓ chantBuild(path=.)   786ms
[phase] Plan
  ✓ lifecycleDiff(env=dev, live=true)   794ms
    [outcome] Drift=true
[phase] Approve
  • gate:approve-apply-dev()   skipped
[phase] Apply
  • nativeApply(target=postgres, env=dev, output=dist/schema.json, deleteMode=never)   skipped
Op "apply-dev" is gated on "approve-apply-dev" after 2.2s
  Approve apply to dev (delete mode: never)
  plan    : jcs1-sha256:6c5f32d5c2462c62193c80e3063c26376476d51dcd60d54f281fe80a443187f3
  approve : chant approve apply-dev approve-apply-dev --plan jcs1-sha256:6c5f32d5c2462c62193c80e3063c26376476d51dcd60d54f281fe80a443187f3
  expires : 2026-10-12T17:23:47.280Z

apply-dev is waiting at gate "approve-apply-dev" for approval of this plan.
Approve it with:
  chant approve apply-dev approve-apply-dev --plan jcs1-sha256:6c5f32d5c2462c62193c80e3063c26376476d51dcd60d54f281fe80a443187f3
then run npx yodel apply dev again.
[exit 3]
```

```console
$ npx chant approve apply-dev approve-apply-dev --plan jcs1-sha256:6c5f32d5c2462c62193c80e3063c26376476d51dcd60d54f281fe80a443187f3
Gate "approve-apply-dev" on "apply-dev" resolved by yodel at 2026-10-10T17:23:49.033Z
This approves the plan jcs1-sha256:6c5f32d5c2462c62193c80e3063c26376476d51dcd60d54f281fe80a443187f3, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run apply-dev` and it walks through gate "approve-apply-dev".
```

```console
$ npx yodel apply dev
Plan for dev (postgres 18.6 at 127.0.0.1:5432/postgres, sql.profiles.dev)

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

Access control: not managed in dev (off by default); policies, grants, roles and users are not planned.

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
  ✓ chantBuild(path=.)   755ms
[phase] Plan
  ✓ lifecycleDiff(env=dev, live=true)   788ms
    [outcome] Drift=true
[phase] Approve
  ✓ gate:approve-apply-dev()   210ms
    [approved] yodel at 2026-10-10T17:23:49.033Z
[phase] Apply
  ✓ nativeApply(target=postgres, env=dev, output=dist/schema.json, deleteMode=never)   43ms
Op "apply-dev" completed in 1.9s

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
wrote migrations/20261010T1723-baseline (6 statements)
recorded 20261010T1723-baseline applied in yodeler.history as a baseline; none of its statements was run
Adopted dev (postgres): 3 objects
  Schema shop
  Table shop.orders
  Index shop.orders_status_idx

Declarations: src/schema.ts
Baseline:     migrations/20261010T1723-baseline/ (6 statements, sha256:db30a46ecb470f51b98c5b2a00d1e238f384577b5b84400fea58fb43391dd6af)
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
Migrations in dev (postgres 18.6 at 127.0.0.1:5432/postgres, history yodeler.history)

Applied (1):
  20261010T1723-baseline  2026-10-10 17:23:54.742760 by yodel@example

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

export const migrateDev = Op({
  name: "migrate-dev",
  overview: "Apply the pending migrations to dev, behind an approval bound to their plan digest",
  phases: [
    phase("Plan", [plan]),
    phase("Approve", [gate("approve-migrate-dev", { plan: digest, resume: true })]),
    phase("Apply", [shell("yodel apply dev --execute", { env: { YODEL_APPROVED_PLAN: digest }, timeout: "2h" })]),
  ],
});
```

## 3. A constraint the rows already there break

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

`yodel new` writes the constraint in chant's lock-safe form: added `NOT VALID`, which reads no rows, then validated under SHARE UPDATE EXCLUSIVE, so reads and writes go on. The validation can fail on the rows already there, so the step carries a pre-check counting them:

```console
$ npx yodel new coupons
Wrote migrations/20261010T1723-coupons/ (3 statements; follows 20261010T1723-baseline)
  step 1 can fail on the rows already there (rows that fail the check orders_amount_positive (amount > 0)); yodel apply runs its pre-check precheck-1 before the first statement and refuses unless it returns 0: SELECT count(*) AS n FROM shop.orders WHERE NOT (amount > 0)
```

`migrations/20261010T1723-coupons/migration.sql`:

```sql
-- yodel migration 20261010T1723-coupons
-- parent: 20261010T1723-baseline

-- orders (shop.orders): SQLPG201 metadata
ALTER TABLE shop.orders ADD COLUMN coupon text;

-- orders (shop.orders): SQLPG217 metadata
-- pre-check, must return 0 (rows that fail the check orders_amount_positive (amount > 0)): SELECT count(*) AS n FROM shop.orders WHERE NOT (amount > 0)
ALTER TABLE shop.orders ADD CONSTRAINT orders_amount_positive CHECK (amount > 0) NOT VALID;

-- orders (shop.orders): SQLPG220 validate
ALTER TABLE shop.orders VALIDATE CONSTRAINT orders_amount_positive;
```

<!-- quote: postgres#data-dependent -->
```console
$ npx yodel lint
20261010T1723-baseline
  warning  SQLPG112: step 2: orders.customer_email looks like a secret or personal data and neither it nor shop.orders has a COMMENT; say what it holds and how it is protected

20261010T1723-coupons
  warning  data-dependent: step 1: SQLPG217 Add a constraint NOT VALID on shop.orders: can fail on the rows already there (rows that fail the check orders_amount_positive (amount > 0)); yodel apply runs this pre-check before the migration's first statement and refuses when it is not 0: SELECT count(*) AS n FROM shop.orders WHERE NOT (amount > 0)

2 migrations: 0 errors, 2 warnings, 0 silenced.
```

`yodel apply` runs the pre-check before the gate. The free sample breaks the constraint, so it refuses (exit 4), and nobody is asked to approve a plan that would fail:

<!-- quote: postgres#precheck-refused -->
```console
$ npx yodel apply dev
yodel apply: refused: a pre-migration check of 20261010T1723-coupons failed before the gate. Nothing of 20261010T1723-coupons was applied:
  step 1, ALTER TABLE shop.orders ADD CONSTRAINT orders_amount_positive CHECK (amount > 0) NOT VALID, would fail: 1 rows that fail the check orders_amount_positive (amount > 0) (pre-check precheck-1: SELECT count(*) AS n FROM shop.orders WHERE NOT (amount > 0))
Fix the data, then run yodel apply again; if the check is wrong, edit it in migration.json and run yodel lint --update-checksum 20261010T1723-coupons (the plan digest moves, so the plan is approved again). A statement's pre-check is chant's count of the rows the statement fails on: fix those rows, or change the declaration.
[exit 4]
```

Fix the data, and apply:

```sql
UPDATE shop.orders SET amount = 0.01 WHERE amount <= 0
```

```console
$ npx yodel plan dev
Plan for dev (postgres 18.6 at 127.0.0.1:5432/postgres, history yodeler.history): 1 applied, 1 pending

20261010T1723-coupons
  0  statement  SQLPG201 metadata  shop.orders
       ALTER TABLE shop.orders ADD COLUMN coupon text
  1  statement  SQLPG217 metadata  shop.orders
       ALTER TABLE shop.orders ADD CONSTRAINT orders_amount_positive CHECK (amount > 0) NOT VALID
  2  statement  SQLPG220 validate  shop.orders
       ALTER TABLE shop.orders VALIDATE CONSTRAINT orders_amount_positive
  check precheck-1 (returns a number of at most 0, before the first statement):
       SELECT count(*) AS n FROM shop.orders WHERE NOT (amount > 0)

Plan digest: jcs1-sha256:f634b840e45aff04f0018c2431d8030b39d8669902f258be813883f6630253c5
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:f634b840e45aff04f0018c2431d8030b39d8669902f258be813883f6630253c5
or, at a terminal, with npx yodel approve dev, which shows the plan and asks you first.

Not approved yet. Approving binds exactly this digest; if anything it covers changes before the apply runs, the gate asks again and nothing is applied.
```

```console
$ npx yodel apply dev
Migrations in dev (postgres 18.6 at 127.0.0.1:5432/postgres, history yodeler.history)

Applied (1):
  20261010T1723-baseline  2026-10-10 17:23:54.742760 by yodel@example

Pending (1):
  20261010T1723-coupons

Plan digest: jcs1-sha256:f634b840e45aff04f0018c2431d8030b39d8669902f258be813883f6630253c5
check precheck-1 of 20261010T1723-coupons passed (0); it runs again under the lock before the first statement

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   1.6s
[phase] Approve
  • gate:approve-migrate-dev()   skipped
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 2.2s
  plan    : jcs1-sha256:f634b840e45aff04f0018c2431d8030b39d8669902f258be813883f6630253c5
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:f634b840e45aff04f0018c2431d8030b39d8669902f258be813883f6630253c5
  expires : 2026-10-12T17:24:03.920Z

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:f634b840e45aff04f0018c2431d8030b39d8669902f258be813883f6630253c5).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:f634b840e45aff04f0018c2431d8030b39d8669902f258be813883f6630253c5
or, at a terminal, with npx yodel approve dev, which shows the plan and asks you first;
then run npx yodel apply dev again.
[exit 3]
```

```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:f634b840e45aff04f0018c2431d8030b39d8669902f258be813883f6630253c5
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-10T17:24:05.786Z
This approves the plan jcs1-sha256:f634b840e45aff04f0018c2431d8030b39d8669902f258be813883f6630253c5, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

On Postgres the apply lock is an advisory lock:

```console
$ npx yodel apply dev
Migrations in dev (postgres 18.6 at 127.0.0.1:5432/postgres, history yodeler.history)

Applied (1):
  20261010T1723-baseline  2026-10-10 17:23:54.742760 by yodel@example

Pending (1):
  20261010T1723-coupons

Plan digest: jcs1-sha256:f634b840e45aff04f0018c2431d8030b39d8669902f258be813883f6630253c5
check precheck-1 of 20261010T1723-coupons passed (0); it runs again under the lock before the first statement

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
lock: held in Postgres advisory lock (1498367052, 748638931) for history schema yodeler
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:f634b840e45aff04f0018c2431d8030b39d8669902f258be813883f6630253c5, by yodel at 2026-10-10T17:24:05.786Z
20261010T1723-coupons: check precheck-1 passed (0)
20261010T1723-coupons: applying
  statement 0: ok (SQLPG201 metadata, shop.orders)
  statement 1: ok (SQLPG217 metadata, shop.orders)
  statement 2: ok (SQLPG220 validate, shop.orders)
20261010T1723-coupons: applied

[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   902ms
[phase] Approve
  ✓ gate:approve-migrate-dev()   199ms
    [approved] yodel at 2026-10-10T17:24:05.786Z
[phase] Apply
  ✓ shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":"jcs1-sha256:f634b840e45aff04f0018c2431d8030b39d8669902f258be813883f6630253c5"})   1.6s
Op "migrate-dev" completed in 2.9s

Applied: 20261010T1723-coupons.
```

## 4. A migration that fails part way, and resumes

Add a column, and an index on it, in one migration:

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

export const ordersRefundedAt = index`
  CREATE INDEX CONCURRENTLY orders_refunded_at_idx ON ${orders} (refunded_at)`;
```

```console
$ npx yodel new refunds
Wrote migrations/20261010T1724-refunds/ (3 statements; follows 20261010T1723-coupons)
```

`migrations/20261010T1724-refunds/migration.sql`:

```sql
-- yodel migration 20261010T1724-refunds
-- parent: 20261010T1723-coupons

-- orders (shop.orders): SQLPG201 metadata
ALTER TABLE shop.orders ADD COLUMN refunded_at timestamp with time zone;

-- ordersRefundedAt (shop.orders_refunded_at_idx): SQLPG240 concurrently, outside a transaction
CREATE INDEX CONCURRENTLY orders_refunded_at_idx ON shop.orders (refunded_at);

-- ordersRefundedAt (shop.orders_refunded_at_idx): SQLPG240 concurrently
COMMENT ON INDEX shop.orders_refunded_at_idx IS '[chant managed-by=chant]';
```

```console
$ npx yodel lint
20261010T1723-baseline
  warning  SQLPG112: step 2: orders.customer_email looks like a secret or personal data and neither it nor shop.orders has a COMMENT; say what it holds and how it is protected

20261010T1723-coupons
  warning  data-dependent: step 1: SQLPG217 Add a constraint NOT VALID on shop.orders: can fail on the rows already there (rows that fail the check orders_amount_positive (amount > 0)); yodel apply runs this pre-check before the migration's first statement and refuses when it is not 0: SELECT count(*) AS n FROM shop.orders WHERE NOT (amount > 0)

3 migrations: 0 errors, 2 warnings, 0 silenced.
```

Meanwhile someone trying a query on dev made an index by hand, under the name the migration uses:

```sql
CREATE INDEX orders_refunded_at_idx ON shop.orders (placed_at)
```

```console
$ npx yodel apply dev
Migrations in dev (postgres 18.6 at 127.0.0.1:5432/postgres, history yodeler.history)

Applied (2):
  20261010T1723-baseline  2026-10-10 17:23:54.742760 by yodel@example
  20261010T1723-coupons  2026-10-10 17:24:09.819313 by yodel@example

Pending (1):
  20261010T1724-refunds

Plan digest: jcs1-sha256:b5f00cfef13f9274abb0a096b95bf02bd40883ba91189a20245a3b85e46dedcd

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   927ms
[phase] Approve
  • gate:approve-migrate-dev()   skipped
    [refused] Gate "approve-migrate-dev" is approved, but not for this plan. approved: jcs1-sha256:f634b840e45aff04f0018c2431d8030b39d8669902f258be813883f6630253c5 (by yodel at 2026-10-10T17:24:05.786Z); planned: jcs1-sha256:b5f00cfef13f9274abb0a096b95bf02bd40883ba91189a20245a3b85e46dedcd. The configuration or the live system changed between that approval and this plan, so it needs a fresh one: chant approve migrate-dev approve-migrate-dev
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 1.7s
  plan    : jcs1-sha256:b5f00cfef13f9274abb0a096b95bf02bd40883ba91189a20245a3b85e46dedcd
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:b5f00cfef13f9274abb0a096b95bf02bd40883ba91189a20245a3b85e46dedcd
  expires : 2026-10-12T17:24:15.083Z

Nothing was applied. The approval of jcs1-sha256:f634b840e45aff04f0018c2431d8030b39d8669902f258be813883f6630253c5 (by yodel at 2026-10-10T17:24:05.786Z) does not hold: the plan moved since. What moved, as far as yodel can tell: history changed: applied since: 20261010T1723-coupons (by yodel@example at 2026-10-10 17:24:09.819313); pending migrations changed: committed to since approval: 20261010T1724-refunds (610d641 at 2026-10-10T11:24:12-06:00); live schema changed: as expected after the history change above: applying a migration changes the live schema, and yodel cannot rebuild the live schema as it was at approval, so it cannot confirm that nothing else in it changed.

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:b5f00cfef13f9274abb0a096b95bf02bd40883ba91189a20245a3b85e46dedcd).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:b5f00cfef13f9274abb0a096b95bf02bd40883ba91189a20245a3b85e46dedcd
or, at a terminal, with npx yodel approve dev, which shows the plan and asks you first;
then run npx yodel apply dev again.
[exit 3]
```

```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:b5f00cfef13f9274abb0a096b95bf02bd40883ba91189a20245a3b85e46dedcd
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-10T17:24:17.565Z
This approves the plan jcs1-sha256:b5f00cfef13f9274abb0a096b95bf02bd40883ba91189a20245a3b85e46dedcd, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

Statement 0 ran and is recorded; statement 1 failed on the name:

<!-- quote: postgres#failed -->
```console
$ npx yodel apply dev
Migrations in dev (postgres 18.6 at 127.0.0.1:5432/postgres, history yodeler.history)

Applied (2):
  20261010T1723-baseline  2026-10-10 17:23:54.742760 by yodel@example
  20261010T1723-coupons  2026-10-10 17:24:09.819313 by yodel@example

Pending (1):
  20261010T1724-refunds

Plan digest: jcs1-sha256:b5f00cfef13f9274abb0a096b95bf02bd40883ba91189a20245a3b85e46dedcd

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   891ms
[phase] Approve
  ✓ gate:approve-migrate-dev()   183ms
    [approved] yodel at 2026-10-10T17:24:17.565Z
[phase] Apply
  ✗ shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":"jcs1-sha256:b5f00cfef13f9274abb0a096b95bf02bd40883ba91189a20245a3b85e46dedcd"})   1.6s
    command exited 1 (expected 0): Command failed: yodel apply dev --execute
lock: held in Postgres advisory lock (1498367052, 748638931) for history schema yodeler
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:b5f00cfef13f9274abb0a096b95bf02bd40883ba91189a20245a3b85e46dedcd, by yodel at 2026-10-10T17:24:17.565Z
20261010T1724-refunds: applying
  statement 0: ok (SQLPG201 metadata, shop.orders)
  statement 1: failed: relation "orders_refunded_at_idx" already exists
yodel apply: 20261010T1724-refunds failed at statement 1: relation "orders_refunded_at_idx" already exists
Fix the cause (on the server, or that statement in the migration's files), then run yodel apply again: it resumes at statement 1 and never sends again the statements that succeeded.

Op "migrate-dev" failed after 2.8s
yodel apply: chant run migrate-dev failed (exit 1): its Apply step, yodel apply dev --execute, exited 1

Migrations in dev (postgres 18.6 at 127.0.0.1:5432/postgres, history yodeler.history)

Applied (2):
  20261010T1723-baseline  2026-10-10 17:23:54.742760 by yodel@example
  20261010T1723-coupons  2026-10-10 17:24:09.819313 by yodel@example

Pending (1):
  20261010T1724-refunds  (failed part way at statement 1; resumes at statement 1)
      error: statement 1: relation "orders_refunded_at_idx" already exists

Plan digest: jcs1-sha256:f4538cde31ddae8c82df1d6e19ff46886b6e7ebe9ab0d3c22e24451ed8a52c30
[exit 1]
```

<!-- quote: postgres#failed-status -->
```console
$ npx yodel status dev
Migrations in dev (postgres 18.6 at 127.0.0.1:5432/postgres, history yodeler.history)

Applied (2):
  20261010T1723-baseline  2026-10-10 17:23:54.742760 by yodel@example
  20261010T1723-coupons  2026-10-10 17:24:09.819313 by yodel@example

Pending (1):
  20261010T1724-refunds  (failed part way at statement 1; resumes at statement 1)
      error: statement 1: relation "orders_refunded_at_idx" already exists

Plan digest: jcs1-sha256:f4538cde31ddae8c82df1d6e19ff46886b6e7ebe9ab0d3c22e24451ed8a52c30
[exit 3]
```

Drop the hand-made index. The history changed since the approval (statement 0 ran), so the digest moved and the gate asks again:

```sql
DROP INDEX shop.orders_refunded_at_idx
```

```console
$ npx yodel apply dev
Migrations in dev (postgres 18.6 at 127.0.0.1:5432/postgres, history yodeler.history)

Applied (2):
  20261010T1723-baseline  2026-10-10 17:23:54.742760 by yodel@example
  20261010T1723-coupons  2026-10-10 17:24:09.819313 by yodel@example

Pending (1):
  20261010T1724-refunds  (failed part way at statement 1; resumes at statement 1)
      error: statement 1: relation "orders_refunded_at_idx" already exists

Plan digest: jcs1-sha256:9527e04f668b47281769059b63977f8fafdbbd3bf06b377854aa05273ad5db09

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   901ms
[phase] Approve
  • gate:approve-migrate-dev()   skipped
    [refused] Gate "approve-migrate-dev" is approved, but not for this plan. approved: jcs1-sha256:b5f00cfef13f9274abb0a096b95bf02bd40883ba91189a20245a3b85e46dedcd (by yodel at 2026-10-10T17:24:17.565Z); planned: jcs1-sha256:9527e04f668b47281769059b63977f8fafdbbd3bf06b377854aa05273ad5db09. The configuration or the live system changed between that approval and this plan, so it needs a fresh one: chant approve migrate-dev approve-migrate-dev
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 1.6s
  plan    : jcs1-sha256:9527e04f668b47281769059b63977f8fafdbbd3bf06b377854aa05273ad5db09
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:9527e04f668b47281769059b63977f8fafdbbd3bf06b377854aa05273ad5db09
  expires : 2026-10-12T17:24:25.267Z

Nothing was applied. The approval of jcs1-sha256:b5f00cfef13f9274abb0a096b95bf02bd40883ba91189a20245a3b85e46dedcd (by yodel at 2026-10-10T17:24:17.565Z) does not hold: the plan moved since. What moved, as far as yodel can tell: history changed: 20261010T1724-refunds ran part way since: statements 0 done now; live schema changed: as expected after the history change above: applying a migration changes the live schema, and yodel cannot rebuild the live schema as it was at approval, so it cannot confirm that nothing else in it changed.

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:9527e04f668b47281769059b63977f8fafdbbd3bf06b377854aa05273ad5db09).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:9527e04f668b47281769059b63977f8fafdbbd3bf06b377854aa05273ad5db09
or, at a terminal, with npx yodel approve dev, which shows the plan and asks you first;
then run npx yodel apply dev again.
[exit 3]
```

```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:9527e04f668b47281769059b63977f8fafdbbd3bf06b377854aa05273ad5db09
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-10T17:24:27.531Z
This approves the plan jcs1-sha256:9527e04f668b47281769059b63977f8fafdbbd3bf06b377854aa05273ad5db09, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

<!-- quote: postgres#resumed -->
```console
$ npx yodel apply dev
Migrations in dev (postgres 18.6 at 127.0.0.1:5432/postgres, history yodeler.history)

Applied (2):
  20261010T1723-baseline  2026-10-10 17:23:54.742760 by yodel@example
  20261010T1723-coupons  2026-10-10 17:24:09.819313 by yodel@example

Pending (1):
  20261010T1724-refunds  (failed part way at statement 1; resumes at statement 1)
      error: statement 1: relation "orders_refunded_at_idx" already exists

Plan digest: jcs1-sha256:9527e04f668b47281769059b63977f8fafdbbd3bf06b377854aa05273ad5db09

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
lock: held in Postgres advisory lock (1498367052, 748638931) for history schema yodeler
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:9527e04f668b47281769059b63977f8fafdbbd3bf06b377854aa05273ad5db09, by yodel at 2026-10-10T17:24:27.531Z
20261010T1724-refunds: resuming at statement 1
  statement 0: succeeded in an earlier run; not sent
  statement 1: ok (SQLPG240 concurrently, shop.orders_refunded_at_idx)
  statement 2: ok (SQLPG240 concurrently, shop.orders_refunded_at_idx)
20261010T1724-refunds: applied

[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   921ms
[phase] Approve
  ✓ gate:approve-migrate-dev()   196ms
    [approved] yodel at 2026-10-10T17:24:27.531Z
[phase] Apply
  ✓ shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":"jcs1-sha256:9527e04f668b47281769059b63977f8fafdbbd3bf06b377854aa05273ad5db09"})   1.6s
Op "migrate-dev" completed in 2.9s

Applied: 20261010T1724-refunds.
```

## 5. A column rename: a PostgresMigrationOp step

Renaming `customer_email` to `email` in place would break every reader still using the old name. Declare the new name with `-- previously: <old name>` on its line, and `yodel new` writes the change as a `PostgresMigrationOp` step: add the new column, keep both written with a trigger, backfill, verify, switch, and drop the old column. The new name stays where the old one was declared:

`yodel new` cannot tell a rename from a dropped column and an added one unless the declaration says so. Without the line, the change is a manual step, with a hint:

<!-- quote: postgres#rename-hint -->
```console
$ npx yodel new rename-email
Wrote migrations/20261010T1724-rename-email/ (0 statements; follows 20261010T1724-refunds)
  This migration contains a manual step: orders (shop.orders), SQLPG203, SQLPG204. No statement and no Op makes it:
    shop.orders needs expand and contract, which no in-place statement makes, so nothing was sent for it. SQLPG203 Add a NOT NULL column with no default (columns.email - -> email text): ADD COLUMN ... NOT NULL with no default fails on a table that has rows. Add it nullable, backfill it, then set NOT NULL. https://www.postgresql.org/docs/18/sql-altertable.html No migration Op makes this change yet: make it by hand as expand and contract (add the new, write both, backfill, move readers, then drop the old).
  hint: orders: customer_email is dropped and email added with the same type in the same place; if it is a rename, write -- previously: customer_email on its line
```

```console
$ rm -r migrations/20261010T1724-rename-email
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

export const ordersRefundedAt = index`
  CREATE INDEX CONCURRENTLY orders_refunded_at_idx ON ${orders} (refunded_at)`;
```

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

`migrations/20261010T1724-rename-email/migration.sql`:

<!-- quote: postgres#rename-sql -->
```sql
-- yodel migration 20261010T1724-rename-email
-- parent: 20261010T1724-refunds
-- This migration contains an Op step, not only SQL:
--   PostgresMigrationOp for orders (shop.orders), SQLPG205: not SQL; migration.json holds its declaration

-- orders (shop.orders): SQLPG205 made by PostgresMigrationOp, not a statement:
--   export const { op } = PostgresMigrationOp({ name: "migrate-shop-orders-email", env: "<env>", table: "shop.orders", column: "email" });
```

`src/schema.ts` and the newest migration now agree, so a second `yodel new` writes nothing:

<!-- quote: postgres#new-check -->
```console
$ npx yodel new check
No changes: the declared schema matches the newest migration's recorded schema (20261010T1724-rename-email). Nothing written.
```

```console
$ npx yodel plan dev
Plan for dev (postgres 18.6 at 127.0.0.1:5432/postgres, history yodeler.history): 3 applied, 1 pending

20261010T1724-rename-email
  0  Op PostgresMigrationOp  SQLPG205 expand  shop.orders
       shop.orders needs expand and contract, which no in-place statement makes, so nothing was sent for it. SQLPG205 Rename a column (columns.email customer_email -> email): RENAME COLUMN is a catalog change, but every reader still using the old name fails the moment it runs: add the new column, write both, move readers, drop the old. https://www.postgresql.org/docs/18/sql-altertable.html Run it as the expand-and-contract migration Op: PostgresMigrationOp({ table: "shop.orders", column: "email", ... }) from @intentius/chant-lexicon-sql/postgres (add the new column, write both, backfill, switch readers, then drop the old).
       yodel apply runs it as this step

Plan digest: jcs1-sha256:8fceea63a48a1227fd5ddc01089e850a7c827140ad376098c33fca9eee489eec
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:8fceea63a48a1227fd5ddc01089e850a7c827140ad376098c33fca9eee489eec
or, at a terminal, with npx yodel approve dev, which shows the plan and asks you first.

The newest approval of approve-migrate-dev, by yodel at 2026-10-10T17:24:27.531Z, is for jcs1-sha256:9527e04f668b47281769059b63977f8fafdbbd3bf06b377854aa05273ad5db09, not this plan; it does not hold.
What moved (as far as yodel can tell): history changed: applied since: 20261010T1724-refunds (by yodel@example at 2026-10-10 17:24:31.521713); live schema changed: as expected after the history change above: applying a migration changes the live schema, and yodel cannot rebuild the live schema as it was at approval, so it cannot confirm that nothing else in it changed.
```

```console
$ npx yodel apply dev
Migrations in dev (postgres 18.6 at 127.0.0.1:5432/postgres, history yodeler.history)

Applied (3):
  20261010T1723-baseline  2026-10-10 17:23:54.742760 by yodel@example
  20261010T1723-coupons  2026-10-10 17:24:09.819313 by yodel@example
  20261010T1724-refunds  2026-10-10 17:24:31.521713 by yodel@example

Pending (1):
  20261010T1724-rename-email  (step 0: PostgresMigrationOp for orders (shop.orders))

Plan digest: jcs1-sha256:8fceea63a48a1227fd5ddc01089e850a7c827140ad376098c33fca9eee489eec

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   981ms
[phase] Approve
  • gate:approve-migrate-dev()   skipped
    [refused] Gate "approve-migrate-dev" is approved, but not for this plan. approved: jcs1-sha256:9527e04f668b47281769059b63977f8fafdbbd3bf06b377854aa05273ad5db09 (by yodel at 2026-10-10T17:24:27.531Z); planned: jcs1-sha256:8fceea63a48a1227fd5ddc01089e850a7c827140ad376098c33fca9eee489eec. The configuration or the live system changed between that approval and this plan, so it needs a fresh one: chant approve migrate-dev approve-migrate-dev
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 1.8s
  plan    : jcs1-sha256:8fceea63a48a1227fd5ddc01089e850a7c827140ad376098c33fca9eee489eec
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:8fceea63a48a1227fd5ddc01089e850a7c827140ad376098c33fca9eee489eec
  expires : 2026-10-12T17:24:40.455Z

Nothing was applied. The approval of jcs1-sha256:9527e04f668b47281769059b63977f8fafdbbd3bf06b377854aa05273ad5db09 (by yodel at 2026-10-10T17:24:27.531Z) does not hold: the plan moved since. What moved, as far as yodel can tell: history changed: applied since: 20261010T1724-refunds (by yodel@example at 2026-10-10 17:24:31.521713); pending migrations changed: committed to since approval: 20261010T1724-rename-email (4e45a64 at 2026-10-10T11:24:37-06:00); live schema changed: as expected after the history change above: applying a migration changes the live schema, and yodel cannot rebuild the live schema as it was at approval, so it cannot confirm that nothing else in it changed.

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:8fceea63a48a1227fd5ddc01089e850a7c827140ad376098c33fca9eee489eec).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:8fceea63a48a1227fd5ddc01089e850a7c827140ad376098c33fca9eee489eec
or, at a terminal, with npx yodel approve dev, which shows the plan and asks you first;
then run npx yodel apply dev again.
[exit 3]
```

```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:8fceea63a48a1227fd5ddc01089e850a7c827140ad376098c33fca9eee489eec
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-10T17:24:43.127Z
This approves the plan jcs1-sha256:8fceea63a48a1227fd5ddc01089e850a7c827140ad376098c33fca9eee489eec, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

<!-- quote: postgres#rename-apply -->
```console
$ npx yodel apply dev
Migrations in dev (postgres 18.6 at 127.0.0.1:5432/postgres, history yodeler.history)

Applied (3):
  20261010T1723-baseline  2026-10-10 17:23:54.742760 by yodel@example
  20261010T1723-coupons  2026-10-10 17:24:09.819313 by yodel@example
  20261010T1724-refunds  2026-10-10 17:24:31.521713 by yodel@example

Pending (1):
  20261010T1724-rename-email  (step 0: PostgresMigrationOp for orders (shop.orders))

Plan digest: jcs1-sha256:8fceea63a48a1227fd5ddc01089e850a7c827140ad376098c33fca9eee489eec

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
lock: held in Postgres advisory lock (1498367052, 748638931) for history schema yodeler
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:8fceea63a48a1227fd5ddc01089e850a7c827140ad376098c33fca9eee489eec, by yodel at 2026-10-10T17:24:43.127Z
20261010T1724-rename-email: applying
  step 0: PostgresMigrationOp for orders (shop.orders)
  step 0: ok {"op":"PostgresMigrationOp","table":"shop.orders","column":"email","state":"migrate","change":"rename","filled":1,"skipped":0,"backfilledRows":301,"carried":0,"verifiedRows":301,"switched":true,"oldColumn":"shop.orders.customer_email","retainUntil":"2026-10-10T17:24:49.958Z","dropped":true}
20261010T1724-rename-email: applied

[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   1.0s
[phase] Approve
  ✓ gate:approve-migrate-dev()   389ms
    [approved] yodel at 2026-10-10T17:24:43.127Z
[phase] Apply
  ✓ shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":"jcs1-sha256:8fceea63a48a1227fd5ddc01089e850a7c827140ad376098c33fca9eee489eec"})   5.2s
Op "migrate-dev" completed in 6.9s

Applied: 20261010T1724-rename-email.
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
Drift in dev (postgres 18.6 at 127.0.0.1:5432/postgres)

Compared with the schema 20261010T1724-rename-email records, the newest migration the history records as applied.

No drift: every declared object matches the server.
```

## 6. A destructive change, silenced with a reason

```console
$ npx yodel new drop-coupon
Wrote migrations/20261010T1724-drop-coupon/ (1 statement; follows 20261010T1724-rename-email)
```

<!-- quote: postgres#destructive -->
```console
$ npx yodel lint
20261010T1723-baseline
  warning  SQLPG112: step 2: orders.customer_email looks like a secret or personal data and neither it nor shop.orders has a COMMENT; say what it holds and how it is protected

20261010T1723-coupons
  warning  data-dependent: step 1: SQLPG217 Add a constraint NOT VALID on shop.orders: can fail on the rows already there (rows that fail the check orders_amount_positive (amount > 0)); yodel apply runs this pre-check before the migration's first statement and refuses when it is not 0: SELECT count(*) AS n FROM shop.orders WHERE NOT (amount > 0)

20261010T1724-drop-coupon
  error    destructive: step 0: SQLPG204 Drop a column on shop.orders: removes data that cannot be recovered

20261010T1724-rename-email
  warning  SQLPG112: step 0: orders.email looks like a secret or personal data and neither it nor shop.orders has a COMMENT; say what it holds and how it is protected

A statement rule can be silenced for one statement, with a reason the history records when it applies:
  a line `-- yodel:allow <rule> <reason>` above the statement in migration.sql

5 migrations: 1 error, 3 warnings, 0 silenced.
[exit 3]
```

Nothing ever wrote a coupon. Say so above the statement:

`migrations/20261010T1724-drop-coupon/migration.sql` now:

<!-- quote: postgres#silence-sql -->
```sql
-- yodel migration 20261010T1724-drop-coupon
-- parent: 20261010T1724-rename-email

-- orders (shop.orders): SQLPG204 metadata, destructive
-- yodel:allow destructive no order ever had a coupon; checked on dev
ALTER TABLE shop.orders DROP COLUMN coupon;
```

<!-- quote: postgres#update-checksum -->
```console
$ npx yodel lint --update-checksum 20261010T1724-drop-coupon
20261010T1724-drop-coupon: checksum sha256:a249036ee571dacb3190a254750b79e55d6920c82aeed07f779e55e911d0973b is now sha256:326cf9df2b47950bfe361be91935ad57382906f28f8f2555dcf930b030cc6a4e
20261010T1723-baseline
  warning  SQLPG112: step 2: orders.customer_email looks like a secret or personal data and neither it nor shop.orders has a COMMENT; say what it holds and how it is protected

20261010T1723-coupons
  warning  data-dependent: step 1: SQLPG217 Add a constraint NOT VALID on shop.orders: can fail on the rows already there (rows that fail the check orders_amount_positive (amount > 0)); yodel apply runs this pre-check before the migration's first statement and refuses when it is not 0: SELECT count(*) AS n FROM shop.orders WHERE NOT (amount > 0)

20261010T1724-drop-coupon
  silenced destructive: step 0: SQLPG204 Drop a column on shop.orders: removes data that cannot be recovered
           reason: no order ever had a coupon; checked on dev

20261010T1724-rename-email
  warning  SQLPG112: step 0: orders.email looks like a secret or personal data and neither it nor shop.orders has a COMMENT; say what it holds and how it is protected

5 migrations: 0 errors, 3 warnings, 1 silenced.
```

The pull request comment (`yodel plan dev --comment` in CI) is this Markdown:

````console
$ npx yodel plan dev --format markdown
<!-- yodel:plan env=dev -->
### yodel plan: `dev`

Postgres, history `yodeler.history`: 4 applied, **1 pending**.

#### `20261010T1724-drop-coupon`

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

Plan digest the apply gate binds: `jcs1-sha256:fad87d274483e2983efff0f2404b64e28b4182a74e6e353e7449ad0e24786cec`

Approve it with:

```sh
chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:fad87d274483e2983efff0f2404b64e28b4182a74e6e353e7449ad0e24786cec
```

The newest approval of `approve-migrate-dev`, by yodel at 2026-10-10T17:24:43.127Z, is for `jcs1-sha256:8fceea63a48a1227fd5ddc01089e850a7c827140ad376098c33fca9eee489eec`, not this plan; it does not hold.
What moved (as far as yodel can tell): history changed: applied since: 20261010T1724-rename-email (by yodel@example at 2026-10-10 17:24:50.116164); pending migrations changed: committed to since approval: 20261010T1724-drop-coupon (bb251e6 at 2026-10-10T11:24:58-06:00); live schema changed: as expected after the history change above: applying a migration changes the live schema, and yodel cannot rebuild the live schema as it was at approval, so it cannot confirm that nothing else in it changed.

<!-- yodel:subject eyJlbnZpcm9ubWVudCI6ImRldiIsImhpc3RvcnlEYXRhYmFzZSI6InlvZGVsZXIiLCJ0b3BvbG9neSI6eyJraW5kIjoic2luZ2xlIn0sImFwcGxpZWQiOlt7ImlkIjoiMjAyNjEwMTBUMTcyMy1iYXNlbGluZSIsImNoZWNrc3VtIjoic2hhMjU2OmRiMzBhNDZlY2I0NzBmNTFiOThjNWIyYTAwZDFlMjM4ZjM4NDU3N2I1Yjg0NDAwZmVhNThmYjQzMzkxZGQ2YWYifSx7ImlkIjoiMjAyNjEwMTBUMTcyMy1jb3Vwb25zIiwiY2hlY2tzdW0iOiJzaGEyNTY6MTFmZjdkNGIzMDI5NzcyYzEwNThhZGJlNjI2ZDdjZWI3NjlkZmM2MzhiMWMxODU1MWQwZWViNWZjYmNiMDAyMSJ9LHsiaWQiOiIyMDI2MTAxMFQxNzI0LXJlZnVuZHMiLCJjaGVja3N1bSI6InNoYTI1NjplZmVhMjllYzU1NWE4M2UwNjdmNWY2NTQ3ZWM1MjQ3Zjk4MGQ0MWYxMTdlZjc5NDBlMjgyOTAzODJmNTg5ZTJkIn0seyJpZCI6IjIwMjYxMDEwVDE3MjQtcmVuYW1lLWVtYWlsIiwiY2hlY2tzdW0iOiJzaGEyNTY6ZjFiM2JiYTZiOGNkZTRkNzgxMjkwNzMxZjQ3Y2JmM2MzNTAxYzllZTVmNjRmZGE2NjFmYWJjODE4OGQxYzVlOSJ9XSwicGVuZGluZyI6W3siaWQiOiIyMDI2MTAxMFQxNzI0LWRyb3AtY291cG9uIiwiY2hlY2tzdW0iOiJzaGEyNTY6MzI2Y2Y5ZGYyYjQ3OTUwYmZlMzYxYmU5MTkzNWFkNTczODI5MDZmMjhmOGYyNTU1ZGNmOTMwYjAzMGNjNmE0ZSIsImRvbmUiOltdfV0sImxpdmUiOiJzaGEyNTY6MTI5OGRhZTUxMTAyNTkwOWE0ZmM5OTZiMzI5NmI2YmNmMjYxYWNmMzAyMzM2NjMxM2VhZjU2ZGI4YjlmMzI2MiJ9 -->
````

```console
$ npx yodel apply dev
Migrations in dev (postgres 18.6 at 127.0.0.1:5432/postgres, history yodeler.history)

Applied (4):
  20261010T1723-baseline  2026-10-10 17:23:54.742760 by yodel@example
  20261010T1723-coupons  2026-10-10 17:24:09.819313 by yodel@example
  20261010T1724-refunds  2026-10-10 17:24:31.521713 by yodel@example
  20261010T1724-rename-email  2026-10-10 17:24:50.116164 by yodel@example

Pending (1):
  20261010T1724-drop-coupon

Plan digest: jcs1-sha256:fad87d274483e2983efff0f2404b64e28b4182a74e6e353e7449ad0e24786cec

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   966ms
[phase] Approve
  • gate:approve-migrate-dev()   skipped
    [refused] Gate "approve-migrate-dev" is approved, but not for this plan. approved: jcs1-sha256:8fceea63a48a1227fd5ddc01089e850a7c827140ad376098c33fca9eee489eec (by yodel at 2026-10-10T17:24:43.127Z); planned: jcs1-sha256:fad87d274483e2983efff0f2404b64e28b4182a74e6e353e7449ad0e24786cec. The configuration or the live system changed between that approval and this plan, so it needs a fresh one: chant approve migrate-dev approve-migrate-dev
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 1.7s
  plan    : jcs1-sha256:fad87d274483e2983efff0f2404b64e28b4182a74e6e353e7449ad0e24786cec
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:fad87d274483e2983efff0f2404b64e28b4182a74e6e353e7449ad0e24786cec
  expires : 2026-10-12T17:25:03.023Z

Nothing was applied. The approval of jcs1-sha256:8fceea63a48a1227fd5ddc01089e850a7c827140ad376098c33fca9eee489eec (by yodel at 2026-10-10T17:24:43.127Z) does not hold: the plan moved since. What moved, as far as yodel can tell: history changed: applied since: 20261010T1724-rename-email (by yodel@example at 2026-10-10 17:24:50.116164); pending migrations changed: committed to since approval: 20261010T1724-drop-coupon (bb251e6 at 2026-10-10T11:24:58-06:00); live schema changed: as expected after the history change above: applying a migration changes the live schema, and yodel cannot rebuild the live schema as it was at approval, so it cannot confirm that nothing else in it changed.

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:fad87d274483e2983efff0f2404b64e28b4182a74e6e353e7449ad0e24786cec).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:fad87d274483e2983efff0f2404b64e28b4182a74e6e353e7449ad0e24786cec
or, at a terminal, with npx yodel approve dev, which shows the plan and asks you first;
then run npx yodel apply dev again.
[exit 3]
```

```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:fad87d274483e2983efff0f2404b64e28b4182a74e6e353e7449ad0e24786cec
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-10T17:25:05.422Z
This approves the plan jcs1-sha256:fad87d274483e2983efff0f2404b64e28b4182a74e6e353e7449ad0e24786cec, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

```console
$ npx yodel apply dev
Migrations in dev (postgres 18.6 at 127.0.0.1:5432/postgres, history yodeler.history)

Applied (4):
  20261010T1723-baseline  2026-10-10 17:23:54.742760 by yodel@example
  20261010T1723-coupons  2026-10-10 17:24:09.819313 by yodel@example
  20261010T1724-refunds  2026-10-10 17:24:31.521713 by yodel@example
  20261010T1724-rename-email  2026-10-10 17:24:50.116164 by yodel@example

Pending (1):
  20261010T1724-drop-coupon

Plan digest: jcs1-sha256:fad87d274483e2983efff0f2404b64e28b4182a74e6e353e7449ad0e24786cec

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
lock: held in Postgres advisory lock (1498367052, 748638931) for history schema yodeler
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:fad87d274483e2983efff0f2404b64e28b4182a74e6e353e7449ad0e24786cec, by yodel at 2026-10-10T17:25:05.422Z
20261010T1724-drop-coupon: applying
  statement 0: ok (SQLPG204 metadata, shop.orders)
20261010T1724-drop-coupon: applied

[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   893ms
[phase] Approve
  ✓ gate:approve-migrate-dev()   193ms
    [approved] yodel at 2026-10-10T17:25:05.422Z
[phase] Apply
  ✓ shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":"jcs1-sha256:fad87d274483e2983efff0f2404b64e28b4182a74e6e353e7449ad0e24786cec"})   1.7s
Op "migrate-dev" completed in 2.9s

Applied: 20261010T1724-drop-coupon.
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
Wrote migrations/20261010T1725-add-gift/ (1 statement; follows 20261010T1724-drop-coupon)
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
Wrote migrations/20261010T1725-index-placed-at/ (2 statements; follows 20261010T1724-drop-coupon)
```

<!-- quote: postgres#pg-lock -->
```console
$ npx yodel lint
20261010T1723-baseline
  warning  SQLPG112: step 2: orders.customer_email looks like a secret or personal data and neither it nor shop.orders has a COMMENT; say what it holds and how it is protected

20261010T1723-coupons
  warning  data-dependent: step 1: SQLPG217 Add a constraint NOT VALID on shop.orders: can fail on the rows already there (rows that fail the check orders_amount_positive (amount > 0)); yodel apply runs this pre-check before the migration's first statement and refuses when it is not 0: SELECT count(*) AS n FROM shop.orders WHERE NOT (amount > 0)

20261010T1724-drop-coupon
  silenced destructive: step 0: SQLPG204 Drop a column on shop.orders: removes data that cannot be recovered
           reason: no order ever had a coupon; checked on dev

20261010T1724-rename-email
  warning  SQLPG112: step 0: orders.email looks like a secret or personal data and neither it nor shop.orders has a COMMENT; say what it holds and how it is protected

20261010T1725-index-placed-at
  error    pg-lock: step 0: SQLPG241 Create an index without CONCURRENTLY on shop.orders_placed_at_idx: builds an index without CONCURRENTLY: SHARE on the table, blocking every write until the build ends; declare the index CONCURRENTLY

A statement rule can be silenced for one statement, with a reason the history records when it applies:
  a line `-- yodel:allow <rule> <reason>` above the statement in migration.sql

6 migrations: 1 error, 3 warnings, 1 silenced.
[exit 3]
```

```console
$ rm -r migrations/20261010T1725-index-placed-at
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

export const ordersRefundedAt = index`
  CREATE INDEX CONCURRENTLY orders_refunded_at_idx ON ${orders} (refunded_at)`;
```

```console
$ npx yodel new index-placed-at
Wrote migrations/20261010T1725-index-placed-at/ (2 statements; follows 20261010T1724-drop-coupon)
```

`migrations/20261010T1725-index-placed-at/migration.sql`:

```sql
-- yodel migration 20261010T1725-index-placed-at
-- parent: 20261010T1724-drop-coupon

-- ordersPlacedAt (shop.orders_placed_at_idx): SQLPG240 concurrently, outside a transaction
CREATE INDEX CONCURRENTLY orders_placed_at_idx ON shop.orders (placed_at);

-- ordersPlacedAt (shop.orders_placed_at_idx): SQLPG240 concurrently
COMMENT ON INDEX shop.orders_placed_at_idx IS '[chant managed-by=chant]';
```

```console
$ npx yodel lint
20261010T1723-baseline
  warning  SQLPG112: step 2: orders.customer_email looks like a secret or personal data and neither it nor shop.orders has a COMMENT; say what it holds and how it is protected

20261010T1723-coupons
  warning  data-dependent: step 1: SQLPG217 Add a constraint NOT VALID on shop.orders: can fail on the rows already there (rows that fail the check orders_amount_positive (amount > 0)); yodel apply runs this pre-check before the migration's first statement and refuses when it is not 0: SELECT count(*) AS n FROM shop.orders WHERE NOT (amount > 0)

20261010T1724-drop-coupon
  silenced destructive: step 0: SQLPG204 Drop a column on shop.orders: removes data that cannot be recovered
           reason: no order ever had a coupon; checked on dev

20261010T1724-rename-email
  warning  SQLPG112: step 0: orders.email looks like a secret or personal data and neither it nor shop.orders has a COMMENT; say what it holds and how it is protected

6 migrations: 0 errors, 3 warnings, 1 silenced.
```

```console
$ git add -A && git commit -q -m 'feat: index orders by placed_at'
```

Someone applies the index branch to dev to try it:

```console
$ npx yodel apply dev
Migrations in dev (postgres 18.6 at 127.0.0.1:5432/postgres, history yodeler.history)

Applied (5):
  20261010T1723-baseline  2026-10-10 17:23:54.742760 by yodel@example
  20261010T1723-coupons  2026-10-10 17:24:09.819313 by yodel@example
  20261010T1724-refunds  2026-10-10 17:24:31.521713 by yodel@example
  20261010T1724-rename-email  2026-10-10 17:24:50.116164 by yodel@example
  20261010T1724-drop-coupon  2026-10-10 17:25:09.412058 by yodel@example

Pending (1):
  20261010T1725-index-placed-at

Plan digest: jcs1-sha256:406dceef9024722898023bfdcaf34ee672f4d94e42c810efc3188cc7abefcda0

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   913ms
[phase] Approve
  • gate:approve-migrate-dev()   skipped
    [refused] Gate "approve-migrate-dev" is approved, but not for this plan. approved: jcs1-sha256:fad87d274483e2983efff0f2404b64e28b4182a74e6e353e7449ad0e24786cec (by yodel at 2026-10-10T17:25:05.422Z); planned: jcs1-sha256:406dceef9024722898023bfdcaf34ee672f4d94e42c810efc3188cc7abefcda0. The configuration or the live system changed between that approval and this plan, so it needs a fresh one: chant approve migrate-dev approve-migrate-dev
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 1.6s
  plan    : jcs1-sha256:406dceef9024722898023bfdcaf34ee672f4d94e42c810efc3188cc7abefcda0
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:406dceef9024722898023bfdcaf34ee672f4d94e42c810efc3188cc7abefcda0
  expires : 2026-10-12T17:25:18.371Z

Nothing was applied. The approval of jcs1-sha256:fad87d274483e2983efff0f2404b64e28b4182a74e6e353e7449ad0e24786cec (by yodel at 2026-10-10T17:25:05.422Z) does not hold: the plan moved since. What moved, as far as yodel can tell: history changed: applied since: 20261010T1724-drop-coupon (by yodel@example at 2026-10-10 17:25:09.412058); pending migrations changed: committed to since approval: 20261010T1725-index-placed-at (5f7dba4 at 2026-10-10T11:25:15-06:00); live schema changed: as expected after the history change above: applying a migration changes the live schema, and yodel cannot rebuild the live schema as it was at approval, so it cannot confirm that nothing else in it changed.

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:406dceef9024722898023bfdcaf34ee672f4d94e42c810efc3188cc7abefcda0).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:406dceef9024722898023bfdcaf34ee672f4d94e42c810efc3188cc7abefcda0
or, at a terminal, with npx yodel approve dev, which shows the plan and asks you first;
then run npx yodel apply dev again.
[exit 3]
```

```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:406dceef9024722898023bfdcaf34ee672f4d94e42c810efc3188cc7abefcda0
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-10T17:25:20.750Z
This approves the plan jcs1-sha256:406dceef9024722898023bfdcaf34ee672f4d94e42c810efc3188cc7abefcda0, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

```console
$ npx yodel apply dev
Migrations in dev (postgres 18.6 at 127.0.0.1:5432/postgres, history yodeler.history)

Applied (5):
  20261010T1723-baseline  2026-10-10 17:23:54.742760 by yodel@example
  20261010T1723-coupons  2026-10-10 17:24:09.819313 by yodel@example
  20261010T1724-refunds  2026-10-10 17:24:31.521713 by yodel@example
  20261010T1724-rename-email  2026-10-10 17:24:50.116164 by yodel@example
  20261010T1724-drop-coupon  2026-10-10 17:25:09.412058 by yodel@example

Pending (1):
  20261010T1725-index-placed-at

Plan digest: jcs1-sha256:406dceef9024722898023bfdcaf34ee672f4d94e42c810efc3188cc7abefcda0

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
lock: held in Postgres advisory lock (1498367052, 748638931) for history schema yodeler
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:406dceef9024722898023bfdcaf34ee672f4d94e42c810efc3188cc7abefcda0, by yodel at 2026-10-10T17:25:20.750Z
20261010T1725-index-placed-at: applying
  statement 0: ok (SQLPG240 concurrently, shop.orders_placed_at_idx)
  statement 1: ok (SQLPG240 concurrently, shop.orders_placed_at_idx)
20261010T1725-index-placed-at: applied

[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   955ms
[phase] Approve
  ✓ gate:approve-migrate-dev()   207ms
    [approved] yodel at 2026-10-10T17:25:20.750Z
[phase] Apply
  ✓ shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":"jcs1-sha256:406dceef9024722898023bfdcaf34ee672f4d94e42c810efc3188cc7abefcda0"})   2.0s
Op "migrate-dev" completed in 3.4s

Applied: 20261010T1725-index-placed-at.
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
  error    fork: 20261010T1725-add-gift and 20261010T1725-index-placed-at both follow 20261010T1724-drop-coupon; rebase one onto the other

20261010T1723-baseline
  warning  SQLPG112: step 2: orders.customer_email looks like a secret or personal data and neither it nor shop.orders has a COMMENT; say what it holds and how it is protected

20261010T1723-coupons
  warning  data-dependent: step 1: SQLPG217 Add a constraint NOT VALID on shop.orders: can fail on the rows already there (rows that fail the check orders_amount_positive (amount > 0)); yodel apply runs this pre-check before the migration's first statement and refuses when it is not 0: SELECT count(*) AS n FROM shop.orders WHERE NOT (amount > 0)

20261010T1724-drop-coupon
  silenced destructive: step 0: SQLPG204 Drop a column on shop.orders: removes data that cannot be recovered
           reason: no order ever had a coupon; checked on dev

20261010T1724-rename-email
  warning  SQLPG112: step 0: orders.email looks like a secret or personal data and neither it nor shop.orders has a COMMENT; say what it holds and how it is protected

7 migrations: 1 error, 3 warnings, 1 silenced.
[exit 3]
```

`yodel rebase` moves one migration onto the other and writes its statements and recorded schema again. With `--env dev` it reads dev's history first, and refuses to move a migration that ran there:

<!-- quote: postgres#rebase-refused -->
```console
$ npx yodel rebase 20261010T1725-index-placed-at --onto 20261010T1725-add-gift --env dev
yodel rebase: refused: dev's history records 20261010T1725-index-placed-at (applied). Nothing was written. A migration that ran is never rebased: its statements already ran in that order. Rebase the other branch onto it instead (yodel rebase <the other> --onto <the end of this one>).
[exit 4]
```

The clean fix is the one it names: move `add-gift` after `index-placed-at`. To show what yodel does when a migration that ran is moved anyway (a rebase run without `--env`), this walkthrough moves `index-placed-at`:

<!-- quote: postgres#rebase -->
```console
$ npx yodel rebase 20261010T1725-index-placed-at --onto 20261010T1725-add-gift
Rebased 20261010T1725-index-placed-at onto 20261010T1725-add-gift (it followed 20261010T1724-drop-coupon).
  20261010T1725-index-placed-at: follows 20261010T1725-add-gift; 2 statements; checksum sha256:8b0a50449f82a2bc1c63fb8c868eb6968dba13b9ab5b02ccc43c8fd231659117 -> sha256:6be6d45f55c4fa14ed67b2b22471f217f92ba3115bcc5c10fa154c99ef1a281f
No history was checked (--env): make sure none of these ran anywhere before merging.
```

Its files changed after it ran on dev, so dev's history no longer matches them. `yodel status` and `yodel apply` refuse (exit 4):

```console
$ npx yodel status dev
Migrations in dev (postgres 18.6 at 127.0.0.1:5432/postgres, history yodeler.history)

Applied (6):
  20261010T1723-baseline  2026-10-10 17:23:54.742760 by yodel@example
  20261010T1723-coupons  2026-10-10 17:24:09.819313 by yodel@example
  20261010T1724-refunds  2026-10-10 17:24:31.521713 by yodel@example
  20261010T1724-rename-email  2026-10-10 17:24:50.116164 by yodel@example
  20261010T1724-drop-coupon  2026-10-10 17:25:09.412058 by yodel@example
  20261010T1725-index-placed-at  2026-10-10 17:25:24.896277 by yodel@example

Pending (1):
  20261010T1725-add-gift  (out of order)

Out of order (1): 20261010T1725-add-gift; apply with --allow-out-of-order

Checksum mismatches (1):
  20261010T1725-index-placed-at was applied with checksum sha256:8b0a50449f82a2bc1c63fb8c868eb6968dba13b9ab5b02ccc43c8fd231659117, but its files now hash to sha256:6be6d45f55c4fa14ed67b2b22471f217f92ba3115bcc5c10fa154c99ef1a281f; if the edit is intended, record it with yodel repair 20261010T1725-index-placed-at --reason ... <env>
[exit 4]
```

<!-- quote: postgres#checksum-refused -->
```console
$ npx yodel apply dev
yodel apply: refused: the history does not match the migrations directory; nothing was applied:
  20261010T1725-index-placed-at was applied with checksum sha256:8b0a50449f82a2bc1c63fb8c868eb6968dba13b9ab5b02ccc43c8fd231659117, but its files now hash to sha256:6be6d45f55c4fa14ed67b2b22471f217f92ba3115bcc5c10fa154c99ef1a281f; if the edit is intended, record it with yodel repair 20261010T1725-index-placed-at --reason ... <env>
[exit 4]
```

The edit is intended: its statements are the same, only its parent changed. `yodel repair` records the new checksum, with the reason, in dev's history. Nothing runs on the server:

<!-- quote: postgres#repair -->
```console
$ npx yodel repair 20261010T1725-index-placed-at --reason 'rebased onto add-gift after it ran on dev' dev
Repaired 20261010T1725-index-placed-at in dev's history (yodeler).
  old checksum: sha256:8b0a50449f82a2bc1c63fb8c868eb6968dba13b9ab5b02ccc43c8fd231659117
  new checksum: sha256:6be6d45f55c4fa14ed67b2b22471f217f92ba3115bcc5c10fa154c99ef1a281f
  reason: rebased onto add-gift after it ran on dev
```

Now `add-gift` comes before a migration dev has applied. It is out of order, and apply refuses it rather than skip it:

```console
$ npx yodel status dev
Migrations in dev (postgres 18.6 at 127.0.0.1:5432/postgres, history yodeler.history)

Applied (6):
  20261010T1723-baseline  2026-10-10 17:23:54.742760 by yodel@example
  20261010T1723-coupons  2026-10-10 17:24:09.819313 by yodel@example
  20261010T1724-refunds  2026-10-10 17:24:31.521713 by yodel@example
  20261010T1724-rename-email  2026-10-10 17:24:50.116164 by yodel@example
  20261010T1724-drop-coupon  2026-10-10 17:25:09.412058 by yodel@example
  20261010T1725-index-placed-at  2026-10-10 17:25:24.896277 by yodel@example
      repaired 2026-10-10 17:25:30.589306 by yodel@example: rebased onto add-gift after it ran on dev

Pending (1):
  20261010T1725-add-gift  (out of order)

Out of order (1): 20261010T1725-add-gift; apply with --allow-out-of-order
[exit 4]
```

<!-- quote: postgres#out-of-order -->
```console
$ npx yodel apply dev
yodel apply: refused: 20261010T1725-add-gift is out of order: the chain puts it before 20261010T1725-index-placed-at, which is already applied. Nothing was applied. Pass --allow-out-of-order to apply it now (in chain order); it is never skipped.
[exit 4]
```

Adding a column after the index changes nothing the index needs, so apply it out of order:

```console
$ npx yodel apply dev --allow-out-of-order
Migrations in dev (postgres 18.6 at 127.0.0.1:5432/postgres, history yodeler.history)

Applied (6):
  20261010T1723-baseline  2026-10-10 17:23:54.742760 by yodel@example
  20261010T1723-coupons  2026-10-10 17:24:09.819313 by yodel@example
  20261010T1724-refunds  2026-10-10 17:24:31.521713 by yodel@example
  20261010T1724-rename-email  2026-10-10 17:24:50.116164 by yodel@example
  20261010T1724-drop-coupon  2026-10-10 17:25:09.412058 by yodel@example
  20261010T1725-index-placed-at  2026-10-10 17:25:24.896277 by yodel@example
      repaired 2026-10-10 17:25:30.589306 by yodel@example: rebased onto add-gift after it ran on dev

Pending (1):
  20261010T1725-add-gift  (out of order)

Out of order (1): 20261010T1725-add-gift; apply with --allow-out-of-order

Plan digest: jcs1-sha256:a6b43ee382e0a02028ff147d6d6c1a5e0932f1351c226c64555200835edd5cf9

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   912ms
[phase] Approve
  • gate:approve-migrate-dev()   skipped
    [refused] Gate "approve-migrate-dev" is approved, but not for this plan. approved: jcs1-sha256:406dceef9024722898023bfdcaf34ee672f4d94e42c810efc3188cc7abefcda0 (by yodel at 2026-10-10T17:25:20.750Z); planned: jcs1-sha256:a6b43ee382e0a02028ff147d6d6c1a5e0932f1351c226c64555200835edd5cf9. The configuration or the live system changed between that approval and this plan, so it needs a fresh one: chant approve migrate-dev approve-migrate-dev
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 1.6s
  plan    : jcs1-sha256:a6b43ee382e0a02028ff147d6d6c1a5e0932f1351c226c64555200835edd5cf9
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:a6b43ee382e0a02028ff147d6d6c1a5e0932f1351c226c64555200835edd5cf9
  expires : 2026-10-12T17:25:34.358Z

Nothing was applied. The approval of jcs1-sha256:406dceef9024722898023bfdcaf34ee672f4d94e42c810efc3188cc7abefcda0 (by yodel at 2026-10-10T17:25:20.750Z) does not hold: the plan moved since. What moved, as far as yodel can tell: history changed: applied since: 20261010T1725-index-placed-at (by yodel@example at 2026-10-10 17:25:24.896277); pending migrations changed: committed to since approval: 20261010T1725-index-placed-at (14d5fc7 at 2026-10-10T11:25:28-06:00); live schema changed: as expected after the history change above: applying a migration changes the live schema, and yodel cannot rebuild the live schema as it was at approval, so it cannot confirm that nothing else in it changed.

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:a6b43ee382e0a02028ff147d6d6c1a5e0932f1351c226c64555200835edd5cf9).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:a6b43ee382e0a02028ff147d6d6c1a5e0932f1351c226c64555200835edd5cf9
or, at a terminal, with npx yodel approve dev, which shows the plan and asks you first;
then run npx yodel apply dev again.
[exit 3]
```

```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:a6b43ee382e0a02028ff147d6d6c1a5e0932f1351c226c64555200835edd5cf9
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-10T17:25:36.714Z
This approves the plan jcs1-sha256:a6b43ee382e0a02028ff147d6d6c1a5e0932f1351c226c64555200835edd5cf9, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

<!-- quote: postgres#out-of-order-apply -->
```console
$ npx yodel apply dev --allow-out-of-order
Migrations in dev (postgres 18.6 at 127.0.0.1:5432/postgres, history yodeler.history)

Applied (6):
  20261010T1723-baseline  2026-10-10 17:23:54.742760 by yodel@example
  20261010T1723-coupons  2026-10-10 17:24:09.819313 by yodel@example
  20261010T1724-refunds  2026-10-10 17:24:31.521713 by yodel@example
  20261010T1724-rename-email  2026-10-10 17:24:50.116164 by yodel@example
  20261010T1724-drop-coupon  2026-10-10 17:25:09.412058 by yodel@example
  20261010T1725-index-placed-at  2026-10-10 17:25:24.896277 by yodel@example
      repaired 2026-10-10 17:25:30.589306 by yodel@example: rebased onto add-gift after it ran on dev

Pending (1):
  20261010T1725-add-gift  (out of order)

Out of order (1): 20261010T1725-add-gift; apply with --allow-out-of-order

Plan digest: jcs1-sha256:a6b43ee382e0a02028ff147d6d6c1a5e0932f1351c226c64555200835edd5cf9

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
lock: held in Postgres advisory lock (1498367052, 748638931) for history schema yodeler
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:a6b43ee382e0a02028ff147d6d6c1a5e0932f1351c226c64555200835edd5cf9, by yodel at 2026-10-10T17:25:36.714Z
20261010T1725-add-gift: applying (out of order, allowed)
  statement 0: ok (SQLPG201 metadata, shop.orders)
20261010T1725-add-gift: applied

[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   929ms
[phase] Approve
  ✓ gate:approve-migrate-dev()   184ms
    [approved] yodel at 2026-10-10T17:25:36.714Z
[phase] Apply
  ✓ shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":"jcs1-sha256:a6b43ee382e0a02028ff147d6d6c1a5e0932f1351c226c64555200835edd5cf9"})   1.6s
Op "migrate-dev" completed in 2.8s

Applied: 20261010T1725-add-gift.
```

`yodel status` lists `index-placed-at` as applied when it ran, and the repair under it:

<!-- quote: postgres#status -->
```console
$ npx yodel status dev
Migrations in dev (postgres 18.6 at 127.0.0.1:5432/postgres, history yodeler.history)

Applied (7):
  20261010T1723-baseline  2026-10-10 17:23:54.742760 by yodel@example
  20261010T1723-coupons  2026-10-10 17:24:09.819313 by yodel@example
  20261010T1724-refunds  2026-10-10 17:24:31.521713 by yodel@example
  20261010T1724-rename-email  2026-10-10 17:24:50.116164 by yodel@example
  20261010T1724-drop-coupon  2026-10-10 17:25:09.412058 by yodel@example
  20261010T1725-add-gift  2026-10-10 17:25:40.602850 by yodel@example
  20261010T1725-index-placed-at  2026-10-10 17:25:24.896277 by yodel@example
      repaired 2026-10-10 17:25:30.589306 by yodel@example: rebased onto add-gift after it ran on dev

Pending: none
```

## 8. Drift

Someone changes a default by hand:

```sql
ALTER TABLE shop.orders ALTER COLUMN status SET DEFAULT 'new'
```

```console
$ npx yodel drift dev
Drift in dev (postgres 18.6 at 127.0.0.1:5432/postgres)

Compared with the schema 20261010T1725-index-placed-at records, the newest migration the history records as applied.

Changed out of band:
  orders (Postgres::Table)
    column status default: declared 'placed'::text, live 'new'::text
[exit 2]
```

`ops/watch-dev.op.ts` runs the same check as a `WatchOp` on a schedule. Run once by hand:

```console
$ npx chant run watch-dev
Snapshot saved to chant/lifecycle (sql(5))

sql — environment: dev
0 missing, 0 orphan, 0 disappeared, 0 newly observed, 0 drifted, 5 unchanged
--------------------------------------------------------------------------------

sql (properties)
1 property drift across 1 resource(s), 0 accepted, 4 unchanged
--------------------------------------------------------------------------------

PROPERTY DRIFT (declared vs live; baseline shown where one exists):
  - orders (Postgres::Table)
      columns[2].default: 'placed'::text → 'new'::text [from: authored]
[phase] Snapshot
  ✓ lifecycleSnapshot(env=dev)   889ms
[phase] Diff
  ✓ lifecycleDiff(env=dev, live=true)   767ms
    [outcome] Drift=true
Op "watch-dev" completed in 1.8s
```

`chant run` exits 0 when the watch completes, drift or not; the drift is the run's `Drift` outcome. Put the default back:

```sql
ALTER TABLE shop.orders ALTER COLUMN status SET DEFAULT 'placed'
```

```console
$ npx yodel drift dev
Drift in dev (postgres 18.6 at 127.0.0.1:5432/postgres)

Compared with the schema 20261010T1725-index-placed-at records, the newest migration the history records as applied.

No drift: every declared object matches the server.
```

## 9. The replay check

`yodel lint --replay replay --reset` replays every migration, in order, into the server the `replay` profile names, and compares each with the schema it recorded. In CI that profile points at a throwaway server the job starts. Here it points at the same emulator as dev, so the replay empties dev's schema; `--reset-shared dev` says that is intended, and the check runs last:

```console
$ npx yodel lint --replay replay --reset --reset-shared dev
replay: emptying shop on postgres://127.0.0.1:5432/postgres (sql.profiles.replay)
replay: 20261010T1723-baseline: replaying
replay: 20261010T1723-baseline: matches its recorded schema
replay: 20261010T1723-coupons: replaying
replay: 20261010T1723-coupons: matches its recorded schema
replay: 20261010T1724-refunds: replaying
replay: 20261010T1724-refunds: matches its recorded schema
replay: 20261010T1724-rename-email: replaying
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
COMMENT ON COLUMN shop.orders.customer_email IS 'chant migration of shop.orders.email: the old name, kept until 2026-10-10T17:25:48.464Z [chant managed-by=chant migration=shop.orders.email role=old retain-until=2026-10-10T17%3A25%3A48.464Z]'
DROP TRIGGER email__chant_sync ON shop.orders
DROP FUNCTION shop.orders__email__chant_sync()
ALTER TABLE shop.orders DROP COLUMN customer_email
replay: 20261010T1724-rename-email: matches its recorded schema
replay: 20261010T1724-drop-coupon: replaying
replay: 20261010T1724-drop-coupon: matches its recorded schema
replay: 20261010T1725-add-gift: replaying
replay: 20261010T1725-add-gift: matches its recorded schema
replay: 20261010T1725-index-placed-at: replaying
replay: 20261010T1725-index-placed-at: matches its recorded schema
Replay of 7 migrations (postgres) into postgres://127.0.0.1:5432/postgres (sql.profiles.replay)
  schemas: shop (emptied first)
  ok      20261010T1723-baseline (6 statements)
  ok      20261010T1723-coupons (3 statements)
  ok      20261010T1724-refunds (3 statements)
  ok      20261010T1724-rename-email (0 statements; ran step 0: PostgresMigrationOp for orders (shop.orders) (switched, old column dropped))
  ok      20261010T1724-drop-coupon (1 statement)
  ok      20261010T1725-add-gift (1 statement)
  ok      20261010T1725-index-placed-at (2 statements)
Every migration replays to its recorded schema.

20261010T1723-baseline
  warning  SQLPG112: step 2: orders.customer_email looks like a secret or personal data and neither it nor shop.orders has a COMMENT; say what it holds and how it is protected

20261010T1723-coupons
  warning  data-dependent: step 1: SQLPG217 Add a constraint NOT VALID on shop.orders: can fail on the rows already there (rows that fail the check orders_amount_positive (amount > 0)); yodel apply runs this pre-check before the migration's first statement and refuses when it is not 0: SELECT count(*) AS n FROM shop.orders WHERE NOT (amount > 0)

20261010T1724-drop-coupon
  silenced destructive: step 0: SQLPG204 Drop a column on shop.orders: removes data that cannot be recovered
           reason: no order ever had a coupon; checked on dev

20261010T1724-rename-email
  warning  SQLPG112: step 0: orders.email looks like a secret or personal data and neither it nor shop.orders has a COMMENT; say what it holds and how it is protected

7 migrations: 0 errors, 3 warnings, 1 silenced.
```
