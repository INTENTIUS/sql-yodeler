import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-sql";

// The repair and rebase e2e tests point YODEL_E2E_CLICKHOUSE_URL at the emulator
// (`chant emulator up --lexicon sql`). The migrations' objects live in
// database yodel_15, the history in yodel_15_history (YODEL_HISTORY_DATABASE).
export default {
  lexicons: ["sql"],
  sql: {
    dialect: "clickhouse",
    profiles: {
      e2e: { url: process.env.YODEL_E2E_CLICKHOUSE_URL ?? "http://localhost:8123", databases: ["yodel_15"] },
    },
  },
} satisfies ChantConfig;
