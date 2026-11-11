# Changelog

## 0.13.3

### Changed

- The pull request plan is chant's product plan (chant issues 4799, 4963 and 4972, issue 345). `yodel plan <env> --pr-note <dir>` writes the note for chant's note job, which posts it, so the plan job holds no forge token; `--comment` and its forge flags are gone. The note's first line is chant's marker, with `<!-- yodel:plan env=<env> -->` second, and each environment gets the status `yodel/plan/<env>`. On GitLab the plan jobs are in `.gitlab/yodel-plan.gitlab-ci.yml`, and the notes come from a scheduled pipeline of the default branch with `CHANT_PLAN_NOTES=1`, which you create (docs/approval.md). Run `yodel ci` to write the pipelines again.
- `ci.evidence` in `yodel.config.ts` signs each environment's plan and policy checks, and each deciding wave's plan, with chant's evidence (chant issues 4869, 4870 and 4978). On GitHub and Forgejo chant's check job replaces yodel's lint job and signs each hook that passed; GitLab's hooks are not signed yet. `ci.refGate: true` adds chant's ref gate for main, which refuses a push until every environment's plan and policy checks are signed. It is off by default and needs `ci.evidence` (issue 346).
- `yodel drift` reads chant's columns by name and its pending changes (chant issue 4944). A path reads `columns[#country].default.expr` where it read `column country default.expr`. A column or privilege added on the server by hand is drift, listed under "Added on the server, which the next apply undoes", and reaches the tracking issue and the fingerprint. `yodel drift --json` has `pending` and no longer has `columns`, and a Postgres privilege granted by hand is now drift.
- `yodel ci` writes its files and removes the ones it no longer renders through chant's planned-files (chant issue 4966). Its output and exit codes are unchanged.

chant is at 0.124.90, and the starter templates take `^0.13.1`. Their apply pipelines are rendered again for chant 0.124.90's job check.

## 0.13.2

### Changed

- The drift notice's fingerprint and the drift records are chant's (chant issue 4896). The fingerprint is 16 hex digits where it was `sha256:` and 64, so a receiver that dedups on it sees one new value after the upgrade. A declared object the server lacks is `missing`, where it was `pending`, so each open tracking issue is edited once.
- `yodel ci` removes the pipeline files it wrote and no longer renders, such as a forge's files after it leaves `ci.forges`, and `yodel ci --check` lists them (issue 348).
- The release image is a `dockerfile` entry in chant's `release.images` (chant issue 4908), which sets up QEMU itself (chant issue 4876). `scripts/release-image.sh` and the `YODEL_IMAGE_PLATFORMS` override are gone. The CI image is declared with the docker lexicon's `Dockerfile` (chant issue 4932), and the drift watch's login step has a name.
- yodel runs chant and resolves imports with no install through chant's `runChant` and `installResolveFallback` (chant issue 4889), finds `sql-types.d.ts` with `sqlTypesPath` (chant issue 4897), and loads chant's approval prompt directly (chant issue 4916). `YODEL_OWN_CONFIRM=1` still selects yodel's own prompt.

chant is at 0.124.88, and the starter templates take `^0.13.1`.

## 0.13.1

0.13.0 was cut and never published: its package took in the release's image archive, which npm refused as too large. The package now leaves `dist/images` out. 0.13.1 carries everything below.

### Changed: where the source is, and the tracking issue's body

A project's source directory is `sourceDir` in `chant.config.ts`, else the project's root, the rule chant now uses for every command (chant issue 4794). Before, yodel fell back to `src/` when it existed. The starter templates set `sourceDir: "src"`, so a project made from them builds as before. A project with declarations in `src/` and no `sourceDir` now builds its whole root: set `sourceDir: "src"` to keep the old behaviour. `yodel init` writes declarations to the root when there is no `sourceDir`, and the unmigrated-schema lint runs only when `sourceDir` is set.

The drift tracking issue `yodel drift` keeps is chant's (chant issue 4790). Its body is chant's table of drifted objects, with yodel's words and marker, so each open tracking issue is rewritten once on the first run after the upgrade. The `fingerprint` in `--json` and in the notify event is unchanged.

### Changed: the pipelines yodel writes

- The apply waves and the drift watch come from chant's Op waves pipeline with yodel's login, report and readers passed in (chant issue 4791). On GitHub, `id-token: write` moves from the workflow to the jobs that hold a cloud-minted role. On GitLab, wave jobs keep chant's outcome files in their artifacts. Run `yodel ci` to write them again.
- On Forgejo the cloud login is chant's (chant issue 4788): one login step, `AWS_REGION` set for AWS, and gcloud reading the workload identity file with no `gcloud auth login`.
- The overdue check of a scheduled Op is chant's (chant issue 4789). Its log line keeps the `yodel plan: ` prefix and drops yodel's `Warning: `.
- The CI image is chant's product image (chant issue 4784): it runs as `yodel` with `HOME=/tmp` and chant's reproducibility settings.
- Forge flags, the note size limit and how yodel runs chant are chant's helpers (chant issue 4800); a bad `--forge` or `--repo` is refused in chant's words.

### Removed

- yodel's checks for chant parts its pinned chant always has (chant issue 4792), and the part list `yodel upgrade` printed.

chant is at 0.124.87, and the starter templates take `^0.13.1`.

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
