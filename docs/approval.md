---
claims: [approve-and-apply, digest-moved, pr-comment]
---

# Approval

`yodel apply` applies only a plan someone approved, on both paths. The approval is chant's (the [Glossary](glossary.md) has the terms): a gate in an Op, bound to a plan digest, resolved with `chant approve`, and kept on the `chant/lifecycle` branch of the project's git repository. yodel keeps no approval store of its own. The output quoted here is from the examples' runs; `...` marks lines left out.

## The migrations Op

On the versioned path, `yodel apply <env>` runs the project's migrations Op for the environment with `chant run`. It is an ordinary chant Op with three phases, which the starter templates and the examples declare in `ops/migrate-<env>.op.ts`:

<!-- quote: clickhouse#migrations-op -->
```ts
import { Op, phase, gate, shell, stepOutput } from "@intentius/chant/op";

// yodel apply dev runs this Op when migrations are pending. The gate is bound
// to the plan digest (the pending migrations' checksums, the topology, the
// history and the live schema), so an approval given for one state never
// applies another.
const plan = shell("yodel apply dev --digest", { id: "plan" });
const digest = stepOutput(plan, "stdout");

export const op = Op({
  name: "migrate-dev",
  overview: "Apply the pending migrations to dev, behind an approval bound to their plan digest",
  phases: [
    phase("Plan", [plan]),
    phase("Approve", [gate("approve-migrate-dev", { plan: digest })]),
    phase("Apply", [shell("yodel apply dev --execute", { env: { YODEL_APPROVED_PLAN: digest }, timeout: "2h" })]),
  ],
});
```

- Plan: `yodel apply dev --digest` prints the plan digest.
- Approve: a gate bound to that output. A resolution counts only for that digest.
- Apply: `yodel apply dev --execute`, given the approved digest in `YODEL_APPROVED_PLAN`, takes the lock, computes the digest again, refuses if it moved, and applies.

The digest is checked twice: by the gate on every run, against the approval, and by the Apply step under the lock, against the digest the gate passed, so a change between the two (another runner applying first, a table altered out of band) refuses too.

`yodel apply` finds the Op by its shape, whatever its name. When there is none it prints this declaration to add; when more than one applies the environment, `--op <name>` picks one; an Op whose gate is not bound to the Plan step's output is refused. `chant run migrate-dev` run directly (as CI may) needs `yodel` on `PATH`; `yodel apply` puts itself there for the Op it runs. The declarative path's `ApplyOp` carries its own plan-bound gate ([The two workflows](workflows.md)).

## The plan digest

On the versioned path the digest covers what the run would do and the state it would start from:

- the migrations it would apply, in order, each with its files' checksum and the statements of it that already succeeded (a migration that failed part way resumes);
- the history it starts from: every applied migration and its checksum;
- the topology the statements are rendered for;
- the live schema: a fingerprint of the server's catalog in the environment's databases or schemas. The history's own database is left out, so recording a run does not move the digest.

It is chant's plan digest (`jcs1-sha256:...`), so `chant approve <op> <gate> --plan <digest>` takes it. `yodel plan <env>` prints it with the command that approves it:

<!-- quote: clickhouse#plan -->
```console
$ npx yodel plan dev
Plan for dev (clickhouse 26.8.15.10 at 127.0.0.1:8123, history yodeler.history (single (default))): 1 applied, 1 pending

20261010T0528-add-country
  0  statement  SQLCH201 metadata  shop.events
       ALTER TABLE `shop`.`events` ADD COLUMN country LowCardinality(String) DEFAULT '' AFTER `at`

Plan digest: jcs1-sha256:62d246010143e51e9ba1c8a4988836dd44017840392ce4a211ac4407b1081c2e
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:62d246010143e51e9ba1c8a4988836dd44017840392ce4a211ac4407b1081c2e
or, at a terminal, with npx yodel approve dev, which shows the plan and asks you first.

Not approved yet. Approving binds exactly this digest; if anything it covers changes before the apply runs, the gate asks again and nothing is applied.
```

`yodel status <env>` prints it too, and `yodel apply <env> --plan` prints the pending migrations and the digest without applying.

## Approving

<!-- quote: clickhouse#approve -->
```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:62d246010143e51e9ba1c8a4988836dd44017840392ce4a211ac4407b1081c2e
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-10T05:28:45.812Z
This approves the plan jcs1-sha256:62d246010143e51e9ba1c8a4988836dd44017840392ce4a211ac4407b1081c2e, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

The approval is a commit on the local `chant/lifecycle` branch. Push it (`git push origin chant/lifecycle`) so CI sees it: every job in the starter templates fetches that branch first. In the templates, the pull request comment ends with the approve command; approve before merging, and the apply job after the merge goes through. A merge with nothing approved applies nothing and fails with the command to run; approve, push, and run the apply job again.

Then `yodel apply` runs through the gate:

<!-- quote: clickhouse#apply -->
```console
$ npx yodel apply dev
...
Running migrate-dev (<tmp>/clickhouse/ops/migrate-dev.op.ts)
lock: no KeeperMap on this server (KeeperMap is disabled because 'keeper_map_path_prefix' config is not defined. (BAD_ARGUMENTS) (version 26.8.15.10 (official build))); the lock is a file on this machine, so cross-runner locking needs Keeper (and keeper_map_path_prefix)
approval: migrate-dev / approve-migrate-dev for jcs1-sha256:62d246010143e51e9ba1c8a4988836dd44017840392ce4a211ac4407b1081c2e, by yodel at 2026-10-10T05:28:45.812Z
20261010T0528-add-country: applying
  statement 0: ok (SQLCH201 metadata, shop.events)
20261010T0528-add-country: applied
...
```

### On your own machine

`yodel approve <env>` approves at the terminal without the Op and gate names or the digest. It shows the pending migrations and the plan digest, asks you to type the environment's name, and records the same approval `chant approve` gives, bound to the same digest:

```sh
npx yodel approve dev
npx yodel apply dev
```

It never approves without a person at the terminal: with no terminal to ask (a script, CI, a coding agent) it approves nothing and exits 4. The printed `npx chant approve ...` command does the same in one line, and `"$(npx yodel apply dev --digest)"` can stand in for the digest.

In a repository with no remote, chant warns that the approval (and the pending record `yodel apply` writes at the gate) was not pushed; on your own machine that is expected.

## The pull request comment

`yodel plan <env> --comment` posts the plan as one comment per environment on the pull (merge) request, and updates that comment on the next push rather than adding another. `--format markdown` prints the same Markdown without posting. From the ClickHouse example, for its rebuild:

<!-- quote: clickhouse#comment -->
````console
$ npx yodel plan dev --format markdown
<!-- yodel:plan env=dev -->
### yodel plan: `dev`

ClickHouse, history `yodeler.history (single (default))`: 2 applied, **1 pending**.

#### `20261010T0528-events-by-id`

| # | Step | Rule | Class | Object |
|---|---|---|---|---|
| 0 | **Op ClickHouseRebuildOp** | SQLCH220 | rebuild | `shop.events` |

Op steps:
- step 0, `shop.events`: made by Op `ClickHouseRebuildOp` (SQLCH220 rebuild orderBy). yodel apply runs it as this step.

  <details><summary>ClickHouseRebuildOp for events</summary>

  ```text
  needs a rebuild, which ALTER cannot make: SQLCH220 Change the sorting key on orderBy (( kind , at ) -> ( kind , id )): The sorting key is the on-disk order of every part (and in ReplacingMergeTree the deduplication identity); beyond appending new columns (SQLCH216) it cannot change in place. https://clickhouse.com/docs/sql-reference/statements/alter/order-by. Run it as the rebuild migration Op: ClickHouseRebuildOp({ table: "shop.events", ... }) from @intentius/chant-lexicon-sql/clickhouse
  ```

  ```ts
  export const { op } = ClickHouseRebuildOp({ name: "rebuild-shop-events", env: "<env>", table: "shop.events", dualWrite: { mode: "materialized-view", cutoverColumn: "at" } });
  ```

  </details>

#### Approval

Plan digest the apply gate binds: `jcs1-sha256:9189fe68c92a7b40c811d90d8ccb4e68f0aaf4b460bcb9118dc178949cd69511`

Approve it with:

```sh
chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:9189fe68c92a7b40c811d90d8ccb4e68f0aaf4b460bcb9118dc178949cd69511
```

The newest approval of `approve-migrate-dev`, by yodel at 2026-10-10T05:28:45.812Z, is for `jcs1-sha256:62d246010143e51e9ba1c8a4988836dd44017840392ce4a211ac4407b1081c2e`, not this plan; it does not hold.
What moved (as far as yodel can tell): history changed: applied since: 20261010T0528-add-country (by yodel@example at 2026-10-10 05:28:49.676850); pending migrations changed: committed to since approval: 20261010T0528-events-by-id (48acfad at 2026-10-09T23:28:54-06:00); live schema changed: as expected after the history change above: applying a migration changes the live schema, and yodel cannot rebuild the live schema as it was at approval, so it cannot confirm that nothing else in it changed.

<!-- yodel:subject eyJlbnZpcm9ubWVudCI6ImRldiIsImhpc3RvcnlEYXRhYmFzZSI6InlvZGVsZXIiLCJ0b3BvbG9neSI6eyJraW5kIjoic2luZ2xlIn0sImFwcGxpZWQiOlt7ImlkIjoiMjAyNjEwMTBUMDUyOC1iYXNlbGluZSIsImNoZWNrc3VtIjoic2hhMjU2OjUyZDRjODE5ZTU3MjM4YTA5YTMyY2U4MTkzNDU1MmY5Y2IzOGFjZmQ1MWE3ODkzM2Y3OTM0MGE2YzQ1MWU1ODQifSx7ImlkIjoiMjAyNjEwMTBUMDUyOC1hZGQtY291bnRyeSIsImNoZWNrc3VtIjoic2hhMjU2OmUxYTZiNDU0MGZjNjgzMDQwZDMyODA3ODcwMzI1MmVmMzBiYmIxMGRjNWE2ZmJkMThmYmQ0M2Q2MzEzMTNiN2MifV0sInBlbmRpbmciOlt7ImlkIjoiMjAyNjEwMTBUMDUyOC1ldmVudHMtYnktaWQiLCJjaGVja3N1bSI6InNoYTI1NjplNmNiMzJmNDZkYjc5NjExYWY1MTg0NTlmNTFiNGUyYTQ1YTcwNzg0YTdmN2Q3ZWU0YjJkZGVkZjc5NmMyYzEwIiwiZG9uZSI6W119XSwibGl2ZSI6InNoYTI1NjpiYTA4MzBmYjk2NjkzNWMzYTNiNmQ1Nzg3ODIwNGJhMzMzMzQxMTg2YzJkMzk4M2E3YTMwN2IxMjk4MmFiMmY1In0 -->
````

The hidden `yodel:subject` line at the end records the state the plan was made from; the next `--comment` run reads it from the comment it updates, to say what moved. The forge, the repository, the request and the API come from the CI job's environment:

| Forge | Detected by | Token |
|---|---|---|
| GitHub Actions | `GITHUB_ACTIONS=true` | `GITHUB_TOKEN`, with `pull-requests: write` |
| GitLab CI | `GITLAB_CI=true` | `GITLAB_TOKEN`: a project or personal access token with `api` scope (`CI_JOB_TOKEN` cannot write merge request notes) |
| Forgejo Actions | `FORGEJO_ACTIONS=true` or `GITEA_ACTIONS=true` (or a GitHub-style job whose API URL ends in `/api/v1`) | `FORGEJO_TOKEN`, else `GITHUB_TOKEN` |

Outside those, or to override them: `--forge github|gitlab|forgejo`, `--repo`, `--pr`, `--api-url`, and `--token-env <VAR>` for the variable that holds the token. The token is never a flag and never printed. The comment job needs only read credentials for the database; the starter templates give it the reader.

## When the digest moves

Anything the digest covers that changes after the approval (another migration, an edited one, another run applying first, a table changed out of band) makes a new digest, and the approval does not carry over. The gate asks again, nothing is applied, and yodel says what moved, as far as it can tell from the history and git.

In the ClickHouse example a plan is approved, then someone adds a column by hand before the apply runs:

<!-- quote: clickhouse#plan-add-source -->
```console
$ npx yodel plan dev
Plan for dev (clickhouse 26.8.15.10 at 127.0.0.1:8123, history yodeler.history (single (default))): 4 applied, 1 pending

20261010T0530-add-source
  0  statement  SQLCH201 metadata  shop.events
       ALTER TABLE `shop`.`events` ADD COLUMN source LowCardinality(String) DEFAULT 'web' AFTER `country`

Plan digest: jcs1-sha256:383557fc287dd670eb533a3ebc3d468d3081d4b6cbe7a2545006b6d2738b7ac6
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:383557fc287dd670eb533a3ebc3d468d3081d4b6cbe7a2545006b6d2738b7ac6
or, at a terminal, with npx yodel approve dev, which shows the plan and asks you first.

The newest approval of approve-migrate-dev, by yodel at 2026-10-10T05:30:16.074Z, is for jcs1-sha256:688a2645626e67027be0f753f184f415bbd2643dcd02ab308ae8caf99ddb323c, not this plan; it does not hold.
What moved: history changed: applied since: 20261010T0530-fill-country (by yodel@example at 2026-10-10 05:30:19.862295); pending migrations changed: new pending migration: 20261010T0530-add-source.
```

<!-- quote: clickhouse#approve-add-source -->
```console
$ npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:383557fc287dd670eb533a3ebc3d468d3081d4b6cbe7a2545006b6d2738b7ac6
Gate "approve-migrate-dev" on "migrate-dev" resolved by yodel at 2026-10-10T05:30:24.450Z
This approves the plan jcs1-sha256:383557fc287dd670eb533a3ebc3d468d3081d4b6cbe7a2545006b6d2738b7ac6, and only that plan. A run whose fresh plan differs refuses rather than applying it.
This records the resolution as a fact; it does not itself re-run anything. Run `chant run migrate-dev` and it walks through gate "approve-migrate-dev".
```

```sql
ALTER TABLE shop.events ADD COLUMN debug String DEFAULT ''
```

<!-- quote: clickhouse#moved -->
```console
$ npx yodel apply dev
...
Running migrate-dev (<tmp>/clickhouse/ops/migrate-dev.op.ts)
[phase] Plan
  ✓ shellCmd(cmd=yodel apply dev --digest)   1.1s
[phase] Approve
  • gate:approve-migrate-dev()   skipped
    [refused] Gate "approve-migrate-dev" is approved, but not for this plan. approved: jcs1-sha256:383557fc287dd670eb533a3ebc3d468d3081d4b6cbe7a2545006b6d2738b7ac6 (by yodel at 2026-10-10T05:30:24.450Z); planned: jcs1-sha256:4ae6a0b8ab9a045d0ef690bb9101a335eec3781dc9ad6a93be033c436c48fb55. The configuration or the live system changed between that approval and this plan, so it needs a fresh one: chant approve migrate-dev approve-migrate-dev
[phase] Apply
  • shellCmd(cmd=yodel apply dev --execute, env={"YODEL_APPROVED_PLAN":{"kind":"step-output-ref","step":"plan","path":"stdout"}})   skipped
Op "migrate-dev" is gated on "approve-migrate-dev" after 1.9s
  plan    : jcs1-sha256:4ae6a0b8ab9a045d0ef690bb9101a335eec3781dc9ad6a93be033c436c48fb55
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:4ae6a0b8ab9a045d0ef690bb9101a335eec3781dc9ad6a93be033c436c48fb55
  expires : 2026-10-12T05:30:27.702Z

Nothing was applied. The approval of jcs1-sha256:383557fc287dd670eb533a3ebc3d468d3081d4b6cbe7a2545006b6d2738b7ac6 (by yodel at 2026-10-10T05:30:24.450Z) does not hold: the plan moved since. What moved, as far as yodel can tell: live schema changed: no state yodel can rebuild from the history and git hashes to the approved digest with today's live schema, so an object in the environment's live schema (a table, view, index, dictionary, database or schema) changed since approval (or a part yodel cannot rebuild did).

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:4ae6a0b8ab9a045d0ef690bb9101a335eec3781dc9ad6a93be033c436c48fb55).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:4ae6a0b8ab9a045d0ef690bb9101a335eec3781dc9ad6a93be033c436c48fb55
or, at a terminal, with npx yodel approve dev, which shows the plan and asks you first;
then run npx yodel apply dev again.
[exit 3]
```

Dropping the column puts the live schema back, and the digest is the approved one again. The gate still asks again, because the refused run asked for approval after that approval was given; an approval holds only when it is newer than the latest request. `yodel plan` and `yodel apply` say so:

<!-- quote: clickhouse#asked-again-plan -->
```console
$ npx yodel plan dev
Plan for dev (clickhouse 26.8.15.10 at 127.0.0.1:8123, history yodeler.history (single (default))): 4 applied, 1 pending

20261010T0530-add-source
  0  statement  SQLCH201 metadata  shop.events
       ALTER TABLE `shop`.`events` ADD COLUMN source LowCardinality(String) DEFAULT 'web' AFTER `country`

Plan digest: jcs1-sha256:383557fc287dd670eb533a3ebc3d468d3081d4b6cbe7a2545006b6d2738b7ac6
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:383557fc287dd670eb533a3ebc3d468d3081d4b6cbe7a2545006b6d2738b7ac6
or, at a terminal, with npx yodel approve dev, which shows the plan and asks you first.

The newest approval of approve-migrate-dev, by yodel at 2026-10-10T05:30:24.450Z, is for this plan's digest, but approval was asked for again after it at 2026-10-10T05:30:27.702Z (a run holding jcs1-sha256:4ae6a0b8ab9a045d0ef690bb9101a335eec3781dc9ad6a93be033c436c48fb55), so it does not hold; approve this plan again.
```

<!-- quote: clickhouse#asked-again-apply -->
```console
$ npx yodel apply dev
...
Op "migrate-dev" is gated on "approve-migrate-dev" after 1.5s
  plan    : jcs1-sha256:383557fc287dd670eb533a3ebc3d468d3081d4b6cbe7a2545006b6d2738b7ac6
  approve : chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:383557fc287dd670eb533a3ebc3d468d3081d4b6cbe7a2545006b6d2738b7ac6
  expires : 2026-10-12T05:30:32.194Z

Nothing was applied. The approval of jcs1-sha256:383557fc287dd670eb533a3ebc3d468d3081d4b6cbe7a2545006b6d2738b7ac6 (by yodel at 2026-10-10T05:30:24.450Z) is for this plan's digest, but approval was asked for again after it at 2026-10-10T05:30:27.702Z (a run holding jcs1-sha256:4ae6a0b8ab9a045d0ef690bb9101a335eec3781dc9ad6a93be033c436c48fb55), so it does not hold; approve this plan again.

migrate-dev is waiting at gate "approve-migrate-dev" for approval of this plan (jcs1-sha256:383557fc287dd670eb533a3ebc3d468d3081d4b6cbe7a2545006b6d2738b7ac6).
Approve it with:
  chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:383557fc287dd670eb533a3ebc3d468d3081d4b6cbe7a2545006b6d2738b7ac6
or, at a terminal, with npx yodel approve dev, which shows the plan and asks you first;
then run npx yodel apply dev again.
[exit 3]
```

After a new `chant approve`, the apply goes through. A migration that failed part way moves the digest too, since the statements that succeeded are part of it; the [Postgres example](../examples/postgres/README.md#4-a-migration-that-fails-part-way-and-resumes) approves again before resuming.

## Policy and overrides

Some rules are not lint: no drops in production, no rebuilds during business hours, every silence cites a ticket. `yodel.config.ts` declares them as `policy`, rules over the plan `yodel apply` would run:

```ts
// yodel.config.ts
import { defineConfig } from "@intentius/sql-yodeler";

export default defineConfig({
  policy: {
    overriders: ["alice", "bob"],
    rules: [
      { id: "no-drops-in-prod", environments: ["prod"], description: "no drops in prod", refuse: { classes: ["drop"], destructive: true } },
      { id: "silences-cite-a-ticket", silences: { reason: /\b[A-Z]+-\d+\b/ } },
      {
        id: "no-rebuilds-in-hours",
        environments: ["prod"],
        check: (plan) => {
          const hour = new Date(plan.now).getUTCHours();
          const rebuild = plan.pending.some((m) => m.steps.some((s) => s.classes.includes("rebuild")));
          return rebuild && hour >= 8 && hour < 18 ? "a rebuild between 08:00 and 18:00 UTC" : undefined;
        },
      },
    ],
  },
});
```

A rule applies to the environments it lists, or to every one. It denies the plan when any of its parts does:

- `refuse.classes` denies a pending step of one of those classes (ClickHouse: `metadata`, `create`, `rewrite`, `rebuild`, `drop`; Postgres: `metadata`, `create`, `validate`, `concurrently`, `rewrite`, `expand`, `drop`), and `refuse.destructive` any destructive step.
- `silences.reason` denies a `-- yodel:allow` silence (of `silences.rules`, default any) whose reason does not match the pattern.
- `check` is a TypeScript predicate over the plan: the environment, the dialect, the time (`now`), and each pending migration with its id, checksum, steps (classes, destructive, rules, SQL, Op) and silences. A message, a list of messages or `false` denies; `undefined`, `true` or `[]` allows.

`yodel plan` shows each rule's outcome, and the pull request comment shows them in a table with the command that overrides a denial. `yodel apply` judges the policy before the gate and the Apply step judges it again under the lock: a rule that denies the plan refuses the apply with exit 4, naming the rule and why, and nothing is applied.

An override is a person's decision, with a reason, to apply a plan a rule denies:

```sh
npx yodel override prod --rule no-drops-in-prod --reason "the table has been empty since OPS-412" --by alice
```

It is recorded on chant's gate ledger (the `chant/lifecycle` branch) as an approval of the gate `override-<rule>` of the environment's migrations Op, for exactly the current plan digest, with the reason as its note (`chant approve <op> override-<rule> --plan <digest> --note <reason>`). It counts only for that digest: if the plan moves (a migration added or edited, the live schema changed), the rule denies again and needs a new override. It counts only when `policy.overriders` lists who recorded it (`--by`, else chant's actor: the CI user or your login). `yodel override` refuses a rule that does not deny the current plan, so an override always answers one denial. An override does not approve the plan: the migrations Op's gate still asks for approval as before.

The Apply step writes the overrides it relied on into the history, in the `note` of each migration's `started` row, as `{"policy":{"overrides":[{"rule":...,"by":...,"at":...,"reason":...,"digest":...}]}}`.
