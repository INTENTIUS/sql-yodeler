# Changelog

## 0.12.1

### Fixed: a wave job's plan has its environment's reader

On 0.12.0 every apply wave failed before it planned, with `yodel plan: sql.profiles.<env>.user names <ENV>_<DIALECT>_READER_USER, which is not set`. chant's `sql-migrate` runs a wave's `yodel plan --part` and `--wave-plan` with the writer taken out, so they connect as the environment's reader, and the rendered wave job held only the writer. `yodel ci` now gives each wave job its own environment's reader too (and, for a token-minted reader, the cloud login it mints from). Run `npx yodel ci` after moving to 0.12.1 and commit the pipelines it writes; `yodel ci --check` fails until you do. The starter templates take `^0.12.1`.

Found by the forge claim on Forgejo; the claims that run the pipeline locally have every variable set, so they did not see it.

### Docs

- docs/schema.md, "Computing the schema": a composite that loops over a list, and a value from a build parameter, with `examples/computed` (#309).
- docs/adoption.md takes the kinds `yodel init` refuses from chant's object coverage.

## 0.12.0

### Breaking: run `yodel upgrade` before moving to 0.12

0.12 takes chant 0.124.67 as its floor and removes the copies of chant CI that 0.11 kept for an older chant and for the pipelines 0.10.1 rendered (#303). Run `npx yodel upgrade` on 0.11 first, or in the same commit that moves `@intentius/sql-yodeler` to 0.12, and commit what it writes with `package.json` and `package-lock.json` ([Upgrading the pipelines](docs/workflows.md#upgrading-the-pipelines-to-chant-012467)). A project that moves to 0.12 with 0.10.1's pipelines still committed fails `yodel ci --check` on its pull requests, and its wave jobs stop before they plan.

Removed:

- `yodel ci` renders only through chant's product pipeline. yodel's own generator, and `render(dir, { product: false })`, are gone; on a chant without the product pipeline `yodel ci` refuses and prints the install line.
- `yodel-waves.json` names the sql lexicon's `sql-migrate` step and `standDown: true`. The `plan` and `apply` callbacks a 0.10.1 spec has are no longer rendered. `yodel apply <env> --wave-plan` and `--wave-apply` stay, since they are the commands the capability runs.
- `YODEL_LOCK_WAIT` and `YODEL_STAND_DOWN`, which 0.10.1's wave jobs set, are no longer settings. `yodel apply` and `yodel revert` refuse either one by name (exit 1), pointing at `yodel upgrade`; they remain only as the hand-off of `--lock-wait` and `--stand-down` to the migrations Op's steps. `environments.<env>.lockWait` and `--lock-wait` set the lock wait.
- yodel's own newer-commit check for `--stand-down` (`src/versioned/stand-down.ts`). `yodel apply --stand-down` asks chant's `newerCommitOnBranch`, the question chant's waves ask.
- yodel's own pull request note. `yodel plan --comment` and `--format markdown` give chant's note in yodel's words, as 0.11 did on chant 0.124.57. A tenant set keeps yodel's own note, which names the set in one approval; chant's would ask for an approval per tenant.
- yodel's own cloud login steps on GitHub and GitLab, which ran `aws`, `gcloud` and `az` from a token file. Those forges log in through chant's ci-identity trade. Forgejo, which gives a job no OIDC token, keeps yodel's login from the runner's `tokenFile`.
- yodel's own MCP server. `yodel mcp` serves on `chant serve mcp --read-only`, the tools named `yodel:status` and so on, and refuses `YODEL_OWN_MCP`.

Kept: a project with no workspace declaration (one not upgraded yet, or a member under a declaration above it) still gets the lint job's own steps, since chant has no check hooks to run for it.
