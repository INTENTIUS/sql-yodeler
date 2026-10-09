import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-sql";

// yodel lint reads only migrations/; the lint e2e test points the e2e
// profile at the emulator (database yodel_14) for --env and apply.
export default {
  lexicons: ["sql"],
  sql: {
    dialect: "clickhouse",
    profiles: {
      e2e: { url: process.env.YODEL_E2E_CLICKHOUSE_URL ?? "http://localhost:8123", databases: ["yodel_14"] },
    },
  },
} satisfies ChantConfig;
