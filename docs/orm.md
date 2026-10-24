---
claims: [declarative]
type: howto
---

# Schema from an ORM

When an ORM defines some of the tables, yodel can read them from the DDL the ORM prints instead of having them rewritten as declarations. The ORM's tables then go through the same plan, approval and apply as the ones in `src/`.

yodel is a CLI. Your app keeps its ORM or query client and never imports yodel.

## Plain .sql files in src/

The simplest way to keep schema as DDL is a `.sql` file in `src/`. chant's build reads every `.sql` file in the source directory beside the TypeScript declarations, so yodel needs no configuration for it:

```sql
-- src/billing.sql
CREATE TABLE app.invoices (
  id bigint PRIMARY KEY,
  customer_id bigint NOT NULL REFERENCES app.customers (id),
  amount numeric(12, 2) NOT NULL
);

CREATE INDEX invoices_customer ON app.invoices (customer_id);
```

A file reads the same statements a DDL source does (below). A name in it that another object declares, in a `.sql` file or in TypeScript, is a dependency, so the plan creates `app.customers` first. An object declared in a file and in a template is a build error naming both. A file whose first line is `-- chant-discovery-skip` is not read, for seed data or queries kept beside the schema.

Use a file when you write or paste the DDL yourself. Use a DDL source when a command prints it, such as an ORM's, so the declarations follow the model each time yodel builds.

## A DDL source

Name each source in `yodel.config.ts` under `sources`, with the command that prints its DDL or a file that holds it:

```ts
import { defineConfig } from "@intentius/sql-yodeler";

export default defineConfig({
  sources: {
    prisma: {
      command: "npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script",
      schema: "app",
    },
    legacy: { file: "db/legacy.sql" },
  },
});
```

| Setting | What it is |
|---|---|
| `command` | a shell command, run in the project directory, that prints the DDL on stdout |
| `file` | a file of DDL, relative to the project directory |
| `schema` | the Postgres schema (ClickHouse database) for the names the DDL leaves unqualified, as an ORM does when its connection picks the schema |

Give one of `command` and `file`. A source's name is lowercase letters, digits and `-`.

Commands that print an ORM's DDL:

| ORM | Command |
|---|---|
| Prisma | `npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script` |
| Drizzle | `npx drizzle-kit export` (or `drizzle-kit generate`, then a `file` source on the SQL it wrote) |
| Django | `python manage.py sqlmigrate <app> <migration>`, one source per app |
| SQLAlchemy | a script that prints `CreateTable(table).compile(engine)` for each table of the metadata |

## What yodel does with it

Before each build (`yodel plan`, `yodel new`, `yodel apply`, `yodel drift`), yodel runs each source's command or reads its file, parses the DDL with the sql lexicon, and writes it out as declarations in `src/<name>.generated.ts`: the same file `chant import` writes, with a header saying where it came from. The build reads that file like any other declaration, so a model change shows up in `yodel plan` as the change it makes to the table, and the ApplyOp's own build finds it too.

Commit the generated file. A build that yodel does not start, such as `chant build` or an Op run outside yodel, reads the committed copy.

Keep a `file` source's DDL out of the schema build. chant's build reads every `.sql` file in the directory it builds, and an ApplyOp's diff builds the project root unless `chant.config.ts` sets `sourceDir`. A DDL file there would declare each object a second time, beside the generated file. Set `sourceDir: "src"` in `chant.config.ts`, or start the file with a `-- chant-discovery-skip` line.

yodel reads the DDL with the sql lexicon's `sqlFileDeclarations`, the reader chant's build uses for a `.sql` file in `src/`, so a source and a file read the same statements. On Postgres that is each `CREATE`, `GRANT`, `REVOKE` and `ALTER DEFAULT PRIVILEGES`, with `COMMENT ON` and `ALTER TABLE ... ROW LEVEL SECURITY` folded into the object they finish. ORMs print foreign keys as `ALTER TABLE <t> ADD CONSTRAINT ... FOREIGN KEY ...`; each `ALTER TABLE ... ADD` of a table constraint is folded into `<t>`'s `CREATE TABLE`, where a declaration holds it. `BEGIN` and `COMMIT` are skipped. On ClickHouse, it reads `CREATE DATABASE`, `TABLE`, `VIEW`, `MATERIALIZED VIEW`, `DICTIONARY` and `FUNCTION`.

Any other statement is an error that names it, and nothing is built. Leaving it out would leave part of the ORM's schema unmanaged without saying so.

With `schema` set, the unqualified names are qualified with it: on Postgres, each object's own name, an index's table, a foreign key's table, and a column whose type is an enum or domain the same DDL creates; on ClickHouse, each object's own name except a function's, which belongs to no database.

## One owner per object

An object is declared in one place. If a source creates a table that `src/` (or another source) also declares, the build stops and names both:

```text
$ yodel plan dev
yodel plan: each object has one owner, and app.customers is declared twice: by src/ (export customers) and by the source "prisma" (src/prisma.generated.ts). Leave it to one of them.
```

The same holds when `src/` exports the object under another name: yodel reads each built object's name and refuses the build when a source creates it too.

## Drizzle for queries, chant for the schema

The sections above read the ORM's schema into declarations. For Drizzle on Postgres the other direction works too: the declarations in `src/` own the schema, and chant writes the Drizzle module the application queries with. A select over it has the row type the declaration gives, and the plan, the approval and the apply stay yodel's.

```bash
npx chant sql drizzle --output app/db/schema.ts
```

The command builds the project as `chant build` does and writes `pgTable`, `pgEnum`, `pgSequence` and view declarations, with the foreign keys, indexes and constraints named as Postgres names them. The file starts with chant's generated-file marker. Commit it, and import it where the application imports its Drizzle schema today. Your app keeps Drizzle and never imports yodel.

Then stop running Drizzle's migrations:

- Remove `drizzle-kit push` and `drizzle-kit migrate` from scripts, CI and the deploy. Tables change through `yodel new`, `yodel plan` and `yodel apply`, or through a `PostgresMigrationOp` for a hard change.
- Run `npx chant sql drizzle --check --output app/db/schema.ts` in CI. It exits 1, naming the file, when `src/` declares something the file does not.
- In a chant workspace, list the file as a `generated` entry of the member, so `chant workspace check --generated` fails on a stale file ([In a chant workspace](workspace.md)):

```json
{
  "name": "db",
  "dir": "db",
  "kind": "chant",
  "generated": [
    { "path": "app/db/schema.ts", "generator": "chant sql drizzle --output app/db/schema.ts", "sources": ["db/src"] }
  ]
}
```

Use one direction per table. If a Drizzle `drizzle-kit export` source (above) declares `app.orders`, the export of the same table would write what that source already owns, and a table declared in `src/` and by a source is a build error ([One owner per object](#one-owner-per-object)). Pick the source for tables Drizzle owns, and the export for tables `src/` owns.

The module is checked against drizzle-orm 0.45.4. `bigint` columns are `number` by default, as `drizzle-kit pull` writes them, and `--bigint bigint` reads them as `bigint`. Routines, triggers, extensions, grants and the other objects Drizzle has no declaration for are listed in the file's header and left out; chant's [Drizzle Schema Export](https://intentius.io/chant/lexicons/sql/drizzle/) page has the full list and the mapping.

## Proof

The `declarative` claim runs a project whose `yodel.config.ts` has a source whose command prints a Prisma-style DDL file (the claim installs no ORM): the first apply creates the ORM's tables behind the gate, a column added to the model is the one change `yodel plan` shows, the approved apply adds it, and the plan is then empty. Under `BREAK=1` the DDL changes again after the approval, and the column is not applied.
