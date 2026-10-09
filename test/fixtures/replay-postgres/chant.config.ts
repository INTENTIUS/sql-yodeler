import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-sql";

// The replay e2e tests (#11) point YODEL_E2E_POSTGRES_URL at the emulator
// (`chant emulator up --lexicon sql`). The history's objects live in schema
// yodel_11_pg; the replay drops and recreates it.
export default {
  lexicons: ["sql"],
  sql: {
    dialect: "postgres",
    profiles: {
      emulator: {
        url: process.env.YODEL_E2E_POSTGRES_URL ?? "postgres://localhost:5432/postgres",
        user: { env: "YODEL_E2E_POSTGRES_USER" },
        password: { env: "YODEL_E2E_POSTGRES_PASSWORD" },
        schemas: ["yodel_11_pg"],
        defaultSchema: "yodel_11_pg",
      },
    },
  },
} satisfies ChantConfig;
