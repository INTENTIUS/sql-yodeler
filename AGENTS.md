# Working on SQL Yodeler

Working in the INTENTIUS workspace, `../agents/shared.md` applies too. This file adds what is particular to sql-yodeler. Building from a clone, tests against a server, walkthroughs, claims and releasing are in [CONTRIBUTING.md](CONTRIBUTING.md). An agent setting SQL Yodeler up in another repository follows [docs/agents.md](docs/agents.md) instead.

## Gate and merging

- Local gate: `npm ci && npm run build && npm run check` (typecheck, lint, test). A template or release pull request also runs `npm run templates:check`.
- main has a merge queue. Run the local gate, push, open the pull request with `Closes #N`, queue it with `gh pr merge <n> --auto --squash`, and stop. The queue tests it on top of main and merges it; nobody waits for CI.
- Workflows are declared in `.github/src/<name>.ts` with `@intentius/chant-lexicon-github`. Edit the declaration, run `npm run workflows`, commit both; `npm run check` fails on a difference.

## chant

- `@intentius/chant` and `@intentius/chant-lexicon-sql` come from npm, never a `file:` or workspace link.
- A CI feature goes in chant CI core first, then chant's sql lexicon, and in SQL Yodeler only for a reason that belongs to its audience. The migration engine stays here and chant runs it ([CONTRIBUTING.md, Where a feature goes](CONTRIBUTING.md#where-a-feature-goes)).

## Templates

Templates take `@intentius/sql-yodeler` by caret range, and `chant init --from INTENTIUS/sql-yodeler@main#templates/<dialect>` installs that range from npm, so main's templates must work with what is published. A template change that needs unreleased yodel ships in the release pull request that moves the range.

## The emulator

- Start it with `chant emulator up --lexicon sql`. It is shared: don't stop or restart it.
- Write only to your own ClickHouse database or Postgres schema, named `yodel_<issue>`.
- A local Postgres holds `127.0.0.1:5432`, so use the machine's LAN address (`ipconfig getifaddr en0`) or the stack's Docker network to reach the emulator.

## Product rules

- Docs, READMEs and issues don't compare SQL Yodeler with other migration tools, and nobody benchmarks another tool's binary from this repo.
- Nothing goes behind a login or a paid plan: no object type, driver, lint rule or safety feature.
