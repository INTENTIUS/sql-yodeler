import type { YodelConfig } from "@intentius/sql-yodeler";

// What yodel needs per environment that chant.config.ts does not say. Each
// key is a profile in chant.config.ts.
//
// - history.database: the schema yodel's history table lives in. It is never
//   part of the declared schema. The apply lock is a Postgres advisory lock.
export default {
  environments: {
    dev: { history: { database: "{{chant:history_schema}}" } },
    prod: { history: { database: "{{chant:history_schema}}" } },
    // The lint job's throwaway server (chant.config.ts), with the same history schema.
    replay: { history: { database: "{{chant:history_schema}}" } },
  },
  // The apply pipeline's waves, in order: scripts/ci.ts renders one job per
  // wave, each needing the one before. A wave's gate says when it waits for
  // an approval: "always" (whenever it has a migration to apply),
  // "on-destructive" (a drop, a table rewrite or lock-heavy statement, a
  // rebuild, an Op or manual step) or "never". The pipeline reads the gate
  // from the commit before the push, so a change cannot loosen its own.
  // A wave applies only migrations the wave before it has applied (its
  // history records them, with the same checksum); `requires: "<env>"` names
  // another environment, `requires: false` none.
  waves: [
    { env: "dev", gate: "always" },
    { env: "prod", gate: "always" },
  ],
} satisfies YodelConfig;
