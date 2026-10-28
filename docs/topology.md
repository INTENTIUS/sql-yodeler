---
claims: [clickhouse]
type: reference
---

# Topology

A ClickHouse environment runs on one of four topologies. One migrations directory serves all of them: `yodel new` writes every statement for a single node and records nothing about where it will run, and `yodel apply` renders each statement for the environment's topology as it sends it. (Topology does not apply to Postgres.)

| Setting | What it is | What a statement gets |
|---|---|---|
| `single` | one server, the default | sent as written |
| `cluster:<name>` | a cluster in `remote_servers` | `ON CLUSTER <name>`; `MergeTree` engines become `ReplicatedMergeTree` with a Keeper path and replica name |
| `replicated`, `replicated:<cluster>` | `Replicated` databases, which replicate their own DDL | no `ON CLUSTER` inside the database; `ReplicatedMergeTree` with no arguments (the database supplies them); with a cluster named, `CREATE DATABASE` itself goes `ON CLUSTER` |
| `cloud` | ClickHouse Cloud | no `ON CLUSTER`; plain `MergeTree`, which Cloud turns into `SharedMergeTree` |

A dictionary is rendered like a table: `ON CLUSTER` on a cluster, none inside a `Replicated` database. A function, user, role, row policy or grant belongs to no database, so a `Replicated` database's log does not carry it: it goes `ON CLUSTER` on a cluster, and in `replicated:<cluster>` too (`CREATE FUNCTION f ON CLUSTER main`, `GRANT ON CLUSTER main SELECT ON ...`); in `replicated` with no cluster named it is sent to the node the apply runs on ([Access control](access.md#clickhouse)).

The object form, `{ kind: "cluster", cluster: "main", replicaPath: "...", replicaName: "..." }`, sets the Keeper path and replica name of the tables the migrations create (the default path is `/clickhouse/tables/{uuid}/{shard}`, the replica `{replica}`).

## Setting it

Per environment, first one set wins: `environments.<env>.topology` in `yodel.config.ts`, then `sql.profiles.<env>.topology` in `chant.config.ts`, then `YODEL_TOPOLOGY`, then `single`. `yodel status` and `yodel plan` print it with where it came from:

<!-- quote: clickhouse#status -->
```console
$ npx yodel status dev
Migrations in dev (clickhouse 26.8.15.10 at 127.0.0.1:8123, history yodeler.history, topology single (default))
...
```

The declarative path (no `migrations/`) plans and applies through chant, which reads only `sql.profiles.<env>.topology`. A topology other than `single` set only in `yodel.config.ts` is refused there (chant renders a single node when its profile sets none); set it in `chant.config.ts` too. `yodel drift` reads through chant as well and refuses the same way, on either path: chant compares the server against the declaration rendered for the profile's topology, so a cluster's `ReplicatedMergeTree` would otherwise show as drift from the declared `MergeTree`. A rebuild step (`ClickHouseRebuildOp`) runs through chant as well, and yodel hands it the environment's topology, so it renders for the same topology as the statements around it.

## The same statements on each topology

`examples/walkthrough/topology.ts` runs three statements like the ClickHouse example's through the renderer `yodel apply` calls for each statement, and prints the history's DDL for each topology:

```console
$ npx tsx examples/walkthrough/topology.ts
-- topology: single
CREATE DATABASE shop ENGINE = Atomic;
CREATE TABLE shop.events (id UInt64, kind LowCardinality(String), at DateTime) ENGINE = MergeTree PARTITION BY toYYYYMM(at) ORDER BY (kind, at);
ALTER TABLE `shop`.`events` ADD COLUMN country LowCardinality(String) DEFAULT '' AFTER `at`;
-- the history: CREATE DATABASE IF NOT EXISTS `yodeler`
--   its table's engine: MergeTree

-- topology: cluster:main
CREATE DATABASE shop ON CLUSTER `main` ENGINE = Atomic;
CREATE TABLE shop.events ON CLUSTER `main` (id UInt64, kind LowCardinality(String), at DateTime) ENGINE = ReplicatedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}') PARTITION BY toYYYYMM(at) ORDER BY (kind, at);
ALTER TABLE `shop`.`events` ON CLUSTER `main` ADD COLUMN country LowCardinality(String) DEFAULT '' AFTER `at`;
-- the history: CREATE DATABASE IF NOT EXISTS `yodeler` ON CLUSTER `main`
--   its table's engine: ReplicatedMergeTree('/clickhouse/yodeler/yodeler/history', '{shard}-{replica}')

-- topology: replicated
CREATE DATABASE shop ENGINE = Replicated('/clickhouse/databases/shop', '{shard}', '{replica}');
CREATE TABLE shop.events (id UInt64, kind LowCardinality(String), at DateTime) ENGINE = ReplicatedMergeTree PARTITION BY toYYYYMM(at) ORDER BY (kind, at);
ALTER TABLE `shop`.`events` ADD COLUMN country LowCardinality(String) DEFAULT '' AFTER `at`;
-- the history: CREATE DATABASE IF NOT EXISTS `yodeler` ENGINE = Replicated('/clickhouse/databases/yodeler', '{shard}', '{replica}')
--   its table's engine: ReplicatedMergeTree

-- topology: replicated:main
CREATE DATABASE shop ON CLUSTER `main` ENGINE = Replicated('/clickhouse/databases/shop', '{shard}', '{replica}');
CREATE TABLE shop.events (id UInt64, kind LowCardinality(String), at DateTime) ENGINE = ReplicatedMergeTree PARTITION BY toYYYYMM(at) ORDER BY (kind, at);
ALTER TABLE `shop`.`events` ADD COLUMN country LowCardinality(String) DEFAULT '' AFTER `at`;
-- the history: CREATE DATABASE IF NOT EXISTS `yodeler` ON CLUSTER `main` ENGINE = Replicated('/clickhouse/databases/yodeler', '{shard}', '{replica}')
--   its table's engine: ReplicatedMergeTree

-- topology: cloud
CREATE DATABASE shop ENGINE = Atomic;
CREATE TABLE shop.events (id UInt64, kind LowCardinality(String), at DateTime) ENGINE = MergeTree PARTITION BY toYYYYMM(at) ORDER BY (kind, at);
ALTER TABLE `shop`.`events` ADD COLUMN country LowCardinality(String) DEFAULT '' AFTER `at`;
-- the history: CREATE DATABASE IF NOT EXISTS `yodeler`
--   its table's engine: MergeTree
```

`test/docs.test.ts` checks that this block is what the script prints.

## The history and the lock

The history table follows the topology too, as above: `MergeTree` on a single node and on Cloud, one `ReplicatedMergeTree` copy for the whole cluster (its Keeper path names no shard, so every runner on any host reads the same rows), and `ReplicatedMergeTree` inside a `Replicated` database. A statement row records the hash of the statement as written, not as rendered, so a migration that failed part way resumes the same way on any topology; its `note` says what it was sent for (`topology=single`).

The plan digest covers the topology, so an approval given for one topology does not apply on another.

The apply lock is a row in a `KeeperMap` table, `<history database>.lock`, which needs Keeper and the server setting `keeper_map_path_prefix`. On a cluster the table is created `ON CLUSTER`, every host naming the same Keeper path. A single node without them falls back to a lock file on the runner's machine and says so; this is the emulator, in the ClickHouse example:

```
lock: no KeeperMap on this server (KeeperMap is disabled because 'keeper_map_path_prefix' config is not defined. (BAD_ARGUMENTS) (version 26.8.15.10 (official build))); the lock is a file on this machine, so cross-runner locking needs Keeper (and keeper_map_path_prefix)
```

A cluster, a `Replicated` database and Cloud never fall back: without the `KeeperMap` lock, the apply refuses. [Migrations](migrations.md#the-apply-lock) says how to clear a lock.

## What has been run where

The examples run on a single node (the emulator). `test/e2e/topology.test.ts` applies one migrations directory to the emulator and to a `Replicated` database on a scratch two-replica cluster with Keeper, and `test/e2e/keeper.test.ts` runs the lock and the replicated history on that cluster (both need Docker and `YODEL_E2E_KEEPER=1`).

The `topology` claim (`npm run claims -- topology`, `scenarios/claims/topology.ts`) does the same, and also applies to a sharded cluster: a third server joins the scratch cluster as a second shard (`test/e2e/keeper-cluster.ts` with `{ shards: 2 }`), and an environment with topology `cluster:yodel_sharded` gets versioned migrations, `ON CLUSTER`, with `ReplicatedMergeTree` tables and a `Distributed` table over them. The claim checks the tables on every server, rows written through the `Distributed` table landing half on each shard, the history read from the second shard, a sort-key change applied as a rebuild step that copies and verifies every shard (each keeps its own rows, and the `Distributed` table still reads them all), and `yodel drift`: clean after the applies, then naming a TTL changed on the second shard alone, and a TTL changed and a table dropped `ON CLUSTER`. Drift reads every server of the cluster and says which server a difference was seen on.

A rebuild on a cluster of more than one shard needs the `{shard}` macro on every server, distinct per shard; without it the step refuses the cluster.

What it does not cover yet:

- ClickHouse Cloud is untested beyond rendering: the `cloud` output above comes from the renderer and its unit tests, and nothing in this repository has applied to a Cloud service.
