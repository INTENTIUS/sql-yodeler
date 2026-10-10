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
export const { op } = ApplyOp({ name: "apply-dev", env: "dev", target: "postgres", gate: {} });
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
  ✓ chantBuild(path=.)   803ms
[phase] Plan
  ✓ lifecycleDiff(env=dev, live=true)   723ms
    [outcome] Drift=true
[phase] Approve
  • gate:approve-apply-dev()   skipped
[phase] Apply
  • nativeApply(target=postgres, env=dev, output=dist/schema.json, deleteMode=never)   skipped
Op "apply-dev" is gated on "approve-apply-dev" after 2.0s
  Approve apply to dev (delete mode: never)
  plan    : jcs1-sha256:6c5f32d5c2462c62193c80e3063c26376476d51dcd60d54f281fe80a443187f3
  approve : chant approve apply-dev approve-apply-dev --plan jcs1-sha256:6c5f32d5c2462c62193c80e3063c26376476d51dcd60d54f281fe80a443187f3
  expires : 2026-10-12T05:31:52.438Z

apply-dev is waiting at gate "approve-apply-dev" for approval of this plan.
Approve it with:
  chant approve apply-dev approve-apply-dev --plan jcs1-sha256:6c5f32d5c2462c62193c80e3063c26376476d51dcd60d54f281fe80a443187f3
then run npx yodel apply dev again.
[exit 3]
```

```console
$ npx chant approve apply-dev approve-apply-dev --plan jcs1-sha256:6c5f32d5c2462c62193c80e3063c26376476d51dcd60d54f281fe80a443187f3
Gate "approve-apply-dev" on "apply-dev" resolved by yodel at 2026-10-10T05:31:54.156Z
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
  ✓ chantBuild(path=.)   845ms
[phase] Plan
  ✓ lifecycleDiff(env=dev, live=true)   771ms
    [outcome] Drift=true
[phase] Approve
  ✓ gate:approve-apply-dev()   221ms
    [approved] yodel at 2026-10-10T05:31:54.156Z
[phase] Apply
  ✓ nativeApply(target=postgres, env=dev, output=dist/schema.json, deleteMode=never)   47ms
Op "apply-dev" completed in 2.0s

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
wrote migrations/20261010T0531-baseline (6 statements)
recorded 20261010T0531-baseline applied in yodeler.history as a baseline; none of its statements was run
Adopted dev (postgres): 3 objects
  Schema shop
  Table shop.orders
  Index shop.orders_status_idx

Declarations: src/schema.ts
Baseline:     migrations/20261010T0531-baseline/ (6 statements, sha256:e0978a8c58c455b17884c0e3d7a423cb156fda7edbdf8675c3aebb7f5155b8ca)
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
  20261010T0531-baseline  2026-10-10 05:31:59.965821 by yodel@example

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
Wrote migrations/20261010T0532-coupons/ (2 statements; follows 20261010T0531-baseline)
```

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

Do as the finding says: delete the migration, declare the constraint `NOT VALID`, and write it again:

```console
$ rm -r migrations/20261010T0532-coupons
```

```console
$ npx yodel new coupons
Wrote migrations/20261010T0532-coupons/ (2 statements; follows 20261010T0531-baseline)
```

`migrations/20261010T0532-coupons/migration.sql`:

```sql
-- yodel migration 20261010T0532-coupons
-- parent: 20261010T0531-baseline

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
Plan for dev (postgres 18.6 at 127.0.0.1:5432/postgres, history yodeler.history): 1 applied, 1 pending

20261010T0532-coupons
  0  statement  SQLPG201 metadata  shop.orders
       ALTER TABLE shop.orders ADD COLUMN coupon text
  1  statement  SQLPG217 metadata  shop.orders
       ALTER TABLE shop.orders ADD CONSTRAINT orders_amount_positive CHECK (amount > 0) NOT VALID

Plan digest: jcs1-sha256:babee5c67ad91e52333859d25b75d32ed57b93753a7e48cb78cfb9e26c71018b
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:babee5c67ad91e52333859d25b75d32ed57b93753a7e48cb78cfb9e26c71018b
or, at a terminal, with npx yodel approve dev, which shows the plan and asks you first.

Not approved yet. Approving binds exactly this digest; if anything it covers changes before the apply runs, the gate asks again and nothing is applied.
```

```console
$ npx yodel apply dev
Migrations in dev (postgres 18.6 at 127.0.0.1:5432/postgres, history yodeler.history)

Applied (1):
  20261010T0531-baseline  2026-10-10 05:31:59.965821 by yodel@example

Pending (1):
  20261010T0532-coupons

Plan digest: jcs1-sha256:babee5c67ad91e52333859d25b75d32ed57b93753a7e48cb78cfb9e26c71018b

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   3.0s
[phase] Approve
  • gate:approve-migrate-dev()   skipped
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 3.8s
  plan    : jcs1-sha256:babee5c67ad91e52333859d25b75d32ed57b93753a7e48cb78cfb9e26c71018b
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:babee5c67ad91e52333859d25b75d32ed57b93753a7e48cb78cfb9e26c71018b
  expires : 2026-10-12T05:32:11.171Z

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:babee5c67ad91e52333859d25b75d32ed57b93753a7e48cb78cfb9e26c71018b).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:babee5c67ad91e52333859d25b75d32ed57b93753a7e48cb78cfb9e26c71018b
or, at a terminal, with npx yodel approve dev, which shows the plan and asks you first;
then run npx yodel apply dev again.
[exit 3]
```

```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:babee5c67ad91e52333859d25b75d32ed57b93753a7e48cb78cfb9e26c71018b
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-10T05:32:14.262Z
This approves the plan jcs1-sha256:babee5c67ad91e52333859d25b75d32ed57b93753a7e48cb78cfb9e26c71018b, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

On Postgres the apply lock is an advisory lock:

```console
$ npx yodel apply dev
Migrations in dev (postgres 18.6 at 127.0.0.1:5432/postgres, history yodeler.history)

Applied (1):
  20261010T0531-baseline  2026-10-10 05:31:59.965821 by yodel@example

Pending (1):
  20261010T0532-coupons

Plan digest: jcs1-sha256:babee5c67ad91e52333859d25b75d32ed57b93753a7e48cb78cfb9e26c71018b

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
lock: held in Postgres advisory lock (1498367052, 748638931) for history schema yodeler
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:babee5c67ad91e52333859d25b75d32ed57b93753a7e48cb78cfb9e26c71018b, by yodel at 2026-10-10T05:32:14.262Z
20261010T0532-coupons: applying
  statement 0: ok (SQLPG201 metadata, shop.orders)
  statement 1: ok (SQLPG217 metadata, shop.orders)
20261010T0532-coupons: applied

[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   1.3s
[phase] Approve
  ✓ gate:approve-migrate-dev()   241ms
    [approved] yodel at 2026-10-10T05:32:14.262Z
[phase] Apply
  ✓ shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":"jcs1-sha256:babee5c67ad91e52333859d25b75d32ed57b93753a7e48cb78cfb9e26c71018b"})   2.3s
Op "migrate-dev" completed in 3.9s

Applied: 20261010T0532-coupons.
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
Wrote migrations/20261010T0532-validate-amount/ (2 statements; follows 20261010T0532-coupons)
```

`migrations/20261010T0532-validate-amount/migration.sql`:

```sql
-- yodel migration 20261010T0532-validate-amount
-- parent: 20261010T0532-coupons

-- orders (shop.orders): SQLPG201 metadata
ALTER TABLE shop.orders ADD COLUMN refunded_at timestamp with time zone;

-- orders (shop.orders): SQLPG220 validate
ALTER TABLE shop.orders VALIDATE CONSTRAINT orders_amount_positive;
```

```console
$ npx yodel apply dev
Migrations in dev (postgres 18.6 at 127.0.0.1:5432/postgres, history yodeler.history)

Applied (2):
  20261010T0531-baseline  2026-10-10 05:31:59.965821 by yodel@example
  20261010T0532-coupons  2026-10-10 05:32:19.532446 by yodel@example

Pending (1):
  20261010T0532-validate-amount

Plan digest: jcs1-sha256:00bfc43c33f4a97624882160220fb78b7e747ea1e602cd3c1d3557f6e0a12476

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   1.1s
[phase] Approve
  • gate:approve-migrate-dev()   skipped
    [refused] Gate "approve-migrate-dev" is approved, but not for this plan. approved: jcs1-sha256:babee5c67ad91e52333859d25b75d32ed57b93753a7e48cb78cfb9e26c71018b (by yodel at 2026-10-10T05:32:14.262Z); planned: jcs1-sha256:00bfc43c33f4a97624882160220fb78b7e747ea1e602cd3c1d3557f6e0a12476. The configuration or the live system changed between that approval and this plan, so it needs a fresh one: chant approve migrate-dev approve-migrate-dev
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 2.0s
  plan    : jcs1-sha256:00bfc43c33f4a97624882160220fb78b7e747ea1e602cd3c1d3557f6e0a12476
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:00bfc43c33f4a97624882160220fb78b7e747ea1e602cd3c1d3557f6e0a12476
  expires : 2026-10-12T05:32:25.918Z

Nothing was applied. The approval of jcs1-sha256:babee5c67ad91e52333859d25b75d32ed57b93753a7e48cb78cfb9e26c71018b (by yodel at 2026-10-10T05:32:14.262Z) does not hold: the plan moved since. What moved, as far as yodel can tell: history changed: applied since: 20261010T0532-coupons (by yodel@example at 2026-10-10 05:32:19.532446); pending migrations changed: committed to since approval: 20261010T0532-validate-amount (411abd4 at 2026-10-09T23:32:23-06:00); live schema changed: as expected after the history change above: applying a migration changes the live schema, and yodel cannot rebuild the live schema as it was at approval, so it cannot confirm that nothing else in it changed.

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:00bfc43c33f4a97624882160220fb78b7e747ea1e602cd3c1d3557f6e0a12476).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:00bfc43c33f4a97624882160220fb78b7e747ea1e602cd3c1d3557f6e0a12476
or, at a terminal, with npx yodel approve dev, which shows the plan and asks you first;
then run npx yodel apply dev again.
[exit 3]
```

```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:00bfc43c33f4a97624882160220fb78b7e747ea1e602cd3c1d3557f6e0a12476
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-10T05:32:28.879Z
This approves the plan jcs1-sha256:00bfc43c33f4a97624882160220fb78b7e747ea1e602cd3c1d3557f6e0a12476, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

The free sample breaks the constraint. Statement 0 ran and is recorded; statement 1 failed:

<!-- quote: postgres#failed -->
```console
$ npx yodel apply dev
Migrations in dev (postgres 18.6 at 127.0.0.1:5432/postgres, history yodeler.history)

Applied (2):
  20261010T0531-baseline  2026-10-10 05:31:59.965821 by yodel@example
  20261010T0532-coupons  2026-10-10 05:32:19.532446 by yodel@example

Pending (1):
  20261010T0532-validate-amount

Plan digest: jcs1-sha256:00bfc43c33f4a97624882160220fb78b7e747ea1e602cd3c1d3557f6e0a12476

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   1.2s
[phase] Approve
  ✓ gate:approve-migrate-dev()   425ms
    [approved] yodel at 2026-10-10T05:32:28.879Z
[phase] Apply
  ✗ shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":"jcs1-sha256:00bfc43c33f4a97624882160220fb78b7e747ea1e602cd3c1d3557f6e0a12476"})   1.8s
    command exited 1 (expected 0): Command failed: yodel apply dev --execute
lock: held in Postgres advisory lock (1498367052, 748638931) for history schema yodeler
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:00bfc43c33f4a97624882160220fb78b7e747ea1e602cd3c1d3557f6e0a12476, by yodel at 2026-10-10T05:32:28.879Z
20261010T0532-validate-amount: applying
  statement 0: ok (SQLPG201 metadata, shop.orders)
  statement 1: failed: check constraint "orders_amount_positive" of relation "orders" is violated by some row
yodel apply: 20261010T0532-validate-amount failed at statement 1: check constraint "orders_amount_positive" of relation "orders" is violated by some row
Fix the cause (on the server, or that statement in the migration's files), then run yodel apply again: it resumes at statement 1 and never sends again the statements that succeeded.

Op "migrate-dev" failed after 3.9s
yodel apply: chant run migrate-dev failed (exit 1): its Apply step, yodel apply dev --execute, exited 1

Migrations in dev (postgres 18.6 at 127.0.0.1:5432/postgres, history yodeler.history)

Applied (2):
  20261010T0531-baseline  2026-10-10 05:31:59.965821 by yodel@example
  20261010T0532-coupons  2026-10-10 05:32:19.532446 by yodel@example

Pending (1):
  20261010T0532-validate-amount  (failed part way at statement 1; resumes at statement 1)
      error: statement 1: check constraint "orders_amount_positive" of relation "orders" is violated by some row

Plan digest: jcs1-sha256:00316318758c0e81b1db8cc977b56bba0639fb987f94a1a96332df5505f19c9c
[exit 1]
```

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

Fix the data. The history changed since the approval (statement 0 ran), so the digest moved and the gate asks again:

```sql
UPDATE shop.orders SET amount = 0.01 WHERE amount <= 0
```

```console
$ npx yodel apply dev
Migrations in dev (postgres 18.6 at 127.0.0.1:5432/postgres, history yodeler.history)

Applied (2):
  20261010T0531-baseline  2026-10-10 05:31:59.965821 by yodel@example
  20261010T0532-coupons  2026-10-10 05:32:19.532446 by yodel@example

Pending (1):
  20261010T0532-validate-amount  (failed part way at statement 1; resumes at statement 1)
      error: statement 1: check constraint "orders_amount_positive" of relation "orders" is violated by some row

Plan digest: jcs1-sha256:00316318758c0e81b1db8cc977b56bba0639fb987f94a1a96332df5505f19c9c

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   1.8s
[phase] Approve
  • gate:approve-migrate-dev()   skipped
    [refused] Gate "approve-migrate-dev" is approved, but not for this plan. approved: jcs1-sha256:00bfc43c33f4a97624882160220fb78b7e747ea1e602cd3c1d3557f6e0a12476 (by yodel at 2026-10-10T05:32:28.879Z); planned: jcs1-sha256:00316318758c0e81b1db8cc977b56bba0639fb987f94a1a96332df5505f19c9c. The configuration or the live system changed between that approval and this plan, so it needs a fresh one: chant approve migrate-dev approve-migrate-dev
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 2.9s
  plan    : jcs1-sha256:00316318758c0e81b1db8cc977b56bba0639fb987f94a1a96332df5505f19c9c
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:00316318758c0e81b1db8cc977b56bba0639fb987f94a1a96332df5505f19c9c
  expires : 2026-10-12T05:32:42.302Z

Nothing was applied. The approval of jcs1-sha256:00bfc43c33f4a97624882160220fb78b7e747ea1e602cd3c1d3557f6e0a12476 (by yodel at 2026-10-10T05:32:28.879Z) does not hold: the plan moved since. What moved, as far as yodel can tell: history changed: 20261010T0532-validate-amount ran part way since: statements 0 done now; live schema changed: as expected after the history change above: applying a migration changes the live schema, and yodel cannot rebuild the live schema as it was at approval, so it cannot confirm that nothing else in it changed.

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:00316318758c0e81b1db8cc977b56bba0639fb987f94a1a96332df5505f19c9c).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:00316318758c0e81b1db8cc977b56bba0639fb987f94a1a96332df5505f19c9c
or, at a terminal, with npx yodel approve dev, which shows the plan and asks you first;
then run npx yodel apply dev again.
[exit 3]
```

```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:00316318758c0e81b1db8cc977b56bba0639fb987f94a1a96332df5505f19c9c
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-10T05:32:45.303Z
This approves the plan jcs1-sha256:00316318758c0e81b1db8cc977b56bba0639fb987f94a1a96332df5505f19c9c, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

<!-- quote: postgres#resumed -->
```console
$ npx yodel apply dev
Migrations in dev (postgres 18.6 at 127.0.0.1:5432/postgres, history yodeler.history)

Applied (2):
  20261010T0531-baseline  2026-10-10 05:31:59.965821 by yodel@example
  20261010T0532-coupons  2026-10-10 05:32:19.532446 by yodel@example

Pending (1):
  20261010T0532-validate-amount  (failed part way at statement 1; resumes at statement 1)
      error: statement 1: check constraint "orders_amount_positive" of relation "orders" is violated by some row

Plan digest: jcs1-sha256:00316318758c0e81b1db8cc977b56bba0639fb987f94a1a96332df5505f19c9c

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
lock: held in Postgres advisory lock (1498367052, 748638931) for history schema yodeler
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:00316318758c0e81b1db8cc977b56bba0639fb987f94a1a96332df5505f19c9c, by yodel at 2026-10-10T05:32:45.303Z
20261010T0532-validate-amount: resuming at statement 1
  statement 0: succeeded in an earlier run; not sent
  statement 1: ok (SQLPG220 validate, shop.orders)
20261010T0532-validate-amount: applied

[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   971ms
[phase] Approve
  ✓ gate:approve-migrate-dev()   254ms
    [approved] yodel at 2026-10-10T05:32:45.303Z
[phase] Apply
  ✓ shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":"jcs1-sha256:00316318758c0e81b1db8cc977b56bba0639fb987f94a1a96332df5505f19c9c"})   1.1s
Op "migrate-dev" completed in 2.5s

Applied: 20261010T0532-validate-amount.
```

## 5. A column rename: a PostgresMigrationOp step

Renaming `customer_email` to `email` in place would break every reader still using the old name. Declare the new name with `-- previously: <old name>` on its line, and `yodel new` writes the change as a `PostgresMigrationOp` step: add the new column, keep both written with a trigger, backfill, verify, switch, and drop the old column. The new name stays where the old one was declared:

`yodel new` cannot tell a rename from a dropped column and an added one unless the declaration says so. Without the line, the change is a manual step, with a hint:

<!-- quote: postgres#rename-hint -->
```console
$ npx yodel new rename-email
Wrote migrations/20261010T0532-rename-email/ (0 statements; follows 20261010T0532-validate-amount)
  This migration contains a manual step: orders (shop.orders), SQLPG203, SQLPG204. No statement and no Op makes it:
    shop.orders needs expand and contract, which no in-place statement makes, so nothing was sent for it. SQLPG203 Add a NOT NULL column with no default (columns.email - -> email text): ADD COLUMN ... NOT NULL with no default fails on a table that has rows. Add it nullable, backfill it, then set NOT NULL. https://www.postgresql.org/docs/18/sql-altertable.html No migration Op makes this change yet: make it by hand as expand and contract (add the new, write both, backfill, move readers, then drop the old).
  hint: orders: customer_email is dropped and email added with the same type in the same place; if it is a rename, write -- previously: customer_email on its line
```

```console
$ rm -r migrations/20261010T0532-rename-email
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
Wrote migrations/20261010T0532-rename-email/ (0 statements; follows 20261010T0532-validate-amount)
  This migration contains an Op step: PostgresMigrationOp for orders (shop.orders), SQLPG205.
    It is not SQL. migration.json holds the Op's declaration:
    export const { op } = PostgresMigrationOp({ name: "migrate-shop-orders-email", env: "<env>", table: "shop.orders", column: "email" });
```

`migrations/20261010T0532-rename-email/migration.sql`:

<!-- quote: postgres#rename-sql -->
```sql
-- yodel migration 20261010T0532-rename-email
-- parent: 20261010T0532-validate-amount
-- This migration contains an Op step, not only SQL:
--   PostgresMigrationOp for orders (shop.orders), SQLPG205: not SQL; migration.json holds its declaration

-- orders (shop.orders): SQLPG205 made by PostgresMigrationOp, not a statement:
--   export const { op } = PostgresMigrationOp({ name: "migrate-shop-orders-email", env: "<env>", table: "shop.orders", column: "email" });
```

`src/schema.ts` and the newest migration now agree, so a second `yodel new` writes nothing:

<!-- quote: postgres#new-check -->
```console
$ npx yodel new check
No changes: the declared schema matches the newest migration's recorded schema (20261010T0532-rename-email). Nothing written.
```

```console
$ npx yodel plan dev
Plan for dev (postgres 18.6 at 127.0.0.1:5432/postgres, history yodeler.history): 3 applied, 1 pending

20261010T0532-rename-email
  0  Op PostgresMigrationOp  SQLPG205 expand  shop.orders
       shop.orders needs expand and contract, which no in-place statement makes, so nothing was sent for it. SQLPG205 Rename a column (columns.email customer_email -> email): RENAME COLUMN is a catalog change, but every reader still using the old name fails the moment it runs: add the new column, write both, move readers, drop the old. https://www.postgresql.org/docs/18/sql-altertable.html Run it as the expand-and-contract migration Op: PostgresMigrationOp({ table: "shop.orders", column: "email", ... }) from @intentius/chant-lexicon-sql/postgres (add the new column, write both, backfill, switch readers, then drop the old).
       yodel apply runs it as this step

Plan digest: jcs1-sha256:935527e15a4311e97553fa806b82c2927c349278a1371c03780125b2877a4d9f
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:935527e15a4311e97553fa806b82c2927c349278a1371c03780125b2877a4d9f
or, at a terminal, with npx yodel approve dev, which shows the plan and asks you first.

The newest approval of approve-migrate-dev, by yodel at 2026-10-10T05:32:45.303Z, is for jcs1-sha256:00316318758c0e81b1db8cc977b56bba0639fb987f94a1a96332df5505f19c9c, not this plan; it does not hold.
What moved (as far as yodel can tell): history changed: applied since: 20261010T0532-validate-amount (by yodel@example at 2026-10-10 05:32:49.686972); live schema changed: as expected after the history change above: applying a migration changes the live schema, and yodel cannot rebuild the live schema as it was at approval, so it cannot confirm that nothing else in it changed.
```

```console
$ npx yodel apply dev
Migrations in dev (postgres 18.6 at 127.0.0.1:5432/postgres, history yodeler.history)

Applied (3):
  20261010T0531-baseline  2026-10-10 05:31:59.965821 by yodel@example
  20261010T0532-coupons  2026-10-10 05:32:19.532446 by yodel@example
  20261010T0532-validate-amount  2026-10-10 05:32:49.686972 by yodel@example

Pending (1):
  20261010T0532-rename-email  (step 0: PostgresMigrationOp for orders (shop.orders))

Plan digest: jcs1-sha256:935527e15a4311e97553fa806b82c2927c349278a1371c03780125b2877a4d9f

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   1.1s
[phase] Approve
  • gate:approve-migrate-dev()   skipped
    [refused] Gate "approve-migrate-dev" is approved, but not for this plan. approved: jcs1-sha256:00316318758c0e81b1db8cc977b56bba0639fb987f94a1a96332df5505f19c9c (by yodel at 2026-10-10T05:32:45.303Z); planned: jcs1-sha256:935527e15a4311e97553fa806b82c2927c349278a1371c03780125b2877a4d9f. The configuration or the live system changed between that approval and this plan, so it needs a fresh one: chant approve migrate-dev approve-migrate-dev
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 2.1s
  plan    : jcs1-sha256:935527e15a4311e97553fa806b82c2927c349278a1371c03780125b2877a4d9f
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:935527e15a4311e97553fa806b82c2927c349278a1371c03780125b2877a4d9f
  expires : 2026-10-12T05:32:58.887Z

Nothing was applied. The approval of jcs1-sha256:00316318758c0e81b1db8cc977b56bba0639fb987f94a1a96332df5505f19c9c (by yodel at 2026-10-10T05:32:45.303Z) does not hold: the plan moved since. What moved, as far as yodel can tell: history changed: applied since: 20261010T0532-validate-amount (by yodel@example at 2026-10-10 05:32:49.686972); pending migrations changed: committed to since approval: 20261010T0532-rename-email (79a2bcf at 2026-10-09T23:32:55-06:00); live schema changed: as expected after the history change above: applying a migration changes the live schema, and yodel cannot rebuild the live schema as it was at approval, so it cannot confirm that nothing else in it changed.

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:935527e15a4311e97553fa806b82c2927c349278a1371c03780125b2877a4d9f).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:935527e15a4311e97553fa806b82c2927c349278a1371c03780125b2877a4d9f
or, at a terminal, with npx yodel approve dev, which shows the plan and asks you first;
then run npx yodel apply dev again.
[exit 3]
```

```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:935527e15a4311e97553fa806b82c2927c349278a1371c03780125b2877a4d9f
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-10T05:33:01.628Z
This approves the plan jcs1-sha256:935527e15a4311e97553fa806b82c2927c349278a1371c03780125b2877a4d9f, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

<!-- quote: postgres#rename-apply -->
```console
$ npx yodel apply dev
Migrations in dev (postgres 18.6 at 127.0.0.1:5432/postgres, history yodeler.history)

Applied (3):
  20261010T0531-baseline  2026-10-10 05:31:59.965821 by yodel@example
  20261010T0532-coupons  2026-10-10 05:32:19.532446 by yodel@example
  20261010T0532-validate-amount  2026-10-10 05:32:49.686972 by yodel@example

Pending (1):
  20261010T0532-rename-email  (step 0: PostgresMigrationOp for orders (shop.orders))

Plan digest: jcs1-sha256:935527e15a4311e97553fa806b82c2927c349278a1371c03780125b2877a4d9f

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
lock: held in Postgres advisory lock (1498367052, 748638931) for history schema yodeler
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:935527e15a4311e97553fa806b82c2927c349278a1371c03780125b2877a4d9f, by yodel at 2026-10-10T05:33:01.628Z
20261010T0532-rename-email: applying
  step 0: PostgresMigrationOp for orders (shop.orders)
  step 0: ok {"op":"PostgresMigrationOp","table":"shop.orders","column":"email","state":"migrate","change":"rename","filled":1,"skipped":0,"backfilledRows":301,"carried":0,"verifiedRows":301,"switched":true,"oldColumn":"shop.orders.customer_email","retainUntil":"2026-10-10T05:33:05.797Z","dropped":true}
20261010T0532-rename-email: applied

[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   976ms
[phase] Approve
  ✓ gate:approve-migrate-dev()   235ms
    [approved] yodel at 2026-10-10T05:33:01.628Z
[phase] Apply
  ✓ shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":"jcs1-sha256:935527e15a4311e97553fa806b82c2927c349278a1371c03780125b2877a4d9f"})   1.3s
Op "migrate-dev" completed in 2.7s

Applied: 20261010T0532-rename-email.
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

No drift: every declared object matches the server.
```

## 6. A destructive change, silenced with a reason

```console
$ npx yodel new drop-coupon
Wrote migrations/20261010T0533-drop-coupon/ (1 statement; follows 20261010T0532-rename-email)
```

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

Nothing ever wrote a coupon. Say so above the statement:

`migrations/20261010T0533-drop-coupon/migration.sql` now:

<!-- quote: postgres#silence-sql -->
```sql
-- yodel migration 20261010T0533-drop-coupon
-- parent: 20261010T0532-rename-email

-- orders (shop.orders): SQLPG204 metadata, destructive
-- yodel:allow destructive no order ever had a coupon; checked on dev
ALTER TABLE shop.orders DROP COLUMN coupon;
```

<!-- quote: postgres#update-checksum -->
```console
$ npx yodel lint --update-checksum 20261010T0533-drop-coupon
20261010T0533-drop-coupon: checksum sha256:ba19680b8db2c23fe9e84b445602a4d3dec2e1910923121636ce21fde6ab3bd2 is now sha256:4d629ea6b3b71520270b61696af81a22569982c02bc55adce08d0488d9de990e
20261010T0533-drop-coupon
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

#### `20261010T0533-drop-coupon`

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

Plan digest the apply gate binds: `jcs1-sha256:28d1a14db726e28613cb2546d68f4f328f3d2d1530cfa5463e0d594dcec1a6f7`

Approve it with:

```sh
chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:28d1a14db726e28613cb2546d68f4f328f3d2d1530cfa5463e0d594dcec1a6f7
```

The newest approval of `approve-migrate-dev`, by yodel at 2026-10-10T05:33:01.628Z, is for `jcs1-sha256:935527e15a4311e97553fa806b82c2927c349278a1371c03780125b2877a4d9f`, not this plan; it does not hold.
What moved (as far as yodel can tell): history changed: applied since: 20261010T0532-rename-email (by yodel@example at 2026-10-10 05:33:05.861373); pending migrations changed: committed to since approval: 20261010T0533-drop-coupon (aa2b941 at 2026-10-09T23:33:11-06:00); live schema changed: as expected after the history change above: applying a migration changes the live schema, and yodel cannot rebuild the live schema as it was at approval, so it cannot confirm that nothing else in it changed.

<!-- yodel:subject eyJlbnZpcm9ubWVudCI6ImRldiIsImhpc3RvcnlEYXRhYmFzZSI6InlvZGVsZXIiLCJ0b3BvbG9neSI6eyJraW5kIjoic2luZ2xlIn0sImFwcGxpZWQiOlt7ImlkIjoiMjAyNjEwMTBUMDUzMS1iYXNlbGluZSIsImNoZWNrc3VtIjoic2hhMjU2OmUwOTc4YThjNThjNDU1YjE3ODg0YzBlM2Q3YTQyM2NiMTU2ZmRhN2VkYmRmODY3NWMzYWViYjdmNTE1NWI4Y2EifSx7ImlkIjoiMjAyNjEwMTBUMDUzMi1jb3Vwb25zIiwiY2hlY2tzdW0iOiJzaGEyNTY6MDZhMjQ3MzYzZmM0MDQ5MTM1NWFlMzVmYTU5MzE5ZDhhNzU3NjM5YzYwMzY5OTIyM2E1NzAyYWJhZjliMGU3MiJ9LHsiaWQiOiIyMDI2MTAxMFQwNTMyLXZhbGlkYXRlLWFtb3VudCIsImNoZWNrc3VtIjoic2hhMjU2Ojc0MGQ3OTcxYmRmODY5YjZkMGFkNDhjODQyNDM2NjZlYmFjOGYxZDVjYThhYzU5NzE5M2ZjOWMyNWEzNjEwM2UifSx7ImlkIjoiMjAyNjEwMTBUMDUzMi1yZW5hbWUtZW1haWwiLCJjaGVja3N1bSI6InNoYTI1NjpmMmNiMGE1MGRhNzY1OTZjN2I2OTNhMjIzY2FjM2FhMGU0NGIxYzVjMjY0ZGYwZDU4ZjIwZmJiYjkyODg0NmQ4In1dLCJwZW5kaW5nIjpbeyJpZCI6IjIwMjYxMDEwVDA1MzMtZHJvcC1jb3Vwb24iLCJjaGVja3N1bSI6InNoYTI1Njo0ZDYyOWVhNmIzYjcxNTIwMjcwYjYxNjk2YWY4MWEyMjU2OTk4MmMwMmJjNTVhZGNlMDhkMDQ4OGQ5ZGU5OTBlIiwiZG9uZSI6W119XSwibGl2ZSI6InNoYTI1NjpmMmIwMTE3Zjc3ZmFmZGI0MzBmNGMzNzc1MjcxNTMzODVhNDQzMTZiMTQwYzhkZTA0NzMzMTc5YTQ2ZDUzOWE5In0 -->
````

```console
$ npx yodel apply dev
Migrations in dev (postgres 18.6 at 127.0.0.1:5432/postgres, history yodeler.history)

Applied (4):
  20261010T0531-baseline  2026-10-10 05:31:59.965821 by yodel@example
  20261010T0532-coupons  2026-10-10 05:32:19.532446 by yodel@example
  20261010T0532-validate-amount  2026-10-10 05:32:49.686972 by yodel@example
  20261010T0532-rename-email  2026-10-10 05:33:05.861373 by yodel@example

Pending (1):
  20261010T0533-drop-coupon

Plan digest: jcs1-sha256:28d1a14db726e28613cb2546d68f4f328f3d2d1530cfa5463e0d594dcec1a6f7

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   1.4s
[phase] Approve
  • gate:approve-migrate-dev()   skipped
    [refused] Gate "approve-migrate-dev" is approved, but not for this plan. approved: jcs1-sha256:935527e15a4311e97553fa806b82c2927c349278a1371c03780125b2877a4d9f (by yodel at 2026-10-10T05:33:01.628Z); planned: jcs1-sha256:28d1a14db726e28613cb2546d68f4f328f3d2d1530cfa5463e0d594dcec1a6f7. The configuration or the live system changed between that approval and this plan, so it needs a fresh one: chant approve migrate-dev approve-migrate-dev
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 2.4s
  plan    : jcs1-sha256:28d1a14db726e28613cb2546d68f4f328f3d2d1530cfa5463e0d594dcec1a6f7
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:28d1a14db726e28613cb2546d68f4f328f3d2d1530cfa5463e0d594dcec1a6f7
  expires : 2026-10-12T05:33:15.666Z

Nothing was applied. The approval of jcs1-sha256:935527e15a4311e97553fa806b82c2927c349278a1371c03780125b2877a4d9f (by yodel at 2026-10-10T05:33:01.628Z) does not hold: the plan moved since. What moved, as far as yodel can tell: history changed: applied since: 20261010T0532-rename-email (by yodel@example at 2026-10-10 05:33:05.861373); pending migrations changed: committed to since approval: 20261010T0533-drop-coupon (aa2b941 at 2026-10-09T23:33:11-06:00); live schema changed: as expected after the history change above: applying a migration changes the live schema, and yodel cannot rebuild the live schema as it was at approval, so it cannot confirm that nothing else in it changed.

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:28d1a14db726e28613cb2546d68f4f328f3d2d1530cfa5463e0d594dcec1a6f7).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:28d1a14db726e28613cb2546d68f4f328f3d2d1530cfa5463e0d594dcec1a6f7
or, at a terminal, with npx yodel approve dev, which shows the plan and asks you first;
then run npx yodel apply dev again.
[exit 3]
```

```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:28d1a14db726e28613cb2546d68f4f328f3d2d1530cfa5463e0d594dcec1a6f7
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-10T05:33:18.612Z
This approves the plan jcs1-sha256:28d1a14db726e28613cb2546d68f4f328f3d2d1530cfa5463e0d594dcec1a6f7, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

```console
$ npx yodel apply dev
Migrations in dev (postgres 18.6 at 127.0.0.1:5432/postgres, history yodeler.history)

Applied (4):
  20261010T0531-baseline  2026-10-10 05:31:59.965821 by yodel@example
  20261010T0532-coupons  2026-10-10 05:32:19.532446 by yodel@example
  20261010T0532-validate-amount  2026-10-10 05:32:49.686972 by yodel@example
  20261010T0532-rename-email  2026-10-10 05:33:05.861373 by yodel@example

Pending (1):
  20261010T0533-drop-coupon

Plan digest: jcs1-sha256:28d1a14db726e28613cb2546d68f4f328f3d2d1530cfa5463e0d594dcec1a6f7

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
lock: held in Postgres advisory lock (1498367052, 748638931) for history schema yodeler
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:28d1a14db726e28613cb2546d68f4f328f3d2d1530cfa5463e0d594dcec1a6f7, by yodel at 2026-10-10T05:33:18.612Z
20261010T0533-drop-coupon: applying
  statement 0: ok (SQLPG204 metadata, shop.orders)
20261010T0533-drop-coupon: applied

[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   1.3s
[phase] Approve
  ✓ gate:approve-migrate-dev()   301ms
    [approved] yodel at 2026-10-10T05:33:18.612Z
[phase] Apply
  ✓ shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":"jcs1-sha256:28d1a14db726e28613cb2546d68f4f328f3d2d1530cfa5463e0d594dcec1a6f7"})   1.5s
Op "migrate-dev" completed in 3.2s

Applied: 20261010T0533-drop-coupon.
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
Wrote migrations/20261010T0533-add-gift/ (1 statement; follows 20261010T0533-drop-coupon)
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
Wrote migrations/20261010T0533-index-placed-at/ (2 statements; follows 20261010T0533-drop-coupon)
```

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

```console
$ rm -r migrations/20261010T0533-index-placed-at
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
Wrote migrations/20261010T0533-index-placed-at/ (2 statements; follows 20261010T0533-drop-coupon)
```

`migrations/20261010T0533-index-placed-at/migration.sql`:

```sql
-- yodel migration 20261010T0533-index-placed-at
-- parent: 20261010T0533-drop-coupon

-- ordersPlacedAt (shop.orders_placed_at_idx): SQLPG240 concurrently, outside a transaction
CREATE INDEX CONCURRENTLY orders_placed_at_idx ON shop.orders (placed_at);

-- ordersPlacedAt (shop.orders_placed_at_idx): SQLPG240 concurrently
COMMENT ON INDEX shop.orders_placed_at_idx IS '[chant managed-by=chant]';
```

```console
$ npx yodel lint
20261010T0533-drop-coupon
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
Migrations in dev (postgres 18.6 at 127.0.0.1:5432/postgres, history yodeler.history)

Applied (5):
  20261010T0531-baseline  2026-10-10 05:31:59.965821 by yodel@example
  20261010T0532-coupons  2026-10-10 05:32:19.532446 by yodel@example
  20261010T0532-validate-amount  2026-10-10 05:32:49.686972 by yodel@example
  20261010T0532-rename-email  2026-10-10 05:33:05.861373 by yodel@example
  20261010T0533-drop-coupon  2026-10-10 05:33:24.090984 by yodel@example

Pending (1):
  20261010T0533-index-placed-at

Plan digest: jcs1-sha256:72e612a5e19396d156fb886b20f936c8b1328c3e1dae33ba352f5d45787bdb92

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   3.0s
[phase] Approve
  • gate:approve-migrate-dev()   skipped
    [refused] Gate "approve-migrate-dev" is approved, but not for this plan. approved: jcs1-sha256:28d1a14db726e28613cb2546d68f4f328f3d2d1530cfa5463e0d594dcec1a6f7 (by yodel at 2026-10-10T05:33:18.612Z); planned: jcs1-sha256:72e612a5e19396d156fb886b20f936c8b1328c3e1dae33ba352f5d45787bdb92. The configuration or the live system changed between that approval and this plan, so it needs a fresh one: chant approve migrate-dev approve-migrate-dev
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 6.6s
  plan    : jcs1-sha256:72e612a5e19396d156fb886b20f936c8b1328c3e1dae33ba352f5d45787bdb92
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:72e612a5e19396d156fb886b20f936c8b1328c3e1dae33ba352f5d45787bdb92
  expires : 2026-10-12T05:33:46.606Z

Nothing was applied. The approval of jcs1-sha256:28d1a14db726e28613cb2546d68f4f328f3d2d1530cfa5463e0d594dcec1a6f7 (by yodel at 2026-10-10T05:33:18.612Z) does not hold: the plan moved since. What moved, as far as yodel can tell: history changed: applied since: 20261010T0533-drop-coupon (by yodel@example at 2026-10-10 05:33:24.090984); pending migrations changed: committed to since approval: 20261010T0533-index-placed-at (2b14c81 at 2026-10-09T23:33:37-06:00); live schema changed: as expected after the history change above: applying a migration changes the live schema, and yodel cannot rebuild the live schema as it was at approval, so it cannot confirm that nothing else in it changed.

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:72e612a5e19396d156fb886b20f936c8b1328c3e1dae33ba352f5d45787bdb92).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:72e612a5e19396d156fb886b20f936c8b1328c3e1dae33ba352f5d45787bdb92
or, at a terminal, with npx yodel approve dev, which shows the plan and asks you first;
then run npx yodel apply dev again.
[exit 3]
```

```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:72e612a5e19396d156fb886b20f936c8b1328c3e1dae33ba352f5d45787bdb92
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-10T05:33:58.308Z
This approves the plan jcs1-sha256:72e612a5e19396d156fb886b20f936c8b1328c3e1dae33ba352f5d45787bdb92, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

```console
$ npx yodel apply dev
Migrations in dev (postgres 18.6 at 127.0.0.1:5432/postgres, history yodeler.history)

Applied (5):
  20261010T0531-baseline  2026-10-10 05:31:59.965821 by yodel@example
  20261010T0532-coupons  2026-10-10 05:32:19.532446 by yodel@example
  20261010T0532-validate-amount  2026-10-10 05:32:49.686972 by yodel@example
  20261010T0532-rename-email  2026-10-10 05:33:05.861373 by yodel@example
  20261010T0533-drop-coupon  2026-10-10 05:33:24.090984 by yodel@example

Pending (1):
  20261010T0533-index-placed-at

Plan digest: jcs1-sha256:72e612a5e19396d156fb886b20f936c8b1328c3e1dae33ba352f5d45787bdb92

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
lock: held in Postgres advisory lock (1498367052, 748638931) for history schema yodeler
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:72e612a5e19396d156fb886b20f936c8b1328c3e1dae33ba352f5d45787bdb92, by yodel at 2026-10-10T05:33:58.308Z
20261010T0533-index-placed-at: applying
  statement 0: ok (SQLPG240 concurrently, shop.orders_placed_at_idx)
  statement 1: ok (SQLPG240 concurrently, shop.orders_placed_at_idx)
20261010T0533-index-placed-at: applied

[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   5.8s
[phase] Approve
  ✓ gate:approve-migrate-dev()   1.6s
    [approved] yodel at 2026-10-10T05:33:58.308Z
[phase] Apply
  ✓ shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":"jcs1-sha256:72e612a5e19396d156fb886b20f936c8b1328c3e1dae33ba352f5d45787bdb92"})   9.6s
Op "migrate-dev" completed in 17.7s

Applied: 20261010T0533-index-placed-at.
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
  error    fork: 20261010T0533-add-gift and 20261010T0533-index-placed-at both follow 20261010T0533-drop-coupon; rebase one onto the other

20261010T0533-drop-coupon
  silenced destructive: step 0: SQLPG204 Drop a column on shop.orders: removes data that cannot be recovered
           reason: no order ever had a coupon; checked on dev

7 migrations: 1 error, 0 warnings, 1 silenced.
[exit 3]
```

`yodel rebase` moves one migration onto the other and writes its statements and recorded schema again. With `--env dev` it reads dev's history first, and refuses to move a migration that ran there:

<!-- quote: postgres#rebase-refused -->
```console
$ npx yodel rebase 20261010T0533-index-placed-at --onto 20261010T0533-add-gift --env dev
yodel rebase: refused: dev's history records 20261010T0533-index-placed-at (applied). Nothing was written. A migration that ran is never rebased: its statements already ran in that order. Rebase the other branch onto it instead (yodel rebase <the other> --onto <the end of this one>).
[exit 4]
```

The clean fix is the one it names: move `add-gift` after `index-placed-at`. To show what yodel does when a migration that ran is moved anyway (a rebase run without `--env`), this walkthrough moves `index-placed-at`:

<!-- quote: postgres#rebase -->
```console
$ npx yodel rebase 20261010T0533-index-placed-at --onto 20261010T0533-add-gift
Rebased 20261010T0533-index-placed-at onto 20261010T0533-add-gift (it followed 20261010T0533-drop-coupon).
  20261010T0533-index-placed-at: follows 20261010T0533-add-gift; 2 statements; checksum sha256:410404006edaf140669995ff0d58a50107c7c942b1a584969ea26f4f93495f27 -> sha256:cee769c87a775fc8908095c799c7a93f0f6ba16aaac3ba2e13464d09ff0f071d
No history was checked (--env): make sure none of these ran anywhere before merging.
```

Its files changed after it ran on dev, so dev's history no longer matches them. `yodel status` and `yodel apply` refuse (exit 4):

```console
$ npx yodel status dev
Migrations in dev (postgres 18.6 at 127.0.0.1:5432/postgres, history yodeler.history)

Applied (6):
  20261010T0531-baseline  2026-10-10 05:31:59.965821 by yodel@example
  20261010T0532-coupons  2026-10-10 05:32:19.532446 by yodel@example
  20261010T0532-validate-amount  2026-10-10 05:32:49.686972 by yodel@example
  20261010T0532-rename-email  2026-10-10 05:33:05.861373 by yodel@example
  20261010T0533-drop-coupon  2026-10-10 05:33:24.090984 by yodel@example
  20261010T0533-index-placed-at  2026-10-10 05:34:22.041695 by yodel@example

Pending (1):
  20261010T0533-add-gift  (out of order)

Out of order (1): 20261010T0533-add-gift; apply with --allow-out-of-order

Checksum mismatches (1):
  20261010T0533-index-placed-at was applied with checksum sha256:410404006edaf140669995ff0d58a50107c7c942b1a584969ea26f4f93495f27, but its files now hash to sha256:cee769c87a775fc8908095c799c7a93f0f6ba16aaac3ba2e13464d09ff0f071d; if the edit is intended, record it with yodel repair 20261010T0533-index-placed-at --reason ... <env>
[exit 4]
```

<!-- quote: postgres#checksum-refused -->
```console
$ npx yodel apply dev
yodel apply: refused: the history does not match the migrations directory; nothing was applied:
  20261010T0533-index-placed-at was applied with checksum sha256:410404006edaf140669995ff0d58a50107c7c942b1a584969ea26f4f93495f27, but its files now hash to sha256:cee769c87a775fc8908095c799c7a93f0f6ba16aaac3ba2e13464d09ff0f071d; if the edit is intended, record it with yodel repair 20261010T0533-index-placed-at --reason ... <env>
[exit 4]
```

The edit is intended: its statements are the same, only its parent changed. `yodel repair` records the new checksum, with the reason, in dev's history. Nothing runs on the server:

<!-- quote: postgres#repair -->
```console
$ npx yodel repair 20261010T0533-index-placed-at --reason 'rebased onto add-gift after it ran on dev' dev
Repaired 20261010T0533-index-placed-at in dev's history (yodeler).
  old checksum: sha256:410404006edaf140669995ff0d58a50107c7c942b1a584969ea26f4f93495f27
  new checksum: sha256:cee769c87a775fc8908095c799c7a93f0f6ba16aaac3ba2e13464d09ff0f071d
  reason: rebased onto add-gift after it ran on dev
```

Now `add-gift` comes before a migration dev has applied. It is out of order, and apply refuses it rather than skip it:

```console
$ npx yodel status dev
Migrations in dev (postgres 18.6 at 127.0.0.1:5432/postgres, history yodeler.history)

Applied (6):
  20261010T0531-baseline  2026-10-10 05:31:59.965821 by yodel@example
  20261010T0532-coupons  2026-10-10 05:32:19.532446 by yodel@example
  20261010T0532-validate-amount  2026-10-10 05:32:49.686972 by yodel@example
  20261010T0532-rename-email  2026-10-10 05:33:05.861373 by yodel@example
  20261010T0533-drop-coupon  2026-10-10 05:33:24.090984 by yodel@example
  20261010T0533-index-placed-at  2026-10-10 05:34:22.041695 by yodel@example
      repaired 2026-10-10 05:34:32.012861 by yodel@example: rebased onto add-gift after it ran on dev

Pending (1):
  20261010T0533-add-gift  (out of order)

Out of order (1): 20261010T0533-add-gift; apply with --allow-out-of-order
[exit 4]
```

<!-- quote: postgres#out-of-order -->
```console
$ npx yodel apply dev
yodel apply: refused: 20261010T0533-add-gift is out of order: the chain puts it before 20261010T0533-index-placed-at, which is already applied. Nothing was applied. Pass --allow-out-of-order to apply it now (in chain order); it is never skipped.
[exit 4]
```

Adding a column after the index changes nothing the index needs, so apply it out of order:

```console
$ npx yodel apply dev --allow-out-of-order
Migrations in dev (postgres 18.6 at 127.0.0.1:5432/postgres, history yodeler.history)

Applied (6):
  20261010T0531-baseline  2026-10-10 05:31:59.965821 by yodel@example
  20261010T0532-coupons  2026-10-10 05:32:19.532446 by yodel@example
  20261010T0532-validate-amount  2026-10-10 05:32:49.686972 by yodel@example
  20261010T0532-rename-email  2026-10-10 05:33:05.861373 by yodel@example
  20261010T0533-drop-coupon  2026-10-10 05:33:24.090984 by yodel@example
  20261010T0533-index-placed-at  2026-10-10 05:34:22.041695 by yodel@example
      repaired 2026-10-10 05:34:32.012861 by yodel@example: rebased onto add-gift after it ran on dev

Pending (1):
  20261010T0533-add-gift  (out of order)

Out of order (1): 20261010T0533-add-gift; apply with --allow-out-of-order

Plan digest: jcs1-sha256:1878c0839ddffd3f080512d43843abb8604befc6e1fcab3a1f0c2a52e6b72768

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   1.4s
[phase] Approve
  • gate:approve-migrate-dev()   skipped
    [refused] Gate "approve-migrate-dev" is approved, but not for this plan. approved: jcs1-sha256:72e612a5e19396d156fb886b20f936c8b1328c3e1dae33ba352f5d45787bdb92 (by yodel at 2026-10-10T05:33:58.308Z); planned: jcs1-sha256:1878c0839ddffd3f080512d43843abb8604befc6e1fcab3a1f0c2a52e6b72768. The configuration or the live system changed between that approval and this plan, so it needs a fresh one: chant approve migrate-dev approve-migrate-dev
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 2.3s
  plan    : jcs1-sha256:1878c0839ddffd3f080512d43843abb8604befc6e1fcab3a1f0c2a52e6b72768
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:1878c0839ddffd3f080512d43843abb8604befc6e1fcab3a1f0c2a52e6b72768
  expires : 2026-10-12T05:34:38.077Z

Nothing was applied. The approval of jcs1-sha256:72e612a5e19396d156fb886b20f936c8b1328c3e1dae33ba352f5d45787bdb92 (by yodel at 2026-10-10T05:33:58.308Z) does not hold: the plan moved since. What moved, as far as yodel can tell: history changed: applied since: 20261010T0533-index-placed-at (by yodel@example at 2026-10-10 05:34:22.041695); pending migrations changed: committed to since approval: 20261010T0533-index-placed-at (bad5be5 at 2026-10-09T23:34:28-06:00); live schema changed: as expected after the history change above: applying a migration changes the live schema, and yodel cannot rebuild the live schema as it was at approval, so it cannot confirm that nothing else in it changed.

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:1878c0839ddffd3f080512d43843abb8604befc6e1fcab3a1f0c2a52e6b72768).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:1878c0839ddffd3f080512d43843abb8604befc6e1fcab3a1f0c2a52e6b72768
or, at a terminal, with npx yodel approve dev, which shows the plan and asks you first;
then run npx yodel apply dev again.
[exit 3]
```

```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:1878c0839ddffd3f080512d43843abb8604befc6e1fcab3a1f0c2a52e6b72768
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-10T05:34:41.015Z
This approves the plan jcs1-sha256:1878c0839ddffd3f080512d43843abb8604befc6e1fcab3a1f0c2a52e6b72768, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

<!-- quote: postgres#out-of-order-apply -->
```console
$ npx yodel apply dev --allow-out-of-order
Migrations in dev (postgres 18.6 at 127.0.0.1:5432/postgres, history yodeler.history)

Applied (6):
  20261010T0531-baseline  2026-10-10 05:31:59.965821 by yodel@example
  20261010T0532-coupons  2026-10-10 05:32:19.532446 by yodel@example
  20261010T0532-validate-amount  2026-10-10 05:32:49.686972 by yodel@example
  20261010T0532-rename-email  2026-10-10 05:33:05.861373 by yodel@example
  20261010T0533-drop-coupon  2026-10-10 05:33:24.090984 by yodel@example
  20261010T0533-index-placed-at  2026-10-10 05:34:22.041695 by yodel@example
      repaired 2026-10-10 05:34:32.012861 by yodel@example: rebased onto add-gift after it ran on dev

Pending (1):
  20261010T0533-add-gift  (out of order)

Out of order (1): 20261010T0533-add-gift; apply with --allow-out-of-order

Plan digest: jcs1-sha256:1878c0839ddffd3f080512d43843abb8604befc6e1fcab3a1f0c2a52e6b72768

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
lock: held in Postgres advisory lock (1498367052, 748638931) for history schema yodeler
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:1878c0839ddffd3f080512d43843abb8604befc6e1fcab3a1f0c2a52e6b72768, by yodel at 2026-10-10T05:34:41.015Z
20261010T0533-add-gift: applying (out of order, allowed)
  statement 0: ok (SQLPG201 metadata, shop.orders)
20261010T0533-add-gift: applied

[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   1.2s
[phase] Approve
  ✓ gate:approve-migrate-dev()   286ms
    [approved] yodel at 2026-10-10T05:34:41.015Z
[phase] Apply
  ✓ shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":"jcs1-sha256:1878c0839ddffd3f080512d43843abb8604befc6e1fcab3a1f0c2a52e6b72768"})   1.2s
Op "migrate-dev" completed in 2.9s

Applied: 20261010T0533-add-gift.
```

`yodel status` lists `index-placed-at` as applied when it ran, and the repair under it:

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

## 8. Drift

Someone changes a default by hand:

```sql
ALTER TABLE shop.orders ALTER COLUMN status SET DEFAULT 'new'
```

```console
$ npx yodel drift dev
Drift in dev (postgres 18.6 at 127.0.0.1:5432/postgres)

Changed out of band:
  orders (Postgres::Table)
    column status default: declared 'placed'::text, live 'new'::text
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
  ✓ lifecycleSnapshot(env=dev)   1.2s
[phase] Diff
  ✓ lifecycleDiff(env=dev, live=true)   968ms
    [outcome] Drift=true
Op "watch-dev" completed in 2.4s
```

`chant run` exits 0 when the watch completes, drift or not; the drift is the run's `Drift` outcome. Put the default back:

```sql
ALTER TABLE shop.orders ALTER COLUMN status SET DEFAULT 'placed'
```

```console
$ npx yodel drift dev
Drift in dev (postgres 18.6 at 127.0.0.1:5432/postgres)

No drift: every declared object matches the server.
```

## 9. The replay check

`yodel lint --replay replay --reset` replays every migration, in order, into the server the `replay` profile names, and compares each with the schema it recorded. In CI that profile points at a throwaway server the job starts. Here it points at the same emulator as dev, so the replay empties dev's schema; `--reset-shared dev` says that is intended, and the check runs last:

```console
$ npx yodel lint --replay replay --reset --reset-shared dev
replay: emptying shop on postgres://127.0.0.1:5432/postgres (sql.profiles.replay)
replay: 20261010T0531-baseline: replaying
replay: 20261010T0531-baseline: matches its recorded schema
replay: 20261010T0532-coupons: replaying
replay: 20261010T0532-coupons: matches its recorded schema
replay: 20261010T0532-validate-amount: replaying
replay: 20261010T0532-validate-amount: matches its recorded schema
replay: 20261010T0532-rename-email: replaying
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
COMMENT ON COLUMN shop.orders.customer_email IS 'chant migration of shop.orders.email: the old name, kept until 2026-10-10T05:34:57.173Z [chant managed-by=chant migration=shop.orders.email role=old retain-until=2026-10-10T05%3A34%3A57.173Z]'
DROP TRIGGER email__chant_sync ON shop.orders
DROP FUNCTION shop.orders__email__chant_sync()
ALTER TABLE shop.orders DROP COLUMN customer_email
replay: 20261010T0532-rename-email: matches its recorded schema
replay: 20261010T0533-drop-coupon: replaying
replay: 20261010T0533-drop-coupon: matches its recorded schema
replay: 20261010T0533-add-gift: replaying
replay: 20261010T0533-add-gift: matches its recorded schema
replay: 20261010T0533-index-placed-at: replaying
replay: 20261010T0533-index-placed-at: matches its recorded schema
Replay of 7 migrations (postgres) into postgres://127.0.0.1:5432/postgres (sql.profiles.replay)
  schemas: shop (emptied first)
  ok      20261010T0531-baseline (6 statements)
  ok      20261010T0532-coupons (2 statements)
  ok      20261010T0532-validate-amount (2 statements)
  ok      20261010T0532-rename-email (0 statements; ran step 0: PostgresMigrationOp for orders (shop.orders) (switched, old column dropped))
  ok      20261010T0533-drop-coupon (1 statement)
  ok      20261010T0533-add-gift (1 statement)
  ok      20261010T0533-index-placed-at (2 statements)
Every migration replays to its recorded schema.

20261010T0533-drop-coupon
  silenced destructive: step 0: SQLPG204 Drop a column on shop.orders: removes data that cannot be recovered
           reason: no order ever had a coupon; checked on dev

7 migrations: 0 errors, 0 warnings, 1 silenced.
```
