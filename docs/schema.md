---
claims: [migrations, declarative]
type: concepts
---

# Declaring the schema

SQL Yodeler is declarative: `src/` says what the database should be, and yodel works out the change from what it is. The schema is TypeScript in `src/`. Each exported constant is one object: a database or schema, a table, a view, an index. Its body is the database's own DDL, in a tagged template from chant's `sql` lexicon, so a statement reads the way `SHOW CREATE` prints it. TypeScript holds the statements together: objects import each other, refer to each other with `${}`, and composites make families of them. `yodel new` writes the next migration from the change since the last one, and `yodel plan` shows a declarative change against the live server ([The two workflows](workflows.md)).

<!-- tabs: dialect -->
#### ClickHouse

```ts
// src/schema.ts
import { database, table } from "@intentius/chant-lexicon-sql/clickhouse";

export const db = database`
  CREATE DATABASE events
  ENGINE = Atomic`;

export const events = table`
  CREATE TABLE ${db}.events (
    id       UInt64,
    kind     LowCardinality(String),
    at       DateTime
  )
  ENGINE = MergeTree
  ORDER BY (kind, at)`;
```

#### Postgres

```ts
// src/schema.ts
import { index, schema, table } from "@intentius/chant-lexicon-sql/postgres";

export const app = schema`CREATE SCHEMA app`;

export const orders = table`
  CREATE TABLE ${app}.orders (
    id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    status    text NOT NULL DEFAULT 'placed',
    amount    numeric(12,2) NOT NULL,
    placed_at timestamptz NOT NULL DEFAULT now()
  )`;

export const ordersByStatus = index`
  CREATE INDEX orders_status_idx ON ${orders} (${orders.columns.status})`;
```
<!-- /tabs -->

The export name is the object's identity, and the name in the SQL is its name on the server. Keep the export name when you change the name in the SQL, and the change is planned as a rename, not as a drop and a create.

## Why plain SQL

Each object is written as the statement the server runs. That choice gives you:

- A pull request shows the DDL the server will see, with nothing translated in between, so anyone who reads SQL can review it.
- Any clause the server accepts goes in, with no attribute vocabulary to wait for when the server adds a clause or a setting. A clause chant's parser does not know is kept as written: the build warns and names it, the catalog check and the server decide, and a change to that clause is planned as one a person reviews. The build still fails on statements that are not schema (`INSERT`, `DROP`, `SET`), on kinds of object chant does not declare, on access statements, on a near-miss spelling of a known clause, and on unbalanced parentheses or a query inside the clause.
- The schema is still a model. The build parses every statement into objects, columns, types and keys, so plans, lint, renames and column lineage work on it, and your own lint rules can read it ([Lint](lint.md)).
- ClickHouse changes are classified and linted like Postgres ones, and a change `ALTER` cannot make, such as a new sort key, is planned as a rebuild ([Data changes](#data-changes)).
- There is no second language whose meaning has to be kept in step with the database's, so nothing drifts from the server.
- The build checks the schema offline against the catalog of a pinned server release, with no development database ([What the build checks](#what-the-build-checks)).
- Every feature is in the open-source CLI.

## Schema as data

The build reads `src/` as data: it reduces each file to the objects it declares, without running it. So the same source gives the same schema on any machine and in every environment, the schema at two commits can be compared with no database, and nothing in it depends on where or when it was built.

That makes `src/` a small part of TypeScript: exported objects, constants and strings, imports between files, `${}` references, and composites called with literal options. What a program would do is not schema:

- Reading an environment variable or a file, or querying a database. The schema is the same in every environment; what differs between them, the server and the credentials, is in `chant.config.ts`'s profiles ([Installing and configuring](configuration.md)).
- `if` or a loop around exports, `let`, and functions or callbacks in `src/`. Write each object as an export, or put the repetition in a composite ([Generating objects](#generating-objects)).

A file outside that part still builds, but chant runs it instead of reading it, and `chant build --verbose` names the file and the reason. chant's [TypeScript as data](https://intentius.io/chant/concepts/typescript-as-data/) page has the whole subset.

## References

An interpolated object is a reference, not text. `${db}.events` still reads `events.events` in the statement sent to the server, and the build also knows the table belongs to that database, so it creates the database first. A column is referenced through `.columns`:

```ts
// src/views.ts
import { view } from "@intentius/chant-lexicon-sql/clickhouse";
import { db, events } from "./schema.js";

export const byKind = view`
  CREATE VIEW ${db}.events_by_kind AS
  SELECT ${events.columns.kind} AS kind, count() AS n
  FROM ${events}
  GROUP BY kind`;
```

A misspelled reference, `${events.columns.knd}`, fails the build and says which interpolation is undefined. When a view reads every column through a reference, the build also records which columns each of its output columns comes from.

A name written as plain text is SQL, not a reference: `FROM events.events` builds and runs, but the build cannot order the view after the table. Plain text is the way to name something the project does not declare, such as a table another team owns (`REFERENCES billing.accounts (id)`) or a role the environment keeps.

## Splitting the schema

Any number of files in `src/` make up the schema, and they import each other like any TypeScript modules: a database in `src/db.ts`, a table per file, the views beside the tables they read. The build orders the objects by their references, whatever the file order. Plain `.sql` files in `src/` and DDL an ORM prints join the same build ([Schema from an ORM](orm.md)).

## Generating objects

A family of objects with the same shape is a composite of your own: the shape once, in a module outside `src/`, and one call per object in `src/`. A rollup table per region:

```ts
// lib/rollup.ts
import { Composite } from "@intentius/chant/composite";
import { table, type ClickHouseDatabase } from "@intentius/chant-lexicon-sql/clickhouse";

export const DailyRollup = Composite((props: { db: ClickHouseDatabase; region: string }) => ({
  table: table`
    CREATE TABLE ${props.db}.${`daily_${props.region}`} (
      day  Date,
      kind LowCardinality(String),
      n    UInt64
    )
    ENGINE = SummingMergeTree
    ORDER BY (day, kind)`,
}), "DailyRollup");
```

```ts
// src/daily.ts
import { DailyRollup } from "../lib/rollup.js";
import { db } from "./schema.js";

export const { table: dailyEu } = DailyRollup({ db, region: "eu" });
export const { table: dailyUs } = DailyRollup({ db, region: "us" });
export const { table: dailyApac } = DailyRollup({ db, region: "apac" });
```

The build reads `src/daily.ts` as data and writes three `CREATE TABLE` statements. A fourth region is one more line, and `yodel new` writes its table into the next migration.

## Composites

The `sql` lexicon ships composites of its own, for shapes many schemas need. On Postgres, `TenantTable` puts the tenant column first in the table's primary key and in an index:

```ts
// src/tickets.ts
import { TenantTable } from "@intentius/chant-lexicon-sql/postgres";
import { app } from "./schema.js";

export const { table: tickets, index: ticketsByTenant } = TenantTable({
  name: "tickets",
  schema: app,
  columns: "id bigint GENERATED ALWAYS AS IDENTITY, title text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()",
  primaryKey: "id",
  indexOn: "created_at DESC",
});
```

That builds a table with `PRIMARY KEY (tenant_id, id)` and the index `tickets_tenant_idx` on `(tenant_id, created_at DESC)`. The others: `SoftDeleteTable`, `AuditLogTable`, `JoinTable` and `RefreshedView` on Postgres; `EventsTable`, `ReplacingTable`, `RollupView`, `CdcMirror` and `ShardedTable` on ClickHouse. chant's [composites page](https://intentius.io/chant/lexicons/sql/composites/) has each one's options.

## Data changes

The declaration says what the schema should be; some changes also move data. When the change from the last migration is one no statement makes in place, `yodel new` writes it as a data step of the same migration: a ClickHouse sort-key or engine change as a rebuild into a new table, a Postgres column rename or type change as expand and contract, and a backfill you write with `yodel new <name> --backfill`. A data step runs under the same lock and approval as the statements, and resumes where it stopped ([Data migrations](steps.md)).

## What the build checks

`chant build`, which yodel runs itself before it writes or plans a migration, parses every statement and checks it against the catalog of a pinned server, read from that release's own system tables: ClickHouse 26.8, and each Postgres major from 14 to 18. A mistake fails the build with a message that names the object, the column and the release:

- a column type the server does not have, in any spelling it does not accept (`UInt46`, `uint64`, `numerik`), wrong type parameters (`Decimal(100, 2)`, `numeric(2000,2)`, `bigint(8)`), or a nesting it refuses (`Nullable(Array(String))`)
- an engine, codec, codec parameter, MergeTree setting, Postgres storage parameter, index access method or operator class the server does not have
- a function the server does not have, in a default, a key, a partition, a TTL, a check or an index
- a column named in a key, an index, a foreign key or a grant that the table does not declare, and a foreign key between columns whose types cannot compare
- a column declared twice, or two exports that declare the same object

Names written as plain text for objects the project does not declare, and column names inside expressions, are left to the server. Lint rules then flag what the server would accept but should not: a primary key that is not a prefix of the sort key, a partition finer than a day, a timestamp without time zone, a foreign key no index leads with. [Lint](lint.md) has yodel's own rules on migrations, and chant's [lint rules page](https://intentius.io/chant/lexicons/sql/lint-rules/) has the build's.

## Typed columns

The build catches a misspelled `${events.columns.knd}`, but only when it runs. To have the editor and `tsc` catch it as you type, give the table its qualified name as a type argument and generate the types:

```ts
// src/schema.ts
export const orders = table<"shop.orders">`
  CREATE TABLE ${shop}.orders (
    id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email text NOT NULL
  )`;
```

```sh
npx chant sql types   # writes src/sql-types.d.ts; commit it
```

`tsc` then knows each column, with its type:

```ts
${orders.columns.emial}
// error TS2551: Property 'emial' does not exist on type '{ id: ...; email: ...; }'. Did you mean 'email'?
```

The name is `schema.table` in Postgres and `database.table` in ClickHouse. It also checks a Postgres foreign key's column types and a Nullable column in a ClickHouse sort key. A declaration without the type argument keeps working as before, so a project can adopt it one table at a time.

`RowOf` gives the row type of a table for application code, as the database driver returns it:

```ts
import type { RowOf } from "@intentius/chant-lexicon-sql/postgres";
import type { orders } from "./schema.js";

type Order = RowOf<typeof orders>; // { id: string; email: string }
```

Run `chant sql types` again after each schema change. When a project commits `sql-types.d.ts`, the pull request job `yodel ci` renders runs `chant sql types --check`, which fails when the file no longer matches the schema. Tables a composite builds get their `RowOf` type, but their `.columns` stay unchecked until [chant#3787](https://github.com/INTENTIUS/chant/issues/3787). The examples (`examples/clickhouse`, `examples/postgres`) use typed columns, and chant's [typed columns page](https://intentius.io/chant/lexicons/sql/typed-columns/) has the type mapping for each dialect.

## In the editor

chant's language server (`chant serve lsp`, set up as [chant's LSP page](https://intentius.io/chant/cli/lsp/) shows) completes inside the templates from the same catalog: engines after `ENGINE =`, column types, codecs, settings and functions, and after `${` the tables and views the project declares and their columns. Hovering a type, an engine or a `${}` reference shows what it is, and chant's lint findings appear as you type.
