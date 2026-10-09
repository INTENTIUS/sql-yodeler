import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-sql";

// The Postgres versioned e2e tests (#13) point YODEL_E2E_POSTGRES_URL at the
// emulator (`chant emulator up --lexicon sql`). The migrations' objects live
// in schema yodel_13, the history in yodel_13_history (YODEL_HISTORY_DATABASE).
// A short lock timeout, so a statement blocked behind another session's lock
// gives up and is retried within the test's time.
export default {
  lexicons: ["sql"],
  sql: {
    dialect: "postgres",
    profiles: {
      e2e: {
        url: process.env.YODEL_E2E_POSTGRES_URL ?? "postgres://localhost:5432/postgres",
        user: { env: "YODEL_E2E_POSTGRES_USER" },
        password: { env: "YODEL_E2E_POSTGRES_PASSWORD" },
        schemas: ["yodel_13"],
        lockTimeoutMs: 500,
      },
    },
  },
} satisfies ChantConfig;
