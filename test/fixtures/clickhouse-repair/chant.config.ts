import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-sql";

// The repair and rebase e2e tests point YODEL_E2E_CLICKHOUSE_URL at the emulator
// (`chant emulator up --lexicon sql`). The migrations' objects live in
// database yodel_e2e_fixture, the history in yodel_e2e_fixture_history (YODEL_HISTORY_DATABASE).
// yodel_e2e_fixture stands for the suite's own name (test/e2e/names.ts), put in
// its place when the suite copies this fixture.
export default {
  lexicons: ["sql"],
  sql: {
    dialect: "clickhouse",
    profiles: {
      e2e: { url: process.env.YODEL_E2E_CLICKHOUSE_URL ?? "http://localhost:8123", databases: ["yodel_e2e_fixture"] },
    },
  },
} satisfies ChantConfig;
