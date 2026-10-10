import pg from "pg";
import type { Walkthrough } from "./run.js";

const url = () => process.env.YODEL_E2E_POSTGRES_URL ?? "";
const user = () => process.env.YODEL_E2E_POSTGRES_USER ?? "postgres";
const password = () => process.env.YODEL_E2E_POSTGRES_PASSWORD ?? "";

/** Runs SQL and returns the last result's rows, tab-separated. */
async function sql(text: string): Promise<string> {
  const u = new URL(url());
  const client = new pg.Client({ host: u.hostname, port: Number(u.port || 5432), database: u.pathname.replace(/^\//, "") || "postgres", user: user(), password: password() });
  await client.connect();
  try {
    const result = (await client.query(text)) as unknown as pg.QueryResult | pg.QueryResult[];
    const last = Array.isArray(result) ? result.at(-1) : result;
    if (!last?.fields.length) return "";
    const rows = last.rows as Array<Record<string, unknown>>;
    const names = last.fields.map((f) => f.name);
    const cell = (v: unknown): string => {
      if (v === null) return "NULL";
      if (v instanceof Date) return v.toISOString();
      if (typeof v === "string") return v;
      if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
      return JSON.stringify(v);
    };
    return [names.join("\t"), ...rows.map((r) => names.map((n) => cell(r[n])).join("\t"))].join("\n") + "\n";
  } finally {
    await client.end();
  }
}

const SCHEMA = `import { index, schema, table } from "@intentius/chant-lexicon-sql/postgres";

export const shop = schema\`
  CREATE SCHEMA yodel_18_shop;
  COMMENT ON SCHEMA yodel_18_shop IS 'The SQL Yodeler Postgres example'\`;

export const orders = table\`
  CREATE TABLE \${shop}.orders (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_email text NOT NULL,
    status         text NOT NULL DEFAULT 'placed',
    amount         numeric(12, 2) NOT NULL,
    placed_at      timestamptz NOT NULL DEFAULT now()
  )\`;

export const ordersStatus = index\`
  CREATE INDEX orders_status_idx ON \${orders} (\${orders.columns.status})\`;
`;

const APPLY_OP = `import { ApplyOp } from "@intentius/chant/op";

// The declarative path: yodel apply dev plans src/ against dev and runs this
// Op, behind a gate bound to the plan.
export const { op } = ApplyOp({ name: "apply-dev", env: "dev", target: "postgres", gate: {} });
`;

export const walkthrough: Walkthrough = {
  dialect: "postgres",
  intro: `
# Postgres example

A Postgres schema taken from the declarative path to versioned migrations: adoption with \`yodel init --from\`, lint findings and a silence, a migration that fails part way and resumes, a column rename run as a \`PostgresMigrationOp\` step, two branches that fork the history (rebase, repair, out of order), drift, and the replay check. Every command below ran against the emulator (\`chant emulator up --lexicon sql\`), and the output under each is what it printed. \`examples/walkthrough/postgres.ts\` holds the steps; \`npx tsx examples/walkthrough/run.ts postgres --write\` runs them again and rewrites this file and the project files from the run.

The project in this directory is what the walkthrough leaves: \`src/schema.ts\`, the migrations it wrote, and the two Ops.

To run it yourself, from a clone of this repository:

\`\`\`sh
npm ci && npm run build          # in the repository root
chant emulator up --lexicon sql  # or any Postgres you can drop schema yodel_18_shop on
cd examples/postgres
npm install                      # takes @intentius/sql-yodeler from ../..
export DEV_POSTGRES_URL=postgres://127.0.0.1:5432/postgres DEV_POSTGRES_USER=postgres DEV_POSTGRES_PASSWORD=...
\`\`\`

The run happened in a temporary copy of this directory, a git repository with a local \`origin\`; its path is shown as \`<tmp>\`. A command that exited with a code other than 0 ends with \`[exit <code>]\`.
`,
  start: ["package.json", "chant.config.ts", "yodel.config.ts", "tsconfig.json", ".gitignore", "ops/watch-dev.op.ts"],
  keep: ["src", "migrations", "ops"],
  env: () => ({
    DEV_POSTGRES_URL: url(),
    DEV_POSTGRES_USER: user(),
    DEV_POSTGRES_PASSWORD: password(),
    REPLAY_POSTGRES_URL: url(),
    REPLAY_POSTGRES_USER: user(),
    REPLAY_POSTGRES_PASSWORD: password(),
  }),
  sql,
  reset: async () => {
    await sql("DROP SCHEMA IF EXISTS yodel_18_shop CASCADE; DROP SCHEMA IF EXISTS yodel_18_history CASCADE");
  },
  steps: [
    { say: "## 1. A declared schema, applied without migrations" },
    {
      say: "The project starts on the declarative path: `src/schema.ts` says what the schema should be, and an `ApplyOp` applies it. There is no `migrations/` directory, so `yodel plan` and `yodel apply` diff the declared schema against the live database. `package.json` has a `build` script (`chant build src --lexicon sql -o dist/schema.json`), which the `ApplyOp` runs first.",
    },
    { file: "src/schema.ts", content: SCHEMA },
    { file: "ops/apply-dev.op.ts", content: APPLY_OP },
    { run: "git add -A && git commit -q -m 'feat: the declared schema' && git push -q origin main", code: 0, hide: true },
    { run: "npx yodel plan dev", code: 0, expect: ["3 create"] },
    { say: "`yodel apply dev` stops at the `ApplyOp`'s gate, which wants an approval of this exact plan, and exits 3:" },
    { run: "npx yodel apply dev", code: 3, expect: ["is waiting at gate"] },
    { run: "{approve}", code: 0 },
    { run: "npx yodel apply dev", code: 0, expect: ["Applied: dev matches the declared schema."] },

    { say: "## 2. Adopting the schema into versioned migrations" },
    { say: "Orders arrive, one of them a free sample with an amount of 0:" },
    {
      sql: "INSERT INTO yodel_18_shop.orders (customer_email, status, amount, placed_at)\nSELECT 'customer' || (n % 40) || '@example.com', (ARRAY['placed', 'paid', 'shipped'])[n % 3 + 1], (n * 7 % 500) + 0.99, timestamptz '2026-06-01' + n * interval '5 hours'\nFROM generate_series(1, 300) AS n;\nINSERT INTO yodel_18_shop.orders (customer_email, amount) VALUES ('sample@example.com', 0)",
    },
    {
      say: "`yodel init --from dev` reads the live schema, writes its declarations to `src/`, checks they plan clean, writes the baseline migration and records it applied in dev's history without running it. `--force` because `src/schema.ts` is already there:",
    },
    { run: "npx yodel init --from dev --force", code: 0, expect: ["Adopted dev (postgres): 3 objects"] },
    { cat: "src/schema.ts" },
    { run: "npx yodel status dev", code: 0, expect: ["-baseline"] },
    { say: "The versioned path runs a migrations Op, so `ops/apply-dev.op.ts` gives way to `ops/migrate-dev.op.ts`:" },
    { run: "git rm -q ops/apply-dev.op.ts", code: 0 },
    { file: "ops/migrate-dev.op.ts" },
    { run: "git add -A && git commit -q -m 'feat: adopt dev into versioned migrations' && git push -q origin main", code: 0, hide: true },

    { say: "## 3. Lint catches a full-table lock" },
    { say: "Add a column and a CHECK constraint:" },
    {
      edit: "src/schema.ts",
      from: "      CONSTRAINT orders_pkey PRIMARY KEY (id)\n",
      to: "      coupon text,\n      CONSTRAINT orders_pkey PRIMARY KEY (id),\n      CONSTRAINT orders_amount_positive CHECK (amount > 0)\n",
    },
    { run: "npx yodel new coupons", code: 0, expect: ["2 statements"] },
    { run: "npx yodel lint", code: 3, expect: ["pg-rewrite"] },
    { say: "Do as the finding says: delete the migration, declare the constraint `NOT VALID`, and write it again:" },
    { run: "rm -r migrations/{id:coupons}", code: 0 },
    { edit: "src/schema.ts", from: "CHECK (amount > 0)\n", to: "CHECK (amount > 0) NOT VALID\n", show: false },
    { run: "npx yodel new coupons", code: 0 },
    { cat: "migrations/{id:coupons}/migration.sql" },
    { run: "npx yodel lint", code: 0, expect: ["0 errors"] },
    { run: "git add -A && git commit -q -m 'feat: coupons, and amounts above 0' && git push -q origin main", code: 0, hide: true },
    { run: "npx yodel plan dev", code: 0, expect: ["Not approved yet."] },
    { run: "npx yodel apply dev", code: 3, expect: ["is waiting at gate"] },
    { run: "{approve}", code: 0 },
    { say: "On Postgres the apply lock is an advisory lock:" },
    { run: "npx yodel apply dev", code: 0, expect: ["advisory lock", "Applied: "] },

    { say: "## 4. A migration that fails part way, and resumes" },
    { say: "Validate the constraint, and add a column in the same migration:" },
    {
      edit: "src/schema.ts",
      from: "      coupon text,\n",
      to: "      coupon text,\n      refunded_at timestamp with time zone,\n",
      show: false,
    },
    { edit: "src/schema.ts", from: "CHECK (amount > 0) NOT VALID\n", to: "CHECK (amount > 0)\n" },
    { run: "npx yodel new validate-amount", code: 0 },
    { cat: "migrations/{id:validate-amount}/migration.sql" },
    { run: "git add -A && git commit -q -m 'feat: validate amounts, refunded_at' && git push -q origin main", code: 0, hide: true },
    { run: "npx yodel apply dev", code: 3, expect: ["is waiting at gate"] },
    { run: "{approve}", code: 0 },
    { say: "The free sample breaks the constraint. Statement 0 ran and is recorded; statement 1 failed:" },
    { run: "npx yodel apply dev", code: 1, expect: ["failed at statement 1"] },
    { run: "npx yodel status dev", code: 3, expect: ["resumes at statement 1"] },
    { say: "Fix the data. The history changed since the approval (statement 0 ran), so the digest moved and the gate asks again:" },
    { sql: "UPDATE yodel_18_shop.orders SET amount = 0.01 WHERE amount <= 0" },
    { run: "npx yodel apply dev", code: 3, expect: ["is waiting at gate"] },
    { run: "{approve}", code: 0 },
    { run: "npx yodel apply dev", code: 0, expect: ["statement 0: succeeded in an earlier run; not sent"] },

    { say: "## 5. A column rename: a PostgresMigrationOp step" },
    {
      say: "Renaming `customer_email` to `email` in place would break every reader still using the old name. Declare the new name with `-- previously: <old name>` on its line, and `yodel new` writes the change as a `PostgresMigrationOp` step: add the new column, keep both written with a trigger, backfill, verify, switch, and drop the old column. The new name stays where the old one was declared:",
    },
    { edit: "src/schema.ts", from: "      customer_email text NOT NULL,\n", to: "      email text NOT NULL, -- previously: customer_email\n" },
    { run: "npx yodel new rename-email", code: 0, expect: ["PostgresMigrationOp"] },
    { cat: "migrations/{id:rename-email}/migration.sql" },
    { run: "npx yodel plan dev", code: 0, expect: ["yodel apply runs it as this step"] },
    { run: "git add -A && git commit -q -m 'feat: orders.email' && git push -q origin main", code: 0, hide: true },
    { run: "npx yodel apply dev", code: 3, expect: ["is waiting at gate"] },
    { run: "{approve}", code: 0 },
    { run: "npx yodel apply dev", code: 0, expect: ['"switched":true'] },
    {
      say: "The expand added `email` at the end of the table, and Postgres has no `ALTER` that moves a column, so the live order is not the declared one. Drift compares the columns by name, so that is not drift:",
    },
    { sql: "SELECT string_agg(column_name, ', ' ORDER BY ordinal_position) AS live_columns FROM information_schema.columns WHERE table_schema = 'yodel_18_shop' AND table_name = 'orders'", showResult: true },
    { run: "npx yodel drift dev", code: 0, expect: ["No drift"] },

    { say: "## 6. A destructive change, silenced with a reason" },
    { edit: "src/schema.ts", from: "      coupon text,\n", to: "", show: false },
    { run: "npx yodel new drop-coupon", code: 0 },
    { run: "npx yodel lint", code: 3, expect: ["destructive"] },
    { say: "Nothing ever wrote a coupon. Say so above the statement:" },
    {
      edit: "migrations/{id:drop-coupon}/migration.sql",
      from: "ALTER TABLE yodel_18_shop.orders DROP COLUMN coupon;",
      to: "-- yodel:allow destructive no order ever had a coupon; checked on dev\nALTER TABLE yodel_18_shop.orders DROP COLUMN coupon;",
    },
    { run: "npx yodel lint --update-checksum {id:drop-coupon}", code: 0, expect: ["1 silenced"] },
    { run: "git add -A && git commit -q -m 'feat: drop orders.coupon' && git push -q origin main", code: 0, hide: true },
    { say: "The pull request comment (`yodel plan dev --comment` in CI) is this Markdown:" },
    { run: "npx yodel plan dev --format markdown", code: 0, expect: ["destructive"] },
    { run: "npx yodel apply dev", code: 3, expect: ["is waiting at gate"] },
    { run: "{approve}", code: 0 },
    { run: "npx yodel apply dev", code: 0, expect: ["Applied: "] },
    { say: "Every history row the migration wrote records the silence:" },
    { sql: "SELECT kind, statement_index, status, silences FROM yodel_18_history.history WHERE migration_id LIKE '%drop-coupon' ORDER BY seq", showResult: true },

    { say: "## 7. Two branches, a fork, a rebase and a repair" },
    { say: "Two changes are made on two branches. The first adds a column:" },
    { run: "git switch -q -c gift", code: 0 },
    {
      edit: "src/schema.ts",
      from: "      refunded_at timestamp with time zone,\n",
      to: "      refunded_at timestamp with time zone,\n      gift boolean DEFAULT false NOT NULL,\n",
      show: false,
    },
    { run: "npx yodel new add-gift", code: 0 },
    { run: "git add -A && git commit -q -m 'feat: orders.gift' && git switch -q main", code: 0 },
    { say: "The second, from main, adds an index:" },
    { run: "git switch -q -c placed-at-index", code: 0 },
    {
      edit: "src/schema.ts",
      from: "USING btree (status)`;\n",
      to: "USING btree (status)`;\n\nexport const ordersPlacedAt = index`\n  CREATE INDEX orders_placed_at_idx ON ${orders} (placed_at)`;\n",
      show: false,
    },
    { run: "npx yodel new index-placed-at", code: 0 },
    { run: "npx yodel lint", code: 3, expect: ["pg-lock"] },
    { run: "rm -r migrations/{id:index-placed-at}", code: 0 },
    { edit: "src/schema.ts", from: "CREATE INDEX orders_placed_at_idx", to: "CREATE INDEX CONCURRENTLY orders_placed_at_idx" },
    { run: "npx yodel new index-placed-at", code: 0 },
    { cat: "migrations/{id:index-placed-at}/migration.sql" },
    { run: "npx yodel lint", code: 0, expect: ["0 errors"] },
    { run: "git add -A && git commit -q -m 'feat: index orders by placed_at'", code: 0 },
    { say: "Someone applies the index branch to dev to try it:" },
    { run: "npx yodel apply dev", code: 3, expect: ["is waiting at gate"] },
    { run: "{approve}", code: 0 },
    { run: "npx yodel apply dev", code: 0, expect: ["Applied: "] },
    { say: "Both branches merge. Each migration follows `drop-coupon`, so the history forks, and lint says so:" },
    { run: "git switch -q main && git merge -q --no-edit gift && git merge -q --no-edit placed-at-index", code: 0 },
    { run: "npx yodel lint", code: 3, expect: ["fork"] },
    { say: "`yodel rebase` moves one migration onto the other and writes its statements and recorded schema again. With `--env dev` it reads dev's history first, and refuses to move a migration that ran there:" },
    { run: "npx yodel rebase {id:index-placed-at} --onto {id:add-gift} --env dev", code: 4, expect: ["refused"] },
    {
      say: "The clean fix is the one it names: move `add-gift` after `index-placed-at`. To show what yodel does when a migration that ran is moved anyway (a rebase run without `--env`), this walkthrough moves `index-placed-at`:",
    },
    { run: "npx yodel rebase {id:index-placed-at} --onto {id:add-gift}", code: 0, expect: ["No history was checked"] },
    { run: "git add -A && git commit -q -m 'chore: rebase index-placed-at onto add-gift' && git push -q origin main", code: 0, hide: true },
    { say: "Its files changed after it ran on dev, so dev's history no longer matches them. `yodel status` and `yodel apply` refuse (exit 4):" },
    { run: "npx yodel status dev", code: 4, expect: ["checksum"] },
    { run: "npx yodel apply dev", code: 4 },
    { say: "The edit is intended: its statements are the same, only its parent changed. `yodel repair` records the new checksum, with the reason, in dev's history. Nothing runs on the server:" },
    { run: "npx yodel repair {id:index-placed-at} --reason 'rebased onto add-gift after it ran on dev' dev", code: 0 },
    { say: "Now `add-gift` comes before a migration dev has applied. It is out of order, and apply refuses it rather than skip it:" },
    { run: "npx yodel status dev", code: 4, expect: ["ut of order"] },
    { run: "npx yodel apply dev", code: 4, expect: ["--allow-out-of-order"] },
    { say: "Adding a column after the index changes nothing the index needs, so apply it out of order:" },
    { run: "npx yodel apply dev --allow-out-of-order", code: 3, expect: ["is waiting at gate"] },
    { run: "{approve}", code: 0 },
    { run: "npx yodel apply dev --allow-out-of-order", code: 0, expect: ["Applied: "] },
    { say: "`yodel status` lists `index-placed-at` as applied when it ran, and the repair under it:" },
    { run: "npx yodel status dev", code: 0, expect: ["repaired "] },

    { say: "## 8. Drift" },
    { say: "Someone changes a default by hand:" },
    { sql: "ALTER TABLE yodel_18_shop.orders ALTER COLUMN status SET DEFAULT 'new'" },
    { run: "npx yodel drift dev", code: 2, expect: ["Changed out of band"] },
    { say: "`ops/watch-dev.op.ts` runs the same check as a `WatchOp` on a schedule. Run once by hand:" },
    { run: "npx chant run watch-dev", code: 0, expect: ["Drift=true"] },
    { say: "`chant run` exits 0 when the watch completes, drift or not; the drift is the run's `Drift` outcome. Put the default back:" },
    { sql: "ALTER TABLE yodel_18_shop.orders ALTER COLUMN status SET DEFAULT 'placed'" },
    { run: "npx yodel drift dev", code: 0 },

    { say: "## 9. The replay check" },
    {
      say: "`yodel lint --replay replay --reset` replays every migration, in order, into the server the `replay` profile names, and compares each with the schema it recorded. In CI that profile points at a throwaway server the job starts. Here it points at the same emulator as dev, so `--reset` drops dev's schema, and the check runs last:",
    },
    { run: "npx yodel lint --replay replay --reset", code: 0, expect: ["Every migration replays to its recorded schema."] },
  ],
};
