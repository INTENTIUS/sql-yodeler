import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-sql";

// The e2e tests point YODEL_E2E_POSTGRES_URL at the emulator
// (`chant emulator up --lexicon sql`); everything lives in schema yodel_6.
export default {
  lexicons: ["sql"],
  sql: {
    dialect: "postgres",
    profiles: {
      e2e: {
        url: process.env.YODEL_E2E_POSTGRES_URL ?? "postgres://localhost:5432/postgres",
        user: { env: "YODEL_E2E_POSTGRES_USER" },
        password: { env: "YODEL_E2E_POSTGRES_PASSWORD" },
        schemas: ["yodel_6"],
      },
    },
  },
} satisfies ChantConfig;
