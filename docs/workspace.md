---
claims: []
type: howto
---

# In a chant workspace

A yodel project can be a member of a [chant workspace](https://intentius.io/chant/reference/workspace-declaration/), the repository-level declaration that lists a team's projects and what each one reads from the others. chant reads the project's tables, views and columns as outputs, so another member can link to one, and `chant workspace check` fails when `src/` stops declaring it. A dbt project is a member too: its `sources.yml` links to the tables a yodel project declares, and dropping or renaming a column a dbt source reads fails the check at the dbt file and line.

This needs chant 0.124.23 or later (INTENTIUS/chant#3931, #3932 and #3941).

## The workspace

```json
{
  "name": "shop",
  "schema": 1,
  "pins": [{ "package": "@intentius/chant-lexicon-sql", "version": "0.124.23" }],
  "members": [
    { "name": "db", "dir": "db", "kind": "chant" },
    {
      "name": "app",
      "dir": "app",
      "kind": "other",
      "because": "the service that reads events",
      "links": [{ "member": "db", "output": "app.events.kind" }]
    },
    { "name": "analytics", "dir": "analytics", "kind": "dbt", "fields": { "sqlMember": "db", "dialect": "postgres" } }
  ]
}
```

`db` is the yodel project, with `chant.config.ts`, `src/`, `migrations/` and `ops/` as `yodel create` made them. Nothing in it changes to be a member. `pins` pins the sql lexicon, whose kinds file has the `dbt` kind.

## Output names

Each table or view is an output, and each of its columns:

| Dialect | Table or view | Column |
|---|---|---|
| Postgres | `<schema>.<table>` | `<schema>.<table>.<column>` |
| ClickHouse | `<database>.<table>` | `<database>.<table>.<column>` |

The names are the ones `src/` declares, never an environment's or a tenant's. A [tenant set](migrations.md) applies the same tables to every tenant's schema, and links name the template's schema, the one in `src/`. Postgres folds unquoted names to lower case; ClickHouse keeps them as written. chant's [sql lexicon page](https://intentius.io/chant/lexicons/sql/workspace-outputs/) has the rules for views and quoted names.

A table from an ORM's DDL ([Schema from an ORM](orm.md)) is an output once `yodel` has written its declarations into `src/`, which every build does.

## dbt sources

The `dbt` member reads each source in its `.yml` files. A source table links to `<schema>.<table>`, and each column it lists to `<schema>.<table>.<column>`. When a source sets no `schema`, its `name` stands in, as in dbt. On ClickHouse, dbt-clickhouse reads a source's `schema` as the database, and the member sets `"dialect": "clickhouse"` so names keep their case. Set `sqlMember` to the yodel project when more than one member declares tables.

A source name templated with Jinja (`{{ target.schema }}`) is not rendered. chant reports it as a gap (`WSP099`) and leaves its links out, so the links are the same in every environment.

## Dropping and renaming a column

Drop a column from `src/` and every link to it fails:

```
WSP093 app's link to db output app.events.kind does not resolve: db has no output app.events.kind; its outputs: app.events, app.events.at, app.events.id
```

Run `chant workspace check` in the pull request that drops it, beside `yodel lint`, and the change is caught before `yodel new` writes the migration that would drop the column for good.

For a rename, leave a hint on the new column in `src/`, the same `-- previously:` line chant reads to plan a rename:

```sql
    category text NOT NULL, -- previously: kind
```

and each link to the old name says where it went: `it was renamed to app.events.category, so link to that instead`.

## Ops and backfills

chant reads a member's outputs by folding its TypeScript without running it, the whole directory, `ops/` and `migrations/` included. A name exported twice stops that fold, so every Op in a yodel project has an export of its own. The templates name each one after the Op (`migrateDev`, `watchDev`), and `yodel new --backfill` writes `backfillFillCountry` for a backfill of `fill-country`. chant finds an Op by its value, not its export name, so the name is yours to choose.

A project made before this release exports `op` from each of `ops/*.op.ts` (and from each backfill). Rename each `ops/` file's export, as in `export const { op: watchDev } = WatchOp(...)`. Leave a backfill already in a migration as it is: its file counts in the migration's checksum, and yodel still reads a backfill's Op as `op`.
