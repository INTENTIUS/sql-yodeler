import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-sql";

// The versioned e2e tests point YODEL_E2E_CLICKHOUSE_URL at the emulator
// (`chant emulator up --lexicon sql`). The migrations' objects live in
// database yodel_16, the history in yodel_16_history (YODEL_HISTORY_DATABASE).
export default {
  lexicons: ["sql"],
  sql: {
    dialect: "clickhouse",
    profiles: {
      e2e: { url: process.env.YODEL_E2E_CLICKHOUSE_URL ?? "http://localhost:8123", databases: ["yodel_16"] },
    },
  },
} satisfies ChantConfig;
