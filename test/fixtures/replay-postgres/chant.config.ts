import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-sql";

// The replay e2e tests (#11) point YODEL_E2E_POSTGRES_URL at the emulator
// (`chant emulator up --lexicon sql`). The history's objects live in schema
// yodel_e2e_fixture_pg; the replay drops and recreates it.
// yodel_e2e_fixture stands for the suite's own name (test/e2e/names.ts), put in
// its place when the suite copies this fixture.
export default {
  lexicons: ["sql"],
  sql: {
    dialect: "postgres",
    profiles: {
      emulator: {
        url: process.env.YODEL_E2E_POSTGRES_URL ?? "postgres://localhost:5432/postgres",
        user: { env: "YODEL_E2E_POSTGRES_USER" },
        password: { env: "YODEL_E2E_POSTGRES_PASSWORD" },
        schemas: ["yodel_e2e_fixture_pg"],
        defaultSchema: "yodel_e2e_fixture_pg",
      },
    },
  },
} satisfies ChantConfig;
