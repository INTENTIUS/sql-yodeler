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
} satisfies YodelConfig;
