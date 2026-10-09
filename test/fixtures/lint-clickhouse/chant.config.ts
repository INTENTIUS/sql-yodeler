import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-sql";

// yodel lint reads only migrations/; the lint e2e test points the e2e
// profile at the emulator (database yodel_e2e_fixture) for --env and apply.
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
