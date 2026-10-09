import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-sql";

// test/e2e/topology.test.ts applies one migrations directory to two
// environments: `single`, the emulator (YODEL_E2E_CLICKHOUSE_URL), and
// `replicated`, a scratch two-replica cluster with Keeper whose first
// replica the test puts in YODEL_E2E_REPLICATED_URL. The topology of each is
// in yodel.config.ts, not here. Objects live in yodel_e2e_fixture, the history in
// yodel_e2e_fixture_history.
// yodel_e2e_fixture stands for the suite's own name (test/e2e/names.ts), put in
// its place when the suite copies this fixture.
export default {
  lexicons: ["sql"],
  sql: {
    dialect: "clickhouse",
    profiles: {
      single: { url: process.env.YODEL_E2E_CLICKHOUSE_URL ?? "http://localhost:8123", databases: ["yodel_e2e_fixture"] },
      replicated: { url: process.env.YODEL_E2E_REPLICATED_URL ?? "http://localhost:8124", databases: ["yodel_e2e_fixture"] },
    },
  },
} satisfies ChantConfig;
