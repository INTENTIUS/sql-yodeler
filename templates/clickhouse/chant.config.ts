import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-sql";

/**
 * Two sets of credentials per environment, chosen by YODEL_CREDENTIALS:
 *
 * - reader (the default): a user that can only read (ClickHouse
 *   `readonly = 1`, SELECT and SHOW on the schema's database and the history
 *   database). Pull request jobs, the drift watch and anyone on their laptop
 *   use it.
 * - writer: YODEL_CREDENTIALS=writer. Only the apply job after a merge sets
 *   it, and only that job holds the writer's secrets.
 *
 * Credentials are named by environment variable, never written here:
 * <ENV>_CLICKHOUSE_URL, <ENV>_CLICKHOUSE_READER_USER,
 * <ENV>_CLICKHOUSE_READER_PASSWORD, <ENV>_CLICKHOUSE_WRITER_USER and
 * <ENV>_CLICKHOUSE_WRITER_PASSWORD.
 */
const role = process.env.YODEL_CREDENTIALS === "writer" ? "WRITER" : "READER";

function clickhouse(env: string, url: string) {
  const prefix = env.toUpperCase();
  return {
    url: process.env[`${prefix}_CLICKHOUSE_URL`] ?? url,
    user: { env: `${prefix}_CLICKHOUSE_${role}_USER` },
    password: { env: `${prefix}_CLICKHOUSE_${role}_PASSWORD` },
    databases: ["{{chant:database}}"],
  };
}

export default {
  lexicons: ["sql"],
  // The declared schema. chant builds only this directory, not ops/ or scripts/.
  sourceDir: "src",
  sql: {
    dialect: "clickhouse",
    // One profile per environment, in the order a merge applies them. Adding
    // one: a profile here, its entry in yodel.config.ts (topology, history),
    // ops/migrate-<env>.op.ts and ops/watch-<env>.op.ts, then `npm run ci` to
    // render the pipelines again.
    profiles: {
      dev: clickhouse("dev", "http://127.0.0.1:8123"),
      prod: clickhouse("prod", "https://clickhouse.example.com:8443"),
      // Not an environment: the throwaway server for `yodel lint --replay
      // replay --reset`, which drops and replays {{chant:database}} there. The
      // pull request's lint job starts one as a service; on your machine
      // `npm run replay` starts one with Docker and sets REPLAY_CLICKHOUSE_URL.
      // Never dev's server (the emulator on 8123): it holds {{chant:database}}
      // too, and --reset would drop it. Without REPLAY_CLICKHOUSE_URL it names no server.
      replay: { url: process.env.REPLAY_CLICKHOUSE_URL ?? "http://replay.invalid:8123", databases: ["{{chant:database}}"] },
    },
  },
} satisfies ChantConfig;
