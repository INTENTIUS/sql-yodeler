import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-sql";

// The replay e2e tests (#11) point YODEL_E2E_CLICKHOUSE_URL at the emulator
// (`chant emulator up --lexicon sql`). The history's objects live in
// database yodel_11; the replay drops and recreates it.
export default {
  lexicons: ["sql"],
  sql: {
    dialect: "clickhouse",
    profiles: {
      emulator: { url: process.env.YODEL_E2E_CLICKHOUSE_URL ?? "http://localhost:8123", databases: ["yodel_11"] },
    },
  },
} satisfies ChantConfig;
