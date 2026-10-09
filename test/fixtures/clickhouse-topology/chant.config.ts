import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-sql";

// test/e2e/topology.test.ts applies one migrations directory to two
// environments: `single`, the emulator (YODEL_E2E_CLICKHOUSE_URL), and
// `replicated`, a scratch two-replica cluster with Keeper whose first
// replica the test puts in YODEL_9_REPLICATED_URL. The topology of each is
// in yodel.config.ts, not here. Objects live in yodel_9, the history in
// yodel_9_history.
export default {
  lexicons: ["sql"],
  sql: {
    dialect: "clickhouse",
    profiles: {
      single: { url: process.env.YODEL_E2E_CLICKHOUSE_URL ?? "http://localhost:8123", databases: ["yodel_9"] },
      replicated: { url: process.env.YODEL_9_REPLICATED_URL ?? "http://localhost:8124", databases: ["yodel_9"] },
    },
  },
} satisfies ChantConfig;
