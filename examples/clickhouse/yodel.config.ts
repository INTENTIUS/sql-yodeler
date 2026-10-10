import type { YodelConfig } from "@intentius/sql-yodeler";

// The history table and the apply lock live in yodeler. The topology
// is left to its default, a single node.
export default {
  environments: {
    dev: { history: { database: "yodeler" } },
    replay: { history: { database: "yodeler" } },
  },
} satisfies YodelConfig;
