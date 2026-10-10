import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-sql";

// One environment, dev, on the server DEV_CLICKHOUSE_URL names (the emulator:
// `chant emulator up --lexicon sql`). The declared objects live in database
// shop; yodel's history in yodeler (yodel.config.ts).
export default {
  lexicons: ["sql"],
  sourceDir: "src",
  sql: {
    dialect: "clickhouse",
    profiles: {
      dev: { url: process.env.DEV_CLICKHOUSE_URL ?? "http://127.0.0.1:8123", databases: ["shop"] },
      // Not an environment: the throwaway server `yodel lint --replay replay --reset`
      // replays the migrations into. It drops shop there first.
      replay: { url: process.env.REPLAY_CLICKHOUSE_URL ?? "http://127.0.0.1:8123", databases: ["shop"] },
    },
  },
} satisfies ChantConfig;
