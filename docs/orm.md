---
claims: [declarative]
---

# Schema from an ORM

When an ORM defines some of the tables, yodel can read them from the DDL the ORM prints instead of having them rewritten as declarations. The ORM's tables then go through the same plan, approval and apply as the ones in `src/`.

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

On Postgres, yodel reads `CREATE SCHEMA`, `TABLE`, `INDEX`, `VIEW`, `MATERIALIZED VIEW`, `SEQUENCE`, `TYPE ... AS ENUM`, `DOMAIN` and `EXTENSION`, with `COMMENT ON` for those. ORMs print foreign keys as `ALTER TABLE <t> ADD CONSTRAINT ... FOREIGN KEY ...`; yodel folds each `ALTER TABLE ... ADD` of a table constraint into `<t>`'s `CREATE TABLE`, where a declaration holds it. `BEGIN` and `COMMIT` are skipped. On ClickHouse, it reads `CREATE DATABASE`, `TABLE`, `VIEW` and `MATERIALIZED VIEW`.

Any other statement is an error that names it, and nothing is built. Leaving it out would leave part of the ORM's schema unmanaged without saying so.

With `schema` set, yodel qualifies the unqualified names: on Postgres, each object's own name, an index's table, a foreign key's table, and a column whose type is an enum or domain the same DDL creates; on ClickHouse, each object's own name.

## One owner per object

An object is declared in one place. If a source creates a table that `src/` (or another source) also declares, the build stops and names both:

```text
$ yodel plan dev
yodel plan: each object has one owner, and app.customers is declared twice: by src/ (export customers) and by the source "prisma" (src/prisma.generated.ts). Leave it to one of them.
```

The same holds when `src/` exports the object under another name: yodel reads each built object's name and refuses the build when a source creates it too.

## Proof

The `declarative` claim runs a project whose `yodel.config.ts` has a source whose command prints a Prisma-style DDL file (the claim installs no ORM): the first apply creates the ORM's tables behind the gate, a column added to the model is the one change `yodel plan` shows, the approved apply adds it, and the plan is then empty. Under `BREAK=1` the DDL changes again after the approval, and the column is not applied.
