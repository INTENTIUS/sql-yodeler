import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-sql";

// The Postgres versioned e2e tests (#13) point YODEL_E2E_POSTGRES_URL at the
// emulator (`chant emulator up --lexicon sql`). The migrations' objects live
// in schema yodel_e2e_fixture, the history in yodel_e2e_fixture_history (YODEL_HISTORY_DATABASE).
// A short lock timeout, so a statement blocked behind another session's lock
// gives up and is retried within the test's time.
// yodel_e2e_fixture stands for the suite's own name (test/e2e/names.ts), put in
// its place when the suite copies this fixture.
export default {
  lexicons: ["sql"],
  sql: {
    dialect: "postgres",
    profiles: {
      e2e: {
        url: process.env.YODEL_E2E_POSTGRES_URL ?? "postgres://localhost:5432/postgres",
        user: { env: "YODEL_E2E_POSTGRES_USER" },
        password: { env: "YODEL_E2E_POSTGRES_PASSWORD" },
        schemas: ["yodel_e2e_fixture"],
        lockTimeoutMs: 500,
      },
    },
  },
} satisfies ChantConfig;
