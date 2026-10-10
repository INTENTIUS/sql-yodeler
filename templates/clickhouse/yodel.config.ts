import type { YodelConfig } from "@intentius/sql-yodeler";

// What yodel needs per environment that chant.config.ts does not say. Each
// key is a profile in chant.config.ts.
//
// - topology: what every migration's statements are rendered for when they
//   are sent. A cluster takes "cluster:<name>" (ON CLUSTER and Replicated
//   engines), ClickHouse Cloud "cloud".
// - history.database: where yodel's history table and apply lock live. It
//   is never part of the declared schema.
export default {
  environments: {
    dev: { topology: "single", history: { database: "{{chant:history_database}}" } },
    prod: { topology: "single", history: { database: "{{chant:history_database}}" } },
    // The lint job's throwaway server (chant.config.ts), with the same history database.
    replay: { topology: "single", history: { database: "{{chant:history_database}}" } },
  },
  // The apply pipeline's waves, in order: yodel ci renders one job per
  // wave, each needing the one before. A wave's gate says when it waits for
  // an approval: "always" (whenever it has a migration to apply),
  // "on-destructive" (a drop, a table rewrite or lock-heavy statement, a
  // rebuild, an Op or manual step) or "never". The pipeline reads the gate
  // from the commit before the push, so a change cannot loosen its own.
  // A wave applies only migrations the wave before it has applied (its
  // history records them, with the same checksum); `requires: "<env>"` names
  // another environment, `requires: false` none. A wave's `approval` says
  // which approvals count: "ledger" (any chant approve, the default),
  // "pr-review" (also the pull request's review by a writer other than its
  // author) or "sealed" (only one sealed with yodel approve --sign by a key
  // .chant/allowed_signers lists at the base commit).
  waves: [
    { env: "dev", gate: "always" },
    { env: "prod", gate: "always" },
  ],
  // The pipelines `yodel ci` (npm run ci) renders: the forges to render for,
  // and, when the project has jobs of its own, the module that declares them
  // with chant's lexicons (jobs: "ci/jobs.ts", exporting `actions` for GitHub
  // and Forgejo and `gitlab`). yodel ci adds them to the pull request pipeline
  // after its own, so they survive every render. To run every job in the CI
  // image (node, yodel, chant and the lexicons, no npm ci in any job), add
  // image: "ghcr.io/intentius/sql-yodeler:<version>@sha256:<digest>", pinned by
  // the digest the release's image job prints, with <version> the yodel this
  // project installs. yodel approve <env> starts a waiting wave's job again
  // itself; to have a schedule do it too (an approval made with chant approve
  // alone, or a resume that failed), add resume: { schedule: "*/10 * * * *" }:
  // yodel ci --help says which token each forge needs.
  ci: { forges: ["github", "gitlab", "forgejo"] },
} satisfies YodelConfig;
