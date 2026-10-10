---
claims: []
type: reference
---

# Glossary

SQL Yodeler is built on chant. These are the chant terms the docs and yodel's output use, in yodel's terms. You need no other chant knowledge to use yodel. The terms are chant's, and [chant's documentation](https://intentius.io/chant/) covers each in full; the last column links the page for it.

| Term | What it is in SQL Yodeler | In chant's docs |
|---|---|---|
| chant | the toolkit yodel is built on. Its CLI is the npm package `@intentius/chant`: `npx @intentius/chant@latest` before a project exists, `npx chant` inside one (plain `npx chant` outside a project runs an unrelated package). | [chant](https://intentius.io/chant/) |
| `chant init --from` | makes a new project from one of SQL Yodeler's templates. See [Starting a project](adoption.md). | [From a template repository](https://intentius.io/chant/cli/init/#from-a-template-repository) |
| the `sql` lexicon | chant's package for ClickHouse and Postgres (`@intentius/chant-lexicon-sql`). The declarations in `src/` use it, and yodel uses it to plan, diff and apply. | [The sql lexicon](https://intentius.io/chant/lexicons/sql/) |
| `chant.config.ts` | the project's config: the dialect and one profile per environment. | |
| profile | one environment in `chant.config.ts` (`sql.profiles.<env>`): its server address, the variables its credentials are read from, and its databases or schemas. `yodel plan dev` uses the `dev` profile. See [Installing and configuring](configuration.md). | |
| Op | a file in `ops/` that declares a run in steps. `ops/migrate-<env>.op.ts` is what `yodel apply <env>` runs: plan, wait for approval, apply. See [Approval](approval.md). | [Ops](https://intentius.io/chant/guide/ops/) |
| gate | the step in an Op that waits for a person's approval. `yodel apply` stops there (exit 3) until the plan is approved. | [Gate steps](https://intentius.io/chant/guide/ops/#gate-steps) |
| plan digest | a hash of what `yodel apply` would do and the state it starts from (`jcs1-sha256:...`). An approval names a digest, and holds only while the plan still hashes to it. | [A gate approves a plan](https://intentius.io/chant/guide/ops/#a-gate-approves-a-plan-not-the-next-run) |
| `chant approve` | records a person's approval of a plan digest at a gate: `npx chant approve migrate-dev approve-migrate-dev --plan <digest>`. yodel prints the command for a script to run. At a terminal, `yodel approve <env>` does the same: it shows the plan, asks for the environment's name and records the approval. | [Gate steps](https://intentius.io/chant/guide/ops/#gate-steps) |
| `chant/lifecycle` | the git branch where approvals are kept, as commits. Push it (`git push origin chant/lifecycle`) so CI sees an approval made on your machine. | [Gate steps](https://intentius.io/chant/guide/ops/#gate-steps) |
| `chant run` | runs an Op. `yodel apply` runs the migrations Op itself, so you seldom need it; `npx chant run watch-dev` runs a drift watch once. | [chant run](https://intentius.io/chant/cli/run/) |
| emulator | a local ClickHouse and Postgres in Docker for trying yodel: `npx chant emulator up --lexicon sql`. ClickHouse on `http://127.0.0.1:8123` (user `default`, no password), Postgres on `127.0.0.1:5432` (user `postgres`, password `chant`). | [chant emulator](https://intentius.io/chant/cli/emulator/) |
| `ApplyOp` | the Op on the declarative path, where `yodel apply` applies the declared schema with no migrations. See [The two workflows](workflows.md). | [Applying](https://intentius.io/chant/lexicons/sql/applying/) |
| `WatchOp` | the drift watch, an Op the pipelines run on a schedule. See [Drift](drift.md). | [Watching the lifecycle](https://intentius.io/chant/guide/watching-lifecycle/) |
| wave | one environment of the apply pipeline, applied after the wave before it, behind its own gate policy. A tenant set is one wave over many databases or schemas. See [Waves](approval.md#waves-a-gate-per-environment). terragucci, also built on chant, uses the word for something else: a batch of Terraform roots applied behind one approval ([terragucci's definition](https://intentius.io/terragucci/concepts/glossary/#wave)). | [Op waves](https://intentius.io/chant/guide/op-waves/) |
