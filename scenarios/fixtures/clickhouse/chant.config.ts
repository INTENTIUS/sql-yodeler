import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-sql";

// A scenario claim's scratch project (scenarios/lib/project.ts). The copy
// renames the profile CLAIMENV to the claim's name and the database
// yodel_34_claim to the claim's own, yodel_34_<claim>.
export default {
  lexicons: ["sql"],
  sql: {
    dialect: "clickhouse",
    profiles: {
      "CLAIMENV": { url: process.env.YODEL_CLAIMS_CLICKHOUSE_URL ?? "http://localhost:8123", databases: ["yodel_34_claim"] },
    },
  },
} satisfies ChantConfig;
