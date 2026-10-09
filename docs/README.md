# SQL Yodeler

SQL Yodeler manages the schemas of ClickHouse and Postgres databases. You declare the schema in TypeScript with chant's `sql` lexicon, and the `yodel` CLI either applies it directly (the declarative path) or writes versioned migrations from it and applies those (the versioned path). Both paths apply behind an approval bound to a digest of the plan. Data migrations (rebuilds, backfills, expand-and-contract column changes) are steps inside a migration, recorded in the same history as the DDL, and resume where they stopped.

| Page | What it covers |
|---|---|
| [Installing and configuring](configuration.md) | installing `yodel` today, the project layout, `chant.config.ts` profiles, `yodel.config.ts`, the environment variables |
| [Starting a project](adoption.md) | a new project from a starter template, and `yodel init --from` to adopt a database that already exists |
| [The two workflows](workflows.md) | the declarative path (`yodel plan`, `yodel apply` against the declared schema) and the versioned path (`yodel new`, then `yodel apply`) |
| [Migrations](migrations.md) | the migrations directory, the history table, the apply lock, resume, out-of-order refusal, `yodel status`, `yodel rebase`, `yodel repair` |
| [Steps](steps.md) | ClickHouse rebuilds, backfills, Postgres `PostgresMigrationOp` steps, and manual steps |
| [Lint](lint.md) | the rules, `yodel:allow` silences, rule levels, `--env`, and the replay check (`--replay`) |
| [Approval](approval.md) | the migrations Op and its gate, the plan digest, the pull request comment, and what happens when the digest moves |
| [Drift](drift.md) | `yodel drift` and the scheduled `WatchOp` |
| [Topology](topology.md) | ClickHouse on a single node, a cluster, a `Replicated` database and ClickHouse Cloud |

Two example projects, one per dialect, show each of these on a real server. Their READMEs are transcripts of runs against chant's emulator, with the output each command printed:

- [examples/clickhouse](../examples/clickhouse/README.md): adoption, a migration, a sort-key rebuild, a backfill, a lint silence, an approval that stops holding, drift, the replay check.
- [examples/postgres](../examples/postgres/README.md): adoption, lint findings, a migration that fails part way and resumes, a column rename as an expand-and-contract step, a destructive change silenced, a fork resolved with `yodel rebase` and `yodel repair`, an out-of-order migration, drift, the replay check.

The pages quote those runs. `test/e2e/examples.test.ts` runs both walkthroughs again when the emulator variables are set, so the commands and exit codes shown stay right.

## The commands

```console
$ yodel --help
Usage: yodel <command> [options]

Schema management and migrations for ClickHouse and Postgres.

Commands:
  init    adopt a live database: its declarations, a baseline migration, recorded applied
  plan    show what apply would change in an environment
  apply   bring an environment to the declared schema or the pending migrations
  new     write the next migration from the declared schema
  lint    check the migrations against the lint rules
  status  list applied, pending and out-of-order migrations
  drift   report declared objects changed out of band or gone from an environment
  rebase  move a migration onto a new parent and recompute its schema
  repair  record a new checksum for an applied migration, with a reason

Options:
  -h, --help     show this help
  -v, --version  print the version
```

`yodel <command> --help` lists each command's options and exit codes. The exit codes mean the same across commands where they can: 0 done or nothing to do, 1 an error, 2 something `yodel` will not do itself (a change that needs an Op it does not run, a manual step) or, for `yodel drift`, drift found, 3 something outstanding (an approval, pending migrations, lint errors), 4 refused with nothing done, 5 another apply holds the lock.
