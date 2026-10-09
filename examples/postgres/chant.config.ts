import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-sql";

// One environment, dev, on the server DEV_POSTGRES_URL names (the emulator:
// `chant emulator up --lexicon sql`), with the user and password from
// DEV_POSTGRES_USER and DEV_POSTGRES_PASSWORD. The declared objects live in
// schema yodel_18_shop; yodel's history in schema yodel_18_history
// (yodel.config.ts).
export default {
  lexicons: ["sql"],
  sourceDir: "src",
  sql: {
    dialect: "postgres",
    profiles: {
      dev: {
        url: process.env.DEV_POSTGRES_URL ?? "postgres://127.0.0.1:5432/postgres",
        user: { env: "DEV_POSTGRES_USER" },
        password: { env: "DEV_POSTGRES_PASSWORD" },
        schemas: ["yodel_18_shop"],
      },
      // Not an environment: the throwaway server `yodel lint --replay replay --reset`
      // replays the migrations into. It drops schema yodel_18_shop there first.
      replay: {
        url: process.env.REPLAY_POSTGRES_URL ?? "postgres://127.0.0.1:5432/postgres",
        user: { env: "REPLAY_POSTGRES_USER" },
        password: { env: "REPLAY_POSTGRES_PASSWORD" },
        schemas: ["yodel_18_shop"],
      },
    },
  },
} satisfies ChantConfig;
