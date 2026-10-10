import type { Walkthrough } from "./run.js";

/**
 * A project made from templates/clickhouse, as docs/adoption.md shows it:
 * `chant init --from`, then the first migration. It needs no server, writes
 * no README and keeps nothing; `run.ts template --write` refreshes the
 * adoption.md quotes from it. The project gets the clone's node_modules
 * linked in, in place of `npm install`.
 */
export const walkthrough: Walkthrough = {
  dialect: "clickhouse",
  readme: false,
  intro: "",
  start: [],
  keep: [],
  env: () => ({}),
  sql: () => Promise.reject(new Error("the template walkthrough runs no SQL")),
  reset: () => Promise.resolve(),
  steps: [
    {
      run: "npx chant init --from {clone}/templates/clickhouse --param name=events-schema --param database=yodel_18_tpl --param history_database=yodel_18_tpl_history my-schema",
      code: 0,
      expect: ["Created:"],
      quote: "adoption.md",
    },
    { run: "ln -s ../node_modules my-schema/node_modules", code: 0, hide: true },
    { run: "npx yodel new init", cwd: "my-schema", code: 0, expect: ["the first migration"], quote: "adoption.md" },
    { run: "npx yodel lint", cwd: "my-schema", code: 0, expect: ["0 errors"], quote: "adoption.md" },
  ],
};
