# The two workflows

`yodel plan <env>` and `yodel apply <env>` take one of two paths, chosen by the project: the versioned path when it has a `migrations/` directory holding at least one migration, the declarative path otherwise. (A template's empty `migrations/`, with only `.gitkeep`, is still declarative.) Both apply behind an approval bound to a digest of what they would do; see [Approval](approval.md).

## Declarative: the declared schema against the live database

No migration files. `yodel plan <env>` shows the classified change from the environment's live database to the declared schema in `src/`, as `chant sql plan` reports it, and `yodel apply <env>` makes it.

`yodel apply` plans, then runs the project's `ApplyOp` for the environment with `chant run`. From the ClickHouse example:

```ts
// ops/apply-dev.op.ts
import { ApplyOp } from "@intentius/chant/op";

export const { op } = ApplyOp({ name: "apply-dev", env: "dev", target: "clickhouse", gate: {} });
```

The Op builds the project first with `npm run build`, so `package.json` needs a `build` script that writes chant's build output:

```json
"scripts": { "build": "chant build src --lexicon sql -o dist/schema.json" }
```

Without it the Op fails at its Build step (`npm error Missing script: "build"`).

The run below is the ClickHouse example's first apply. The Op stops at its gate and `yodel apply` exits 3 with the command that approves this plan:

```console
$ npx yodel apply dev
Plan for dev (clickhouse, sql.profiles.dev)

shop (yodel_18_shop)
  [create] object: yodel_18_shop
      SQLCH200 Create an object. A new database, table or view is created; nothing existing changes. https://clickhouse.com/docs/sql-reference/statements/create
events (yodel_18_shop.events)
  [create] object: yodel_18_shop.events
      SQLCH200 Create an object. A new database, table or view is created; nothing existing changes. https://clickhouse.com/docs/sql-reference/statements/create

2 create

Running apply-dev (<tmp>/clickhouse/ops/apply-dev.op.ts)

> sql-yodeler-example-clickhouse@0.0.0 build
> chant build src --lexicon sql -o dist/schema.json


fold: 1 file folded, 0 ran

sql — environment: dev
2 missing, 0 orphan, 0 disappeared, 0 newly observed, 0 drifted, 0 unchanged
--------------------------------------------------------------------------------

MISSING (declared, provider reports not in cloud):
  - events [queried http://192.168.14.189:8123 yodel_18_shop.events] [definition 4df0ec958ca149f9d5e482606258feb8ab4820f0dbff84efa26e4b94c1b657eb]
  - shop [queried http://192.168.14.189:8123 yodel_18_shop] [definition 9753d576a549332582784b40e5a42ded207e362694a6c40ae17e65dfc511e4bc]
[phase] Build
  ✓ chantBuild(path=.)   1.4s
[phase] Plan
  ✓ lifecycleDiff(env=dev, live=true)   1.2s
    [outcome] Drift=true
[phase] Approve
  • gate:approve-apply-dev()   skipped
[phase] Apply
  • nativeApply(target=clickhouse, env=dev, output=dist/schema.json, deleteMode=never)   skipped
Op "apply-dev" is gated on "approve-apply-dev" after 3.7s
  Approve apply to dev (delete mode: never)
  plan    : jcs1-sha256:9f3ff42832188c693979a158c11d5fe50bee60ebb0dc48162ed791178c2b1263
  approve : chant approve apply-dev approve-apply-dev --plan jcs1-sha256:9f3ff42832188c693979a158c11d5fe50bee60ebb0dc48162ed791178c2b1263
  expires : 2026-10-11T20:36:37.561Z

apply-dev is waiting at gate "approve-apply-dev" for approval of this plan.
Approve it with:
  chant approve apply-dev approve-apply-dev --plan jcs1-sha256:9f3ff42832188c693979a158c11d5fe50bee60ebb0dc48162ed791178c2b1263
then run yodel apply dev again.
[exit 3]
```

```console
$ npx chant approve apply-dev approve-apply-dev --plan jcs1-sha256:9f3ff42832188c693979a158c11d5fe50bee60ebb0dc48162ed791178c2b1263
Gate "approve-apply-dev" on "apply-dev" resolved by yodel at 2026-10-09T20:36:40.363Z
This approves the plan jcs1-sha256:9f3ff42832188c693979a158c11d5fe50bee60ebb0dc48162ed791178c2b1263, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run apply-dev` and it walks through gate "approve-apply-dev".
```

Run again, the same command applies the plan; the [example](../examples/clickhouse/README.md#1-a-declared-schema-applied-without-migrations) shows that run, which ends `Applied: dev matches the declared schema.`

What the declarative path does and does not do:

- An `ApplyOp` with no `delete` option runs with delete mode `never` (its output says `delete mode: never`): a drop stays in the plan, and `yodel apply` says so when changes remain after the Op. `delete: "owned-only"` or `"gated"` on the `ApplyOp` lets it drop (chant's `ApplyOp` options).
- A change no statement makes in place (a ClickHouse sort-key change, a Postgres column rename or type change across kinds) makes `yodel plan` exit 2, and `yodel apply` applies nothing. Those changes are steps of a migration on the versioned path ([Steps](steps.md)).
- It keeps no history. What the database is, is what the live catalog says; `yodel drift` compares the two ([Drift](drift.md)).
- The topology comes from `sql.profiles.<env>.topology` only ([Topology](topology.md)).
- chant marks the objects it creates with an ownership marker in their comment (`[chant managed-by=chant]`) and never touches an object the project does not declare.

## Versioned: migrations written from the declared schema

The declared schema stays the source. `yodel new <name>` writes the next migration by diffing it against the schema the newest migration recorded, with no database involved. Each change goes through review as a pull request holding the edit to `src/` and the migration it produced:

```sh
$EDITOR src/schema.ts
npx yodel new add-country     # writes migrations/<timestamp>-add-country/
npx yodel lint                # offline; CI runs it on every pull request
npx yodel plan dev            # the pending migrations and the plan digest
npx yodel apply dev           # behind the migrations Op's gate
```

`yodel apply` on this path runs the pending migrations in chain order, statement by statement, recording each in the history table under a lock, and resumes a migration that failed part way at the statement that failed. A change that is not one statement (a rebuild, a backfill, an expand-and-contract column change) is a step inside the migration, recorded in the same history. [Migrations](migrations.md) has the details, and [Steps](steps.md) the steps.

## Moving from one to the other

A project on the declarative path moves to the versioned one with `yodel init --from <env>`: it imports the live database into `src/`, writes the baseline migration that creates all of it, and records the baseline applied in the environment's history without running it. With `src/` already declaring the schema, `--force` lets it write over the declarations. Then the `ApplyOp` gives way to a migrations Op. Both examples start declarative and move this way; [Starting a project](adoption.md) has the run.

Going back is deleting `migrations/` and adding an `ApplyOp`. The history table stays in the database, unread.
