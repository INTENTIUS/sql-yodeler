---
claims: [migrations]
type: reference
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
data-dependent     warning, silenceable, postgres
                   Postgres: a statement that can fail on the rows already there (a unique index over duplicates, SET NOT NULL over NULLs, a check or foreign key some row breaks); yodel apply runs its pre-check first and refuses when it counts any
naming             error, silenceable
                   a table, column, index or constraint the migration adds breaks yodel.config.ts lint.naming
ch-mutation        error, silenceable, clickhouse
                   ClickHouse: starts a mutation that rewrites existing parts in the background, with no rollback
ch-rebuild         error, silenceable, clickhouse
                   ClickHouse: a rebuild, every row copied into a new table and swapped in (ClickHouseRebuildOp)
ch-access          error, silenceable, clickhouse
                   ClickHouse: takes access away: a privilege or role revoked from a user or role (SQLCH274)
refused-step       error
                   a step yodel apply refuses to run: a manual step, or an Op step it does not run
migration-sql      error
                   migration.sql does not hold a statement as migration.json records it; apply runs migration.json's
silence            error
                   a yodel:allow line that is malformed, names a rule no statement can silence, has no reason, or silences nothing
replay             error
                   with --replay <env>: the history, replayed into a fresh database, does not give each migration's recorded schema
SQL101             the check's level, silenceable
                   schema check: Two exports declare the same object
SQL102             the check's level, silenceable
                   schema check: sql-types.d.ts differs from what the build declares
SQLCH101           the check's level, silenceable, clickhouse
                   schema check: A ClickHouse object names an engine the pinned server does not have
SQLCH102           the check's level, silenceable, clickhouse
                   schema check: A PRIMARY KEY is not a prefix of ORDER BY
SQLCH103           the check's level, silenceable, clickhouse
                   schema check: An engine's version, sign or is_deleted column has an unsupported type
SQLCH104           the check's level, silenceable, clickhouse
                   schema check: A MergeTree engine argument names a column the table does not declare
SQLCH105           the check's level, silenceable, clickhouse
                   schema check: A table key clause names a column the table does not declare
SQLCH106           the check's level, silenceable, clickhouse
                   schema check: A skip index expression names a column the table does not declare
SQLCH107           the check's level, silenceable, clickhouse
                   schema check: A TTL expression is built on a column that is not a Date or DateTime
SQLCH108           the check's level, silenceable, clickhouse
                   schema check: CREATE OR REPLACE TABLE in a database that is not Atomic
SQLCH109           the check's level, silenceable, clickhouse
                   schema check: A materialized view selects *
SQLCH110           the check's level, silenceable, clickhouse
                   schema check: A materialized view writes a column its TO target does not declare
SQLCH111           the check's level, silenceable, clickhouse
                   schema check: A String column limited to a few values is not LowCardinality
SQLCH112           the check's level, silenceable, clickhouse
                   schema check: A PARTITION BY expression is finer than a day
SQLCH113           the check's level, silenceable, clickhouse
                   schema check: A MergeTree table declares no sort key
SQLCH114           the check's level, silenceable, clickhouse
                   schema check: A column codec is not one the pinned server has
SQLCH115           the check's level, silenceable, clickhouse
                   schema check: A secret- or PII-named column carries no comment, TTL or encryption
SQLCH116           the check's level, silenceable, clickhouse
                   schema check: A view is SQL SECURITY DEFINER with no DEFINER
SQLCH117           the check's level, silenceable, clickhouse
                   schema check: A MergeTree setting is obsolete at the pinned server
SQLCH118           the check's level, silenceable, clickhouse
                   schema check: A MergeTree setting is not one the pinned server has
SQLCH119           the check's level, silenceable, clickhouse
                   schema check: An object uses a deprecated or experimental engine
SQLCH120           the check's level, silenceable, clickhouse
                   schema check: A MergeTree engine uses the deprecated positional arguments
SQLCH121           the check's level, silenceable, clickhouse
                   schema check: A column type names a family the pinned server does not have
SQLCH122           the check's level, silenceable, clickhouse
                   schema check: A column type's parameters do not fit its family
SQLCH123           the check's level, silenceable, clickhouse
                   schema check: A Nullable wraps a type ClickHouse does not allow inside Nullable
SQLCH124           the check's level, silenceable, clickhouse
                   schema check: A table declares a column twice
SQLCH125           the check's level, silenceable, clickhouse
                   schema check: A codec parameter is outside what the codec takes
SQLCH126           the check's level, silenceable, clickhouse
                   schema check: A GRANT column list names a column the table does not declare
SQLCH127           the check's level, silenceable, clickhouse
                   schema check: An expression calls a function the pinned server does not have
SQLCH128           the check's level, silenceable, clickhouse
                   schema check: An integration engine or table function argument holds a literal credential
```

`fork`, `directory`, `checksum`, `unreadable-object` and `checkpoint` are integrity rules: always errors. `unreadable-object` means an object in a recorded schema, or a step, that the `sql` lexicon cannot read or classify; it is never skipped. `destructive`, `pg-rewrite`, `pg-lock`, `ch-mutation` and `ch-rebuild` come from the classifier's class of each statement or step, and can be silenced one statement at a time. The `pg-` and `ch-` rules apply to their own dialect.

Two Postgres rules are about access control ([Access control](access.md)). `pg-access` flags a statement that takes access away: a privilege revoked (SQLPG297), a policy dropped (SQLPG292), row-level security turned off or no longer forced (SQLPG293). A revoke on an object the same migration creates is left out, since nobody held the privilege. A wave with gate `on-destructive` waits on it. `pg-rls-not-forced`, a warning, flags a migration that enables a table's row-level security while its recorded schema does not force it, so the table's owner is not held to its policies.

On ClickHouse, `ch-access` flags a privilege or role revoked from a user or role (SQLCH274). ClickHouse takes no `REVOKE` declaration: the grant declarations naming a grantee are everything it holds, so a revoke always takes away something no declaration grants any more. A wave with gate `on-destructive` waits on it too.

Two Postgres rules read a step with the rest of its migration (#44). `pg-signature` flags a function or procedure dropped and created with another signature: SQLPG281 (the result type, an output parameter, an input parameter's name or a removed default, which `CREATE OR REPLACE` refuses, or other parameter types between two builds), or a routine dropped and one of the same name with other parameter types created in the same migration. A caller written for the old signature fails once it runs; it can be silenced for the statement. `pg-routine-in-use` flags a function dropped while a trigger in the migration's recorded schema still executes it, which happens when the trigger names the function in its text rather than through its declaration. The `DROP` would fail on the server, so it cannot be silenced: declare the function again, or drop the trigger in the same migration.

Findings from the Postgres example. A CHECK constraint added to a table that holds rows, which `yodel new` writes `NOT VALID` and then validates, so the validation carries a pre-check ([Statements that can fail on the data](#statements-that-can-fail-on-the-data)); the baseline's warning is [`SQLPG112`](#schema-checks), a column that looks like personal data with no comment:

<!-- quote: postgres#data-dependent -->
```console
$ npx yodel lint
20261010T1723-baseline
  warning  SQLPG112: step 2: orders.customer_email looks like a secret or personal data and neither it nor shop.orders has a COMMENT; say what it holds and how it is protected

20261010T1723-coupons
  warning  data-dependent: step 1: SQLPG217 Add a constraint NOT VALID on shop.orders: can fail on the rows already there (rows that fail the check orders_amount_positive (amount > 0)); yodel apply runs this pre-check before the migration's first statement and refuses when it is not 0: SELECT count(*) AS n FROM shop.orders WHERE NOT (amount > 0)

2 migrations: 0 errors, 2 warnings, 0 silenced.
```

an index built without `CONCURRENTLY`:

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

and a column dropped:

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

## Rule levels

`yodel.config.ts` sets a rule to `"error"`, `"warning"` or `"off"`:

```ts
export default defineConfig({
  lint: { rules: { "ch-mutation": "warning", "pg-lock": "off" } },
});
```

The integrity rules cannot be lowered. A schema check's id is a rule too (`"SQLPG104": "off"`), and `lint.naming` sets the [naming rules](#naming-rules).

## Schema checks

The `sql` lexicon's schema checks, the ones `chant lint` runs over a build, run inside `yodel lint` on each migration's recorded schema, so a project has one lint command and one configuration. Each check is a rule named by its id: `SQLPG101` (a table with no primary key), `SQLPG102` (a foreign key whose columns have no index), `SQLPG104` (a timestamp without time zone), `SQLCH101` (an engine the pinned server does not have), `SQLCH113` (a MergeTree table with no sort key), and the rest that `yodel lint --rules` lists for the project's dialect.

A finding is reported once, in the migration whose recorded schema first has it: the parent's recorded schema is checked too, and what it already had is left out. It is placed at the migration's first step on the object it names, so a `-- yodel:allow SQLPG101 <reason>` line above that step silences it. In the Postgres example, the first migration's `customer_email` column and the later rename's `email` are each reported where they appear:

```text
20261010T1723-baseline
  warning  SQLPG112: step 2: orders.customer_email looks like a secret or personal data and neither it nor shop.orders has a COMMENT; say what it holds and how it is protected
```

A check's level is, in order: `lint.rules` in `yodel.config.ts`; else `lint.rules` in `chant.config.ts`, the level `chant lint` uses (`info` counts as a warning); else the level the check gives the finding. `"off"` in either file turns it off. The checks read the objects as `chant build` writes them, with their columns, keys and engine besides the DDL; that is what `yodel new` records.

## Your own column rules

A team often has rules of its own: every table has a `created_at`, no column in a ClickHouse sort key can be `Nullable`. You write each one as a small TypeScript check, list its file in `chant.config.ts`, and `yodel lint` runs it next to the schema checks above, on each migration's recorded schema. `chant build` and `chant lint` run the same checks on the declared schema, so a rule holds in both places.

A check doesn't parse SQL. The `sql` lexicon has already read every statement into tables and columns, with each column's type, whether it can be null, and whether it's in the primary or sort key. The check reads that through `@intentius/chant-lexicon-sql/read` and returns a finding for each table that breaks the rule.

Postgres: every table has `created_at timestamptz NOT NULL`. `canonicalPostgresType` matches however the type is spelled (`timestamptz` or `timestamp with time zone`):

```ts
// policies/rules.ts
import type { PostSynthCheck } from "@intentius/chant/lint/post-synth";
import { canonicalPostgresType, readPostgres } from "@intentius/chant-lexicon-sql/read";

const TZ = canonicalPostgresType("timestamptz");

export const createdAt: PostSynthCheck = {
  id: "ORG-CREATED-AT",
  description: "every table has created_at timestamptz NOT NULL",
  check: (ctx) =>
    readPostgres(ctx).tables
      .filter((t) => {
        const c = t.column("created_at");
        return !c || c.typeName !== TZ || c.nullable;
      })
      .map((t) => ({ checkId: "ORG-CREATED-AT", severity: "error", entity: t.export, message: `${t.qualifiedName} needs created_at timestamptz NOT NULL` })),
};
```

ClickHouse: no `Nullable` column in a sort key. `nullable` is true for `Nullable(...)` and for `LowCardinality(Nullable(...))`:

```ts
// policies/rules.ts
import type { PostSynthCheck } from "@intentius/chant/lint/post-synth";
import { readClickHouse } from "@intentius/chant-lexicon-sql/read";

export const sortKey: PostSynthCheck = {
  id: "ORG-SORT-KEY",
  description: "no Nullable column in a sort key",
  check: (ctx) =>
    readClickHouse(ctx).tables.flatMap((t) =>
      t.columns
        .filter((c) => c.inSortKey && c.nullable)
        .map((c) => ({ checkId: "ORG-SORT-KEY", severity: "error", entity: t.export, message: `${t.qualifiedName}.${c.name} is Nullable and in the sort key` })),
    ),
};
```

Then name the file in `chant.config.ts`:

```ts
export default {
  lexicons: ["sql"],
  lint: { policies: ["policies/rules.ts"] },
  // ...
} satisfies ChantConfig;
```

Each check is a rule named by its id, which is upper case with a dash (`ORG-CREATED-AT`). Everything above about schema checks applies to it as well:
- it is reported in the migration that first breaks it;
- `-- yodel:allow ORG-CREATED-AT <reason>` silences it;
- its level comes from `lint.rules` in `yodel.config.ts`, else `chant.config.ts`, else the `severity` the check gives;
- `yodel lint --rules` lists it as a project policy.

`yodel lint` refuses a `lint.rules` entry that names no check. A check that throws is reported as a finding of its own. Under `--env <env>`, `ctx.env` is that environment's name, so a rule can apply to prod only.

## Naming rules

`lint.naming` in `yodel.config.ts` sets a rule per kind of object: `table`, `column`, `index`, `constraint`. A rule is a preset, `snake_case`, `camelCase` or `PascalCase`, or a regular expression the whole name must match:

```ts
export default defineConfig({
  lint: {
    naming: { table: "snake_case", column: "snake_case", index: "[a-z_]+_idx", constraint: "[a-z_]+_(pkey|key|fkey|check)" },
  },
});
```

Rule `naming` (an error by default) flags each name a migration adds that breaks its kind's rule: a table, column, index or named constraint in its recorded schema that its parent's does not have. A name already there is not reported again, so a rule added to a project with migrations does not fail what was written before it; the first migration's names are all new. The names are the server's: Postgres folds an unquoted name to lower case, so `CREATE TABLE OrderItems` is `orderitems`. A constraint the declaration does not name is named by the server and is not checked. A ClickHouse table's skip indexes and constraints are its indexes and constraints. The finding is at the migration's first step on the object, and `-- yodel:allow naming <reason>` above it silences it.

## Statements that can fail on the data

Some Postgres statements succeed or fail by what is in the table: a unique index or constraint over duplicate values, `SET NOT NULL` over NULLs, a CHECK some row breaks, a foreign key with orphan rows. chant marks each such statement with a pre-check, a query counting the rows it would fail on, and `migration.json` records it on the step (so it is in the checksum and the plan digest). `migration.sql` shows it above the statement:

```sql
-- ordersStatusKey (yodel_34_lint.orders_status_key): SQLPG240 concurrently, outside a transaction
-- pre-check, must return 0 (values of (status) held by more than one row, which a unique index fails on): SELECT (SELECT count(*) FROM (SELECT 1 FROM yodel_34_lint.orders WHERE status IS NOT NULL GROUP BY status HAVING count(*) > 1) AS duplicates) AS n
CREATE UNIQUE INDEX CONCURRENTLY orders_status_key ON yodel_34_lint.orders (status);
```

Rule `data-dependent`, a warning, flags each one with its pre-check, so a reviewer sees what the statement depends on. `yodel apply` runs the pre-checks with the migration's own [pre-migration checks](migrations.md#pre-migration-checks): before the gate, and again under the lock just before the migration's first statement. A pre-check that returns more than 0 refuses the apply with exit 4, naming the statement and the count, and nothing of the migration is sent:

```text
$ yodel apply lint
yodel apply: refused: a pre-migration check of 20261010T1311-unique-status failed before the gate. Nothing of 20261010T1311-unique-status was applied:
  step 0, CREATE UNIQUE INDEX CONCURRENTLY orders_status_key ON yodel_34_lint.orders (status), would fail: 2 values of (status) held by more than one row, which a unique index fails on (pre-check precheck-0: SELECT (SELECT count(*) FROM (SELECT 1 FROM yodel_34_lint.orders WHERE status IS NOT NULL GROUP BY status HAVING count(*) > 1) AS duplicates) AS n)
Fix the data, then run yodel apply again; if the check is wrong, edit it in migration.json and run yodel lint --update-checksum 20261010T1311-unique-status (the plan digest moves, so the plan is approved again). A statement's pre-check is chant's count of the rows the statement fails on: fix those rows, or change the declaration.
[exit 4]
```

Both are from the `lint` claim's run, where `orders` holds two rows of each of two statuses and the declaration gains `CREATE UNIQUE INDEX CONCURRENTLY orders_status_key ON orders (status)`. `yodel lint` reports the same statement:

```text
20261010T1311-unique-status
  warning  data-dependent: step 0: SQLPG240 Create an index CONCURRENTLY on yodel_34_lint.orders_status_key: can fail on the rows already there (values of (status) held by more than one row, which a unique index fails on); yodel apply runs this pre-check before the migration's first statement and refuses when it is not 0: SELECT (SELECT count(*) FROM (SELECT 1 FROM yodel_34_lint.orders WHERE status IS NOT NULL GROUP BY status HAVING count(*) > 1) AS duplicates) AS n
```

Fix the rows, or change the declaration, and apply again. The plan and the pull request comment list the pre-checks with the migration's checks, and `yodel new` prints them when it writes the migration. A pre-check that reads a table or column an earlier statement of the same migration adds cannot run before the first statement; it is passed, and if the statement then fails on the data, the migration stops there and resumes at it on the next run.

Migrations `yodel new` writes use chant's lock-safe forms. On a table that exists, `SET NOT NULL` is a CHECK (`col IS NOT NULL`) added `NOT VALID` (SQLPG217, no rows read), validated (SQLPG220, under SHARE UPDATE EXCLUSIVE, so reads and writes go on), then `SET NOT NULL`, which the valid check proves without a scan, and the check dropped. A CHECK or a foreign key is added `NOT VALID`, then validated. Each statement runs in a transaction of its own, so no lock that blocks reads or writes is held across a scan. The plan shows each step's rule and class (`metadata`, `validate`, `concurrently`, `rewrite`), and the first statement of each sequence carries the pre-check.

## Silencing a finding

A line above a statement in its `migration.sql` silences one of the classifier rules, `data-dependent`, `naming` or a schema check for that statement:

```sql
-- yodel:allow <rule> <reason>
```

The reason is required. For an Op step, the line goes above the step's comment. From the Postgres example:

<!-- quote: postgres#silence-sql -->
```sql
-- yodel migration 20261010T1724-drop-coupon
-- parent: 20261010T1724-rename-email

-- orders (shop.orders): SQLPG204 metadata, destructive
-- yodel:allow destructive no order ever had a coupon; checked on dev
ALTER TABLE shop.orders DROP COLUMN coupon;
```

The line is part of `migration.sql`, so it changes the migration's checksum, and lint says so. In the ClickHouse example, after silencing the rebuild:

<!-- quote: clickhouse#checksum -->
```console
$ npx yodel lint
20261010T1722-events-by-id
  error    checksum: 20261010T1722-events-by-id: its files hash to sha256:957ddc1e1c31ff222c7fa567e8bcb5bc6cedef03f621d0263da0913a7c4f953c, but migration.json records sha256:e3c2c97aea554b9df6c0ad70147403180c045dc321f545c0cef0dee9bb7358c4; if it is not applied in any environment, record its new checksum with yodel lint --update-checksum 20261010T1722-events-by-id; if it is, undo the edit, or record it with yodel repair 20261010T1722-events-by-id --reason ... <env>
  silenced ch-rebuild: step 0: ClickHouseRebuildOp rebuilds shop.events: every row is copied into a new table and swapped in, for SQLCH220 Change the sorting key (orderBy)
           reason: 600 rows; the copy takes seconds

3 migrations: 1 error, 0 warnings, 1 silenced.
[exit 3]
```

For a migration not applied anywhere yet, `--update-checksum <id>` (repeatable) writes the new checksum into its `migration.json` before linting:

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

## A project with no migrations

On the declarative path there are no migrations to check. `yodel lint` runs the schema checks, the project's own checks and `lint.naming` over the build of `src/`, offline, and `yodel lint --env <env>` also plans `src/` against that environment and checks each planned change against `destructive`, `pg-rewrite`, `pg-access`, `ch-mutation`, `ch-rebuild` and `ch-access`, with `refused-step` for a change that needs its own Op. The plan says each change's rule and class but not its statement, so the rules that read a statement (`pg-lock`, `data-dependent`, `pg-signature`) run on migrations only. Nothing is silenced; `lint.rules` sets the levels. `yodel plan <env>` shows the same findings, and its pull request comment carries them ([The two workflows](workflows.md#review-on-a-pull-request)). `--replay` and `--update-checksum` read a migrations directory, and are refused.

## Against an environment's history: --env

`yodel lint --env <env>` also reads that environment's history (on the declarative path, its plan: [above](#a-project-with-no-migrations)). A `checksum` finding is then an applied migration whose files changed since it ran (an error) or a pending migration's edit (a warning). It needs the server; a server that does not answer exits 1.

## The replay check: --replay

`yodel lint --replay <env>` also replays every migration, in order, into `<env>`'s server and compares the schema each one leaves with the schema it recorded. The first that differs fails the run (rule `replay`, exit 3) and is named. This is what keeps the recorded schemas, which `yodel new` diffs against, true to what the statements do.

`<env>` should be a throwaway server: the emulator (`npx yodel emulator up`), or in CI a service container, as the starter templates' `replay` profile is. The databases or schemas the history names must not exist there yet; otherwise it runs nothing and exits 4:

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
  ok      20261010T1722-baseline (2 statements)
  ok      20261010T1722-add-country (1 statement)
  ok      20261010T1722-events-by-id (0 statements; ran step 0: ClickHouseRebuildOp for events (shop.events) (swapped))
  ok      20261010T1722-fill-country (0 statements; skipped step 0: backfill backfill.ts (moves data; the replayed database has none))
  ok      20261010T1723-add-source (1 statement)
Every migration replays to its recorded schema.

20261010T1722-events-by-id
  silenced ch-rebuild: step 0: ClickHouseRebuildOp rebuilds shop.events: every row is copied into a new table and swapped in, for SQLCH220 Change the sorting key (orderBy)
           reason: 600 rows; the copy takes seconds

5 migrations: 0 errors, 0 warnings, 1 silenced.
```

## Findings on the pull request: --format

`yodel lint --format github` prints the usual report, then one workflow command per finding, such as `::error file=migrations/<id>/migration.sql,line=3,title=yodel lint destructive::...`. GitHub Actions and Forgejo Actions read those lines and show each finding on its migration file in the pull request, on the statement's line when the rule knows it. A fork is shown on the newer of the two migrations, the one to rebase. A warning is a `::warning`, and a silenced finding a `::notice` that carries its reason.

`yodel lint --format gitlab` prints the same report and writes GitLab's code quality report to `gl-code-quality-report.json` (or the file `--output` names), even when there are no findings. An error is `major`, a warning `minor` and a silenced finding `info`.

File paths are relative to the forge's checkout (`GITHUB_WORKSPACE`, `CI_PROJECT_DIR`), or to the project's directory outside CI. In a declarative project a finding is about the declared schema or a plan, not a file, so GitHub and Forgejo show it on the run rather than on a file, and GitLab places it on the project's directory. `yodel ci` renders each forge's lint job with its format, and on GitLab keeps the report as the job's `artifacts:reports:codequality`, when the job fails too. `--json` is `--format json`.

## Tests on the replayed database: yodel test

The replay check shows each migration gives the schema it recorded. It doesn't show that the data survives a migration, that a backfill fills what it should, or that a view returns the right rows: the replayed database has no data, and the replay skips backfills. `yodel test` runs tests for those, written in `tests/*.test.ts`:

```ts
import { defineTests, expectError, expectRows, expectValue } from "@intentius/sql-yodeler";

export default defineTests([
  {
    name: "fill-country fills the country of each event in the months it covers",
    at: "20261010T1722-events-by-id",
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
