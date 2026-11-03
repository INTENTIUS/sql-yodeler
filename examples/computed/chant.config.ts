import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-sql";

// A schema computed from a list and a build parameter (docs/schema.md,
// "Computing the schema"). The build needs no server.
export default {
  lexicons: ["sql"],
  sourceDir: "src",
  // tier sets the orders table's fillfactor: chant build --param tier=large.
  buildParams: { tier: { type: "string", default: "small", enum: ["small", "large"] } },
  sql: { dialect: "postgres" },
} satisfies ChantConfig;
