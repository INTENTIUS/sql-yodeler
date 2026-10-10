import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-sql";
import { credentials } from "@intentius/sql-yodeler";

/**
 * Two sets of credentials per environment, from credentials(), chosen by
 * YODEL_CREDENTIALS:
 *
 * - reader (the default): a role that can only read (USAGE and SELECT on the
 *   schema and the history schema, `default_transaction_read_only = on`).
 *   Pull request jobs, the drift watch and anyone on their laptop use it.
 * - writer: YODEL_CREDENTIALS=writer:<env> for that environment alone (or
 *   =writer for every one). Only an environment's wave job after a merge
 *   sets it, and only that job holds that environment's writer secrets; it
 *   reads the environment before it (waves[].requires) with the reader.
 *
 * Credentials are named by environment variable, never written here:
 * <ENV>_POSTGRES_URL, <ENV>_POSTGRES_READER_USER,
 * <ENV>_POSTGRES_READER_PASSWORD, <ENV>_POSTGRES_WRITER_USER and
 * <ENV>_POSTGRES_WRITER_PASSWORD. The URL names the database:
 * postgres://db.example.com:5432/app. yodel refuses an environment whose
 * reader and writer are the same user, and every pull request job tries a
 * write first and fails if the server lets it through.
 *
 * A password can be a short-lived token in place of a variable, minted when
 * a connection needs it:
 * credentials("prod", "postgres", { writer: { password: { token: "rds-iam" } } }).
 * `npm run ci` then renders the jobs' cloud identity; see Configuration in
 * the SQL Yodeler docs.
 */
function postgres(env: string, url: string) {
  return {
    url: process.env[`${env.toUpperCase()}_POSTGRES_URL`] ?? url,
    ...credentials(env, "postgres"),
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
      // Not an environment: the throwaway server for `yodel lint --replay
      // replay --reset`, which drops and replays {{chant:schema}} there. The
      // pull request's lint job starts one as a service; on your machine
      // `npm run replay` starts one with Docker and sets REPLAY_POSTGRES_URL.
      // Never dev's server (the emulator on 5432): it holds {{chant:schema}}
      // too, and --reset would drop it. Without REPLAY_POSTGRES_URL it names no server.
      replay: {
        url: process.env.REPLAY_POSTGRES_URL ?? "postgres://replay.invalid:5432/postgres",
        user: { env: "REPLAY_POSTGRES_USER" },
        password: { env: "REPLAY_POSTGRES_PASSWORD" },
        schemas: ["{{chant:schema}}"],
      },
    },
  },
} satisfies ChantConfig;
