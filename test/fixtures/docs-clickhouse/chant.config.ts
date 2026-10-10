import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-sql";

// test/schema-docs.test.ts builds this for `yodel docs`; no server is read.
export default {
  lexicons: ["sql"],
  sql: { dialect: "clickhouse", profiles: { dev: { url: "http://localhost:8123", databases: ["shop"] } } },
} satisfies ChantConfig;
