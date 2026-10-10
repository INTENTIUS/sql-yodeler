import type { YodelConfig } from "@intentius/sql-yodeler";

// The history table lives in schema yodeler. The apply lock is a
// Postgres advisory lock, so it needs no table.
export default {
  environments: {
    dev: { history: { database: "yodeler" } },
    replay: { history: { database: "yodeler" } },
  },
} satisfies YodelConfig;
