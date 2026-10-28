# <img src="docs-site/public/brand/hat-small.png" width="22" height="20" alt=""> Contributing to SQL Yodeler

This page is for working on SQL Yodeler itself. To use it, start with [Your first migration](docs/getting-started.md). The rules for commits, pull requests and releases are in [AGENTS.md](AGENTS.md); they apply to people and coding agents alike.

## Where a feature goes

SQL Yodeler, [terragucci](https://intentius.io/terragucci/) and [plywood](https://intentius.io/plywood/) are CI products on chant's runtime, and they share chant CI features as far as they can. Extending chant CI is the default. A feature goes in the first of these homes that fits it:

1. chant CI core, when the products share it.
2. chant's sql lexicon, when the capability belongs to the SQL engines: dialect parsing, plan and classification, change-set parts, the mapping onto chant's exit codes, lock rows, CI setup lines and database token sources.
3. SQL Yodeler, which holds its words and presets, its config defaults and init templates, and its docs.

A feature stays inside SQL Yodeler only for a reason that belongs to its audience, database and data teams who write SQL, and never for convenience. Approvals, gate decisions, overrides and the records of applies and runs go in the chant workspace ledger, never in SQL Yodeler's own writes. Before adding storage for a record, check whether the ledger already holds it.

The versioned migration engine stays in SQL Yodeler, and chant's sql lexicon runs it through a fixed argv list, as the pulumi lexicon runs plunge. Only the CI capability moves to chant. The engine is the migrations directory and its checksums, the history table and the apply lock, steps (rebuild and backfill Ops), promotion, tenant sets, revert, rebase and repair, cleanup and baseline, the replay check, the lint rules and `yodel test`, under `src/versioned`, `src/history`, `src/migrations`, `src/steps`, `src/tenants`, `src/rebase`, `src/replay` and `src/lint`. Its commands are `yodel new`, `status`, `plan`, `apply`, `revert`, `rebase`, `repair`, `checkpoint`, `cleanup`, `init`, `lint`, `check`, `test`, `drift` and `docs`. The CI product is the rest: the pipeline (`yodel ci`), the plan note and drift issue (`--comment`, `--issue`), the exit codes, the wave plan and apply that chant runs (`--wave-plan`, `--wave-apply`), approvals and overrides (`yodel approve`, `yodel override`), cloud logins, the audit report and the MCP tools (`yodel mcp`). Each of those runs on chant core or the sql lexicon, and SQL Yodeler keeps its words for them, such as `yodel approve <env>` and the `yodel/plan` status.

The rule and the issues behind it are on chant's [CI products on chant](https://intentius.io/chant/concepts/ci-products/) page and in [chant#4530](https://github.com/INTENTIUS/chant/issues/4530) and [#285](https://github.com/INTENTIUS/sql-yodeler/issues/285); [#300](https://github.com/INTENTIUS/sql-yodeler/issues/300) places each module under `src/`.

## Building from a clone

Node 22.12 or later (`.nvmrc`).

```sh
git clone https://github.com/INTENTIUS/sql-yodeler.git
cd sql-yodeler
npm ci            # also builds dist/ through the prepare script
npm run build     # the same, by hand
npx yodel --help
npm run check     # typecheck, lint and test
```

Binary files (images, fonts, PDFs, archives) go in [Git LFS](https://git-lfs.com): run `git lfs install` once, and `.gitattributes` sends each binary type there. `npm run check` fails on a binary file committed without LFS (`test/binaries.test.ts`). The brand images committed before LFS stay plain files, listed by name in `.gitattributes`.

## Running an unreleased yodel in a project

A project normally installs `@intentius/sql-yodeler` from npm. To try a commit that is not released yet:

From git (npm clones the commit, installs its dev dependencies and runs `prepare`, which builds `dist/`; `package-lock.json` pins the commit):

```sh
npm install github:INTENTIUS/sql-yodeler#main
```

From a clone, by path (npm links it, so a rebuild of the clone is picked up):

```sh
npm install ../sql-yodeler
```

Or packed, as a tarball you can commit:

```sh
mkdir -p vendor
(cd ../sql-yodeler && npm pack --pack-destination "$OLDPWD/vendor")
npm install ./vendor/intentius-sql-yodeler-<version>.tgz
```

Installing the tarball rewrites the dependency in `package.json` to `file:vendor/...`. The projects in `examples/` take `file:../..`, the clone they sit in.

`yodel create` copies the template released with the yodel that runs it, the tag `v<version>`, which an unreleased version does not have yet. To make a project from a clone's templates instead, give it the clone with `--from`, which is for developing yodel only:

```sh
npx --package ../sql-yodeler yodel create my-schema --clickhouse --database events --from ../sql-yodeler
```

`--from` takes a `<repo>@<ref>` too (`INTENTIUS/sql-yodeler@main`); yodel adds `#templates/<dialect>`.

## Tests against a server

`npm run check` needs no server. The suites in `test/e2e/` run against chant's emulator (`npx chant emulator up --lexicon sql`) when its addresses are set, and skip otherwise:

```sh
export YODEL_E2E_CLICKHOUSE_URL=http://<host>:8123
export YODEL_E2E_POSTGRES_URL=postgres://<host>:5432/postgres YODEL_E2E_POSTGRES_USER=postgres YODEL_E2E_POSTGRES_PASSWORD=chant
export YODEL_E2E_PREFIX=yodel_<issue>   # the databases and schemas a run writes
npx vitest run test/e2e
```

A Postgres of your own on `127.0.0.1:5432` hides the emulator's at `localhost`; use the machine's LAN address (`ipconfig getifaddr en0` on macOS) or the Docker network. The emulator may be shared, so write only to names under your own prefix.

## The walkthroughs and the docs quotes

The example READMEs and the console blocks the docs quote come from runs, not from hand. `examples/walkthrough/` holds the steps; `run.ts` runs them in a temporary copy and, with `--write`, rewrites the README, the example's files and the quoted blocks in `docs/`:

```sh
npm run build
YODEL_E2E_CLICKHOUSE_URL=... npx tsx examples/walkthrough/run.ts clickhouse --write
YODEL_E2E_POSTGRES_URL=... npx tsx examples/walkthrough/run.ts postgres --write
npx tsx examples/walkthrough/run.ts template --write
YODEL_GETTING_STARTED_CLICKHOUSE_URL=http://127.0.0.1:18123 npx tsx examples/walkthrough/run.ts getting-started --write
```

The getting-started walkthrough drops and creates databases `events` and `yodeler`, so give it a ClickHouse of its own, never a shared one; the comment at the top of `examples/walkthrough/getting-started.ts` shows one. `test/docs.test.ts` checks the quotes against what the runs wrote.

## The docs site

`docs-site/` builds [intentius.io/sql-yodeler](https://intentius.io/sql-yodeler/) from `docs/*.md`:

```sh
cd docs-site && npm ci && npm run build
```

The build fails on an internal link that leads nowhere.

The logo is a cowboy hat with a database on its front. `docs-site/public/brand/hat-source.png` is the hat as rendered, its background taken out, and `python3 scripts/brand.py` (Pillow and NumPy) draws everything else from it, each size resampled once: `brand/hat.png` for the home page, `docs-site/src/assets/brand/hat.png` for Starlight's header logo, `brand/hat-small.png` (the 22x20 mark at twice that size, for inline use and list bullets), `brand/hat-160.png` for the README, the favicons, `hat-share.png` (the square image a shared link shows), `social-preview.png`, the pixel-art star `brand/star.svg` (the site's small mark, drawn from the grid in the script), and `src/brand.ts`, which inlines the hat in the pages `yodel report --html` and `yodel docs` write. `python3 scripts/brand.py --from <render.png>` rebuilds `hat-source.png` from a new render first. `social-preview.png` is the image for the repository's social preview in GitHub's settings. After changing `src/brand.ts`, run `yodel docs` in each example to rewrite its `schema-docs/`.

## Scenario claims

Each scenario claim (`scenarios/claims/`) is a promise the docs make, run against the emulator the way a team would use yodel, once plain and once with the property broken. `npm run claims` runs them; the comment at the top of `scenarios/run.ts` has the options. [Claims status](docs/claims.md) shows the last recorded verdicts. They run between development cycles, started by a person from a real terminal (it asks you to type `run`), never as a merge or release gate. To let a coding agent start them, grant it from your terminal: `npm run grant -- waves bench` (`--show`, `--end`).

A new feature extends the claim whose setup it shares rather than adding a claim: each claim's scratch project, first migration and apply cost the same whatever it then checks. A claim of several parts lists them in `parts` and runs them with `runParts` (`scenarios/lib/claim.ts`), each part a function of its own taking the claim's state. A part added to a claim goes in that list. A part that runs on some dialects only names them as the third element of its entry (`["routines", routines, ["pg"]]`), and the claim lists them with `partDialects(parts)` beside `partNames(parts)`; `BREAK=<part>` then runs only on those dialects. Under `BREAK=1` every part breaks its own property in one run, and the run is caught only when each part caught its break, so each part must go on from whatever the parts before it left, broken or not. `BREAK=<part> npm run claims -- <claim>` breaks that part alone, the others running plain; the next cycle's claims run covers each new part. Setup that is not the claim's point applies with `Project.setupApply`, the migrations Op's steps without the outer `chant run`; a claim's plain and broken runs use databases of their own (`<claim>` and `<claim>-break`), so they run at once.


Each page under `docs/` starts with front matter naming the claims that prove what it describes, `claims: [approval, waves]` (`claims: []` for a page that describes no behaviour). `npm run check` (test/docs-claims.test.ts, scenarios/docs-claims.ts) fails when a page has no claims line or names a claim that is not in `scenarios/claims/index.ts`. It does not read `scenarios/claims-record.json`, so it never waits on a claim run. A page that describes something not proven yet can take `draft: true`: the site then says on the page which claims do not hold, and leaves it out of `llms.txt`. The site ends each page with "Proven by", from the record, and `npm run claims:page` lists each claim's pages on [Claims status](docs/claims.md). A claim can also cite a row of a product scenario on the shared e2e harness: a proof of kind `product-scenario` in `scenarios/product-proofs.json` (`repo`, `scenario`, `claim`, `commit`, `date`, `engine_version`; scenarios/product-proofs.ts has the rules). `npm run check` fails when a proof lacks one of the six fields. A row counts only when its `engine_version` is `package.json`'s version, so a release re-renders the page with `npm run claims:page`; a row at another version is listed and marked not counted. A cited row never replaces the claim's own run.

The forge, waves and approval claims also run as scenarios on chant's e2e harness (`scenarios/harness/`): one file per claim and dialect in `scenarios/harness/scenarios/`, each on its starter template, with a plain arm and a BREAK arm, run on the harness's Forgejo and runner with the sql profile. `npm run harness` runs them under the same grant as the claims (`npm run harness -- --list` shows each step and what it expects); the comment at the top of `scenarios/harness/run.ts` has what it needs. It needs a chant with the harness (`E2E_HARNESS_FLOOR`), and says so on one without it. Each scenario is listed under `pending` in `scenarios/product-proofs.json` until a row is recorded and the proof the run prints is added to `proofs`. On a chant with the harness, `test/e2e/forgejo.test.ts` and the first case of `test/e2e/pr-comment.test.ts` skip, since the scenarios show the same (`test/e2e/harness-fallback.ts`); on one without it they run as before.

## Benchmarks

`npm run bench` measures what yodel costs as a schema and a history grow; see `bench/README.md`.
