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

The history is an append-only table, `<db>.history`, one row per migration and per statement event, never updated or deleted. Until `yodel.config.ts` (#9) sets them per environment, the process environment does:

- `YODEL_HISTORY_DATABASE`: the database for the history and the lock (default `yodeler`)
- `YODEL_TOPOLOGY`: `single` (default, MergeTree), `cluster:<name>` (ReplicatedMergeTree `ON CLUSTER`), `replicated[:<cluster>]` (a Replicated database, ReplicatedMergeTree with no arguments) or `cloud` (plain MergeTree DDL)
- `YODEL_LOCK_TTL`: the apply lock's TTL in seconds (default 900)

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
