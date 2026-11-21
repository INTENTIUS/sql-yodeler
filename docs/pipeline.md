---
claims: [pipeline, waves]
type: howto
---

# Environments as pipeline stages

With `ci.promotion` in `yodel.config.ts`, the apply pipeline's environments are the stages of [chant's pipeline](https://intentius.io/chant/reference/pipeline/). A merge applies the first environment and cuts a release from what it applied. Each later environment takes that release with `yodel promote`, behind a gate of its own. That gate can read the change's risk and the soak of the stage before it. Without `ci.promotion`, every wave applies on merge, one after another, as [The pipelines](workflows.md#the-pipelines-yodel-ci) describes.

The keys are chant's stage keys from its [CI product config reference](https://intentius.io/chant/reference/ci-product-config/#stage-keys), spelled in camelCase under `ci`. yodel hands each one to chant as written, and chant runs every mechanism behind them.

## Turn it on

`ci.promotion` lists the environments `waves` lists, in the same order:

```ts
export default defineConfig({
  waves: [
    { env: "dev", gate: "never" },
    { env: "staging", gate: "on-destructive" },
    { env: "prod", gate: "always" },
  ],
  ci: {
    promotion: ["dev", "staging", "prod"],
    approvalRules: [{ count: 1, notAuthor: true }],
    risk: { approveAbove: 0.5 },
    environments: {
      dev: { soak: { duration: "30m", checks: [{ kind: "http", url: "https://dev.example.com/health" }] } },
      prod: {
        approvalRules: [{ count: 2, roles: ["sre"] }],
        risk: { approvalRules: [{ count: 1, roles: ["dba"] }] },
        freeze: [{ from: "2026-12-20T00:00:00Z", until: "2027-01-04T00:00:00Z", reason: "year end" }],
        urgent: { role: "sre" },
      },
    },
  },
});
```

Then `yodel ci` writes these files, and `yodel ci --check` fails while any of them differs from what the config writes:

| File | Holds |
|---|---|
| `.chant/pipeline.ts` | the pipeline declaration, written with chant's `pipelineFromConfig` and `pipelineSource`. `chant build` folds it, and the gates read it at the base commit. `yodel ci --check` runs chant's `checkPipelineFile` on it and prints the line diff |
| `yodel-waves.json` | the first stage's op-waves spec, taken from the folded file, under the op name `yodel-apply`, so approvals already on `chant/lifecycle` keep counting. Its last wave cuts the release, and its release records name the component `yodel-apply`, the name every stage records under |
| `yodel-apply.yml` (`.gitlab/yodel-apply.gitlab-ci.yml`) | the first stage's wave job, on a push to main |
| `yodel-apply-promote.yml` (`.gitlab/yodel-apply-promote.gitlab-ci.yml`) | one job per later stage, started by hand with the stage and the release. On GitLab, start a pipeline from the web with `CHANT_PROMOTE_STAGE` and `CHANT_PROMOTE_RELEASE` |
| `yodel-reject.yml` (GitHub and Forgejo) | the job that answers `/yodel reject` on a pull request |

Each promote job holds its environment's writer and the reader of the environment it requires, the same secrets that environment's wave job held. It runs in the wave jobs' image (`ci.image`, or Node with `npm ci`) and installs yodel the same way before it runs `yodel chant components promote`. A promote job whose environment has a cloud-minted password logs in as that environment's wave job does. On GitHub and GitLab it trades for the `ci.login` the environment names, or requests the forge's OIDC token for a cloud with no `ci.login` entry. On Forgejo it logs in from the runner's token files. The job checks out the default branch with its full history, which holds the commit each release was cut from.

## Gates and approval rules

| Key under `ci` | chant's key | Sets |
|---|---|---|
| `promotion` | `promotion` | the stages, first to last |
| `approvalRules` | `approval_rules` | the approval rules of every stage's gate |
| `environments.<env>.approvalRules` | `environments.<name>.approval_rules` | one stage's rules, in place of `approvalRules` |
| `waves[].gate` | `waves[].gate` | when the stage's wave waits: `always`, `on-destructive`, `never` |
| `waves[].approval` | `waves[].approval` | which approvals count: `ledger`, `pr-review`, `sealed` |

A rule is `{ count, roles, notAuthor, proven, name }`. `proven: true` counts only approvers a seal or a review proves. Rules group as `{ all: [...] }`, met when each rule in it is, and `{ any: [...] }`, met when one is, nested up to three deep; `name` shows in each rule's progress line:

```ts
approvalRules: [
  { name: "release", any: [
    { name: "two-approvers", count: 2, proven: true },
    { name: "release-manager", count: 1, roles: ["release-manager"] },
  ] },
]
```

## Change risk

| Key under `ci` | chant's key | Sets |
|---|---|---|
| `risk.approveAbove` | `risk.approve_above` | the score from 0 to 1 above which a plan needs an approval of its own, for every stage that sets none |
| `risk.questions` | `risk.questions` | the questions the review agent answers from 0 to 1, each `{ id, text, weight, approveAbove }` |
| `environments.<env>.risk.approveAbove` | `environments.<name>.risk.approve_above` | one stage's score |
| `environments.<env>.risk.approvalRules` | `environments.<name>.risk.approval_rules` | the rules the stage's gate takes on top of its own when the score is over |

chant scores each change from its reasons, and the sql lexicon's destructive classes are one of them: each lint rule that makes `on-destructive` wait (a drop, a Postgres rewrite or lock-heavy statement, a ClickHouse mutation or rebuild, an access change). `yodel plan <env> --pr-note` and `--format markdown` show the score, its level and each reason in the plan note, under the stage's threshold. Over it, the stage's wave waits for an approval whatever its gate says. A promote into a later stage reads the score the release carries. The score only adds approvals. A later stage with risk keys needs the first stage to score too, so `ci.risk.approveAbove` is the usual place for the threshold. [Change risk](https://intentius.io/chant/guide/change-risk/) has how the score is made.

## Soak

| Key under `ci` | chant's key | Sets |
|---|---|---|
| `environments.<env>.soak.duration` | `environments.<name>.soak.duration` | how long the checks keep passing after the stage's last apply before a release goes into the next stage |
| `environments.<env>.soak.checks[].kind` | `environments.<name>.soak.checks[].kind` | `http`, `prometheus` or `command`, with that kind's settings beside it |
| `environments.<env>.soak.checks[].onFail` | `environments.<name>.soak.checks[].on_fail` | `restart` (the default) starts the soak over once the check passes again, `hold` keeps the elapsed time |
| `environments.<env>.soak.overrides[]` | `environments.<name>.soak.overrides[].members` | a duration and checks of their own for some members |
| `environments.<env>.canary` | `environments.<name>.canary` | the canary stage, whose soak holds every stage after it |
| `recheck.schedule` | `recheck.schedule` | the cron line a promotion a soak holds is tried again on; the promote file gets a `recheck-<env>` job |

A SQL stage soaks on an HTTP probe, a Prometheus query or a command, and `yodel.config.ts` refuses a check of any other kind. The sql lexicon has no lifecycle health reader, so a `health` check would have nothing to read. A promote during the soak exits 3 with the time left. [Soak](https://intentius.io/chant/guide/soak/) has each kind's settings.

## When a verify or soak fails

With `environments.<env>.onVerifyFail` (chant's `on_verify_fail`) at `hold`, the default, the stage stays as applied and holds the next promote. A migration that ran stays run, and applying an earlier release takes none of it back, so `yodel ci` refuses `rollback` on every stage with chant's reason. Undo a migration with [`yodel revert`](migrations.md), behind its own gate.

## Stopping a stage, and the urgent rule

| Key under `ci` | chant's key | Sets |
|---|---|---|
| `environments.<env>.hold` | `environments.<name>.hold` | `true`, or `{ reason, until, description }`: no release is promoted into the stage |
| `environments.<env>.freeze` | `environments.<name>.freeze` | windows `{ from, until, reason }` in which no release is promoted |
| `environments.<env>.pauseAfterRollback` | `environments.<name>.pause_after_rollback` | a rollback of the stage pauses it until `yodel resume` |
| `environments.<env>.urgent.role` | `environments.<name>.urgent.role` | the role whose one sealed approval passes the stage's gate on `yodel promote --urgent` |

A hold and a freeze live in `.chant/pipeline.ts`, and a change to the config lifts them. A pause lives on the ledger: `yodel pause <env> --reason <text>` and `yodel resume <env> --reason <text>`.

## The stage graph

| Key under `ci` | chant's key | Sets |
|---|---|---|
| `environments.<env>.after` | `environments.<name>.after` | the stages a release applies in before this one opens for it; the stage before it when unset |
| `environments.<env>.queue` | `environments.<name>.queue` | `replace`: one release at a time, and a newer release waiting replaces an older one |
| `environments.<env>.failureTolerance` | `environments.<name>.failure_tolerance` | the failed runs a wave of many tenants lets through, a number or a share such as `"10%"` |

## Config and secret sets

| Key under `ci` | chant's key | Sets |
|---|---|---|
| `environments.<env>.config.<variable>` | `environments.<name>.config.<variable>` | a plain value the stage's jobs get as a variable |
| `environments.<env>.secrets.<variable>` | `environments.<name>.secrets.<variable>` | a secret the stage's jobs get, by where it is kept: a forge secret's name, or `{ forgeSecret }`, `{ awsSecretsManager, jsonKey, region }`, `{ gcpSecretManager }`, `{ azureKeyVault }` |
| `environments.<env>.imports` | `environments.<name>.imports` | the shared sets the stage takes first, in order |
| `configSets.<set>` | `config_sets.<set>` | a shared set of `config`, `secrets` and `imports` |

## The release cut's green gate

The merge's cut runs `yodel chant release cut auto --yes --wait-checks` after the first stage's last wave. It cuts a commit that a green gate passed, and `chant.config.ts` names the gate:

```ts
export default {
  lexicons: ["sql"],
  release: { green: "forge-checks" },
  sql: { /* ... */ },
} satisfies ChantConfig;
```

Under `forge-checks` the cut reads the merge commit's checks on the forge and waits while any is still running. It reads them with the wave job's token: on GitHub and Forgejo `yodel ci` gives the first stage's wave jobs the job's token with `checks: read` and `statuses: read`, and on GitLab the job reads `CHANT_GITLAB_TOKEN`, `GITLAB_TOKEN` or its own `CI_JOB_TOKEN`. The cut leaves out its own run, so the commit needs a check from another workflow, such as the repository's own CI on a push to main. A check that failed stops the cut with `release-commit-not-green`, and the stages after the first get no release from that merge.

`chant.config.ts` is the project's own file, and while it names no `release.green`, `yodel ci` prints the line to add. With no `release.green`, chant picks `chant` (a `ci/green/<sha>` tag, which this merge does not write) once the repository holds any `ci/green/` tag, else `forge-checks`. `release: { green: "chant" }` keeps the tags, and `ci.release.cut: false` turns the cut off. [`chant release cut`](https://intentius.io/chant/cli/release/cut/) has each gate.

The first stage's wave job gets its stage's set, and each promote job its own. The sets work without `ci.promotion` too, where each wave job gets its environment's set.

## Release artifacts

| Key under `ci` | chant's key | Sets |
|---|---|---|
| `release.cut` | `release.cut` | the merge cuts a release once the first stage applied; `true` by default |
| `release.label` | `release.label` | the label it is cut with; `auto` by default, the next version |
| `environments.<env>.publish.<artifact>` | `environments.<name>.publish.<artifact>` | a value the stage publishes for each release once it applied: `{ member, output }`, or `{ secret }` naming where a secret is kept |
| `environments.<env>.reads.<variable>` | `environments.<name>.reads.<variable>` | an artifact of an earlier stage the stage's promote gets in a variable: `{ stage, artifact }` |

## The stage commands

| Command | Runs | Does |
|---|---|---|
| `yodel promote --to <env> --release <label>` | `chant components promote` | takes the release into the stage, behind its gate; `--dry-run` prints the plan |
| `yodel promote --to <env> --release <label> --urgent --reason <text>` | `chant components promote --urgent` | passes the stage's gate on its urgent rule |
| `yodel reject yodel-apply <env> --reason <text>` | `chant reject` | turns down the release the stage's gate waits on; a promote of it into that stage then exits 8. `--sign` seals it |
| `yodel pause <env> --reason <text>` | `chant stage pause` | stops releases entering the stage |
| `yodel resume <env> --reason <text>` | `chant stage resume` | lets them in again; the newest release that waited enters |

### Two approvals for a later stage

A promote into a later stage passes two gates, and each can wait with exit 3 and the line that approves it:

1. The stage's gate, on the release. It binds the release digest: `chant approve yodel-apply <env> --env <env> --plan <release digest>`. Its approval rules, risk, soak, hold and freeze windows decide whether it waits.
2. Each wave's gate, on its plan. Once the stage's gate passes, the promote writes the stage's spec to `.chant/op-waves/yodel-apply-<env>.spec.json` and runs the stage's waves in order. Each wave plans, and its gate (`waves[].gate`, `waves[].approval`) binds that plan's digest under the op `yodel-apply-<env>`. A wave that waits prints its own `chant approve yodel-apply-<env> ...` line. Run that line, then run the same `yodel promote` again: the stage's gate stands, and the waves carry on.

The engine checks the wave's decision again under its lock, reading the gate from `.chant/pipeline.ts` at the default branch's tip, as the promote read it.

On GitHub and Forgejo a comment `/yodel reject [--stage <env>] <reason>` on a pull request records the rejection under the author's forge identity, where the stage's approval mode takes it: `ledger` and `pr-review` do. A `sealed` stage, and a rule that needs a proven approver, get a reply with the `yodel reject` line to run with `--sign`.
