import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-sql";

// The e2e tests point YODEL_E2E_CLICKHOUSE_URL at the emulator
// (`chant emulator up --lexicon sql`); everything lives in database yodel_6.
export default {
  lexicons: ["sql"],
  sql: {
    dialect: "clickhouse",
    profiles: {
      e2e: { url: process.env.YODEL_E2E_CLICKHOUSE_URL ?? "http://localhost:8123", databases: ["yodel_6"] },
    },
  },
} satisfies ChantConfig;
