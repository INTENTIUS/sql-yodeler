import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-sql";

// The init e2e tests point YODEL_E2E_CLICKHOUSE_URL at the emulator
// (`chant emulator up --lexicon sql`). The adopted objects live in database
// yodel_10, the history in yodel_10_history (YODEL_HISTORY_DATABASE). No
// src/: yodel init --from e2e writes it.
export default {
  lexicons: ["sql"],
  sql: {
    dialect: "clickhouse",
    profiles: {
      e2e: { url: process.env.YODEL_E2E_CLICKHOUSE_URL ?? "http://localhost:8123", databases: ["yodel_10"] },
    },
  },
} satisfies ChantConfig;
