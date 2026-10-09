import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-sql";

// The init e2e tests point YODEL_E2E_POSTGRES_URL at the emulator
// (`chant emulator up --lexicon sql`); the adopted objects live in schema
// yodel_13 (history in yodel_13_history). No src/: yodel init --from e2e writes it.
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
      },
    },
  },
} satisfies ChantConfig;
