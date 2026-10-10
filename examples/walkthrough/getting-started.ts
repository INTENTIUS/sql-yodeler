import type { Walkthrough } from "./run.js";

/**
 * docs/getting-started.md: a project made from templates/clickhouse, taken to
 * a first applied migration and a second one on a local ClickHouse. It writes no README and keeps nothing; `run.ts getting-started
 * --write` refreshes the page's quotes from it.
 *
 * It drops and creates databases `events` and `yodeler`, so point it at a
 * throwaway ClickHouse of your own, never a shared one:
 *
 *   docker run -d --name yodel-docs-clickhouse -e CLICKHOUSE_SKIP_USER_SETUP=1 -p 127.0.0.1:18123:8123 clickhouse/clickhouse-server:<the emulator's tag>
 *   YODEL_GETTING_STARTED_CLICKHOUSE_URL=http://127.0.0.1:18123 npx tsx examples/walkthrough/run.ts getting-started --write
 *
 * The page shows the server as http://127.0.0.1:8123, where the reader's
 * emulator is.
 */

const url = () => process.env.YODEL_GETTING_STARTED_CLICKHOUSE_URL ?? "";

async function sql(text: string): Promise<string> {
  const res = await fetch(`${url().replace(/\/+$/, "")}/`, { method: "POST", body: text });
  const body = await res.text();
  if (!res.ok) throw new Error(`ClickHouse: ${body}`);
  return body;
}

const dir = "my-schema";

export const walkthrough: Walkthrough = {
  dialect: "clickhouse",
  readme: false,
  intro: "",
  start: [],
  keep: [],
  env: () => ({
    DEV_CLICKHOUSE_URL: url(),
    DEV_CLICKHOUSE_READER_USER: "default",
    DEV_CLICKHOUSE_READER_PASSWORD: "",
    GIT_AUTHOR_NAME: "example",
    GIT_AUTHOR_EMAIL: "example@example.invalid",
    GIT_COMMITTER_NAME: "example",
    GIT_COMMITTER_EMAIL: "example@example.invalid",
  }),
  shown: () => [
    [url().replace(/\/+$/, ""), "http://127.0.0.1:8123"],
    ["<tmp>/clickhouse/my-schema", "<my-schema>"],
  ],
  sql,
  reset: async () => {
    if (!url()) throw new Error("set YODEL_GETTING_STARTED_CLICKHOUSE_URL to a throwaway ClickHouse");
    await sql("DROP DATABASE IF EXISTS events SYNC");
    await sql("DROP DATABASE IF EXISTS yodeler SYNC");
  },
  steps: [
    {
      run: "npx chant init --from {clone}/templates/clickhouse --param name=events-schema --param database=events my-schema",
      code: 0,
      expect: ["Created:"],
      hide: true,
    },
    // In place of npm install: the clone's node_modules, with this repo as @intentius/sql-yodeler.
    { run: "ln -s ../node_modules my-schema/node_modules", code: 0, hide: true },
    { run: "git init -q -b main && git add -A && git commit -q -m 'chore: a new yodel project'", cwd: dir, code: 0, hide: true },
    { run: "npx yodel new init", cwd: dir, code: 0, expect: ["the first migration"], quote: "getting-started.md" },
    { run: "npx yodel lint", cwd: dir, code: 0, expect: ["0 errors"], quote: "getting-started.md" },
    { run: "git add -A && git commit -q -m 'feat: the first migration'", cwd: dir, code: 0, hide: true },
    { run: "npx yodel plan dev", cwd: dir, code: 0, expect: ["1 pending"], quote: "getting-started.md" },
    { say: "" },
    { run: "npx yodel apply dev", cwd: dir, code: 3, expect: ["is waiting at gate"], quote: "getting-started.md" },
    { say: "" },
    {
      run: 'npx chant approve migrate-dev approve-migrate-dev --plan "$(npx yodel apply dev --digest)"',
      cwd: dir,
      code: 0,
      quote: "getting-started.md",
    },
    { run: "npx yodel apply dev", cwd: dir, code: 0, expect: ["Applied: "], quote: "getting-started.md" },
    { run: "npx yodel status dev", cwd: dir, code: 0, quote: "getting-started.md" },
    { say: "" },
    {
      edit: `${dir}/src/schema.ts`,
      from: "    at       DateTime\n",
      to: "    at       DateTime,\n    country  LowCardinality(String) DEFAULT ''\n",
    },
    { run: "npx yodel new add-country", cwd: dir, code: 0, quote: "getting-started.md" },
    { run: "npx yodel lint", cwd: dir, code: 0, expect: ["0 errors"], quote: "getting-started.md" },
    { run: "git add -A && git commit -q -m 'feat: events.country'", cwd: dir, code: 0, hide: true },
    { run: "npx yodel plan dev", cwd: dir, code: 0, expect: ["1 pending"], quote: "getting-started.md" },
    { say: "" },
    {
      run: 'npx chant approve migrate-dev approve-migrate-dev --plan "$(npx yodel apply dev --digest)"',
      cwd: dir,
      code: 0,
      quote: "getting-started.md",
    },
    { run: "npx yodel apply dev", cwd: dir, code: 0, expect: ["Applied: "], quote: "getting-started.md" },
  ],
};
