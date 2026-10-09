import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-sql";

// yodel lint reads only migrations/; the lint e2e test points the e2e
// profile at the emulator (schema yodel_14) for --env and apply.
export default {
  lexicons: ["sql"],
  sql: {
    dialect: "postgres",
    profiles: {
      e2e: {
        url: process.env.YODEL_E2E_POSTGRES_URL ?? "postgres://localhost:5432/postgres",
        user: { env: "YODEL_E2E_POSTGRES_USER" },
        password: { env: "YODEL_E2E_POSTGRES_PASSWORD" },
        schemas: ["yodel_14"],
      },
    },
  },
} satisfies ChantConfig;
