import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-sql";

// yodel lint reads only migrations/; the lint e2e test points the e2e
// profile at the emulator (schema yodel_e2e_fixture) for --env and apply.
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
      },
    },
  },
} satisfies ChantConfig;
