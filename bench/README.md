# The bench

What yodel costs as a schema and a history grow (#35), measured on the
emulator and kept in this repo. Nothing here is published, and nothing is
compared with another tool.

```
npm run bench                                  every measurement, 10 objects, both dialects
npm run bench -- apply resume                  only those measurements
npm run bench -- --sizes 10,100                other sizes
npm run bench -- --full                        10, 100, 1,000 and 10,000 objects
npm run bench -- --dialects ch                 ClickHouse only (ch, pg)
```

Options: `--keep` leaves the databases and the scratch projects behind for a
look; `--replay-max <n>` caps the replayed history (default 1,000
migrations); `--backfill-rows <n>` sets the backfill's rows (default
1,000 per object, at most 1,000,000); `--batches <n>` its batches (default 10).

The default size is the smallest, so a plain `npm run bench` is a check that
the harness works. The large sizes run only when asked for, with `--full` or
`--sizes`.

## What it needs

The emulator (`chant emulator up --lexicon sql`), reached at its LAN
address, and `psql` on PATH. The endpoints, and their defaults:

| variable | default |
|---|---|
| `YODEL_BENCH_CLICKHOUSE_URL` | `http://192.168.14.189:8123` |
| `YODEL_BENCH_POSTGRES_HOST` | `192.168.14.189` |
| `YODEL_BENCH_POSTGRES_PORT` | `5432` |
| `YODEL_BENCH_POSTGRES_USER` | `postgres` |
| `YODEL_BENCH_POSTGRES_PASSWORD` | `chant` |

A run writes only to databases (ClickHouse) and schemas (Postgres) named
`yodel_35_<dialect>_<size>` and those names with `_history`, `_oracle`,
`_r`, `_r_history` and `_r_oracle` after them. It drops them before it
starts and again when it ends. On ClickHouse the backfill's receipts go to
chant's own `chant_receipts.receipts`, and the run deletes its environments'
rows from it when it ends.

## What it measures

For each dialect and size, a scratch project of `size` tables (a database
or schema and `size` tables, a hundred to a file), its own git repository,
and the migrations Op. Each yodel command is the built `dist/bin.js`, run as
a person runs it. Where yodel sends statements to the server, the same
statements are also sent straight to a copy, the oracle, so the difference is
yodel's overhead and not the server's speed.

| measurement | what is timed | oracle |
|---|---|---|
| `new` | `yodel new` for the first migration (every object) and for a second one (a column on every table) | none: `new` sends nothing |
| `plan` | `yodel plan <env> --json` with the first migration pending, and again with the second pending once the first is applied | none: `plan` changes nothing |
| `apply` | the first migration through `yodel apply`, the gate, `chant approve`, and `yodel apply` again, each leg timed; from the history, the time the lock was held, per migration and per statement | its statements sent straight |
| `pr` | the pull request job's local equivalent: `yodel plan <env> --format markdown`, which plans and renders the comment `yodel plan --comment` posts. There is no push, no runner and no forge, so this is not a CI wall time from push to comment | none: the job sends nothing |
| `resume` | the second migration made to fail at its middle statement (that table's column made by hand first), then resumed once the column is gone; against a third migration of the same shape run clean. Also counts statements sent again on the resume (it should be 0) | the clean migration's statements sent straight |
| `backfill` | a hand-written backfill step over every row of a table, in batches: rows per second clean, then another column's backfill interrupted at its middle batch and resumed from its receipts | the same batch statements sent straight to a copy of the table |
| `replay` | `yodel lint --replay <env>` over a history of `min(size, --replay-max)` migrations, each adding a table, generated with `yodel new` first | every migration's statements sent straight into a fresh database |

The lock and per-statement figures come from the history's `recorded_at`:
a statement's time is from its `started` row to its `succeeded` or `failed`
row. The lock is taken before the first row of a run and let go after the
last, so the first-to-last span is a lower bound on the time it was held.
Each apply's record also names the lock it took (a KeeperMap row, a local
file when the server has no KeeperMap, or a Postgres advisory lock).

The oracle client is recorded in each record. ClickHouse: the HTTP
interface, one POST per statement (clickhouse-client is not needed).
Postgres: `psql -f` with `\timing on`, so each statement's figure is psql's
own.

## The records

One JSON per dialect and size per run, `bench/results/<run id>.json`, in
chant-bench's result-set shape (INTENTIUS/chant-bench, PLAN.md, "A second
bench, with no agent: terralith"), so chant-bench can read them without a
translation step:

| field | here |
|---|---|
| `bench`, `arm` | `"sql-yodeler"`, `"yodel"` |
| `scenario` | `yodel-<clickhouse\|postgres>-<size>`: one per size, so a size never shares a scenario with another |
| `run` | the id, the commit, the machine, the emulator's versions as the servers report them, the oracle clients, chant's version |
| `agent` | `{"name": "none", "model": null, "k": 1}` |
| `score.by_task` | one length-1 list per measurement: 1 when yodel did what the stage expects, 0 when it did not (a measured failure) |
| `gates.audit` | the measurement itself ran: no harness error, every scheduled measurement produced a verdict. A slow or failed stage is a score, not `audit: false` |
| `independence` | `account_reads: null`, with the reason: no cloud account is read |
| `effort` | `wall_seconds` for the whole scenario and `stage_seconds` per measurement |
| `measurement` | every other figure, each with a `what` saying what was timed and its `oracle` beside it |

A run's log (every command and its output) is written to the system temp
directory, and its path is printed at the end of each scenario.
