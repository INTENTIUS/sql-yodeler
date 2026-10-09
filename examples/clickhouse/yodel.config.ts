import type { YodelConfig } from "@intentius/sql-yodeler";

// The history table and the apply lock live in yodel_18_history. The topology
// is left to its default, a single node.
export default {
  environments: {
    dev: { history: { database: "yodel_18_history" } },
    replay: { history: { database: "yodel_18_history" } },
  },
} satisfies YodelConfig;
