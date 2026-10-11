---
claims: [new, declarative]
type: concepts
---

# Declaring the schema

The schema is TypeScript in `src/`. Each exported constant is one object: a database or schema, a table, a view, an index. Its body is the database's own DDL, in a tagged template from chant's `sql` lexicon, so a statement reads the way `SHOW CREATE` prints it. TypeScript holds the statements together: objects import each other, refer to each other with `${}`, and can be made by functions and loops. `yodel new` writes the next migration from the change since the last one, and `yodel plan` shows a declarative change against the live server ([The two workflows](workflows.md)).

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

Because the schema is TypeScript, a family of objects can be written once. One rollup table per region:

```ts
// src/regions.ts
import { table } from "@intentius/chant-lexicon-sql/clickhouse";
import { db } from "./schema.js";

const regions = ["eu", "us", "apac"] as const;

export const [dailyEu, dailyUs, dailyApac] = regions.map(
  (region) => table`
    CREATE TABLE ${db}.${`daily_${region}`} (
      day  Date,
      kind LowCardinality(String),
      n    UInt64
    )
    ENGINE = SummingMergeTree
    ORDER BY (day, kind)`,
);
```

The build writes three `CREATE TABLE` statements, and `yodel new` adds a fourth region's table the day the list grows.

## Composites

The `sql` lexicon ships composites: functions that take typed options and return several objects. On Postgres, `TenantTable` puts the tenant column first in the table's primary key and in an index:

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

## What the build checks

`chant build`, which yodel runs itself before it writes or plans a migration, parses every statement and checks it against the catalog of a pinned server, read from that release's own system tables: ClickHouse 26.8, and each Postgres major from 14 to 18. An engine, a codec, a MergeTree setting or a Postgres storage parameter the server does not have fails the build, naming the release; so does a key or index column the table does not declare. Lint rules flag what the server would accept but should not: a primary key that is not a prefix of the sort key, a partition finer than a day, a timestamp without time zone, a foreign key no index leads with. [Lint](lint.md) has yodel's own rules on migrations, and chant's [lint rules page](https://intentius.io/chant/lexicons/sql/lint-rules/) has the build's.

## In the editor

chant's language server (`chant serve lsp`, set up as [chant's LSP page](https://intentius.io/chant/cli/lsp/) shows) completes inside the templates from the same catalog: engines after `ENGINE =`, column types, codecs, settings and functions, and after `${` the tables and views the project declares and their columns. Hovering a type, an engine or a `${}` reference shows what it is, and chant's lint findings appear as you type.
