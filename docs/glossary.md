---
claims: []
---

# Glossary

SQL Yodeler is built on chant. These are the chant terms the docs and yodel's output use, in yodel's terms. You need no other chant knowledge to use yodel.

| Term | What it is in SQL Yodeler |
|---|---|
| chant | the toolkit yodel is built on. Its CLI is the npm package `@intentius/chant`: `npx @intentius/chant@latest` before a project exists, `npx chant` inside one (plain `npx chant` outside a project runs an unrelated package). |
| `chant init --from` | makes a new project from one of SQL Yodeler's templates. See [Starting a project](adoption.md). |
| the `sql` lexicon | chant's package for ClickHouse and Postgres (`@intentius/chant-lexicon-sql`). The declarations in `src/` use it, and yodel uses it to plan, diff and apply. |
| `chant.config.ts` | the project's config: the dialect and one profile per environment. |
| profile | one environment in `chant.config.ts` (`sql.profiles.<env>`): its server address, the variables its credentials are read from, and its databases or schemas. `yodel plan dev` uses the `dev` profile. See [Installing and configuring](configuration.md). |
| Op | a file in `ops/` that declares a run in steps. `ops/migrate-<env>.op.ts` is what `yodel apply <env>` runs: plan, wait for approval, apply. See [Approval](approval.md). |
| gate | the step in an Op that waits for a person's approval. `yodel apply` stops there (exit 3) until the plan is approved. |
| plan digest | a hash of what `yodel apply` would do and the state it starts from (`jcs1-sha256:...`). An approval names a digest, and holds only while the plan still hashes to it. |
| `chant approve` | records a person's approval of a plan digest at a gate: `npx chant approve migrate-dev approve-migrate-dev --plan <digest>`. yodel prints the command; a person runs it. |
| `chant/lifecycle` | the git branch where approvals are kept, as commits. Push it (`git push origin chant/lifecycle`) so CI sees an approval made on your machine. |
| `chant run` | runs an Op. `yodel apply` runs the migrations Op itself, so you seldom need it; `npx chant run watch-dev` runs a drift watch once. |
| emulator | a local ClickHouse and Postgres in Docker for trying yodel: `npx chant emulator up --lexicon sql`. ClickHouse on `http://127.0.0.1:8123` (user `default`, no password), Postgres on `127.0.0.1:5432` (user `postgres`, password `chant`). |
| `ApplyOp` | the Op on the declarative path, where `yodel apply` applies the declared schema with no migrations. See [The two workflows](workflows.md). |
| `WatchOp` | the drift watch, an Op the pipelines run on a schedule. See [Drift](drift.md). |
