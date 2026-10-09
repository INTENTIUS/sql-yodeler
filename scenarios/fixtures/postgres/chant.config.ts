import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-sql";

// A scenario claim's scratch project (scenarios/lib/project.ts). The copy
// renames the profile CLAIMENV to the claim's name and the schema
// yodel_34_claim to the claim's own, yodel_34_<claim>.
export default {
  lexicons: ["sql"],
  sql: {
    dialect: "postgres",
    profiles: {
      "CLAIMENV": {
        url: process.env.YODEL_CLAIMS_POSTGRES_URL ?? "postgres://localhost:5432/postgres",
        user: { env: "YODEL_CLAIMS_POSTGRES_USER" },
        password: { env: "YODEL_CLAIMS_POSTGRES_PASSWORD" },
        schemas: ["yodel_34_claim"],
        // Short, so a statement blocked behind another session's lock gives up and is retried within a claim's time.
        lockTimeoutMs: 500,
      },
    },
  },
} satisfies ChantConfig;
