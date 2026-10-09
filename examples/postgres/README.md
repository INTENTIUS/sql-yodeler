# Postgres example

A Postgres schema taken from the declarative path to versioned migrations: adoption with `yodel init --from`, lint findings and a silence, a migration that fails part way and resumes, a column rename run as a `PostgresMigrationOp` step, two branches that fork the history (rebase, repair, out of order), drift, and the replay check. Every command below ran against the emulator (`chant emulator up --lexicon sql`), and the output under each is what it printed. `examples/walkthrough/postgres.ts` holds the steps; `npx tsx examples/walkthrough/run.ts postgres --write` runs them again and rewrites this file and the project files from the run.

The project in this directory is what the walkthrough leaves: `src/schema.ts`, the migrations it wrote, and the two Ops.

To run it yourself, from a clone of this repository:

```sh
npm ci && npm run build          # in the repository root
chant emulator up --lexicon sql  # or any Postgres you can drop schema yodel_18_shop on
cd examples/postgres
npm install                      # takes @intentius/sql-yodeler from ../..
export DEV_POSTGRES_URL=postgres://127.0.0.1:5432/postgres DEV_POSTGRES_USER=postgres DEV_POSTGRES_PASSWORD=...
```

The run happened in a temporary copy of this directory, a git repository with a local `origin`; its path is shown as `<tmp>`. A command that exited with a code other than 0 ends with `[exit <code>]`.

## 1. A declared schema, applied without migrations

The project starts on the declarative path: `src/schema.ts` says what the schema should be, and an `ApplyOp` applies it. There is no `migrations/` directory, so `yodel plan` and `yodel apply` diff the declared schema against the live database. `package.json` has a `build` script (`chant build src --lexicon sql -o dist/schema.json`), which the `ApplyOp` runs first.

`src/schema.ts`:

```ts
import { index, schema, table } from "@intentius/chant-lexicon-sql/postgres";

export const shop = schema`
  CREATE SCHEMA yodel_18_shop;
  COMMENT ON SCHEMA yodel_18_shop IS 'The SQL Yodeler Postgres example'`;

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

shop (yodel_18_shop)
  [create] schema: yodel_18_shop
      SQLPG200 Create an object. A new object is created; nothing existing changes. A table created in the same plan as its indexes needs no CONCURRENTLY. https://www.postgresql.org/docs/18/sql-createtable.html
orders (yodel_18_shop.orders)
  [create] table: yodel_18_shop.orders
      SQLPG200 Create an object. A new object is created; nothing existing changes. A table created in the same plan as its indexes needs no CONCURRENTLY. https://www.postgresql.org/docs/18/sql-createtable.html
ordersStatus (yodel_18_shop.orders_status_idx)
  [create] index: yodel_18_shop.orders_status_idx
      SQLPG200 Create an object. A new object is created; nothing existing changes. A table created in the same plan as its indexes needs no CONCURRENTLY. https://www.postgresql.org/docs/18/sql-createtable.html

3 create
```

`yodel apply dev` stops at the `ApplyOp`'s gate, which wants an approval of this exact plan, and exits 3:

```console
$ npx yodel apply dev
Plan for dev (postgres, sql.profiles.dev)

shop (yodel_18_shop)
  [create] schema: yodel_18_shop
      SQLPG200 Create an object. A new object is created; nothing existing changes. A table created in the same plan as its indexes needs no CONCURRENTLY. https://www.postgresql.org/docs/18/sql-createtable.html
orders (yodel_18_shop.orders)
  [create] table: yodel_18_shop.orders
      SQLPG200 Create an object. A new object is created; nothing existing changes. A table created in the same plan as its indexes needs no CONCURRENTLY. https://www.postgresql.org/docs/18/sql-createtable.html
ordersStatus (yodel_18_shop.orders_status_idx)
  [create] index: yodel_18_shop.orders_status_idx
      SQLPG200 Create an object. A new object is created; nothing existing changes. A table created in the same plan as its indexes needs no CONCURRENTLY. https://www.postgresql.org/docs/18/sql-createtable.html

3 create

Running apply-dev (<tmp>/postgres/ops/apply-dev.op.ts)

> sql-yodeler-example-postgres@0.0.0 build
> chant build src --lexicon sql -o dist/schema.json


fold: 1 file folded, 0 ran
warning: [orders] orders.customer_email looks like a secret or personal data and neither it nor yodel_18_shop.orders has a COMMENT; say what it holds and how it is protected (sql)

sql — environment: dev
3 missing, 0 orphan, 0 disappeared, 0 newly observed, 0 drifted, 0 unchanged
--------------------------------------------------------------------------------

MISSING (declared, provider reports not in cloud):
  - orders [queried postgres://192.168.14.189:5432/postgres yodel_18_shop.orders] [definition eb7abb434076eead077584404a122bb9f293ade10fc398c6104c7384ec01e2db]
  - ordersStatus [queried postgres://192.168.14.189:5432/postgres yodel_18_shop.orders_status_idx] [definition 4fae1924c6032f650edb0601866fcce4a474afa33d5974a37bc3022fe01257e3]
  - shop [queried postgres://192.168.14.189:5432/postgres yodel_18_shop] [definition 071741bed2db2a5cdbaba83354aacb249b2d2f7d4bb56724a229cd927a05f727]
[phase] Build
  ✓ chantBuild(path=.)   1.4s
[phase] Plan
  ✓ lifecycleDiff(env=dev, live=true)   1.2s
    [outcome] Drift=true
[phase] Approve
  • gate:approve-apply-dev()   skipped
[phase] Apply
  • nativeApply(target=postgres, env=dev, output=dist/schema.json, deleteMode=never)   skipped
Op "apply-dev" is gated on "approve-apply-dev" after 3.7s
  Approve apply to dev (delete mode: never)
  plan    : jcs1-sha256:eed25cb37c4ed9d484949d21b1db67ff39ce60d74038c77efa9c3f6e9d5b772c
  approve : chant approve apply-dev approve-apply-dev --plan jcs1-sha256:eed25cb37c4ed9d484949d21b1db67ff39ce60d74038c77efa9c3f6e9d5b772c
  expires : 2026-10-11T20:36:37.580Z

apply-dev is waiting at gate "approve-apply-dev" for approval of this plan.
Approve it with:
  chant approve apply-dev approve-apply-dev --plan jcs1-sha256:eed25cb37c4ed9d484949d21b1db67ff39ce60d74038c77efa9c3f6e9d5b772c
then run yodel apply dev again.
[exit 3]
```

```console
$ npx chant approve apply-dev approve-apply-dev --plan jcs1-sha256:eed25cb37c4ed9d484949d21b1db67ff39ce60d74038c77efa9c3f6e9d5b772c
Gate "approve-apply-dev" on "apply-dev" resolved by yodel at 2026-10-09T20:36:40.363Z
This approves the plan jcs1-sha256:eed25cb37c4ed9d484949d21b1db67ff39ce60d74038c77efa9c3f6e9d5b772c, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run apply-dev` and it walks through gate "approve-apply-dev".
```

```console
$ npx yodel apply dev
Plan for dev (postgres, sql.profiles.dev)

shop (yodel_18_shop)
  [create] schema: yodel_18_shop
      SQLPG200 Create an object. A new object is created; nothing existing changes. A table created in the same plan as its indexes needs no CONCURRENTLY. https://www.postgresql.org/docs/18/sql-createtable.html
orders (yodel_18_shop.orders)
  [create] table: yodel_18_shop.orders
      SQLPG200 Create an object. A new object is created; nothing existing changes. A table created in the same plan as its indexes needs no CONCURRENTLY. https://www.postgresql.org/docs/18/sql-createtable.html
ordersStatus (yodel_18_shop.orders_status_idx)
  [create] index: yodel_18_shop.orders_status_idx
      SQLPG200 Create an object. A new object is created; nothing existing changes. A table created in the same plan as its indexes needs no CONCURRENTLY. https://www.postgresql.org/docs/18/sql-createtable.html

3 create

Running apply-dev (<tmp>/postgres/ops/apply-dev.op.ts)

> sql-yodeler-example-postgres@0.0.0 build
> chant build src --lexicon sql -o dist/schema.json


fold: 1 file folded, 0 ran
warning: [orders] orders.customer_email looks like a secret or personal data and neither it nor yodel_18_shop.orders has a COMMENT; say what it holds and how it is protected (sql)

sql — environment: dev
3 missing, 0 orphan, 0 disappeared, 0 newly observed, 0 drifted, 0 unchanged
--------------------------------------------------------------------------------

MISSING (declared, provider reports not in cloud):
  - orders [queried postgres://192.168.14.189:5432/postgres yodel_18_shop.orders] [definition eb7abb434076eead077584404a122bb9f293ade10fc398c6104c7384ec01e2db]
  - ordersStatus [queried postgres://192.168.14.189:5432/postgres yodel_18_shop.orders_status_idx] [definition 4fae1924c6032f650edb0601866fcce4a474afa33d5974a37bc3022fe01257e3]
  - shop [queried postgres://192.168.14.189:5432/postgres yodel_18_shop] [definition 071741bed2db2a5cdbaba83354aacb249b2d2f7d4bb56724a229cd927a05f727]
BEGIN
SET LOCAL lock_timeout = '5000ms'
SET LOCAL statement_timeout = '60000ms'
CREATE SCHEMA yodel_18_shop
SET LOCAL lock_timeout = '5000ms'
SET LOCAL statement_timeout = '60000ms'
COMMENT ON SCHEMA yodel_18_shop IS 'The SQL Yodeler Postgres example [chant managed-by=chant]'
SET LOCAL lock_timeout = '5000ms'
SET LOCAL statement_timeout = '60000ms'
CREATE TABLE yodel_18_shop.orders (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_email text NOT NULL,
    status         text NOT NULL DEFAULT 'placed',
    amount         numeric(12, 2) NOT NULL,
    placed_at      timestamptz NOT NULL DEFAULT now()
  )
SET LOCAL lock_timeout = '5000ms'
SET LOCAL statement_timeout = '60000ms'
COMMENT ON TABLE yodel_18_shop.orders IS '[chant managed-by=chant]'
SET LOCAL lock_timeout = '5000ms'
SET LOCAL statement_timeout = '60000ms'
CREATE INDEX orders_status_idx ON yodel_18_shop.orders (status)
SET LOCAL lock_timeout = '5000ms'
SET LOCAL statement_timeout = '60000ms'
COMMENT ON INDEX yodel_18_shop.orders_status_idx IS '[chant managed-by=chant]'
COMMIT
created: Postgres::Schema/yodel_18_shop
created: Postgres::Table/yodel_18_shop.orders
created: Postgres::Index/yodel_18_shop.orders_status_idx
[dev] applied 3 resource(s)
[phase] Build
  ✓ chantBuild(path=.)   1.1s
[phase] Plan
  ✓ lifecycleDiff(env=dev, live=true)   1.2s
    [outcome] Drift=true
[phase] Approve
  ✓ gate:approve-apply-dev()   330ms
    [approved] yodel at 2026-10-09T20:36:40.363Z
[phase] Apply
  ✓ nativeApply(target=postgres, env=dev, output=dist/schema.json, deleteMode=never)   61ms
Op "apply-dev" completed in 2.9s

Applied: dev matches the declared schema.
```

## 2. Adopting the schema into versioned migrations

Orders arrive, one of them a free sample with an amount of 0:

```sql
INSERT INTO yodel_18_shop.orders (customer_email, status, amount, placed_at)
SELECT 'customer' || (n % 40) || '@example.com', (ARRAY['placed', 'paid', 'shipped'])[n % 3 + 1], (n * 7 % 500) + 0.99, timestamptz '2026-06-01' + n * interval '5 hours'
FROM generate_series(1, 300) AS n;
INSERT INTO yodel_18_shop.orders (customer_email, amount) VALUES ('sample@example.com', 0)
```

`yodel init --from dev` reads the live schema, writes its declarations to `src/`, checks they plan clean, writes the baseline migration and records it applied in dev's history without running it. `--force` because `src/schema.ts` is already there:

```console
$ npx yodel init --from dev --force
read 3 object(s) from dev
wrote src/schema.ts
planned against dev: no change
wrote migrations/20261009T2036-baseline (6 statements)
recorded 20261009T2036-baseline applied in yodel_18_history.history as a baseline; none of its statements was run
Adopted dev (postgres): 3 objects
  Schema yodel_18_shop
  Table yodel_18_shop.orders
  Index yodel_18_shop.orders_status_idx

Declarations: src/schema.ts
Baseline:     migrations/20261009T2036-baseline/ (6 statements, sha256:06302f2b66331957530b59a09baa1ee002d0e7d3b1c471a93fd7d411a98459bd)
Recorded:     applied in yodel_18_history.history as a baseline; none of its statements was run

yodel plan dev shows no change, and yodel status dev lists the baseline applied.
```

`src/schema.ts`:

```ts
import { index, schema, table } from "@intentius/chant-lexicon-sql/postgres";

export const yodel18ShopSchema = schema`
  CREATE SCHEMA yodel_18_shop;
  COMMENT ON SCHEMA yodel_18_shop IS 'The SQL Yodeler Postgres example'`;

export const orders = table`
  CREATE TABLE ${yodel18ShopSchema}.orders (
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
Migrations in dev (history yodel_18_history.history)

Applied (1):
  20261009T2036-baseline  2026-10-09 20:36:48.811764 by yodel@example

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

export const yodel18ShopSchema = schema`
  CREATE SCHEMA yodel_18_shop;
  COMMENT ON SCHEMA yodel_18_shop IS 'The SQL Yodeler Postgres example'`;

export const orders = table`
  CREATE TABLE ${yodel18ShopSchema}.orders (
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
Wrote migrations/20261009T2037-coupons/ (2 statements; follows 20261009T2036-baseline)
```

```console
$ npx yodel lint
20261009T2037-coupons
  error    pg-rewrite: step 1: SQLPG218 Add a CHECK constraint on yodel_18_shop.orders: blocks reads and writes on the table while it runs (ADD CONSTRAINT ... CHECK reads every row under ACCESS EXCLUSIVE. Declare it NOT VALID, then remove NOT VALID to validate it under SHARE UPDATE EXCLUSIVE (SQLPG220).)

A statement rule can be silenced for one statement, with a reason the history records when it applies:
  a line `-- yodel:allow <rule> <reason>` above the statement in migration.sql

2 migrations: 1 error, 0 warnings, 0 silenced.
[exit 3]
```

Do as the finding says: delete the migration, declare the constraint `NOT VALID`, and write it again:

```console
$ rm -r migrations/20261009T2037-coupons
```

```console
$ npx yodel new coupons
Wrote migrations/20261009T2037-coupons/ (2 statements; follows 20261009T2036-baseline)
```

`migrations/20261009T2037-coupons/migration.sql`:

```sql
-- yodel migration 20261009T2037-coupons
-- parent: 20261009T2036-baseline

-- orders (yodel_18_shop.orders): SQLPG201 metadata
ALTER TABLE yodel_18_shop.orders ADD COLUMN coupon text;

-- orders (yodel_18_shop.orders): SQLPG217 metadata
ALTER TABLE yodel_18_shop.orders ADD CONSTRAINT orders_amount_positive CHECK (amount > 0) NOT VALID;
```

```console
$ npx yodel lint
2 migrations: 0 errors, 0 warnings, 0 silenced.
```

```console
$ npx yodel plan dev
Plan for dev (postgres, history yodel_18_history.history): 1 applied, 1 pending

20261009T2037-coupons
  0  statement  SQLPG201 metadata  yodel_18_shop.orders
       ALTER TABLE yodel_18_shop.orders ADD COLUMN coupon text
  1  statement  SQLPG217 metadata  yodel_18_shop.orders
       ALTER TABLE yodel_18_shop.orders ADD CONSTRAINT orders_amount_positive CHECK (amount > 0) NOT VALID

Plan digest: jcs1-sha256:66f97a19126ae53858e9a94347e6ff327f26d2aae7d178678000e8189dcc2bac
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:66f97a19126ae53858e9a94347e6ff327f26d2aae7d178678000e8189dcc2bac

Not approved yet. Approving binds exactly this digest; if anything it covers changes before the apply runs, the gate asks again and nothing is applied.
```

```console
$ npx yodel apply dev
Migrations in dev (history yodel_18_history.history)

Applied (1):
  20261009T2036-baseline  2026-10-09 20:36:48.811764 by yodel@example

Pending (1):
  20261009T2037-coupons

Plan digest: jcs1-sha256:66f97a19126ae53858e9a94347e6ff327f26d2aae7d178678000e8189dcc2bac

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   4.1s
[phase] Approve
  • gate:approve-migrate-dev()   skipped
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 5.2s
  plan    : jcs1-sha256:66f97a19126ae53858e9a94347e6ff327f26d2aae7d178678000e8189dcc2bac
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:66f97a19126ae53858e9a94347e6ff327f26d2aae7d178678000e8189dcc2bac
  expires : 2026-10-11T20:37:34.760Z

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:66f97a19126ae53858e9a94347e6ff327f26d2aae7d178678000e8189dcc2bac).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:66f97a19126ae53858e9a94347e6ff327f26d2aae7d178678000e8189dcc2bac
then run yodel apply dev again.
[exit 3]
```

```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:66f97a19126ae53858e9a94347e6ff327f26d2aae7d178678000e8189dcc2bac
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-09T20:37:38.091Z
This approves the plan jcs1-sha256:66f97a19126ae53858e9a94347e6ff327f26d2aae7d178678000e8189dcc2bac, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

On Postgres the apply lock is an advisory lock:

```console
$ npx yodel apply dev
Migrations in dev (history yodel_18_history.history)

Applied (1):
  20261009T2036-baseline  2026-10-09 20:36:48.811764 by yodel@example

Pending (1):
  20261009T2037-coupons

Plan digest: jcs1-sha256:66f97a19126ae53858e9a94347e6ff327f26d2aae7d178678000e8189dcc2bac

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
lock: held in Postgres advisory lock (1498367052, 1669956748) for history schema yodel_18_history
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:66f97a19126ae53858e9a94347e6ff327f26d2aae7d178678000e8189dcc2bac, by yodel at 2026-10-09T20:37:38.091Z
20261009T2037-coupons: applying
  statement 0: ok (SQLPG201 metadata, yodel_18_shop.orders)
  statement 1: ok (SQLPG217 metadata, yodel_18_shop.orders)
20261009T2037-coupons: applied

[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   1.5s
[phase] Approve
  ✓ gate:approve-migrate-dev()   334ms
    [approved] yodel at 2026-10-09T20:37:38.091Z
[phase] Apply
  ✓ shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":"jcs1-sha256:66f97a19126ae53858e9a94347e6ff327f26d2aae7d178678000e8189dcc2bac"})   3.3s
Op "migrate-dev" completed in 5.4s

Applied: 20261009T2037-coupons.
```

## 4. A migration that fails part way, and resumes

Validate the constraint, and add a column in the same migration:

`src/schema.ts` now:

```ts
import { index, schema, table } from "@intentius/chant-lexicon-sql/postgres";

export const yodel18ShopSchema = schema`
  CREATE SCHEMA yodel_18_shop;
  COMMENT ON SCHEMA yodel_18_shop IS 'The SQL Yodeler Postgres example'`;

export const orders = table`
  CREATE TABLE ${yodel18ShopSchema}.orders (
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
Wrote migrations/20261009T2037-validate-amount/ (2 statements; follows 20261009T2037-coupons)
```

`migrations/20261009T2037-validate-amount/migration.sql`:

```sql
-- yodel migration 20261009T2037-validate-amount
-- parent: 20261009T2037-coupons

-- orders (yodel_18_shop.orders): SQLPG201 metadata
ALTER TABLE yodel_18_shop.orders ADD COLUMN refunded_at timestamp with time zone;

-- orders (yodel_18_shop.orders): SQLPG220 validate
ALTER TABLE yodel_18_shop.orders VALIDATE CONSTRAINT orders_amount_positive;
```

```console
$ npx yodel apply dev
Migrations in dev (history yodel_18_history.history)

Applied (2):
  20261009T2036-baseline  2026-10-09 20:36:48.811764 by yodel@example
  20261009T2037-coupons  2026-10-09 20:37:44.294634 by yodel@example

Pending (1):
  20261009T2037-validate-amount

Plan digest: jcs1-sha256:2abc0948f5f7a874be6ec41bf325c9d9e1b4da5a10af42eb6e7feeae41adbd9b

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   1.2s
[phase] Approve
  • gate:approve-migrate-dev()   skipped
    [refused] Gate "approve-migrate-dev" is approved, but not for this plan. approved: jcs1-sha256:66f97a19126ae53858e9a94347e6ff327f26d2aae7d178678000e8189dcc2bac (by yodel at 2026-10-09T20:37:38.091Z); planned: jcs1-sha256:2abc0948f5f7a874be6ec41bf325c9d9e1b4da5a10af42eb6e7feeae41adbd9b. The configuration or the live system changed between that approval and this plan, so it needs a fresh one: chant approve migrate-dev approve-migrate-dev
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 2.4s
  plan    : jcs1-sha256:2abc0948f5f7a874be6ec41bf325c9d9e1b4da5a10af42eb6e7feeae41adbd9b
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:2abc0948f5f7a874be6ec41bf325c9d9e1b4da5a10af42eb6e7feeae41adbd9b
  expires : 2026-10-11T20:37:52.101Z

Nothing was applied. The approval of jcs1-sha256:66f97a19126ae53858e9a94347e6ff327f26d2aae7d178678000e8189dcc2bac (by yodel at 2026-10-09T20:37:38.091Z) does not hold: the plan moved since. What moved, as far as yodel can tell: history changed: applied since: 20261009T2037-coupons (by yodel@example at 2026-10-09 20:37:44.294634); pending migrations changed: committed to since approval: 20261009T2037-validate-amount (9ea4598 at 2026-10-09T14:37:48-06:00); live schema changed: no state yodel can rebuild from the history and git hashes to the approved digest with today's live schema, so an object in the environment's live schema (a table, view, index, dictionary, database or schema) changed since approval (or a part yodel cannot rebuild did).

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:2abc0948f5f7a874be6ec41bf325c9d9e1b4da5a10af42eb6e7feeae41adbd9b).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:2abc0948f5f7a874be6ec41bf325c9d9e1b4da5a10af42eb6e7feeae41adbd9b
then run yodel apply dev again.
[exit 3]
```

```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:2abc0948f5f7a874be6ec41bf325c9d9e1b4da5a10af42eb6e7feeae41adbd9b
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-09T20:37:55.922Z
This approves the plan jcs1-sha256:2abc0948f5f7a874be6ec41bf325c9d9e1b4da5a10af42eb6e7feeae41adbd9b, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

The free sample breaks the constraint. Statement 0 ran and is recorded; statement 1 failed:

```console
$ npx yodel apply dev
Migrations in dev (history yodel_18_history.history)

Applied (2):
  20261009T2036-baseline  2026-10-09 20:36:48.811764 by yodel@example
  20261009T2037-coupons  2026-10-09 20:37:44.294634 by yodel@example

Pending (1):
  20261009T2037-validate-amount

Plan digest: jcs1-sha256:2abc0948f5f7a874be6ec41bf325c9d9e1b4da5a10af42eb6e7feeae41adbd9b

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   972ms
[phase] Approve
  ✓ gate:approve-migrate-dev()   268ms
    [approved] yodel at 2026-10-09T20:37:55.922Z
[phase] Apply
  ✗ shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":"jcs1-sha256:2abc0948f5f7a874be6ec41bf325c9d9e1b4da5a10af42eb6e7feeae41adbd9b"})   1.1s
    command exited 1 (expected 0): Command failed: yodel apply dev --execute
lock: held in Postgres advisory lock (1498367052, 1669956748) for history schema yodel_18_history
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:2abc0948f5f7a874be6ec41bf325c9d9e1b4da5a10af42eb6e7feeae41adbd9b, by yodel at 2026-10-09T20:37:55.922Z
20261009T2037-validate-amount: applying
  statement 0: ok (SQLPG201 metadata, yodel_18_shop.orders)
  statement 1: failed: check constraint "orders_amount_positive" of relation "orders" is violated by some row
yodel apply: 20261009T2037-validate-amount failed at statement 1: check constraint "orders_amount_positive" of relation "orders" is violated by some row
Fix the cause (on the server, or that statement in the migration's files), then run yodel apply again: it resumes at statement 1 and never sends again the statements that succeeded.

Op "migrate-dev" failed after 2.5s
yodel apply: chant run migrate-dev failed (exit 1)

Migrations in dev (history yodel_18_history.history)

Applied (2):
  20261009T2036-baseline  2026-10-09 20:36:48.811764 by yodel@example
  20261009T2037-coupons  2026-10-09 20:37:44.294634 by yodel@example

Pending (1):
  20261009T2037-validate-amount  (failed part way at statement 1; resumes at statement 1)
      error: statement 1: check constraint "orders_amount_positive" of relation "orders" is violated by some row

Plan digest: jcs1-sha256:b6065a990bfcf25ece55903263a0418c635ba6a6858e775166bb73279dfe9408
[exit 1]
```

```console
$ npx yodel status dev
Migrations in dev (history yodel_18_history.history)

Applied (2):
  20261009T2036-baseline  2026-10-09 20:36:48.811764 by yodel@example
  20261009T2037-coupons  2026-10-09 20:37:44.294634 by yodel@example

Pending (1):
  20261009T2037-validate-amount  (failed part way at statement 1; resumes at statement 1)
      error: statement 1: check constraint "orders_amount_positive" of relation "orders" is violated by some row

Plan digest: jcs1-sha256:b6065a990bfcf25ece55903263a0418c635ba6a6858e775166bb73279dfe9408
[exit 3]
```

Fix the data. The history changed since the approval (statement 0 ran), so the digest moved and the gate asks again:

```sql
UPDATE yodel_18_shop.orders SET amount = 0.01 WHERE amount <= 0
```

```console
$ npx yodel apply dev
Migrations in dev (history yodel_18_history.history)

Applied (2):
  20261009T2036-baseline  2026-10-09 20:36:48.811764 by yodel@example
  20261009T2037-coupons  2026-10-09 20:37:44.294634 by yodel@example

Pending (1):
  20261009T2037-validate-amount  (failed part way at statement 1; resumes at statement 1)
      error: statement 1: check constraint "orders_amount_positive" of relation "orders" is violated by some row

Plan digest: jcs1-sha256:b6065a990bfcf25ece55903263a0418c635ba6a6858e775166bb73279dfe9408

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   1.0s
[phase] Approve
  • gate:approve-migrate-dev()   skipped
    [refused] Gate "approve-migrate-dev" is approved, but not for this plan. approved: jcs1-sha256:2abc0948f5f7a874be6ec41bf325c9d9e1b4da5a10af42eb6e7feeae41adbd9b (by yodel at 2026-10-09T20:37:55.922Z); planned: jcs1-sha256:b6065a990bfcf25ece55903263a0418c635ba6a6858e775166bb73279dfe9408. The configuration or the live system changed between that approval and this plan, so it needs a fresh one: chant approve migrate-dev approve-migrate-dev
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 2.0s
  plan    : jcs1-sha256:b6065a990bfcf25ece55903263a0418c635ba6a6858e775166bb73279dfe9408
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:b6065a990bfcf25ece55903263a0418c635ba6a6858e775166bb73279dfe9408
  expires : 2026-10-11T20:38:04.144Z

Nothing was applied. The approval of jcs1-sha256:2abc0948f5f7a874be6ec41bf325c9d9e1b4da5a10af42eb6e7feeae41adbd9b (by yodel at 2026-10-09T20:37:55.922Z) does not hold: the plan moved since. What moved, as far as yodel can tell: history changed: 20261009T2037-validate-amount ran part way since: statements 0 done now; live schema changed: no state yodel can rebuild from the history and git hashes to the approved digest with today's live schema, so an object in the environment's live schema (a table, view, index, dictionary, database or schema) changed since approval (or a part yodel cannot rebuild did).

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:b6065a990bfcf25ece55903263a0418c635ba6a6858e775166bb73279dfe9408).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:b6065a990bfcf25ece55903263a0418c635ba6a6858e775166bb73279dfe9408
then run yodel apply dev again.
[exit 3]
```

```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:b6065a990bfcf25ece55903263a0418c635ba6a6858e775166bb73279dfe9408
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-09T20:38:06.881Z
This approves the plan jcs1-sha256:b6065a990bfcf25ece55903263a0418c635ba6a6858e775166bb73279dfe9408, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

```console
$ npx yodel apply dev
Migrations in dev (history yodel_18_history.history)

Applied (2):
  20261009T2036-baseline  2026-10-09 20:36:48.811764 by yodel@example
  20261009T2037-coupons  2026-10-09 20:37:44.294634 by yodel@example

Pending (1):
  20261009T2037-validate-amount  (failed part way at statement 1; resumes at statement 1)
      error: statement 1: check constraint "orders_amount_positive" of relation "orders" is violated by some row

Plan digest: jcs1-sha256:b6065a990bfcf25ece55903263a0418c635ba6a6858e775166bb73279dfe9408

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
lock: held in Postgres advisory lock (1498367052, 1669956748) for history schema yodel_18_history
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:b6065a990bfcf25ece55903263a0418c635ba6a6858e775166bb73279dfe9408, by yodel at 2026-10-09T20:38:06.881Z
20261009T2037-validate-amount: resuming at statement 1
  statement 0: succeeded in an earlier run; not sent
  statement 1: ok (SQLPG220 validate, yodel_18_shop.orders)
20261009T2037-validate-amount: applied

[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   1.0s
[phase] Approve
  ✓ gate:approve-migrate-dev()   256ms
    [approved] yodel at 2026-10-09T20:38:06.881Z
[phase] Apply
  ✓ shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":"jcs1-sha256:b6065a990bfcf25ece55903263a0418c635ba6a6858e775166bb73279dfe9408"})   1.1s
Op "migrate-dev" completed in 2.5s

Applied: 20261009T2037-validate-amount.
```

## 5. A column rename: a PostgresMigrationOp step

Renaming `customer_email` to `email` in place would break every reader still using the old name. Declare the new name with `-- previously: <old name>` on its line, and `yodel new` writes the change as a `PostgresMigrationOp` step: add the new column, keep both written with a trigger, backfill, verify, switch, and drop the old column. The step adds the new column at the end of the table, so declare it last; see [issue #47](https://github.com/INTENTIUS/sql-yodeler/issues/47) for what happens to drift otherwise.

`src/schema.ts` now:

```ts
import { index, schema, table } from "@intentius/chant-lexicon-sql/postgres";

export const yodel18ShopSchema = schema`
  CREATE SCHEMA yodel_18_shop;
  COMMENT ON SCHEMA yodel_18_shop IS 'The SQL Yodeler Postgres example'`;

export const orders = table`
  CREATE TABLE ${yodel18ShopSchema}.orders (
      id bigint GENERATED ALWAYS AS IDENTITY,
      status text DEFAULT 'placed'::text NOT NULL,
      amount numeric(12,2) NOT NULL,
      placed_at timestamp with time zone DEFAULT now() NOT NULL,
      coupon text,
      refunded_at timestamp with time zone,
      email text NOT NULL, -- previously: customer_email
      CONSTRAINT orders_pkey PRIMARY KEY (id),
      CONSTRAINT orders_amount_positive CHECK (amount > 0)
  )`;

export const ordersStatusIdx = index`
  CREATE INDEX orders_status_idx ON ${orders} USING btree (status)`;
```

```console
$ npx yodel new rename-email
Wrote migrations/20261009T2038-rename-email/ (0 statements; follows 20261009T2037-validate-amount)
  This migration contains an Op step: PostgresMigrationOp for orders (yodel_18_shop.orders), SQLPG205.
    It is not SQL. migration.json holds the Op's declaration:
    export const { op } = PostgresMigrationOp({ name: "migrate-yodel-18-shop-orders-email", env: "<env>", table: "yodel_18_shop.orders", column: "email" });
```

`migrations/20261009T2038-rename-email/migration.sql`:

```sql
-- yodel migration 20261009T2038-rename-email
-- parent: 20261009T2037-validate-amount
-- This migration contains an Op step, not only SQL:
--   PostgresMigrationOp for orders (yodel_18_shop.orders), SQLPG205: not SQL; migration.json holds its declaration

-- orders (yodel_18_shop.orders): SQLPG205 made by PostgresMigrationOp, not a statement:
--   export const { op } = PostgresMigrationOp({ name: "migrate-yodel-18-shop-orders-email", env: "<env>", table: "yodel_18_shop.orders", column: "email" });
```

```console
$ npx yodel plan dev
Plan for dev (postgres, history yodel_18_history.history): 3 applied, 1 pending

20261009T2038-rename-email
  0  Op PostgresMigrationOp  SQLPG205 expand  yodel_18_shop.orders
       yodel_18_shop.orders needs expand and contract, which no in-place statement makes, so nothing was sent for it. SQLPG205 Rename a column (columns.email customer_email -> email): RENAME COLUMN is a catalog change, but every reader still using the old name fails the moment it runs: add the new column, write both, move readers, drop the old. https://www.postgresql.org/docs/18/sql-altertable.html Run it as the expand-and-contract migration Op: PostgresMigrationOp({ table: "yodel_18_shop.orders", column: "email", ... }) from @intentius/chant-lexicon-sql/postgres (add the new column, write both, backfill, switch readers, then drop the old).
       yodel apply runs it as this step

Plan digest: jcs1-sha256:7dd885c06a5ffdaeb426e45fd6ce5fad997b1f2e59018df13a59c34d60b0b77b
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:7dd885c06a5ffdaeb426e45fd6ce5fad997b1f2e59018df13a59c34d60b0b77b

The newest approval of approve-migrate-dev, by yodel at 2026-10-09T20:38:06.881Z, is for jcs1-sha256:b6065a990bfcf25ece55903263a0418c635ba6a6858e775166bb73279dfe9408, not this plan; it does not hold.
What moved (as far as yodel can tell): history changed: applied since: 20261009T2037-validate-amount (by yodel@example at 2026-10-09 20:38:11.108743); live schema changed: no state yodel can rebuild from the history and git hashes to the approved digest with today's live schema, so an object in the environment's live schema (a table, view, index, dictionary, database or schema) changed since approval (or a part yodel cannot rebuild did).
```

```console
$ npx yodel apply dev
Migrations in dev (history yodel_18_history.history)

Applied (3):
  20261009T2036-baseline  2026-10-09 20:36:48.811764 by yodel@example
  20261009T2037-coupons  2026-10-09 20:37:44.294634 by yodel@example
  20261009T2037-validate-amount  2026-10-09 20:38:11.108743 by yodel@example

Pending (1):
  20261009T2038-rename-email  (step 0: PostgresMigrationOp for orders (yodel_18_shop.orders))

Plan digest: jcs1-sha256:7dd885c06a5ffdaeb426e45fd6ce5fad997b1f2e59018df13a59c34d60b0b77b

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   942ms
[phase] Approve
  • gate:approve-migrate-dev()   skipped
    [refused] Gate "approve-migrate-dev" is approved, but not for this plan. approved: jcs1-sha256:b6065a990bfcf25ece55903263a0418c635ba6a6858e775166bb73279dfe9408 (by yodel at 2026-10-09T20:38:06.881Z); planned: jcs1-sha256:7dd885c06a5ffdaeb426e45fd6ce5fad997b1f2e59018df13a59c34d60b0b77b. The configuration or the live system changed between that approval and this plan, so it needs a fresh one: chant approve migrate-dev approve-migrate-dev
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 2.1s
  plan    : jcs1-sha256:7dd885c06a5ffdaeb426e45fd6ce5fad997b1f2e59018df13a59c34d60b0b77b
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:7dd885c06a5ffdaeb426e45fd6ce5fad997b1f2e59018df13a59c34d60b0b77b
  expires : 2026-10-11T20:38:16.296Z

Nothing was applied. The approval of jcs1-sha256:b6065a990bfcf25ece55903263a0418c635ba6a6858e775166bb73279dfe9408 (by yodel at 2026-10-09T20:38:06.881Z) does not hold: the plan moved since. What moved, as far as yodel can tell: history changed: applied since: 20261009T2037-validate-amount (by yodel@example at 2026-10-09 20:38:11.108743); pending migrations changed: committed to since approval: 20261009T2038-rename-email (8927f2e at 2026-10-09T14:38:13-06:00); live schema changed: no state yodel can rebuild from the history and git hashes to the approved digest with today's live schema, so an object in the environment's live schema (a table, view, index, dictionary, database or schema) changed since approval (or a part yodel cannot rebuild did).

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:7dd885c06a5ffdaeb426e45fd6ce5fad997b1f2e59018df13a59c34d60b0b77b).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:7dd885c06a5ffdaeb426e45fd6ce5fad997b1f2e59018df13a59c34d60b0b77b
then run yodel apply dev again.
[exit 3]
```

```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:7dd885c06a5ffdaeb426e45fd6ce5fad997b1f2e59018df13a59c34d60b0b77b
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-09T20:38:19.678Z
This approves the plan jcs1-sha256:7dd885c06a5ffdaeb426e45fd6ce5fad997b1f2e59018df13a59c34d60b0b77b, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

```console
$ npx yodel apply dev
Migrations in dev (history yodel_18_history.history)

Applied (3):
  20261009T2036-baseline  2026-10-09 20:36:48.811764 by yodel@example
  20261009T2037-coupons  2026-10-09 20:37:44.294634 by yodel@example
  20261009T2037-validate-amount  2026-10-09 20:38:11.108743 by yodel@example

Pending (1):
  20261009T2038-rename-email  (step 0: PostgresMigrationOp for orders (yodel_18_shop.orders))

Plan digest: jcs1-sha256:7dd885c06a5ffdaeb426e45fd6ce5fad997b1f2e59018df13a59c34d60b0b77b

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
lock: held in Postgres advisory lock (1498367052, 1669956748) for history schema yodel_18_history
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:7dd885c06a5ffdaeb426e45fd6ce5fad997b1f2e59018df13a59c34d60b0b77b, by yodel at 2026-10-09T20:38:19.678Z
20261009T2038-rename-email: applying
  step 0: PostgresMigrationOp for orders (yodel_18_shop.orders)
  step 0: ok {"op":"PostgresMigrationOp","table":"yodel_18_shop.orders","column":"email","state":"migrate","change":"rename","filled":1,"skipped":0,"backfilledRows":301,"carried":0,"verifiedRows":301,"switched":true,"oldColumn":"yodel_18_shop.orders.customer_email","retainUntil":"2026-10-09T20:38:25.564Z","dropped":true}
20261009T2038-rename-email: applied

[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   1.1s
[phase] Approve
  ✓ gate:approve-migrate-dev()   379ms
    [approved] yodel at 2026-10-09T20:38:19.678Z
[phase] Apply
  ✓ shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":"jcs1-sha256:7dd885c06a5ffdaeb426e45fd6ce5fad997b1f2e59018df13a59c34d60b0b77b"})   3.1s
Op "migrate-dev" completed in 4.8s

Applied: 20261009T2038-rename-email.
```

```console
$ npx yodel drift dev
Drift in dev

No drift: every declared object matches the server.
```

## 6. A destructive change, silenced with a reason

```console
$ npx yodel new drop-coupon
Wrote migrations/20261009T2038-drop-coupon/ (1 statement; follows 20261009T2038-rename-email)
```

```console
$ npx yodel lint
20261009T2038-drop-coupon
  error    destructive: step 0: SQLPG204 Drop a column on yodel_18_shop.orders: removes data that cannot be recovered

A statement rule can be silenced for one statement, with a reason the history records when it applies:
  a line `-- yodel:allow <rule> <reason>` above the statement in migration.sql

5 migrations: 1 error, 0 warnings, 0 silenced.
[exit 3]
```

Nothing ever wrote a coupon. Say so above the statement:

`migrations/20261009T2038-drop-coupon/migration.sql` now:

```sql
-- yodel migration 20261009T2038-drop-coupon
-- parent: 20261009T2038-rename-email

-- orders (yodel_18_shop.orders): SQLPG204 metadata, destructive
-- yodel:allow destructive no order ever had a coupon; checked on dev
ALTER TABLE yodel_18_shop.orders DROP COLUMN coupon;
```

```console
$ npx yodel lint --update-checksum 20261009T2038-drop-coupon
20261009T2038-drop-coupon: checksum sha256:8f0efe377243da48c7539dc97922acec38613be1e0a3f16b3c3231431d9f1264 is now sha256:00447ccbf8b770c597f5847b98f88e8e0adc03f0943254aab459bf93904368fb
20261009T2038-drop-coupon
  silenced destructive: step 0: SQLPG204 Drop a column on yodel_18_shop.orders: removes data that cannot be recovered
           reason: no order ever had a coupon; checked on dev

5 migrations: 0 errors, 0 warnings, 1 silenced.
```

The pull request comment (`yodel plan dev --comment` in CI) is this Markdown:

````console
$ npx yodel plan dev --format markdown
<!-- yodel:plan env=dev -->
### yodel plan: `dev`

Postgres, history `yodel_18_history.history`: 4 applied, **1 pending**.

#### `20261009T2038-drop-coupon`

| # | Step | Rule | Class | Object |
|---|---|---|---|---|
| 0 | statement | SQLPG204 | metadata, destructive | `yodel_18_shop.orders` |

<details><summary>Statements (1)</summary>

```sql
-- 0: SQLPG204 metadata, yodel_18_shop.orders
ALTER TABLE yodel_18_shop.orders DROP COLUMN coupon;
```

</details>

#### Approval

Plan digest the apply gate binds: `jcs1-sha256:6b34cba670c672c56645d81e0992b53dbc20e28d055a4272726d3d90acbee73d`

Approve it with:

```sh
chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:6b34cba670c672c56645d81e0992b53dbc20e28d055a4272726d3d90acbee73d
```

The newest approval of `approve-migrate-dev`, by yodel at 2026-10-09T20:38:19.678Z, is for `jcs1-sha256:7dd885c06a5ffdaeb426e45fd6ce5fad997b1f2e59018df13a59c34d60b0b77b`, not this plan; it does not hold.
What moved (as far as yodel can tell): history changed: applied since: 20261009T2038-rename-email (by yodel@example at 2026-10-09 20:38:25.652381); pending migrations changed: committed to since approval: 20261009T2038-drop-coupon (91525b2 at 2026-10-09T14:38:32-06:00); live schema changed: no state yodel can rebuild from the history and git hashes to the approved digest with today's live schema, so an object in the environment's live schema (a table, view, index, dictionary, database or schema) changed since approval (or a part yodel cannot rebuild did).

<!-- yodel:subject eyJlbnZpcm9ubWVudCI6ImRldiIsImhpc3RvcnlEYXRhYmFzZSI6InlvZGVsXzE4X2hpc3RvcnkiLCJ0b3BvbG9neSI6eyJraW5kIjoic2luZ2xlIn0sImFwcGxpZWQiOlt7ImlkIjoiMjAyNjEwMDlUMjAzNi1iYXNlbGluZSIsImNoZWNrc3VtIjoic2hhMjU2OjA2MzAyZjJiNjYzMzE5NTc1MzBiNTlhMDliYWExZWUwMDJkMGU3ZDNiMWM0NzFhOTNmZDdkNDExYTk4NDU5YmQifSx7ImlkIjoiMjAyNjEwMDlUMjAzNy1jb3Vwb25zIiwiY2hlY2tzdW0iOiJzaGEyNTY6MDgxZDc5MTI2YzJkOGM1MTIwM2Y3YjAyNjc2NjJkNDQ3MzZhNjU1ODBkODA1NzIyYWQ4ZWFiODcwNjJlNzVkZSJ9LHsiaWQiOiIyMDI2MTAwOVQyMDM3LXZhbGlkYXRlLWFtb3VudCIsImNoZWNrc3VtIjoic2hhMjU2OmViOTUyOGU3ZDcyYjQ2ZDQ5YmM3YzkyMTFhMGQxMTc3ZjI5NGY1YmYxMjEzNmY3ZTZjNzVjY2I3Y2QzY2ViZWYifSx7ImlkIjoiMjAyNjEwMDlUMjAzOC1yZW5hbWUtZW1haWwiLCJjaGVja3N1bSI6InNoYTI1NjphMDgyMWI1OTc5NjBhNzVlNmRjZDVlYzkyNmU0MDZhZjdlOWFmZTVlNjZlNjFjN2QzMmRiNWUzOTA2ZTUzOWRlIn1dLCJwZW5kaW5nIjpbeyJpZCI6IjIwMjYxMDA5VDIwMzgtZHJvcC1jb3Vwb24iLCJjaGVja3N1bSI6InNoYTI1NjowMDQ0N2NjYmY4Yjc3MGM1OTdmNTg0N2I5OGY4OGU4ZTBhZGMwM2YwOTQzMjU0YWFiNDU5YmY5MzkwNDM2OGZiIiwiZG9uZSI6W119XSwibGl2ZSI6InNoYTI1Njo0ZDI4NGI5MDQ0NTJkYmFkYjc1NTgzZWZlOWZkMDRjNDQ4YTFmMzE2MDFhOTNkZTk5MWY4N2M2Y2JmZTZmYzY1In0 -->
````

```console
$ npx yodel apply dev
Migrations in dev (history yodel_18_history.history)

Applied (4):
  20261009T2036-baseline  2026-10-09 20:36:48.811764 by yodel@example
  20261009T2037-coupons  2026-10-09 20:37:44.294634 by yodel@example
  20261009T2037-validate-amount  2026-10-09 20:38:11.108743 by yodel@example
  20261009T2038-rename-email  2026-10-09 20:38:25.652381 by yodel@example

Pending (1):
  20261009T2038-drop-coupon

Plan digest: jcs1-sha256:6b34cba670c672c56645d81e0992b53dbc20e28d055a4272726d3d90acbee73d

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   937ms
[phase] Approve
  • gate:approve-migrate-dev()   skipped
    [refused] Gate "approve-migrate-dev" is approved, but not for this plan. approved: jcs1-sha256:7dd885c06a5ffdaeb426e45fd6ce5fad997b1f2e59018df13a59c34d60b0b77b (by yodel at 2026-10-09T20:38:19.678Z); planned: jcs1-sha256:6b34cba670c672c56645d81e0992b53dbc20e28d055a4272726d3d90acbee73d. The configuration or the live system changed between that approval and this plan, so it needs a fresh one: chant approve migrate-dev approve-migrate-dev
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 1.8s
  plan    : jcs1-sha256:6b34cba670c672c56645d81e0992b53dbc20e28d055a4272726d3d90acbee73d
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:6b34cba670c672c56645d81e0992b53dbc20e28d055a4272726d3d90acbee73d
  expires : 2026-10-11T20:38:36.317Z

Nothing was applied. The approval of jcs1-sha256:7dd885c06a5ffdaeb426e45fd6ce5fad997b1f2e59018df13a59c34d60b0b77b (by yodel at 2026-10-09T20:38:19.678Z) does not hold: the plan moved since. What moved, as far as yodel can tell: history changed: applied since: 20261009T2038-rename-email (by yodel@example at 2026-10-09 20:38:25.652381); pending migrations changed: committed to since approval: 20261009T2038-drop-coupon (91525b2 at 2026-10-09T14:38:32-06:00); live schema changed: no state yodel can rebuild from the history and git hashes to the approved digest with today's live schema, so an object in the environment's live schema (a table, view, index, dictionary, database or schema) changed since approval (or a part yodel cannot rebuild did).

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:6b34cba670c672c56645d81e0992b53dbc20e28d055a4272726d3d90acbee73d).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:6b34cba670c672c56645d81e0992b53dbc20e28d055a4272726d3d90acbee73d
then run yodel apply dev again.
[exit 3]
```

```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:6b34cba670c672c56645d81e0992b53dbc20e28d055a4272726d3d90acbee73d
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-09T20:38:39.220Z
This approves the plan jcs1-sha256:6b34cba670c672c56645d81e0992b53dbc20e28d055a4272726d3d90acbee73d, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

```console
$ npx yodel apply dev
Migrations in dev (history yodel_18_history.history)

Applied (4):
  20261009T2036-baseline  2026-10-09 20:36:48.811764 by yodel@example
  20261009T2037-coupons  2026-10-09 20:37:44.294634 by yodel@example
  20261009T2037-validate-amount  2026-10-09 20:38:11.108743 by yodel@example
  20261009T2038-rename-email  2026-10-09 20:38:25.652381 by yodel@example

Pending (1):
  20261009T2038-drop-coupon

Plan digest: jcs1-sha256:6b34cba670c672c56645d81e0992b53dbc20e28d055a4272726d3d90acbee73d

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
lock: held in Postgres advisory lock (1498367052, 1669956748) for history schema yodel_18_history
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:6b34cba670c672c56645d81e0992b53dbc20e28d055a4272726d3d90acbee73d, by yodel at 2026-10-09T20:38:39.220Z
20261009T2038-drop-coupon: applying
  statement 0: ok (SQLPG204 metadata, yodel_18_shop.orders)
20261009T2038-drop-coupon: applied

[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   1.0s
[phase] Approve
  ✓ gate:approve-migrate-dev()   287ms
    [approved] yodel at 2026-10-09T20:38:39.220Z
[phase] Apply
  ✓ shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":"jcs1-sha256:6b34cba670c672c56645d81e0992b53dbc20e28d055a4272726d3d90acbee73d"})   1.2s
Op "migrate-dev" completed in 2.7s

Applied: 20261009T2038-drop-coupon.
```

Every history row the migration wrote records the silence:

```sql
SELECT kind, statement_index, status, silences FROM yodel_18_history.history WHERE migration_id LIKE '%drop-coupon' ORDER BY seq
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
Wrote migrations/20261009T2038-add-gift/ (1 statement; follows 20261009T2038-drop-coupon)
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
Wrote migrations/20261009T2038-index-placed-at/ (2 statements; follows 20261009T2038-drop-coupon)
```

```console
$ npx yodel lint
20261009T2038-drop-coupon
  silenced destructive: step 0: SQLPG204 Drop a column on yodel_18_shop.orders: removes data that cannot be recovered
           reason: no order ever had a coupon; checked on dev

20261009T2038-index-placed-at
  error    pg-lock: step 0: SQLPG241 Create an index without CONCURRENTLY on yodel_18_shop.orders_placed_at_idx: builds an index without CONCURRENTLY: SHARE on the table, blocking every write until the build ends; declare the index CONCURRENTLY

A statement rule can be silenced for one statement, with a reason the history records when it applies:
  a line `-- yodel:allow <rule> <reason>` above the statement in migration.sql

6 migrations: 1 error, 0 warnings, 1 silenced.
[exit 3]
```

```console
$ rm -r migrations/20261009T2038-index-placed-at
```

`src/schema.ts` now:

```ts
import { index, schema, table } from "@intentius/chant-lexicon-sql/postgres";

export const yodel18ShopSchema = schema`
  CREATE SCHEMA yodel_18_shop;
  COMMENT ON SCHEMA yodel_18_shop IS 'The SQL Yodeler Postgres example'`;

export const orders = table`
  CREATE TABLE ${yodel18ShopSchema}.orders (
      id bigint GENERATED ALWAYS AS IDENTITY,
      status text DEFAULT 'placed'::text NOT NULL,
      amount numeric(12,2) NOT NULL,
      placed_at timestamp with time zone DEFAULT now() NOT NULL,
      refunded_at timestamp with time zone,
      email text NOT NULL, -- previously: customer_email
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
Wrote migrations/20261009T2038-index-placed-at/ (2 statements; follows 20261009T2038-drop-coupon)
```

`migrations/20261009T2038-index-placed-at/migration.sql`:

```sql
-- yodel migration 20261009T2038-index-placed-at
-- parent: 20261009T2038-drop-coupon

-- ordersPlacedAt (yodel_18_shop.orders_placed_at_idx): SQLPG240 concurrently, outside a transaction
CREATE INDEX CONCURRENTLY orders_placed_at_idx ON yodel_18_shop.orders (placed_at);

-- ordersPlacedAt (yodel_18_shop.orders_placed_at_idx): SQLPG240 concurrently
COMMENT ON INDEX yodel_18_shop.orders_placed_at_idx IS '[chant managed-by=chant]';
```

```console
$ npx yodel lint
20261009T2038-drop-coupon
  silenced destructive: step 0: SQLPG204 Drop a column on yodel_18_shop.orders: removes data that cannot be recovered
           reason: no order ever had a coupon; checked on dev

6 migrations: 0 errors, 0 warnings, 1 silenced.
```

```console
$ git add -A && git commit -q -m 'feat: index orders by placed_at'
```

Someone applies the index branch to dev to try it:

```console
$ npx yodel apply dev
Migrations in dev (history yodel_18_history.history)

Applied (5):
  20261009T2036-baseline  2026-10-09 20:36:48.811764 by yodel@example
  20261009T2037-coupons  2026-10-09 20:37:44.294634 by yodel@example
  20261009T2037-validate-amount  2026-10-09 20:38:11.108743 by yodel@example
  20261009T2038-rename-email  2026-10-09 20:38:25.652381 by yodel@example
  20261009T2038-drop-coupon  2026-10-09 20:38:43.696363 by yodel@example

Pending (1):
  20261009T2038-index-placed-at

Plan digest: jcs1-sha256:68d558d117b7b32668b52c514edc8c2c57ad3ee5de4cd097ee31bfbd159db991

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   1.2s
[phase] Approve
  • gate:approve-migrate-dev()   skipped
    [refused] Gate "approve-migrate-dev" is approved, but not for this plan. approved: jcs1-sha256:6b34cba670c672c56645d81e0992b53dbc20e28d055a4272726d3d90acbee73d (by yodel at 2026-10-09T20:38:39.220Z); planned: jcs1-sha256:68d558d117b7b32668b52c514edc8c2c57ad3ee5de4cd097ee31bfbd159db991. The configuration or the live system changed between that approval and this plan, so it needs a fresh one: chant approve migrate-dev approve-migrate-dev
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 2.5s
  plan    : jcs1-sha256:68d558d117b7b32668b52c514edc8c2c57ad3ee5de4cd097ee31bfbd159db991
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:68d558d117b7b32668b52c514edc8c2c57ad3ee5de4cd097ee31bfbd159db991
  expires : 2026-10-11T20:38:52.693Z

Nothing was applied. The approval of jcs1-sha256:6b34cba670c672c56645d81e0992b53dbc20e28d055a4272726d3d90acbee73d (by yodel at 2026-10-09T20:38:39.220Z) does not hold: the plan moved since. What moved, as far as yodel can tell: history changed: applied since: 20261009T2038-drop-coupon (by yodel@example at 2026-10-09 20:38:43.696363); pending migrations changed: committed to since approval: 20261009T2038-index-placed-at (98c5055 at 2026-10-09T14:38:49-06:00); live schema changed: no state yodel can rebuild from the history and git hashes to the approved digest with today's live schema, so an object in the environment's live schema (a table, view, index, dictionary, database or schema) changed since approval (or a part yodel cannot rebuild did).

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:68d558d117b7b32668b52c514edc8c2c57ad3ee5de4cd097ee31bfbd159db991).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:68d558d117b7b32668b52c514edc8c2c57ad3ee5de4cd097ee31bfbd159db991
then run yodel apply dev again.
[exit 3]
```

```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:68d558d117b7b32668b52c514edc8c2c57ad3ee5de4cd097ee31bfbd159db991
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-09T20:38:56.873Z
This approves the plan jcs1-sha256:68d558d117b7b32668b52c514edc8c2c57ad3ee5de4cd097ee31bfbd159db991, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

```console
$ npx yodel apply dev
Migrations in dev (history yodel_18_history.history)

Applied (5):
  20261009T2036-baseline  2026-10-09 20:36:48.811764 by yodel@example
  20261009T2037-coupons  2026-10-09 20:37:44.294634 by yodel@example
  20261009T2037-validate-amount  2026-10-09 20:38:11.108743 by yodel@example
  20261009T2038-rename-email  2026-10-09 20:38:25.652381 by yodel@example
  20261009T2038-drop-coupon  2026-10-09 20:38:43.696363 by yodel@example

Pending (1):
  20261009T2038-index-placed-at

Plan digest: jcs1-sha256:68d558d117b7b32668b52c514edc8c2c57ad3ee5de4cd097ee31bfbd159db991

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
lock: held in Postgres advisory lock (1498367052, 1669956748) for history schema yodel_18_history
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:68d558d117b7b32668b52c514edc8c2c57ad3ee5de4cd097ee31bfbd159db991, by yodel at 2026-10-09T20:38:56.873Z
20261009T2038-index-placed-at: applying
  statement 0: ok (SQLPG240 concurrently, yodel_18_shop.orders_placed_at_idx)
  statement 1: ok (SQLPG240 concurrently, yodel_18_shop.orders_placed_at_idx)
20261009T2038-index-placed-at: applied

[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   1.1s
[phase] Approve
  ✓ gate:approve-migrate-dev()   313ms
    [approved] yodel at 2026-10-09T20:38:56.873Z
[phase] Apply
  ✓ shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":"jcs1-sha256:68d558d117b7b32668b52c514edc8c2c57ad3ee5de4cd097ee31bfbd159db991"})   1.6s
Op "migrate-dev" completed in 3.2s

Applied: 20261009T2038-index-placed-at.
```

Both branches merge. Each migration follows `drop-coupon`, so the history forks, and lint says so:

```console
$ git switch -q main && git merge -q --no-edit gift && git merge -q --no-edit placed-at-index
Auto-merging src/schema.ts
```

```console
$ npx yodel lint
migrations/
  error    fork: fork: 20261009T2038-add-gift and 20261009T2038-index-placed-at both follow 20261009T2038-drop-coupon; rebase one onto the other

20261009T2038-drop-coupon
  silenced destructive: step 0: SQLPG204 Drop a column on yodel_18_shop.orders: removes data that cannot be recovered
           reason: no order ever had a coupon; checked on dev

7 migrations: 1 error, 0 warnings, 1 silenced.
[exit 3]
```

`yodel rebase` moves one migration onto the other and writes its statements and recorded schema again. With `--env dev` it reads dev's history first, and refuses to move a migration that ran there:

```console
$ npx yodel rebase 20261009T2038-index-placed-at --onto 20261009T2038-add-gift --env dev
yodel rebase: refused: dev's history records 20261009T2038-index-placed-at (applied). Nothing was written. A migration that ran is never rebased: its statements already ran in that order. Rebase the other branch onto it instead (yodel rebase <the other> --onto <the end of this one>).
[exit 4]
```

The clean fix is the one it names: move `add-gift` after `index-placed-at`. To show what yodel does when a migration that ran is moved anyway (a rebase run without `--env`), this walkthrough moves `index-placed-at`:

```console
$ npx yodel rebase 20261009T2038-index-placed-at --onto 20261009T2038-add-gift
Rebased 20261009T2038-index-placed-at onto 20261009T2038-add-gift (it followed 20261009T2038-drop-coupon).
  20261009T2038-index-placed-at: follows 20261009T2038-add-gift; 2 statements; checksum sha256:bd35922817b6ea5898322c7e3bc582f832cf14934b0b142424b885cac7efb657 -> sha256:ecf27b32ea4291c9620518596390793696f22a1b01acd6915bfe10ec7028e27f
No history was checked (--env): make sure none of these ran anywhere before merging.
```

Its files changed after it ran on dev, so dev's history no longer matches them. `yodel status` and `yodel apply` refuse (exit 4):

```console
$ npx yodel status dev
Migrations in dev (history yodel_18_history.history)

Applied (6):
  20261009T2036-baseline  2026-10-09 20:36:48.811764 by yodel@example
  20261009T2037-coupons  2026-10-09 20:37:44.294634 by yodel@example
  20261009T2037-validate-amount  2026-10-09 20:38:11.108743 by yodel@example
  20261009T2038-rename-email  2026-10-09 20:38:25.652381 by yodel@example
  20261009T2038-drop-coupon  2026-10-09 20:38:43.696363 by yodel@example
  20261009T2038-index-placed-at  2026-10-09 20:39:02.366262 by yodel@example

Pending (1):
  20261009T2038-add-gift  (out of order)

Out of order (1): 20261009T2038-add-gift; apply with --allow-out-of-order

Checksum mismatches (1):
  20261009T2038-index-placed-at was applied with checksum sha256:bd35922817b6ea5898322c7e3bc582f832cf14934b0b142424b885cac7efb657, but its files now hash to sha256:ecf27b32ea4291c9620518596390793696f22a1b01acd6915bfe10ec7028e27f; if the edit is intended, record it with yodel repair 20261009T2038-index-placed-at --reason ... <env>
[exit 4]
```

```console
$ npx yodel apply dev
yodel apply: refused: the history does not match the migrations directory; nothing was applied:
  20261009T2038-index-placed-at was applied with checksum sha256:bd35922817b6ea5898322c7e3bc582f832cf14934b0b142424b885cac7efb657, but its files now hash to sha256:ecf27b32ea4291c9620518596390793696f22a1b01acd6915bfe10ec7028e27f; if the edit is intended, record it with yodel repair 20261009T2038-index-placed-at --reason ... <env>
[exit 4]
```

The edit is intended: its statements are the same, only its parent changed. `yodel repair` records the new checksum, with the reason, in dev's history. Nothing runs on the server:

```console
$ npx yodel repair 20261009T2038-index-placed-at --reason 'rebased onto add-gift after it ran on dev' dev
Repaired 20261009T2038-index-placed-at in dev's history (yodel_18_history).
  old checksum: sha256:bd35922817b6ea5898322c7e3bc582f832cf14934b0b142424b885cac7efb657
  new checksum: sha256:ecf27b32ea4291c9620518596390793696f22a1b01acd6915bfe10ec7028e27f
  reason: rebased onto add-gift after it ran on dev
```

Now `add-gift` comes before a migration dev has applied. It is out of order, and apply refuses it rather than skip it:

```console
$ npx yodel status dev
Migrations in dev (history yodel_18_history.history)

Applied (6):
  20261009T2036-baseline  2026-10-09 20:36:48.811764 by yodel@example
  20261009T2037-coupons  2026-10-09 20:37:44.294634 by yodel@example
  20261009T2037-validate-amount  2026-10-09 20:38:11.108743 by yodel@example
  20261009T2038-rename-email  2026-10-09 20:38:25.652381 by yodel@example
  20261009T2038-drop-coupon  2026-10-09 20:38:43.696363 by yodel@example
  20261009T2038-index-placed-at  2026-10-09 20:39:02.366262 by yodel@example
      repaired 2026-10-09 20:39:09.181098 by yodel@example: rebased onto add-gift after it ran on dev

Pending (1):
  20261009T2038-add-gift  (out of order)

Out of order (1): 20261009T2038-add-gift; apply with --allow-out-of-order
[exit 4]
```

```console
$ npx yodel apply dev
yodel apply: refused: 20261009T2038-add-gift is out of order: the chain puts it before 20261009T2038-index-placed-at, which is already applied. Nothing was applied. Pass --allow-out-of-order to apply it now (in chain order); it is never skipped.
[exit 4]
```

Adding a column after the index changes nothing the index needs, so apply it out of order:

```console
$ npx yodel apply dev --allow-out-of-order
Migrations in dev (history yodel_18_history.history)

Applied (6):
  20261009T2036-baseline  2026-10-09 20:36:48.811764 by yodel@example
  20261009T2037-coupons  2026-10-09 20:37:44.294634 by yodel@example
  20261009T2037-validate-amount  2026-10-09 20:38:11.108743 by yodel@example
  20261009T2038-rename-email  2026-10-09 20:38:25.652381 by yodel@example
  20261009T2038-drop-coupon  2026-10-09 20:38:43.696363 by yodel@example
  20261009T2038-index-placed-at  2026-10-09 20:39:02.366262 by yodel@example
      repaired 2026-10-09 20:39:09.181098 by yodel@example: rebased onto add-gift after it ran on dev

Pending (1):
  20261009T2038-add-gift  (out of order)

Out of order (1): 20261009T2038-add-gift; apply with --allow-out-of-order

Plan digest: jcs1-sha256:ca59493b7afc74f3641c95e62e1c84d81468b5aaec2fa4519d072290968a9157

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   1.5s
[phase] Approve
  • gate:approve-migrate-dev()   skipped
    [refused] Gate "approve-migrate-dev" is approved, but not for this plan. approved: jcs1-sha256:68d558d117b7b32668b52c514edc8c2c57ad3ee5de4cd097ee31bfbd159db991 (by yodel at 2026-10-09T20:38:56.873Z); planned: jcs1-sha256:ca59493b7afc74f3641c95e62e1c84d81468b5aaec2fa4519d072290968a9157. The configuration or the live system changed between that approval and this plan, so it needs a fresh one: chant approve migrate-dev approve-migrate-dev
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 2.9s
  plan    : jcs1-sha256:ca59493b7afc74f3641c95e62e1c84d81468b5aaec2fa4519d072290968a9157
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:ca59493b7afc74f3641c95e62e1c84d81468b5aaec2fa4519d072290968a9157
  expires : 2026-10-11T20:39:15.352Z

Nothing was applied. The approval of jcs1-sha256:68d558d117b7b32668b52c514edc8c2c57ad3ee5de4cd097ee31bfbd159db991 (by yodel at 2026-10-09T20:38:56.873Z) does not hold: the plan moved since. What moved, as far as yodel can tell: history changed: applied since: 20261009T2038-index-placed-at (by yodel@example at 2026-10-09 20:39:02.366262); pending migrations changed: committed to since approval: 20261009T2038-index-placed-at (33f4a9f at 2026-10-09T14:39:05-06:00); live schema changed: no state yodel can rebuild from the history and git hashes to the approved digest with today's live schema, so an object in the environment's live schema (a table, view, index, dictionary, database or schema) changed since approval (or a part yodel cannot rebuild did).

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:ca59493b7afc74f3641c95e62e1c84d81468b5aaec2fa4519d072290968a9157).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:ca59493b7afc74f3641c95e62e1c84d81468b5aaec2fa4519d072290968a9157
then run yodel apply dev again.
[exit 3]
```

```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:ca59493b7afc74f3641c95e62e1c84d81468b5aaec2fa4519d072290968a9157
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-09T20:39:19.713Z
This approves the plan jcs1-sha256:ca59493b7afc74f3641c95e62e1c84d81468b5aaec2fa4519d072290968a9157, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

```console
$ npx yodel apply dev --allow-out-of-order
Migrations in dev (history yodel_18_history.history)

Applied (6):
  20261009T2036-baseline  2026-10-09 20:36:48.811764 by yodel@example
  20261009T2037-coupons  2026-10-09 20:37:44.294634 by yodel@example
  20261009T2037-validate-amount  2026-10-09 20:38:11.108743 by yodel@example
  20261009T2038-rename-email  2026-10-09 20:38:25.652381 by yodel@example
  20261009T2038-drop-coupon  2026-10-09 20:38:43.696363 by yodel@example
  20261009T2038-index-placed-at  2026-10-09 20:39:02.366262 by yodel@example
      repaired 2026-10-09 20:39:09.181098 by yodel@example: rebased onto add-gift after it ran on dev

Pending (1):
  20261009T2038-add-gift  (out of order)

Out of order (1): 20261009T2038-add-gift; apply with --allow-out-of-order

Plan digest: jcs1-sha256:ca59493b7afc74f3641c95e62e1c84d81468b5aaec2fa4519d072290968a9157

Running migrate-dev (<tmp>/postgres/ops/migrate-dev.op.ts)
lock: held in Postgres advisory lock (1498367052, 1669956748) for history schema yodel_18_history
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:ca59493b7afc74f3641c95e62e1c84d81468b5aaec2fa4519d072290968a9157, by yodel at 2026-10-09T20:39:19.713Z
20261009T2038-add-gift: applying (out of order, allowed)
  statement 0: ok (SQLPG201 metadata, yodel_18_shop.orders)
20261009T2038-add-gift: applied

[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   1.3s
[phase] Approve
  ✓ gate:approve-migrate-dev()   391ms
    [approved] yodel at 2026-10-09T20:39:19.713Z
[phase] Apply
  ✓ shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":"jcs1-sha256:ca59493b7afc74f3641c95e62e1c84d81468b5aaec2fa4519d072290968a9157"})   1.3s
Op "migrate-dev" completed in 3.3s

Applied: 20261009T2038-add-gift.
```

`yodel status` lists `index-placed-at` as applied when it ran, and the repair under it:

```console
$ npx yodel status dev
Migrations in dev (history yodel_18_history.history)

Applied (7):
  20261009T2036-baseline  2026-10-09 20:36:48.811764 by yodel@example
  20261009T2037-coupons  2026-10-09 20:37:44.294634 by yodel@example
  20261009T2037-validate-amount  2026-10-09 20:38:11.108743 by yodel@example
  20261009T2038-rename-email  2026-10-09 20:38:25.652381 by yodel@example
  20261009T2038-drop-coupon  2026-10-09 20:38:43.696363 by yodel@example
  20261009T2038-add-gift  2026-10-09 20:39:25.442832 by yodel@example
  20261009T2038-index-placed-at  2026-10-09 20:39:02.366262 by yodel@example
      repaired 2026-10-09 20:39:09.181098 by yodel@example: rebased onto add-gift after it ran on dev

Pending: none
```

## 8. Drift

Someone changes a default by hand:

```sql
ALTER TABLE yodel_18_shop.orders ALTER COLUMN status SET DEFAULT 'new'
```

```console
$ npx yodel drift dev
Drift in dev

Changed out of band:
  orders (Postgres::Table)
    columns[1].default: declared 'placed'::text, live 'new'::text
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
      columns[1].default: 'placed'::text → 'new'::text [from: authored]
[phase] Snapshot
  ✓ lifecycleSnapshot(env=dev)   1.2s
[phase] Diff
  ✓ lifecycleDiff(env=dev, live=true)   902ms
    [outcome] Drift=true
Op "watch-dev" completed in 2.3s
```

`chant run` exits 0 when the watch completes, drift or not; the drift is the run's `Drift` outcome. Put the default back:

```sql
ALTER TABLE yodel_18_shop.orders ALTER COLUMN status SET DEFAULT 'placed'
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
replay: emptying yodel_18_shop on postgres://192.168.14.189:5432/postgres (sql.profiles.replay)
replay: 20261009T2036-baseline: replaying
replay: 20261009T2036-baseline: matches its recorded schema
replay: 20261009T2037-coupons: replaying
replay: 20261009T2037-coupons: matches its recorded schema
replay: 20261009T2037-validate-amount: replaying
replay: 20261009T2037-validate-amount: matches its recorded schema
replay: 20261009T2038-rename-email: replaying
-- yodel_18_shop.orders.email needs expand and contract (SQLPG205 Rename a column): customer_email renamed to email, batched by id
--   SQLPG205 columns.email: customer_email -> email
ALTER TABLE yodel_18_shop.orders ADD COLUMN email text
COMMENT ON COLUMN yodel_18_shop.orders.email IS 'chant migration of yodel_18_shop.orders.email: the new name of customer_email [chant managed-by=chant migration=yodel_18_shop.orders.email role=new]'
CREATE OR REPLACE FUNCTION yodel_18_shop.orders__email__chant_sync() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $chant$
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
COMMENT ON FUNCTION yodel_18_shop.orders__email__chant_sync() IS 'chant migration of yodel_18_shop.orders.email: keeps the new column written [chant managed-by=chant migration=yodel_18_shop.orders.email role=dual]'
DROP TRIGGER IF EXISTS email__chant_sync ON yodel_18_shop.orders
CREATE TRIGGER email__chant_sync BEFORE INSERT OR UPDATE ON yodel_18_shop.orders FOR EACH ROW EXECUTE FUNCTION yodel_18_shop.orders__email__chant_sync()
COMMENT ON TRIGGER email__chant_sync ON yodel_18_shop.orders IS 'chant migration of yodel_18_shop.orders.email: keeps the new column written [chant managed-by=chant migration=yodel_18_shop.orders.email role=dual]'
-- backfill of yodel_18_shop.orders.email: 0 batch(es), 0 filled (0 row(s)), 0 already filled
SELECT count(*)::text AS rows, count(*) FILTER (WHERE email IS DISTINCT FROM (customer_email))::text AS mismatched,
                count(*) FILTER (WHERE email IS NULL)::text AS nulls,
                COALESCE(sum(pg_catalog.hashtextextended(email::text, 0)), 0)::text AS checksum,
                COALESCE(sum(pg_catalog.hashtextextended((customer_email)::text, 0)), 0)::text AS expected
         FROM yodel_18_shop.orders
-- yodel_18_shop.orders.email: 0 row(s), email equal to customer_email in every one (checksum 0)
ALTER TABLE yodel_18_shop.orders ADD CONSTRAINT email__chant_nn CHECK (email IS NOT NULL) NOT VALID
COMMENT ON CONSTRAINT email__chant_nn ON yodel_18_shop.orders IS 'chant migration of yodel_18_shop.orders.email: proves email NOT NULL [chant managed-by=chant migration=yodel_18_shop.orders.email role=nn]'
ALTER TABLE yodel_18_shop.orders VALIDATE CONSTRAINT email__chant_nn
ALTER TABLE yodel_18_shop.orders ALTER COLUMN email SET NOT NULL
ALTER TABLE yodel_18_shop.orders DROP CONSTRAINT email__chant_nn
COMMENT ON COLUMN yodel_18_shop.orders.email IS NULL
COMMENT ON COLUMN yodel_18_shop.orders.customer_email IS 'chant migration of yodel_18_shop.orders.email: the old name, kept until 2026-10-09T20:39:34.803Z [chant managed-by=chant migration=yodel_18_shop.orders.email role=old retain-until=2026-10-09T20%3A39%3A34.803Z]'
DROP TRIGGER email__chant_sync ON yodel_18_shop.orders
DROP FUNCTION yodel_18_shop.orders__email__chant_sync()
ALTER TABLE yodel_18_shop.orders DROP COLUMN customer_email
replay: 20261009T2038-rename-email: matches its recorded schema
replay: 20261009T2038-drop-coupon: replaying
replay: 20261009T2038-drop-coupon: matches its recorded schema
replay: 20261009T2038-add-gift: replaying
replay: 20261009T2038-add-gift: matches its recorded schema
replay: 20261009T2038-index-placed-at: replaying
replay: 20261009T2038-index-placed-at: matches its recorded schema
Replay of 7 migrations (postgres) into postgres://192.168.14.189:5432/postgres (sql.profiles.replay)
  schemas: yodel_18_shop (emptied first)
  ok      20261009T2036-baseline (6 statements)
  ok      20261009T2037-coupons (2 statements)
  ok      20261009T2037-validate-amount (2 statements)
  ok      20261009T2038-rename-email (0 statements; ran step 0: PostgresMigrationOp for orders (yodel_18_shop.orders) (switched, old column dropped))
  ok      20261009T2038-drop-coupon (1 statement)
  ok      20261009T2038-add-gift (1 statement)
  ok      20261009T2038-index-placed-at (2 statements)
Every migration replays to its recorded schema.

20261009T2038-drop-coupon
  silenced destructive: step 0: SQLPG204 Drop a column on yodel_18_shop.orders: removes data that cannot be recovered
           reason: no order ever had a coupon; checked on dev

7 migrations: 0 errors, 0 warnings, 1 silenced.
```
