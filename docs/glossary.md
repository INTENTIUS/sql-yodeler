---
claims: []
type: reference
---

# Glossary

SQL Yodeler is built on chant. These are the chant terms the docs and yodel's output use, in yodel's terms. You need no other chant knowledge to use yodel. The terms are chant's, and [chant's documentation](https://intentius.io/chant/) covers each in full; the last column links the page for it.

| Term | What it is in SQL Yodeler | In chant's docs |
|---|---|---|
| chant | the toolkit yodel is built on. yodel runs chant's CLI (the npm package `@intentius/chant`) underneath, so you do not run it yourself. | [chant](https://intentius.io/chant/) |
| template | a starter project in this repository (`templates/clickhouse`, `templates/postgres`). `yodel create` makes a project from one, with chant's `init --from` underneath. See [Starting a project](adoption.md). | [From a template repository](https://intentius.io/chant/cli/init/#from-a-template-repository) |
| the `sql` lexicon | chant's package for ClickHouse and Postgres (`@intentius/chant-lexicon-sql`). The declarations in `src/` use it, and yodel uses it to plan, diff and apply. | [The sql lexicon](https://intentius.io/chant/lexicons/sql/) |
| `chant.config.ts` | the project's config: the dialect and one profile per environment. | |
| profile | one environment in `chant.config.ts` (`sql.profiles.<env>`): its server address, the variables its credentials are read from, and its databases or schemas. `yodel plan dev` uses the `dev` profile. See [Installing and configuring](configuration.md). | |
| Op | a file in `ops/` that declares a run in steps. `ops/migrate-<env>.op.ts` is what `yodel apply <env>` runs: plan, wait for approval, apply. See [Approval](approval.md). | [Ops](https://intentius.io/chant/guide/ops/) |
| gate | the step in an Op that waits for a person's approval. `yodel apply` stops there (exit 3) until the plan is approved. | [Gate steps](https://intentius.io/chant/guide/ops/#gate-steps) |
| plan digest | a hash of what `yodel apply` would do and the state it starts from (`jcs1-sha256:...`). An approval names a digest, and holds only while the plan still hashes to it. | [A gate approves a plan](https://intentius.io/chant/guide/ops/#a-gate-approves-a-plan-not-the-next-run) |
| approval | a person's approval of a plan digest at a gate, recorded on `chant/lifecycle`. `yodel approve <env> --plan <digest>`, the command yodel prints, shows the plan, asks for the environment's name and records it (chant's `approve` underneath; `--json` outputs carry chant's command as `chantApprove` for scripts). | [Gate steps](https://intentius.io/chant/guide/ops/#gate-steps) |
| `chant/lifecycle` | the git branch where approvals are kept, as commits. Push it (`git push origin chant/lifecycle`) so CI sees an approval made on your machine. | [Gate steps](https://intentius.io/chant/guide/ops/#gate-steps) |
| `chant run` | runs an Op. `yodel apply` runs the migrations Op itself, and the pipelines run the drift watch on its schedule; `yodel drift <env>` checks for drift by hand. | [chant run](https://intentius.io/chant/cli/run/) |
| emulator | a local ClickHouse and Postgres in Docker for trying yodel: `npx yodel emulator up`. ClickHouse on `http://127.0.0.1:8123` (user `default`, no password), Postgres on `127.0.0.1:5432` (user `postgres`, password `chant`). | [chant emulator](https://intentius.io/chant/cli/emulator/) |
| `ApplyOp` | the Op on the declarative path, where `yodel apply` applies the declared schema with no migrations. See [The two workflows](workflows.md). | [Applying](https://intentius.io/chant/lexicons/sql/applying/) |
| step | a data change a migration carries because its schema change implies it: a ClickHouse rebuild, a Postgres safe rename (expand and contract) or a backfill. It runs once, when the migration applies, and resumes if it stopped. See [Data migrations](steps.md). | [Ops](https://intentius.io/chant/guide/ops/) |
| ClickHouse rebuild | a step for a change `ALTER` can't make (a sort key, engine or partitioning): a new table, the rows copied in and checked, then swapped in. See [ClickHouse rebuilds](steps.md#clickhouse-rebuilds). | |
| Postgres safe rename | a step that renames a column or table without breaking the running app: add the new name, keep both in sync, move readers over, drop the old name later (expand and contract). See [PostgresMigrationOp](steps.md#postgres-postgresmigrationop). | |
| backfill | a step that fills values for existing rows, such as a new column's. You write the fill once; yodel runs it in batches and resumes if it stops. It runs once, never on a schedule. See [Backfills](steps.md#backfills). | |
| resume job | an optional scheduled job (`ci.resume`) that starts approved applies that are waiting. It moves no data itself. See [The scheduled resume job](approval.md#the-scheduled-resume-job). | |
| `WatchOp` | the drift watch, an Op the pipelines run on a schedule. See [Drift](drift.md). | [Watching the lifecycle](https://intentius.io/chant/guide/watching-lifecycle/) |
| wave | one environment of the apply pipeline, applied after the wave before it, behind its own gate policy. A tenant set is one wave over many databases or schemas. See [Waves](approval.md#waves-a-gate-per-environment). terragucci, also built on chant, uses the word for something else: a batch of Terraform roots applied behind one approval ([terragucci's definition](https://intentius.io/terragucci/concepts/glossary/#wave)). | [Op waves](https://intentius.io/chant/guide/op-waves/) |
