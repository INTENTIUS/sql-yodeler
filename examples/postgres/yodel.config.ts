import type { YodelConfig } from "@intentius/sql-yodeler";

// The history table lives in schema yodel_18_history. The apply lock is a
// Postgres advisory lock, so it needs no table.
export default {
  environments: {
    dev: { history: { database: "yodel_18_history" } },
    replay: { history: { database: "yodel_18_history" } },
  },
} satisfies YodelConfig;
