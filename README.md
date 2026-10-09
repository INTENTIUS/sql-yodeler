# SQL Yodeler

Schema management and migrations for ClickHouse and Postgres, on chant's `sql` lexicon. Nothing is built yet.

## Development

Node 22 (`.nvmrc`).

```sh
npm ci
npm run build
npx yodel --help
npm run check   # typecheck, lint and test
```

Working rules are in `AGENTS.md`.

## Versioned migrations (ClickHouse)

`yodel apply <env>` takes the versioned path when the project has a `migrations/` directory holding at least one migration (`yodel new` writes them); otherwise it is the declarative path, unchanged. `yodel status <env>` lists applied, pending, out-of-order and part-way migrations and checksum mismatches (`--json`; exit 0 up to date, 3 pending, 4 mismatch or out of order, 2 an Op step, 1 error).

`yodel init --from <env>` adopts an existing database: it reads it with chant's import (`chant import --from`), writes the declarations to `src/`, checks they plan clean, writes the baseline migration (the first one, creating everything) and records it applied in the history without running it (a succeeded migration row whose `note` starts `baseline:`). It needs a `chant.config.ts` with `sql.profiles.<env>` already, and for ClickHouse the profile's `databases`; `yodel init --help` has the rest. On Postgres it writes the declarations and the baseline, and recording the baseline waits for the Postgres history (#13).

The history is an append-only table, `<db>.history`, one row per migration and per statement event, never updated or deleted.

### yodel.config.ts

An optional `yodel.config.ts` next to `chant.config.ts` sets what chant's config does not, per environment (by its `sql.profiles` name):

```ts
// yodel.config.ts
import { defineConfig } from "@intentius/sql-yodeler";

export default defineConfig({
  environments: {
    dev: { topology: "single" },
    staging: { topology: "replicated" },
    prod: { topology: "cluster:main", history: { database: "yodeler" }, lockTtl: 1800 },
  },
});
```

- `topology`: `single` (a single node), `cluster:<name>` (`ON CLUSTER <name>`, `Replicated*MergeTree` with a Keeper path), `replicated` or `replicated:<cluster>` (a `Replicated` database: no `ON CLUSTER`, `Replicated*MergeTree` with no arguments), or `cloud` (no `ON CLUSTER`, plain MergeTree, which Cloud makes `SharedMergeTree`). The object form, `{ kind: "cluster", cluster: "main", replicaPath, replicaName }`, sets the Keeper path and replica name of the tables the migrations create. Order: `yodel.config.ts`, then `sql.profiles.<env>.topology` in chant.config.ts, then `YODEL_TOPOLOGY`, then `single`.
- `history.database`: the database for the history and the lock. Then `YODEL_HISTORY_DATABASE`, then `yodeler`.
- `lockTtl`: the apply lock's TTL in seconds. Then `YODEL_LOCK_TTL`, then 900.

One migrations directory serves every topology. `yodel new` writes each statement for a single node and records nothing about where it runs; `yodel apply` renders each statement for the environment's topology as it sends it (chant's `renderStatement`). The history records a statement by the hash of the statement as written, so a migration that failed part way resumes the same way on any topology, and the statement row's `note` says the topology it was sent for (`topology=cluster:main`). The plan digest covers the topology, so an approval given for one topology does not apply on another. The history table's own engine follows the topology too: MergeTree on a single node and on Cloud, `ReplicatedMergeTree` `ON CLUSTER` on a cluster (one copy for the whole cluster), `ReplicatedMergeTree` inside a `Replicated` database. `yodel status` and `yodel plan` print the topology and where it came from.

The declarative path (no `migrations/`) plans and applies through chant, which reads `sql.profiles.<env>.topology` only, so a topology set in `yodel.config.ts` alone is refused there; set it in chant.config.ts as well. A rebuild step (`ClickHouseRebuildOp`) also runs through chant and renders for `sql.profiles.<env>.topology`.

One apply runs at a time: the lock is a row in a KeeperMap table, `<db>.lock`, which needs Keeper and `keeper_map_path_prefix` on the server. A single node without them gets a lock file on the runner's machine, and the run says cross-runner locking needs Keeper. A lock left by a dead runner expires; to clear it sooner, once you know nothing is applying: `ALTER TABLE <db>.lock DELETE WHERE name = 'apply'` (or remove the lock file the refusal names).

The apply runs as a chant Op behind a gate bound to the plan digest (the pending migrations' checksums, the history and the live schema). `yodel apply <env>` prints the declaration to add when there is none:

```ts
// ops/migrate-prod.op.ts
import { Op, phase, gate, shell, stepOutput } from "@intentius/chant/op";

const plan = shell("yodel apply prod --digest", { id: "plan" });
const digest = stepOutput(plan, "stdout");

export const op = Op({
  name: "migrate-prod",
  overview: "Apply the pending migrations to prod, behind an approval bound to their plan digest",
  phases: [
    phase("Plan", [plan]),
    phase("Approve", [gate("approve-migrate-prod", { plan: digest })]),
    phase("Apply", [shell("yodel apply prod --execute", { env: { YODEL_APPROVED_PLAN: digest }, timeout: "2h" })]),
  ],
});
```

`yodel apply prod` stops at the gate and prints `chant approve migrate-prod approve-migrate-prod --plan <digest>`; approve, then run it again. `yodel apply prod --plan` prints the pending migrations and the digest without applying. Running `chant run migrate-prod` directly needs `yodel` on PATH.
