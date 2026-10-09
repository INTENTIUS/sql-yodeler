import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-sql";

// The Op-step e2e tests (#12: a rebuild and a backfill inside a migration)
// point YODEL_E2E_CLICKHOUSE_URL at the emulator (`chant emulator up
// --lexicon sql`). The objects live in database yodel_12, the history in
// yodel_12_history (YODEL_HISTORY_DATABASE).
export default {
  lexicons: ["sql"],
  sql: {
    dialect: "clickhouse",
    profiles: {
      e2e: { url: process.env.YODEL_E2E_CLICKHOUSE_URL ?? "http://localhost:8123", databases: ["yodel_12"] },
    },
  },
} satisfies ChantConfig;
