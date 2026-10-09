import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-sql";

// The Op-step e2e tests (#12: a rebuild and a backfill inside a migration)
// point YODEL_E2E_CLICKHOUSE_URL at the emulator (`chant emulator up
// --lexicon sql`). The objects live in database yodel_e2e_fixture, the history in
// yodel_e2e_fixture_history (YODEL_HISTORY_DATABASE).
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
