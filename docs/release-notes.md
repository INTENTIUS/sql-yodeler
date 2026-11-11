---
claims: []
type: reference
---

# Release notes

What each release of `@intentius/sql-yodeler` changed, newest first, in short. The full notes for each release, with the upgrade steps, are on [GitHub releases](https://github.com/INTENTIUS/sql-yodeler/releases).

## 0.13.4

- Changed: on GitLab, chant's check job replaces yodel's lint job when the project has a workspace declaration, and keeps the code quality report as `artifacts: { reports: { codequality } }`. With `ci.evidence`, `check-evidence` signs the checks on GitLab too. Run `yodel ci` to write the pipelines again.
- Changed: each environment's drift watch targets only that environment.
- Fixed: `yodel new` refreshes `sql-types.d.ts` before the build, so it no longer fails after a schema edit.
- Fixed: the starter templates are rendered again on chant's product plan, and the ledger-fetch test can fail.
- chant 0.124.91. The starter templates take `^0.13.4`.

## 0.13.3

- Changed: the pull request plan is chant's product plan. `yodel plan --pr-note` replaces `--comment`, and chant's note job posts the note. On GitLab the notes come from a scheduled pipeline with `CHANT_PLAN_NOTES=1`. Run `yodel ci` to write the pipelines again.
- Added: `ci.evidence` signs the plan and policy checks; `ci.refGate: true` turns on chant's ref gate for main. The gate is off by default.
- Changed: drift paths name columns as chant does, `columns[#country]`, and a column or privilege added by hand is drift. `yodel drift --json` has `pending` in place of `columns`.
- Changed: `yodel ci` writes and removes its files through chant; its output is unchanged.
- chant 0.124.90. The starter templates take `^0.13.1`.

## 0.13.2

- Changed: the drift fingerprint and records are chant's; a notify receiver sees one new fingerprint, and each open tracking issue is edited once.
- Changed: `yodel ci` removes the pipeline files it no longer renders.
- Changed: the release and CI images are built through chant; `YODEL_IMAGE_PLATFORMS` is gone.
- chant 0.124.88. The starter templates take `^0.13.1`.

## 0.13.1

- 0.13.0 was cut and not published; 0.13.1 carries its changes.

- Changed: the source directory is `sourceDir`, else the project's root; yodel no longer falls back to `src/`. The starter templates set `sourceDir: "src"`.
- Changed: the drift tracking issue's body is chant's; each open issue is rewritten once after the upgrade.
- Changed: the apply waves, the drift watch, the Forgejo login, the overdue check and the CI image come from chant. Run `yodel ci` to write the pipelines again.
- chant 0.124.87. The starter templates take `^0.13.1`.

## 0.12.1

- Fixed: every apply wave on 0.12.0 failed before it planned, because the wave job held only the writer and chant's `sql-migrate` plans as the reader. Each wave job now holds its environment's reader too. Run `npx yodel ci` after you move to 0.12.1 and commit the pipelines.
- The starter templates take `^0.12.1`.
- Docs: [Computing the schema](schema.md#computing-the-schema), with `examples/computed`.

## 0.12.0

- Breaking: run `npx yodel upgrade` on 0.11 before you move to 0.12, and commit what it writes ([Upgrading the pipelines](workflows.md#upgrading-the-pipelines-to-chant-012467)). A project still on 0.10.1's pipelines fails `yodel ci --check` on 0.12.
- chant 0.124.67 is the floor.
- Removed the copies of chant CI that 0.11 kept for an older chant: yodel's own pipeline generator, the wave callbacks, its own stand-down check, pull request note, GitHub and GitLab cloud login and MCP server ([What 0.12 no longer has](chant-ci.md#what-012-no-longer-has)).
- `YODEL_LOCK_WAIT`, `YODEL_STAND_DOWN` and `YODEL_OWN_MCP` are refused by name.
- Fixed: a tenant set's plan note keeps one approval for the set, and `yodel plan <set>/@<i>of<n>` plans a wave slot.

## 0.11.1

- chant 0.124.57. The re-rendered pipelines get chant's job guard step, and each wave job a timeout and `CHANT_LOCK_WAIT`.
- Exit code 9 (`misplaced`), a refused job guard.
- The forge, waves and approval scenarios run on chant's e2e harness.

## 0.11.0

- The pipelines run on chant's CI (chant 0.124.55), the product pipeline terragucci and plywood use ([SQL Yodeler on chant CI](chant-ci.md)). `yodel upgrade` moves a project in one commit.
- Breaking: exit codes follow chant's one table. A refusal no approval fixes and lint errors are 1, a waiting person 3, a moved plan 4, a policy denial 7 ([Exit codes](cli.md#exit-codes)).
- The lint job runs yodel's checks as chant check hooks, with squawk and sqlfluff presets.
- Cloud login on GitHub and GitLab goes through chant's ci-identity, and `yodel approve` asks chant's question.
- Fixed: setting both `YODEL_ROLE` and `YODEL_CREDENTIALS` no longer breaks every command, and a lock takeover deletes the expired lock only while it is still expired.

## 0.10.1

- chant 0.124.51.
- Removed the `orm-handoff` step that 0.10.0 added. A migration that still has one is refused before anything runs.

## 0.10.0

- `yodel check` lints the migrations of a golang-migrate, goose, Flyway or dbmate directory, and reads real Flyway projects ([Coming from another migration tool](from-other-tools.md)).
- `yodel new <name> --sql` for a migration you write yourself.
- The declarative path gets the pull request review: plan comment, lint, policy and `yodel override`.
- A yodel project works as a member of a chant workspace, with dbt ([In a chant workspace](workspace.md)), and `yodel plan --part` writes a chant change-set part.
- `YODEL_ROLE` picks the role. `yodel init --from` refuses objects chant cannot declare, and drift reports a column added by hand.

## 0.9.0

- Your own column rules in `lint.policies` ([Lint](lint.md)).
- Typed columns from a generated `src/sql-types.d.ts` ([Declaring the schema](schema.md)).
- A clause chant's parser does not know is kept as written, with a warning, where it used to fail the build.
- chant 0.124.13.

## 0.8.0

- Breaking: the review-and-apply plumbing moves onto chant (0.124.3). Webhook events are chant's `chant.notify/v1` body.
- `yodel override` records through chant's override gate, and one override names every rule that denies the plan.
- The steps around apply run as chant's Op waves stage hooks, and the PR comment and drift issue post through chant's forge client.
- Each apply appends the schema digest to chant's release ledger, so `chant components status` compares environments.
