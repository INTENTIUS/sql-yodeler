import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-sql";

// test/schema-docs.test.ts builds this for `yodel docs`; no server is read.
export default {
  lexicons: ["sql"],
  sql: { dialect: "postgres", profiles: { dev: { url: "postgres://localhost:5432/postgres", schemas: ["shop"] } } },
} satisfies ChantConfig;
