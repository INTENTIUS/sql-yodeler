import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-sql";

// The rebase-silences test (#40) points YODEL_E2E_CLICKHOUSE_URL at the
// emulator (`chant emulator up --lexicon sql`). The migrations' objects and
// the history live in database yodel_e2e_fixture, which stands for the suite's
// own name (test/e2e/names.ts), put in its place when the suite copies this.
export default {
  lexicons: ["sql"],
  sql: {
    dialect: "clickhouse",
    profiles: {
      e2e: { url: process.env.YODEL_E2E_CLICKHOUSE_URL ?? "http://localhost:8123", databases: ["yodel_e2e_fixture"] },
    },
  },
} satisfies ChantConfig;
