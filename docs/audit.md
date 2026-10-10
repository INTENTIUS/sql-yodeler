---
claims: [approval]
type: concepts
---

# Reports and the audit log

Each environment's history table says what ran there, and chant's gate ledger (the `chant/lifecycle` branch) says who approved which plan. `yodel report` reads both for every environment and joins them: a table of each migration's state in each environment, an audit log, and the gaps the two sources show.

```text
$ yodel report
Report for /work/shop (clickhouse, 2 environments)

migration               dev                      prod
20261010T0900-init      applied 2026-10-10 09:02 applied 2026-10-10 11:40
20261010T1000-add-note  applied 2026-10-10 10:05 pending

Gaps: none. Every applied migration has its approval on the ledger, and no history row is missing.

Audit (7 entries):
  2026-10-10T09:01:12.410Z  dev  approval-requested  jcs1-sha256:3e1b0c9a4f...  (run 1c7e...)
  2026-10-10T09:01:40.002Z  dev  approved  by alice  jcs1-sha256:3e1b0c9a4f...
  2026-10-10T09:02:03.118204Z  dev  applied  20261010T0900-init  by ci@runner-7  jcs1-sha256:3e1b0c9a4f...
  ...
```

By default it reads every environment in `chant.config.ts`'s `sql.profiles`, in that order; name some to read only those (`yodel report dev prod`). In CI, fetch the `chant/lifecycle` branch first so the ledger is there. It reads only and takes no lock.

## The audit log

Every entry comes from a history row or a ledger line, so the log cannot say something they do not. Deriving it again from the same sources gives the same entries with the same ids.

| Entry | From |
|---|---|
| `approval-requested` | a pending fact on the ledger: a run stopped at the migrations Op's gate, or the environment's wave stopped at its wave gate |
| `approved` | a resolution of the gate or the wave gate (`chant approve`, `yodel approve`) |
| `override` | a resolution of an `override-<rule>` gate (`yodel override`), with the rule and the reason |
| `silenced` | a `-- yodel:allow` silence, on the migration's first started row |
| `applied` | the history row that first recorded the migration succeeded |
| `refused` | a failed migration row naming a pre-migration check |
| `failed` | any other failed migration row: a statement, an Op step |
| `repaired` | a succeeded row after the migration was applied (`yodel repair`) |

`--audit audit.jsonl` keeps the log as a file, one entry per line. Each run appends the entries the file does not have yet and never rewrites a line. `--audit audit.jsonl --check` appends nothing. Instead it names every entry of the file that the sources no longer give: a ledger line or a history row removed since the file was written. A CI job that keeps `audit.jsonl` as an artifact, or commits it, can run `--check` before it appends.

## Gaps

`yodel report` exits 4 and lists each gap:

- A history row missing. Each environment's history numbers its rows from 1 with no hole, because every run appends at the highest `seq` plus one, under the lock. A hole is a row someone deleted.
- An applied migration whose plan digest has no approval of the environment's gate on the ledger: the approval was removed, or the migration was applied without one. A baseline recorded by `yodel init --from` has no digest and needs no approval; one recorded by `yodel init --baseline` carries the digest its gate approved.

  A migration a wave of the apply pipeline applied ([waves](workflows.md)) was let through on the wave's gate, `yodel-apply-wave-<k>` on the `yodel-apply` ledger, for the wave's set digest, not on the migrations Op's gate. The wave's apply records that gate and digest in the migration's `started` history row (`note.wave`), and the report looks for the approval there. A wave whose gate policy at the base commit needed no approval (`never`, or `on-destructive` with nothing destructive) records that instead, checked under the lock when it applied, and is not a gap.
- With `--audit --check`, an entry of the file the sources no longer give.

An environment that cannot be read (its server does not answer) is reported with its error, and the exit is 1 when there is no gap.

## The run view

`--html report.html` writes a self-contained page with no external resources, safe to upload as a CI artifact. It has one row per migration (each merge that added one) and one column per environment, in the order they were read, so a change's progress from dev to prod reads left to right. Each cell shows the state, when, who applied it and who approved its digest. The gaps and the audit log follow.

## The JSON

`yodel report --json` prints the report described by [schemas/report.schema.json](../schemas/report.schema.json). Within version 1 fields are only added.

| Field | What it holds |
|---|---|
| `version` | 1 |
| `generatedAt` | when the report was read, ISO 8601 UTC |
| `project` | the project directory |
| `dialect` | `clickhouse` or `postgres` |
| `migrations` | the migrations in chain order, then any an environment applied that the directory no longer has |
| `environments` | one per environment read, in order |
| `environments[].name` | the environment |
| `environments[].history` | its history table, `<database>.history` |
| `environments[].op` | its migrations Op: `name` and `gate` |
| `environments[].error` | why it could not be read |
| `environments[].notes` | what was read only in part, such as a ledger that could not be read |
| `environments[].migrations` | each migration's state there |
| `environments[].migrations[].id` | the migration |
| `environments[].migrations[].state` | `applied`, `pending`, `failed` or `started` (stopped part way) |
| `environments[].migrations[].inDirectory` | whether the migrations directory still has it |
| `environments[].migrations[].at` | when it was applied; for failed or started, its latest row's time |
| `environments[].migrations[].by` | who applied it |
| `environments[].migrations[].digest` | the plan digest it was applied under |
| `environments[].migrations[].approvedBy` | who approved that digest on the ledger |
| `environments[].migrations[].approvedAt` | when |
| `audit` | every entry, oldest first |
| `audit[].id` | a hash of the entry and its source |
| `audit[].at` | when, ISO 8601 UTC |
| `audit[].environment` | the environment |
| `audit[].kind` | one of the entries in the table above |
| `audit[].by` | the approver, or who ran the apply |
| `audit[].migration` | the migration, for history entries |
| `audit[].digest` | the plan digest |
| `audit[].detail` | the silence, the override's rule and reason, the error, the repair's reason |
| `audit[].wave` | on an `applied` entry a wave applied: the wave's gate, its set digest, and `approved` or `not-required` |
| `audit[].wave.gate` | the wave's gate, `yodel-apply-wave-<k>` |
| `audit[].wave.digest` | the wave's set digest, the one its approval is bound to |
| `audit[].wave.status` | `approved`, or `not-required` when the wave's policy at the base needed no approval |
| `audit[].source` | the ledger file, Op and gate; or the history table, the row's `seq` and its run |
| `gaps` | each gap |
| `gaps[].environment` | the environment |
| `gaps[].kind` | `history-row` or `approval` |
| `gaps[].detail` | what is missing, in a sentence |
| `auditFile` | with `--audit`: the file |
| `auditFile.path` | the file as given |
| `auditFile.appended` | how many entries were appended (0 with `--check`) |
| `auditFile.missing` | the entries of the file the sources no longer give, shaped as `audit[]` |

## What proves it

The `approve-and-apply` claim, after its approval, pre-migration check and policy parts, runs `yodel report <env> --json --audit audit.jsonl`. Every applied migration must have its `applied` and `approved` entries under the same digest, with no gap, and `--check` must then pass. Under `BREAK=1` the approval line is removed from the ledger before `--check`, which must name the missing entry and the unapproved migration. Unit tests (`test/report.test.ts`) remove a history row and a ledger line from fixed sources and find each as a gap. They also check that every field in the table above is in the schema.
