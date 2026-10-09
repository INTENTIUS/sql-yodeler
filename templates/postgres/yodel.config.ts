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
  },
} satisfies YodelConfig;
