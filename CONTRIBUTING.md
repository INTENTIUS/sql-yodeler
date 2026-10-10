# Contributing to SQL Yodeler

This page is for working on SQL Yodeler itself. To use it, start with [Your first migration](docs/getting-started.md). The rules for commits, pull requests and releases are in [AGENTS.md](AGENTS.md); they apply to people and coding agents alike.

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

## Scenario claims

Each scenario claim (`scenarios/claims/`) is a promise the docs make, run against the emulator the way a team would use yodel, once plain and once with the property broken. `npm run claims` runs them; the comment at the top of `scenarios/run.ts` has the options. [Claims status](docs/claims.md) shows the last recorded verdicts. They run between development cycles, started by a person from a real terminal (it asks you to type `run`), never as a merge or release gate.

A new feature extends the claim whose setup it shares rather than adding a claim: each claim's scratch project, first migration and apply cost the same whatever it then checks. A claim of several parts lists them in `parts` and runs them with `runParts` (`scenarios/lib/claim.ts`), each part a function of its own taking the claim's state. A part added to a claim goes in that list. A part that runs on some dialects only names them as the third element of its entry (`["routines", routines, ["pg"]]`), and the claim lists them with `partDialects(parts)` beside `partNames(parts)`; `BREAK=<part>` then runs only on those dialects. Under `BREAK=1` every part breaks its own property in one run, and the run is caught only when each part caught its break, so each part must go on from whatever the parts before it left, broken or not. `BREAK=<part> npm run claims -- <claim>` breaks that part alone, the others running plain; the next cycle's claims run covers each new part. Setup that is not the claim's point applies with `Project.setupApply`, the migrations Op's steps without the outer `chant run`; a claim's plain and broken runs use databases of their own (`<claim>` and `<claim>-break`), so they run at once.


Each page under `docs/` starts with front matter naming the claims that prove what it describes, `claims: [approval, pr-comment]` (`claims: []` for a page that describes no behaviour). `npm run check` (test/docs-claims.test.ts, scenarios/docs-claims.ts) fails when a page has no claims line or names a claim that is not in `scenarios/claims/index.ts`. It does not read `scenarios/claims-record.json`, so it never waits on a claim run. A page that describes something not proven yet can take `draft: true`: the site then says on the page which claims do not hold, and leaves it out of `llms.txt`. The site ends each page with "Proven by", from the record, and `npm run claims:page` lists each claim's pages on [Claims status](docs/claims.md).

## Benchmarks

`npm run bench` measures what yodel costs as a schema and a history grow; see `bench/README.md`.
