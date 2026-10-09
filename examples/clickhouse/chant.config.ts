import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-sql";

// One environment, dev, on the server DEV_CLICKHOUSE_URL names (the emulator:
// `chant emulator up --lexicon sql`). The declared objects live in database
// yodel_18_shop; yodel's history in yodel_18_history (yodel.config.ts).
export default {
  lexicons: ["sql"],
  sourceDir: "src",
  sql: {
    dialect: "clickhouse",
    profiles: {
      dev: { url: process.env.DEV_CLICKHOUSE_URL ?? "http://127.0.0.1:8123", databases: ["yodel_18_shop"] },
      // Not an environment: the throwaway server `yodel lint --replay replay --reset`
      // replays the migrations into. It drops yodel_18_shop there first.
      replay: { url: process.env.REPLAY_CLICKHOUSE_URL ?? "http://127.0.0.1:8123", databases: ["yodel_18_shop"] },
    },
  },
} satisfies ChantConfig;
