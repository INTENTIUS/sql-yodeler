import type { Walkthrough } from "./run.js";

const url = () => process.env.YODEL_E2E_CLICKHOUSE_URL ?? "";

async function sql(text: string): Promise<string> {
  const res = await fetch(`${url().replace(/\/+$/, "")}/`, { method: "POST", body: text });
  const body = await res.text();
  if (!res.ok) throw new Error(`ClickHouse: ${body}`);
  return body;
}

const SCHEMA = `import { database, table } from "@intentius/chant-lexicon-sql/clickhouse";

export const shop = database\`
  CREATE DATABASE shop
  ENGINE = Atomic
  COMMENT 'The SQL Yodeler ClickHouse example'\`;

export const events = table\`
  CREATE TABLE \${shop}.events (
    id   UInt64,
    kind LowCardinality(String),
    at   DateTime
  )
  ENGINE = MergeTree
  PARTITION BY toYYYYMM(at)
  ORDER BY (kind, at)\`;
`;

const APPLY_OP = `import { ApplyOp } from "@intentius/chant/op";

// The declarative path: yodel apply dev plans src/ against dev and runs this
// Op, behind a gate bound to the plan.
export const { op } = ApplyOp({ name: "apply-dev", env: "dev", target: "clickhouse", gate: {} });
`;

export const walkthrough: Walkthrough = {
  dialect: "clickhouse",
  intro: `
# ClickHouse example

A ClickHouse database taken from the declarative path to versioned migrations: adoption with \`yodel init --from\`, a migration, a sort-key change run as a rebuild step, a backfill step, a lint silence, an approval that stops holding, drift, and the replay check. Every command below ran against the emulator (\`chant emulator up --lexicon sql\`), and the output under each is what it printed. \`examples/walkthrough/clickhouse.ts\` holds the steps; \`npx tsx examples/walkthrough/run.ts clickhouse --write\` runs them again and rewrites this file and the project files from the run.

The project in this directory is what the walkthrough leaves: \`src/schema.ts\`, the migrations it wrote, and the two Ops. It is a finished run, with every migration already written, so running it again does not retrace the steps. To go step by step from an empty directory, start with [Your first migration](../../docs/getting-started.md).

To run it yourself, from a clone of this repository:

\`\`\`sh
npm ci && npm run build          # in the repository root
npx chant emulator up --lexicon sql  # or any ClickHouse you can drop shop on
cd examples/clickhouse
npm install                      # @intentius/sql-yodeler from file:../.., this clone
export DEV_CLICKHOUSE_URL=http://127.0.0.1:8123
\`\`\`

The example's \`package.json\` takes \`@intentius/sql-yodeler\` from \`file:../..\`, the clone it sits in, so it runs the yodel you just built rather than the release on npm. A project of your own installs it from npm instead (\`npm install @intentius/sql-yodeler\`; [Installing](../../docs/configuration.md#installing) has the other routes).

The run happened in a temporary copy of this directory, a git repository with a local \`origin\`; its path is shown as \`<tmp>\`. A command that exited with a code other than 0 ends with \`[exit <code>]\`.
`,
  start: ["package.json", "chant.config.ts", "yodel.config.ts", "tsconfig.json", ".gitignore", "ops/watch-dev.op.ts"],
  keep: ["src", "migrations", "ops", "backfills"],
  env: () => ({ DEV_CLICKHOUSE_URL: url(), REPLAY_CLICKHOUSE_URL: url() }),
  // The server as a reader's emulator is: what the transcripts show does not depend on where the run was.
  shown: () => [
    [url().replace(/\/+$/, ""), "http://127.0.0.1:8123"],
    [new URL(url()).host, "127.0.0.1:8123"],
  ],
  sql,
  reset: async (rename = (text: string) => text) => {
    await sql(rename("DROP DATABASE IF EXISTS shop SYNC"));
    await sql(rename("DROP DATABASE IF EXISTS yodeler SYNC"));
    // The rebuild's and the backfill's receipts from an earlier run (the rebuild's are keyed by the table).
    if ((await sql("EXISTS TABLE chant_receipts.receipts")).trim() === "1") {
      await sql(
        rename(
          "ALTER TABLE chant_receipts.receipts DELETE WHERE startsWith(address, '-/-/rebuild/shop.') OR match(address, '^yodel/dev/[0-9]{8}T[0-9]{4}-(events-by-id|fill-country)/') SETTINGS mutations_sync = 2",
        ),
      );
    }
  },
  steps: [
    { say: "## 1. A declared schema, applied without migrations" },
    {
      say: "The project starts on the declarative path: `src/schema.ts` says what the database should be, and an `ApplyOp` applies it. There is no `migrations/` directory, so `yodel plan` and `yodel apply` diff the declared schema against the live database. `package.json` has a `build` script (`chant build src --lexicon sql -o dist/schema.json`), which the `ApplyOp` runs first.",
    },
    { file: "src/schema.ts", content: SCHEMA },
    { file: "ops/apply-dev.op.ts", content: APPLY_OP, quote: "workflows.md#apply-op" },
    { run: "git add -A && git commit -q -m 'feat: the declared schema' && git push -q origin main", code: 0, hide: true },
    { run: "npx yodel plan dev", code: 0, expect: ["2 create"] },
    { say: "`yodel apply dev` runs the `ApplyOp`. It stops at the gate, which wants an approval of this exact plan, and exits 3:" },
    { run: "npx yodel apply dev", code: 3, expect: ["is waiting at gate"], quote: "workflows.md#declarative-apply" },
    { say: "The approval is a commit on the `chant/lifecycle` branch. Approve, then run the apply again:" },
    { run: "{approve}", code: 0, quote: "workflows.md#declarative-approve" },
    { run: "npx yodel apply dev", code: 0, expect: ["Applied: dev matches the declared schema."] },
    { run: "npx yodel plan dev", code: 0, expect: ["No changes."] },

    { say: "## 2. Adopting the database into versioned migrations" },
    { say: "Some data arrives, six months of it, the last weeks dated in the future (scheduled events):" },
    { sql: "INSERT INTO shop.events\nSELECT number, ['view', 'cart', 'buy'][number % 3 + 1], toDateTime('2026-06-01 00:00:00') + toIntervalHour(number * 7)\nFROM numbers(600)" },
    { sql: "SELECT count() AS rows, countIf(at >= now()) AS future FROM shop.events FORMAT TSVWithNames", showResult: true },
    {
      say: "To move to versioned migrations, `yodel init --from dev` reads the live database, writes its declarations to `src/`, checks that they plan clean against it, writes the baseline migration (the one that creates everything), and records the baseline applied in dev's history without running it. `src/schema.ts` already declares the schema, so it needs `--force` to write over it:",
    },
    { run: "npx yodel init --from dev --force", code: 0, expect: ["Adopted dev (clickhouse): 2 objects"], quote: "adoption.md#adopt" },
    { cat: "src/schema.ts", quote: "adoption.md#adopt-schema" },
    { run: "npx yodel status dev", code: 0, expect: ["-baseline"], quote: "adoption.md#adopt-status" },
    {
      say: "From here `yodel apply dev` takes the versioned path, which runs a migrations Op: a Plan step that prints the plan digest, a gate bound to it, and an Apply step. The `ApplyOp` goes, and `ops/migrate-dev.op.ts` comes in:",
    },
    { run: "git rm -q ops/apply-dev.op.ts", code: 0 },
    { file: "ops/migrate-dev.op.ts", quote: "approval.md#migrations-op" },
    { run: "git add -A && git commit -q -m 'feat: adopt dev into versioned migrations' && git push -q origin main", code: 0, hide: true },

    { say: "## 3. A migration" },
    { say: "Add a column to the declared schema:" },
    { edit: "src/schema.ts", from: "      at DateTime\n", to: "      at DateTime,\n      country LowCardinality(String) DEFAULT ''\n" },
    { say: "`yodel new` diffs the declared schema against the schema the newest migration recorded. It reads no database." },
    { run: "npx yodel new add-country", code: 0, expect: ["1 statement"] },
    { cat: "migrations/{id:add-country}/migration.sql", quote: "migrations.md#add-country-sql" },
    { run: "npx yodel lint", code: 0, expect: ["0 errors"] },
    { run: "npx yodel plan dev", code: 0, expect: ["Not approved yet."], quote: "approval.md#plan" },
    { run: "git add -A && git commit -q -m 'feat: events.country' && git push -q origin main", code: 0, hide: true },
    { run: "npx yodel apply dev", code: 3, expect: ["is waiting at gate"] },
    { run: "{approve}", code: 0, quote: "approval.md#approve" },
    {
      say: "The emulator has no Keeper, so the apply lock is a file on this machine, and the run says so. On a server with Keeper and `keeper_map_path_prefix` the lock is a row in a KeeperMap table, shared by every runner.",
    },
    { run: "npx yodel apply dev", code: 0, expect: ["Applied: "], quote: [{ at: "approval.md#apply", excerpt: { from: "Running migrate-dev", to: ": applied" } }, "migrations.md#apply"] },
    { run: "npx yodel status dev", code: 0, quote: { at: "topology.md#status", excerpt: { to: "Migrations in dev" } } },

    { say: "## 4. A sort-key change: a rebuild step" },
    { say: "ClickHouse cannot change a table's sort key with `ALTER`. Change it in the declared schema:" },
    { edit: "src/schema.ts", from: "ORDER BY (kind, at)", to: "ORDER BY (kind, id)" },
    {
      say: "`yodel new` writes the change as a `ClickHouseRebuildOp` step: a new table with the new key, a materialized view that writes rows at or after a cut-over time into it, a backfill of every row already in the table, partition by partition (a receipt per partition), a verification of every row, and a swap. Rows dated at or after the cut-over, like the future ones here, are copied too.",
    },
    { run: "npx yodel new events-by-id", code: 0, expect: ["ClickHouseRebuildOp"], quote: "steps.md#rebuild-new" },
    { cat: "migrations/{id:events-by-id}/migration.sql" },
    { say: "`yodel lint` flags a rebuild as an error (`ch-rebuild`):" },
    { run: "npx yodel lint", code: 3, expect: ["ch-rebuild"] },
    { say: "The table is small, so the rebuild is fine. Silence the rule for this step with a reason, on the line above it in `migration.sql`:" },
    {
      edit: "migrations/{id:events-by-id}/migration.sql",
      from: "-- events (shop.events): SQLCH220",
      to: "-- yodel:allow ch-rebuild 600 rows; the copy takes seconds\n-- events (shop.events): SQLCH220",
      quote: "steps.md#rebuild-sql",
    },
    { say: "The edit changes the migration's checksum, which lint reports, and the migration has not been applied anywhere, so record the new one:" },
    { run: "npx yodel lint", code: 3, expect: ["checksum"], quote: "lint.md#checksum" },
    { run: "npx yodel lint --update-checksum {id:events-by-id}", code: 0, expect: ["1 silenced"] },
    { run: "git add -A && git commit -q -m 'feat: events sorted by id' && git push -q origin main", code: 0, hide: true },
    { say: "The pull request comment (`yodel plan dev --comment` in CI) is this Markdown:" },
    { run: "npx yodel plan dev --format markdown", code: 0, expect: ["ClickHouseRebuildOp"], quote: "approval.md#comment" },
    { run: "npx yodel apply dev", code: 3, expect: ["is waiting at gate"] },
    { run: "{approve}", code: 0 },
    { say: "The rebuild waits a minute for its cut-over before the backfill:" },
    { run: "npx yodel apply dev", code: 0, expect: ['"swapped":true'], quote: { at: "steps.md#rebuild-apply", excerpt: { from: "Running migrate-dev", to: ": applied" } } },
    { sql: "SELECT sorting_key, total_rows FROM system.tables WHERE database = 'shop' AND name LIKE 'events%' ORDER BY name FORMAT TSVWithNames", showResult: true },
    { say: "Every row is in the new table, the future-dated ones too:" },
    { sql: "SELECT count() AS rows, countIf(at >= now()) AS future FROM shop.events FORMAT TSVWithNames", showResult: true },
    { say: "The old table stays as `events__chant_old` until the date in the step's note (7 days)." },

    { say: "## 5. A backfill step" },
    {
      say: "`country` is empty for the rows already there. A backfill is a data migration in the same history as the DDL: an Op of `effect()` batches, each with its own receipt, so a run that stops part way resumes at the first batch without one. `yodel new --backfill <file>` writes a template when the file does not exist:",
    },
    { run: "npx yodel new fill-country --backfill backfills/country.ts", code: 0, expect: ["Wrote a backfill template"], quote: "steps.md#backfill-template" },
    { say: "Write the batches, one month each:" },
    { file: "backfills/country.ts", quote: "steps.md#backfill-file" },
    { run: "npx yodel new fill-country --backfill backfills/country.ts", code: 0, expect: ["backfill step"], quote: "steps.md#backfill-new" },
    { cat: "migrations/{id:fill-country}/migration.sql", quote: "steps.md#backfill-sql" },
    { run: "npx yodel lint", code: 0 },
    { say: "The pull request comment lists the step under the Op steps apply runs, with the backfill's module:" },
    { run: "npx yodel plan dev --format markdown", code: 0, expect: ["Op steps:", "made by Op `backfill` (backfill.ts)"] },
    { run: "git add -A && git commit -q -m 'feat: fill events.country' && git push -q origin main", code: 0, hide: true },
    { run: "npx yodel apply dev", code: 3, expect: ["is waiting at gate"] },
    { run: "{approve}", code: 0 },
    { run: "npx yodel apply dev", code: 0, expect: ['"ran":6'], quote: { at: "steps.md#backfill-apply", excerpt: { from: "Running migrate-dev", to: ": applied" } } },
    { sql: "SELECT country, count() AS rows FROM shop.events GROUP BY country ORDER BY country FORMAT TSVWithNames", showResult: true },
    { say: "The history has a row per migration event, statement and step, never updated or deleted. The rebuild's rows carry the silence:" },
    {
      sql: "SELECT migration_id, kind, statement_index, status, note, silences\nFROM yodeler.history\nWHERE migration_id LIKE '%events-by-id' OR migration_id LIKE '%fill-country'\nORDER BY seq FORMAT Vertical",
      showResult: true,
      quote: "migrations.md#history-rows",
    },

    { say: "## 6. An approval, then a change out of band" },
    { edit: "src/schema.ts", from: "      country LowCardinality(String) DEFAULT ''\n", to: "      country LowCardinality(String) DEFAULT '',\n      source LowCardinality(String) DEFAULT 'web'\n" },
    { run: "npx yodel new add-source", code: 0 },
    { run: "git add -A && git commit -q -m 'feat: events.source' && git push -q origin main", code: 0, hide: true },
    { run: "npx yodel plan dev", code: 0, expect: ["Plan digest"], quote: "approval.md#plan-add-source" },
    { say: "Approve the plan, as a reviewer would from the pull request comment:" },
    { run: "{approve}", code: 0, quote: "approval.md#approve-add-source" },
    { say: "Before the apply runs, someone adds a column by hand:" },
    { sql: "ALTER TABLE shop.events ADD COLUMN debug String DEFAULT ''" },
    { say: "The plan digest covers the live schema, so the approval no longer holds. The apply stops at the gate, applies nothing, and says what moved:" },
    { run: "npx yodel apply dev", code: 3, expect: ["does not hold", "live schema changed"], quote: { at: "approval.md#moved", excerpt: { from: "Running migrate-dev" } } },
    { say: "The column was a mistake. Drop it, and approve again:" },
    { sql: "ALTER TABLE shop.events DROP COLUMN debug" },
    { run: "npx yodel plan dev", code: 0, expect: ["approval was asked for again after it"], quote: "approval.md#asked-again-plan" },
    {
      say: "The digest is the approved one again, but the refused run asked for approval after that approval was given, and an approval holds only when it is newer than the latest request. The apply stops at the gate again:",
    },
    { run: "npx yodel apply dev", code: 3, expect: ["approval was asked for again after it", "is waiting at gate"], quote: { at: "approval.md#asked-again-apply", excerpt: { from: 'Op "migrate-dev" is gated' } } },
    { run: "{approve}", code: 0 },
    { run: "npx yodel apply dev", code: 0, expect: ["Applied: "] },

    { say: "## 7. Drift" },
    { say: "Someone changes a default by hand:" },
    { sql: "ALTER TABLE shop.events MODIFY COLUMN source LowCardinality(String) DEFAULT 'app'" },
    { say: "`yodel drift dev` compares the declared objects with the live ones and exits 2 on drift:" },
    { run: "npx yodel drift dev", code: 2, expect: ["Changed out of band"], quote: "drift.md#drift" },
    { say: "`ops/watch-dev.op.ts` is the same check as a `WatchOp` on a schedule. Run once by hand:" },
    { cat: "ops/watch-dev.op.ts", quote: "drift.md#watch-op" },
    { run: "npx chant run watch-dev", code: 0, expect: ["Drift=true"], quote: "drift.md#watch-run" },
    {
      say: "`chant run` exits 0 when the watch completes, drift or not; the drift is the run's `Drift` outcome. The starter templates' `scripts/watch-outcome.ts` turns it into a failed CI job. Put the default back:",
    },
    { sql: "ALTER TABLE shop.events MODIFY COLUMN source LowCardinality(String) DEFAULT 'web'" },
    { run: "npx yodel drift dev", code: 0, expect: ["No drift"], quote: "drift.md#no-drift" },

    { say: "## 8. The replay check" },
    {
      say: "`yodel lint --replay replay` replays every migration, in order, into the server the `replay` profile names and compares each with the schema it recorded. Here that profile points at the same emulator as dev, which already holds `shop`, so it refuses:",
    },
    { run: "npx yodel lint --replay replay", code: 4, expect: ["Nothing was run"], quote: "lint.md#replay-refused" },
    { say: "`--reset` drops the database first. In CI the profile points at a throwaway server the job starts; here it empties dev's database, so it runs last:" },
    { run: "npx yodel lint --replay replay --reset", code: 0, expect: ["Every migration replays to its recorded schema."], quote: [{ at: "lint.md#replay", excerpt: { from: "Replay of" } }, { at: "steps.md#replay-rebuild", excerpt: { from: "events-by-id: replaying", to: "events-by-id: matches its recorded schema" } }] },
  ],
};
