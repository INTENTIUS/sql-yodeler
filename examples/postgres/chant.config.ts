import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-sql";

// One environment, dev, on the server DEV_POSTGRES_URL names (the emulator:
// `chant emulator up --lexicon sql`), with the user and password from
// DEV_POSTGRES_USER and DEV_POSTGRES_PASSWORD. The declared objects live in
// schema shop; yodel's history in schema yodeler
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
        schemas: ["shop"],
      },
      // Not an environment: the throwaway server `yodel lint --replay replay --reset`
      // replays the migrations into. It drops schema shop there first.
      replay: {
        url: process.env.REPLAY_POSTGRES_URL ?? "postgres://127.0.0.1:5432/postgres",
        user: { env: "REPLAY_POSTGRES_USER" },
        password: { env: "REPLAY_POSTGRES_PASSWORD" },
        schemas: ["shop"],
      },
    },
  },
} satisfies ChantConfig;
