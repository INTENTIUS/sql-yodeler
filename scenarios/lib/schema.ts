/**
 * The edits claims make to a fixture's declared schema, and what each
 * dialect's fixture holds, so one claim body serves both dialects.
 */

import { Pending, type Ctx } from "./claim.js";
import type { Project } from "./project.js";

/** The fixture's main table: events (ClickHouse), orders (Postgres). */
export const mainTable = (ctx: Ctx): string => (ctx.dialect === "ch" ? "events" : "orders");

/** Adds a column to the main table's declaration in src/schema.ts. */
export function addColumn(p: Project, column: string): void {
  const type = p.ctx.dialect === "ch" ? "String DEFAULT ''" : "text";
  // The column list of the first table ends at a line holding only "  )".
  p.edit("src/schema.ts", /\n {2}\)(\n|`)/, `,\n    ${column} ${type}\n  )$1`);
}

/** Declares another table, `name`, in its own file src/<name>.ts. */
export function addTable(p: Project, name: string): void {
  const body =
    p.ctx.dialect === "ch"
      ? `import { table } from "@intentius/chant-lexicon-sql/clickhouse";\nimport { db } from "./schema.js";\n\nexport const ${name} = table\`\n  CREATE TABLE \${db}.${name} (\n    id UInt64\n  )\n  ENGINE = MergeTree\n  ORDER BY id\`;\n`
      : `import { table } from "@intentius/chant-lexicon-sql/postgres";\nimport { db } from "./schema.js";\n\nexport const ${name} = table\`\n  CREATE TABLE \${db}.${name} (\n    id bigint PRIMARY KEY\n  )\`;\n`;
  p.write(`src/${name}.ts`, body);
}

/** Creates a table of that name by hand, as the declaration in {@link addTable} would. */
export async function createTableByHand(ctx: Ctx, name: string): Promise<void> {
  await ctx.db.exec(
    ctx.dialect === "ch" ? `CREATE TABLE ${ctx.db.name}.${name} (id UInt64) ENGINE = MergeTree ORDER BY id` : `CREATE TABLE ${ctx.db.name}.${name} (id bigint PRIMARY KEY)`,
  );
}

/**
 * Postgres versioned migrations are #13 (PR #33). On main, every versioned
 * verb on a Postgres project refuses, naming #13; once that lands the
 * claims that need it run. Call with a project that holds a migration.
 */
export async function needsVersioned(p: Project): Promise<void> {
  if (p.ctx.dialect !== "pg") return;
  const ran = await p.yodel(["status", p.env, "--json"]);
  if (ran.code === 1 && /Postgres is #13|ClickHouse only/.test(ran.err)) throw new Pending("#13", "Postgres versioned migrations are not on main yet");
}

/** Adds a column to the main table by hand, as {@link addColumn} would declare it. */
export async function addColumnByHand(ctx: Ctx, column: string): Promise<void> {
  const type = ctx.dialect === "ch" ? "String DEFAULT ''" : "text";
  await ctx.db.exec(`ALTER TABLE ${ctx.db.name}.${mainTable(ctx)} ADD COLUMN ${column} ${type}`);
}

/** Deletes a migration's rows from the history, which yodel never does: the history is append-only. */
export async function forgetMigration(ctx: Ctx, id: string): Promise<void> {
  await ctx.db.exec(
    ctx.dialect === "ch"
      ? `ALTER TABLE ${ctx.db.history}.history DELETE WHERE migration_id = '${id}' SETTINGS mutations_sync = 2`
      : `DELETE FROM ${ctx.db.history}.history WHERE migration_id = '${id}'`,
  );
}

/** ClickHouse: 30 events over the last 60 days (three or four monthly partitions, inside the fixture's 90-day TTL). */
export async function insertEvents(ctx: Ctx): Promise<void> {
  await ctx.db.exec(
    `INSERT INTO ${ctx.db.name}.events (id, kind, ts) SELECT number, concat('k', toString(number % 4)), now() - toIntervalDay(number * 2) FROM numbers(30)`,
  );
}

