import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-sql";

/**
 * Two sets of credentials per environment, chosen by YODEL_CREDENTIALS:
 *
 * - reader (the default): a role that can only read (USAGE and SELECT on the
 *   schema and the history schema, `default_transaction_read_only = on`).
 *   Pull request jobs, the drift watch and anyone on their laptop use it.
 * - writer: YODEL_CREDENTIALS=writer. Only the apply job after a merge sets
 *   it, and only that job holds the writer's secrets.
 *
 * Credentials are named by environment variable, never written here:
 * <ENV>_POSTGRES_URL, <ENV>_POSTGRES_READER_USER,
 * <ENV>_POSTGRES_READER_PASSWORD, <ENV>_POSTGRES_WRITER_USER and
 * <ENV>_POSTGRES_WRITER_PASSWORD. The URL names the database:
 * postgres://db.example.com:5432/app.
 */
const role = process.env.YODEL_CREDENTIALS === "writer" ? "WRITER" : "READER";

function postgres(env: string, url: string) {
  const prefix = env.toUpperCase();
  return {
    url: process.env[`${prefix}_POSTGRES_URL`] ?? url,
    user: { env: `${prefix}_POSTGRES_${role}_USER` },
    password: { env: `${prefix}_POSTGRES_${role}_PASSWORD` },
    schemas: ["{{chant:schema}}"],
  };
}

export default {
  lexicons: ["sql"],
  // The declared schema. chant builds only this directory, not ops/ or scripts/.
  sourceDir: "src",
  sql: {
    dialect: "postgres",
    // One profile per environment, in the order a merge applies them. Adding
    // one: a profile here, its entry in yodel.config.ts, ops/migrate-<env>.op.ts
    // and ops/watch-<env>.op.ts, then `npm run ci` to render the pipelines again.
    profiles: {
      dev: postgres("dev", "postgres://127.0.0.1:5432/postgres"),
      prod: postgres("prod", "postgres://db.example.com:5432/app"),
      // Not an environment: the throwaway server the pull request's lint job
      // starts for `yodel lint --replay replay --reset`, which drops and
      // replays {{chant:schema}} there. Never point it at a server whose data
      // matters. Locally: `chant emulator up --lexicon sql`.
      replay: {
        url: process.env.REPLAY_POSTGRES_URL ?? "postgres://127.0.0.1:5432/postgres",
        user: { env: "REPLAY_POSTGRES_USER" },
        password: { env: "REPLAY_POSTGRES_PASSWORD" },
        schemas: ["{{chant:schema}}"],
      },
    },
  },
} satisfies ChantConfig;
