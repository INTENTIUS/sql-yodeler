---
claims: []
type: howto
---

# Schema docs

`yodel docs` writes a reference of the schema for people reading a pull request or onboarding to a project: one HTML page and one Mermaid entity-relationship diagram, from the build of the declared schema. It reads no server and starts nothing; the HTML has its styles inline and no scripts, so it opens from disk or from any static host.

```sh
npx yodel docs                       # writes schema-docs/index.html and schema-docs/erd.md
npx yodel docs --out site/schema     # somewhere else
npx yodel docs --migration 20261010T1723-baseline   # the schema that migration recorded
```

`schema-docs/index.html` lists every database or schema, table, view, materialized view and index, with:

- its columns: type, nullability, default or generated expression, codec, and comment
- its keys: the primary key, unique constraints, checks and foreign keys on Postgres; the engine with its arguments, `ORDER BY`, `PRIMARY KEY`, `PARTITION BY`, `SAMPLE BY` and `TTL` on ClickHouse
- its relations both ways: the foreign keys it holds and the ones that reference it, what a view or materialized view reads, the table a materialized view writes to, the local table a `Distributed` table serves
- its history: each step in `migrations/` that changed it, in chain order
- its DDL

`schema-docs/erd.md` is the diagram as a Markdown file with a `mermaid` block, which GitHub, GitLab and Forgejo render in place. A foreign key is drawn as many-to-one (zero-or-one when its columns may be null); the other relations are dashed. Columns in a primary key are marked `PK`: on ClickHouse that is the `PRIMARY KEY`, or the `ORDER BY` when the table sets none, since the sparse index is built on it. Mermaid takes a type as one word, so spaces and commas in a type become `_` in the diagram; the HTML shows the type as declared.

The same schema always gives the same files, so a project can commit them and a pull request that changes the schema shows the change in `erd.md` and `index.html` next to the migration. `--migration <id>` documents the schema a migration recorded instead of the build, with the history up to that migration.

## The examples

Both example projects commit their output, and `npm run check` fails when it is not what `yodel docs` writes now (`test/schema-docs.test.ts`).

The [ClickHouse example](../examples/clickhouse/README.md) declares one database and one table. [Its reference](../examples/clickhouse/schema-docs/index.html) shows the table's `MergeTree` engine, its sort and partition keys, and the migrations that changed it, the sort-key rebuild among them. A backfill step names no object, so it is in no history.

<!-- erd: clickhouse -->
<pre class="mermaid">
erDiagram
  shop_events["shop.events"] {
    UInt64 id PK
    LowCardinality(String) kind PK
    DateTime at
    LowCardinality(String) country
    LowCardinality(String) source
  }
</pre>

The [Postgres example](../examples/postgres/README.md) declares a schema, a table and three indexes. [Its reference](../examples/postgres/schema-docs/index.html) shows the primary key, the check constraint, the indexes, and the history, the column rename as an expand-and-contract step included.

<!-- erd: postgres -->
<pre class="mermaid">
erDiagram
  shop_orders["shop.orders"] {
    bigint id PK
    text email
    text status
    numeric(12_2) amount
    timestamp_with_time_zone placed_at
    timestamp_with_time_zone refunded_at
    boolean gift
  }
</pre>

Neither example has a foreign key or a view, so neither diagram has a relation line. A project with them gets one per foreign key, per table a view reads and per materialized view target.
