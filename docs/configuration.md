# Installing and configuring

## Installing

`@intentius/sql-yodeler` is not published to npm. Today it installs from a built clone of this repository, either linked or packed. It needs Node 22.12 or later.

Build it once:

```sh
git clone https://github.com/INTENTIUS/sql-yodeler.git
cd sql-yodeler
npm ci
npm run build
```

Then, in your project, either install the clone by path (npm links it, so a rebuild of the clone is picked up):

```sh
npm install ../sql-yodeler
```

or pack it and install the tarball, which you can commit so CI does not need the clone:

```sh
mkdir -p vendor
(cd ../sql-yodeler && npm pack --pack-destination "$OLDPWD/vendor")
npm install ./vendor/intentius-sql-yodeler-0.0.0.tgz
npx yodel --version
```

The project also needs chant and the `sql` lexicon, which `chant.config.ts` and the declarations import: `npm install @intentius/chant@0.114.0 @intentius/chant-lexicon-sql@0.114.0`.

The starter templates' `package.json` names `github:INTENTIUS/sql-yodeler#main`. That install currently gives a package with no `dist/` and no `yodel` bin ([issue #44](https://github.com/INTENTIUS/sql-yodeler/issues/44)); replace it with one of the two forms above until that is fixed. The examples in `examples/` use `file:../..`, the clone they sit in.

## A project

A project is one directory:

```
chant.config.ts     the dialect and one profile per environment (chant's config)
yodel.config.ts     optional: what yodel needs per environment that chant's config does not say
src/                the declared schema (chant's sql lexicon)
migrations/         the versioned migrations, written by yodel new (absent on the declarative path)
ops/                the Ops yodel apply runs (a migrations Op or an ApplyOp per environment), and drift watches
package.json
```

Every command takes `-C <dir>` (`--dir`) for a project elsewhere than the working directory.

## chant.config.ts

The connection and the scope of each environment are chant's: `sql.profiles.<env>`. From the Postgres example:

```ts
import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-sql";

export default {
  lexicons: ["sql"],
  sourceDir: "src",
  sql: {
    dialect: "postgres",
    profiles: {
      dev: {
        url: process.env.DEV_POSTGRES_URL ?? "postgres://127.0.0.1:5432/postgres",
        user: { env: "DEV_POSTGRES_USER" },
        password: { env: "DEV_POSTGRES_PASSWORD" },
        schemas: ["yodel_18_shop"],
      },
    },
  },
} satisfies ChantConfig;
```

| Field | Meaning |
|---|---|
| `url` | ClickHouse: the HTTP interface (`http://clickhouse:8123`). Postgres: a connection URL with no password in it. |
| `user`, `password` | `{ env: "<VAR>" }`: the variable each is read from. Credentials are never written in the file. |
| `databases` (ClickHouse) | the databases the project's schema lives in. `yodel init --from` needs it, and the history's database must not be one of them. |
| `schemas` (Postgres) | the same, for schemas. |
| `topology` (ClickHouse) | the topology chant renders for; see [Topology](topology.md). |
| `lockTimeoutMs`, `statementTimeoutMs`, `scanTimeoutMs` (Postgres) | the `lock_timeout` of every statement `yodel apply` sends (default 5000), the `statement_timeout` of a catalog change (default 60000), and of a statement that reads or rewrites rows (default none). |

The starter templates read a reader's or a writer's credentials by `YODEL_CREDENTIALS` (`writer` only in the apply job); see each template's README.

## yodel.config.ts

Optional. Keyed by the profile names in `chant.config.ts`:

```ts
import { defineConfig } from "@intentius/sql-yodeler";

export default defineConfig({
  environments: {
    dev: { topology: "single", history: { database: "yodeler" } },
    prod: { topology: "cluster:main", history: { database: "yodeler" }, lockTtl: 1800 },
  },
  lint: { rules: { "ch-mutation": "warning" } },
});
```

`import type { YodelConfig } from "@intentius/sql-yodeler"` with `satisfies YodelConfig`, as the templates and examples do, types it the same way.

| Setting | 1. yodel.config.ts | 2. chant.config.ts | 3. variable | Default |
|---|---|---|---|---|
| topology (ClickHouse) | `environments.<env>.topology` | `sql.profiles.<env>.topology` | `YODEL_TOPOLOGY` | `single` |
| the history's database (ClickHouse) or schema (Postgres) | `environments.<env>.history.database` | | `YODEL_HISTORY_DATABASE` | `yodeler` |
| the ClickHouse apply lock's TTL, in seconds | `environments.<env>.lockTtl` | | `YODEL_LOCK_TTL` | 900 |
| lint rule levels | `lint.rules` | | | each rule's own |

The first one set wins. `yodel status <env>` and `yodel plan <env>` print the topology and where it came from (`topology single (default)`).

The declarative path plans and applies through chant, which reads only `sql.profiles.<env>.topology`. So a topology set in `yodel.config.ts` alone is refused there, even `single`:

```console
$ yodel plan dev
yodel plan: yodel.config.ts sets environments.dev.topology to single, but the declarative path plans and applies through chant, which reads sql.profiles.dev.topology (unset). Set sql.profiles.dev.topology to the same in chant.config.ts, or leave the topology to chant.config.ts.
```

## Environment variables

| Variable | Read by | Meaning |
|---|---|---|
| `YODEL_TOPOLOGY` | the versioned commands on ClickHouse (`apply`, `plan`, `status`, `init`, `repair`, `lint --replay`) | the topology, when neither config sets one; the declarative path does not read it |
| `YODEL_HISTORY_DATABASE` | the versioned commands | the history's database or schema, when `yodel.config.ts` sets none |
| `YODEL_LOCK_TTL` | `yodel apply`, `yodel init`, `yodel repair` on ClickHouse | the lock's TTL in seconds |
| `YODEL_LOCK_RETRIES` | `yodel apply` on Postgres | how many more times a statement that hit `lock_timeout` is tried (default 5, the pause doubling from 250 ms) |
| `GITHUB_TOKEN`, `GITLAB_TOKEN`, `FORGEJO_TOKEN` | `yodel plan --comment` | the forge token; see [Approval](approval.md) |

`YODEL_APPROVED_PLAN` and `YODEL_ALLOW_OUT_OF_ORDER` are set by `yodel apply` for the migrations Op's own steps; you do not set them.
