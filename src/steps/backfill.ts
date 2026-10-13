/**
 * A backfill step: a data migration the author writes, run inside the
 * migration between the statements around it, resumable from receipts.
 *
 * The common case is a form, the step's options in `migration.json`
 * ({@link BackfillForm}): a table, an integer key and a batch size (or a
 * list of batches), and the SQL of one batch with `{from}` and `{to}` (or
 * `{batch}`) in it. `yodel new <name> --backfill` writes it from
 * `backfills/<name>.json`. When the step runs, yodel builds the Op below
 * from it ({@link formOp}): one `effect()` per batch, the batches read from
 * the table's smallest and largest key at that moment, aligned to the
 * batch size so a rerun sees the same ranges.
 *
 * The advanced case: the step names a module in the migration's directory (`backfill.ts` by
 * default) that exports one chant Op, under a name of its own. Each
 * step of its phases is an `effect()` step: one batch of the backfill, with
 * its own receipt. The nested steps run SQL on the environment's server with
 * the `yodelSql` activity yodel provides, or any activity chant has:
 *
 *     import { EffectReceipt } from "@intentius/chant";
 *     import { Op, activity, effect, phase } from "@intentius/chant/op";
 *
 *     const months = ["202601", "202602", "202603"];
 *     const batch = (m: string) =>
 *       effect(EffectReceipt(`country-${m}`, { effect: `country/${m}`, flavor: "existence" }), [
 *         activity("yodelSql", { sql: `ALTER TABLE shop.orders UPDATE country = ... WHERE toYYYYMM(ts) = ${m}` }, "atMostOnce"),
 *       ]);
 *
 *     export const backfillCountry = Op({ name: "backfill-country", overview: "...", phases: [phase("Backfill", months.map(batch))] });
 *
 * How a run goes is chant's `effect()` cycle, run by chant's local executor:
 * for each batch, read its receipt; skip the batch when the receipt is there
 * (an earlier run finished it); otherwise run its steps and write the
 * receipt last, only when they all succeeded. A run that fails or is killed
 * part way leaves the finished batches' receipts, so the next `yodel apply`
 * resumes at the first batch without one and never redoes a finished one.
 * A batch that was running when it stopped runs again: make each batch safe
 * to repeat (an idempotent `UPDATE`, or a delete of its rows before the
 * insert), as the rebuild's backfill does per partition.
 *
 * The receipts are rows on the environment's server, kept by the sql
 * lexicon's receipt store (`sqlReceiptStore`), addressed
 * `yodel/<env>/<migration id>/<effect>`, so the same effect name in two
 * migrations is two receipts:
 *
 * - ClickHouse: `chant_receipts.receipts` (the table `ClickHouseRebuildOp`
 *   keeps its partition receipts in).
 * - Postgres: `<history schema>.__chant_receipts`, in the schema yodel's
 *   history is in, over the apply's connection. Each batch runs in one
 *   transaction on that connection, and its receipt is written last
 *   inside it: the batch's statements and its receipt commit together or
 *   not at all, so a run killed anywhere leaves no batch half done, and a
 *   resumed backfill runs no batch twice. A batch's statements must be ones
 *   Postgres runs in a transaction block (no `CREATE INDEX CONCURRENTLY`,
 *   no `VACUUM`). The environment's `lockTimeoutMs` and `scanTimeoutMs` are
 *   the batch's `lock_timeout` and `statement_timeout`, and `yodelSql`'s
 *   `settings` are set for the batch's transaction (`set_config(..., true)`).
 *
 * The module is one of the migration's own files: it counts in the
 * migration's checksum, so the plan digest an approval binds covers it, and
 * an edit after it ran is a checksum mismatch. It is imported from the
 * migration's directory, so it imports packages only (no relative imports).
 * Its Op has no gates (the migration's gate approves it).
 */

import { existsSync, readFileSync } from "node:fs";
import { opExportName } from "../chant/export-name.js";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { OpConfig } from "@intentius/chant/op/types";
import type { SqlDialect } from "@intentius/chant-lexicon-sql/dialects";
import type { ClickHouseEndpoint } from "@intentius/chant-lexicon-sql/clickhouse/http";
import type { ActivityFn } from "@intentius/chant/op/activity-registry";
import type { ReceiptStore } from "@intentius/chant/op/receipt-store";
import type { StepRecord } from "@intentius/chant/op/local-executor";
import { YodelError } from "../project.js";
import type { ClickHousePort } from "../history/index.js";
import type { PgClient } from "../history/postgres/index.js";
import type { PgTimeouts } from "../versioned/postgres/executor.js";
import { gatesOf, runOp, StepOpFailed, type RunOpOptions } from "./run.js";
import { BACKFILL_FILE, BACKFILL_OP, describeForm, formPlaceholders, type BackfillForm, type BackfillStep } from "./kinds.js";

/** The activity a backfill's steps run SQL with: `activity("yodelSql", { sql, settings? })`. */
export const SQL_ACTIVITY = "yodelSql";

/** The step `yodel new --backfill` adds to a migration. */
export function backfillStep(migrationName: string, file = BACKFILL_FILE): BackfillStep {
  return {
    kind: "op",
    object: "backfill",
    type: "Yodel::Backfill",
    name: migrationName,
    op: BACKFILL_OP,
    importPath: `./${file}`,
    options: { file },
    declaration: `the Op exported by ${file} in this migration's directory`,
    changes: [],
    detail: `a data backfill: the effect() steps of the Op in ${file}, each a batch with its own receipt; yodel apply runs it after the statements before it and resumes it from its receipts`,
  };
}

/** The default place `yodel new <name> --backfill` reads a form from (and writes its template at), in the project directory. */
export const formPath = (name: string): string => `backfills/${name}.json`;

/** What one batch of a form runs, as the plan shows it. */
export function describeFormSql(form: BackfillForm): string {
  return (typeof form.sql === "string" ? [form.sql] : form.sql).map((s) => `${s.trim().replace(/;\s*$/, "")};`).join("\n");
}

/** The step `yodel new --backfill` adds for a form: the form is the step's options, so it is in the checksum and the plan shows it. */
export function backfillFormStep(migrationName: string, form: BackfillForm): BackfillStep {
  const batches =
    form.key !== undefined
      ? `each range of ${form.key} ${String(form.batchSize)} wide, {from} inclusive to {to} exclusive, from the table's smallest key to its largest when the step runs, is one batch`
      : `each of the ${String(form.batches?.length ?? 0)} batches listed, {batch} in the SQL, is one batch`;
  return {
    kind: "op",
    object: "backfill",
    type: "Yodel::Backfill",
    name: migrationName,
    op: BACKFILL_OP,
    importPath: "@intentius/sql-yodeler",
    options: form,
    declaration: JSON.stringify(form, null, 2),
    changes: [],
    detail:
      `a data backfill of ${describeForm(form)}: ${batches}, with its own receipt. ` +
      `yodel apply runs the batches in order after the statements before this step, and a rerun after a failure resumes at the first batch without a receipt. Each batch runs:\n` +
      describeFormSql(form),
  };
}

/** Text only the template holds: a backfill still carrying it has not been written. */
export const TEMPLATE_MARK = "write the backfill of";

/** What `yodel new --backfill <file>` writes at `<file>` when there is none yet. */
export function backfillTemplate(name: string, dialect: SqlDialect = "clickhouse"): string {
  const todo =
    dialect === "postgres"
      ? `DO $$ BEGIN RAISE EXCEPTION 'write the backfill of ${name} for batch \${b}'; END $$`
      : `SELECT throwIf(1, 'write the backfill of ${name} for batch \${b}')`;
  return `/**
 * The backfill of migration ${name}. yodel apply runs the Op this file
 * exports, after the migration's statements before the step and before
 * those after it. Each effect() is one batch with its own receipt: a rerun
 * after a failure skips the batches that finished. ${
    dialect === "postgres"
      ? `Each batch is one transaction
 * with its receipt, so a batch that was running when a run stopped left
 * nothing and runs again whole.`
      : `Make each batch safe to
 * run twice (the one running when a run stopped runs again).`
  }
 *
 * This file is copied into the migration's directory and counts in its
 * checksum. Import packages only, no relative paths. No gates: the
 * migration's own gate approves it.
 */
import { EffectReceipt } from "@intentius/chant";
import { Op, activity, effect, phase } from "@intentius/chant/op";

// The batches: months, id ranges, partitions.
const batches: string[] = ["202601", "202602"];

const batch = (b: string) =>
  effect(EffectReceipt(\`${name}-\${b}\`, { effect: \`${name}/\${b}\`, flavor: "existence" }), [
    // TODO: the SQL for one batch.
    activity("${SQL_ACTIVITY}", { sql: \`${todo}\` }, "atMostOnce"),
  ]);

export const ${opExportName(`backfill-${name}`)} = Op({
  name: "backfill-${name}",
  overview: "Backfill for migration ${name}",
  phases: [phase("Backfill", batches.map(batch))],
});
`;
}

/** What `yodel new <name> --backfill` writes at `backfills/<name>.json` when there is none yet: a form to fill in. */
export function formTemplate(name: string, dialect: SqlDialect = "clickhouse"): string {
  const form =
    dialect === "postgres"
      ? {
          table: "<schema>.<table>",
          key: "id",
          batchSize: 10000,
          sql: `${TEMPLATE_MARK} ${name}: UPDATE <schema>.<table> SET <column> = <expression> WHERE id >= {from} AND id < {to}`,
        }
      : {
          table: "<database>.<table>",
          key: "id",
          batchSize: 100000,
          settings: { mutations_sync: "2" },
          sql: `${TEMPLATE_MARK} ${name}: ALTER TABLE <database>.<table> UPDATE <column> = <expression> WHERE id >= {from} AND id < {to}`,
        };
  return `${JSON.stringify(form, null, 2)}\n`;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const opConfigOf = (value: unknown): OpConfig | undefined => {
  const props = isRecord(value) ? value.props : undefined;
  return isRecord(props) && typeof props.name === "string" && Array.isArray(props.phases) ? (props as unknown as OpConfig) : undefined;
};

/**
 * The Op config a module exports: as `op` or its default export, else the
 * one Op it exports under any other name (`backfillCountry`, as yodel new
 * writes it since #2). A module that exports more than one Op under other
 * names gives none: which one runs would be a guess.
 */
export function exportedOp(mod: Record<string, unknown>): OpConfig | undefined {
  for (const value of [mod.op, mod.default]) {
    const config = opConfigOf(value);
    if (config) return config;
  }
  const others = Object.values(mod).map(opConfigOf).filter((c): c is OpConfig => c !== undefined);
  return others.length === 1 ? others[0] : undefined;
}

/** What is wrong with a backfill's Op, if anything: every phase step is an effect() step, and there are no gates. */
export function backfillProblems(config: OpConfig): string[] {
  const problems: string[] = [];
  const steps = config.phases.flatMap((p) => p.steps.map((s) => ({ phase: p.name, s })));
  if (steps.length === 0) problems.push("its Op has no steps");
  for (const { phase, s } of steps) {
    if (s.kind !== "effect") problems.push(`phase "${phase}" has a ${s.kind === "gate" ? `gate (${s.gate ?? "unnamed"})` : `${s.fn} step`} outside an effect(): every step of a backfill is an effect() with its receipt, so a rerun resumes`);
  }
  const gates = gatesOf(config);
  if (gates.length > 0) problems.push(`it has a gate (${gates.join(", ")}); the migration's own gate approves the backfill`);
  return problems;
}

/** Imports a backfill module and returns its Op, or throws naming what is wrong. `text` busts the import cache when the file changed. */
export async function loadBackfill(path: string, text?: string): Promise<OpConfig> {
  if (!existsSync(path)) throw new YodelError(`${path}: no such file; the backfill step runs the Op it exports`);
  const body = text ?? readFileSync(path, "utf8");
  const version = createHash("sha256").update(body).digest("hex").slice(0, 16);
  let mod: Record<string, unknown>;
  try {
    mod = (await import(`${pathToFileURL(path).href}?yodel=${version}`)) as Record<string, unknown>;
  } catch (e) {
    throw new YodelError(`${path}: could not load it: ${e instanceof Error ? e.message : String(e)}`);
  }
  const config = exportedOp(mod);
  if (!config) throw new YodelError(`${path} exports no Op, or more than one (export one Op, as export const backfillCountry = Op({ ... }))`);
  const problems = backfillProblems(config);
  if (problems.length > 0) throw new YodelError(`${path}: ${problems.join("; ")}`);
  return config;
}

export interface BackfillSummary {
  op: "backfill";
  /** The module, for a backfill written as an Op. */
  file?: string;
  /** The table, for a backfill written as a form. */
  table?: string;
  /** The Op's name. */
  name: string;
  /** Batches (effect steps) the Op has. */
  effects: number;
  /** Batches skipped: their receipt was there (an earlier run finished them). */
  skipped: number;
  /** Batches run, and their receipt written, in this run. */
  ran: number;
}

/** A receipt store whose every effect is under `prefix`, so receipts of different migrations never meet. */
export function prefixedStore(store: ReceiptStore, prefix: string): ReceiptStore {
  return {
    read: (r) => store.read({ ...r, effect: `${prefix}${r.effect}` }),
    write: (r, expectation) => store.write({ ...r, effect: `${prefix}${r.effect}` }, expectation),
  };
}

/** Where a backfill's receipts are kept: the environment's ClickHouse server, or the apply's Postgres connection and the schema to keep them in. */
export type ReceiptServer = { clickhouse: ClickHouseEndpoint } | { postgres: PgClient; schema: string };

/**
 * The sql lexicon's receipt store on the environment's server, under the
 * stack `yodel`. On Postgres it writes over the apply's connection (so a
 * receipt written inside a batch's transaction commits with it, and the
 * store never closes it), and the table is made here, before any batch's
 * transaction opens.
 */
export async function serverReceipts(server: ReceiptServer, environment: string): Promise<ReceiptStore> {
  const { sqlReceiptStore } = await import("@intentius/chant-lexicon-sql/receipts");
  const where =
    "clickhouse" in server
      ? { clickhouse: { endpoint: server.clickhouse } }
      : { postgres: { query: <T>(sql: string, params?: readonly unknown[]) => server.postgres.query<T>(sql, params), end: () => Promise.resolve() }, schema: server.schema };
  const store = sqlReceiptStore({ environment, stack: "yodel", config: {}, ...where });
  if ("postgres" in server) await store.ensure();
  return store;
}

/** A backfill on Postgres: the connection its batches run on, and the environment's timeouts. */
export interface PgBackfillServer {
  client: PgClient;
  timeouts: Pick<PgTimeouts, "lockTimeoutMs" | "scanTimeoutMs">;
}

/** How a backfill's batches meet the server: `next` starts a batch, `sql` runs one of its statements, `done` follows its receipt's write, `abandon` its failure. */
interface BatchSession {
  /** A read outside any batch: the form's key bounds. */
  read(sql: string): Promise<Array<Record<string, unknown>>>;
  next(): Promise<void>;
  sql(sql: string, settings: Record<string, string> | undefined): Promise<number>;
  done(): Promise<void>;
  abandon(): Promise<void>;
}

function clickhouseBatches(port: ClickHousePort): BatchSession {
  return {
    read: (sql) => port.query(sql),
    next: () => Promise.resolve(),
    sql: async (sql, settings) => (await port.query(sql, settings ? { settings } : {})).length,
    done: () => Promise.resolve(),
    abandon: () => Promise.resolve(),
  };
}

/** Each batch in one transaction, begun at its first statement and committed after its receipt. */
function postgresBatches(server: PgBackfillServer): BatchSession {
  const { client, timeouts } = server;
  let open = false;
  /** Why this batch's transaction was rolled back: its later statements (an activity's retry) do not run without the earlier ones. */
  let lost: string | undefined;
  const rollback = async () => {
    if (!open) return;
    open = false;
    await client.query("ROLLBACK").catch(() => undefined);
  };
  return {
    async read(sql) {
      await rollback();
      return client.query(sql);
    },
    async next() {
      await rollback();
      lost = undefined;
    },
    async sql(sql, settings) {
      if (lost !== undefined) throw new Error(`this batch's transaction was rolled back (${lost}); the batch runs again whole on the next yodel apply`);
      try {
        if (!open) {
          await client.query("BEGIN");
          open = true;
          await client.query(`SET LOCAL lock_timeout = '${String(Math.max(0, Math.floor(timeouts.lockTimeoutMs)))}ms'`);
          await client.query(`SET LOCAL statement_timeout = '${String(Math.max(0, Math.floor(timeouts.scanTimeoutMs)))}ms'`);
        }
        for (const [name, value] of Object.entries(settings ?? {})) await client.query("SELECT pg_catalog.set_config($1, $2, true)", [name, value]);
        return (await client.query(sql)).length;
      } catch (e) {
        lost = e instanceof Error ? e.message : String(e);
        await rollback();
        throw e;
      }
    },
    async done() {
      if (!open) return;
      open = false;
      await client.query("COMMIT");
    },
    abandon: rollback,
  };
}

export interface RunBackfillOptions extends Omit<RunOpOptions, "activities" | "cwd"> {
  projectDir: string;
  migrationId: string;
  /** The migration's directory. */
  dir: string;
  /** The module's text as the migration read it (and checksummed). */
  text?: string | undefined;
  /** The ClickHouse server the SQL runs on; or `postgres`. */
  port?: ClickHousePort | undefined;
  /** The Postgres server the SQL runs on, a transaction per batch; or `port`. */
  postgres?: PgBackfillServer | undefined;
  receipts: ReceiptStore;
  log?: (line: string) => void;
  /** On a tenant (#56): renames the template in each statement the backfill sends. */
  rename?: ((sql: string) => string) | undefined;
}

/** One batch of a form: the receipt's name and the values its placeholders take. */
export interface FormBatch {
  id: string;
  values: Record<string, string>;
}

/** Floor division of bigints. */
const floorDiv = (a: bigint, b: bigint): bigint => (a % b === 0n || a >= 0n ? a / b : a / b - 1n);

/** The ranges `[from, to)` of width `size`, aligned to multiples of it, that cover `lo` to `hi`. */
export function keyRanges(lo: bigint, hi: bigint, size: number): FormBatch[] {
  const width = BigInt(size);
  const out: FormBatch[] = [];
  for (let from = floorDiv(lo, width) * width; from <= hi; from += width) {
    const to = from + width;
    out.push({ id: `${String(from)}-${String(to)}`, values: { "{from}": String(from), "{to}": String(to) } });
  }
  return out;
}

/** A form's batches: its list, or the ranges of its key over the table's rows now (none when the table is empty). */
export async function formBatches(form: BackfillForm, read: (sql: string) => Promise<Array<Record<string, unknown>>>, dialect: "clickhouse" | "postgres"): Promise<FormBatch[]> {
  if (form.key === undefined) return (form.batches ?? []).map((b) => ({ id: String(b), values: { "{batch}": String(b) } }));
  const sql =
    dialect === "clickhouse"
      ? `SELECT count() AS n, toString(min(${form.key})) AS lo, toString(max(${form.key})) AS hi FROM ${form.table}`
      : `SELECT count(*)::text AS n, min(${form.key})::text AS lo, max(${form.key})::text AS hi FROM ${form.table}`;
  const [row] = await read(sql);
  if (!row || Number(row.n) === 0) return [];
  let lo: bigint, hi: bigint;
  try {
    lo = BigInt(String(row.lo));
    hi = BigInt(String(row.hi));
  } catch {
    throw new YodelError(`the backfill's key ${form.key} of ${form.table} is not an integer (its values run from ${String(row.lo)} to ${String(row.hi)}); list the batches with "batches" instead`);
  }
  return keyRanges(lo, hi, form.batchSize ?? 1);
}

/** The SQL of one batch: each placeholder replaced by its value. */
export function batchSql(form: BackfillForm, batch: FormBatch): string[] {
  const statements = typeof form.sql === "string" ? [form.sql] : form.sql;
  return statements.map((s) => formPlaceholders(form).reduce((out, p) => out.split(p).join(batch.values[p] ?? p), s));
}

/** The Op a form runs: one effect() per batch, each running its statements with `yodelSql` and writing its receipt last. */
export async function formOp(name: string, form: BackfillForm, batches: readonly FormBatch[]): Promise<OpConfig> {
  const { EffectReceipt } = await import("@intentius/chant");
  const { Op, activity, effect, phase } = await import("@intentius/chant/op");
  const kind = form.key !== undefined ? "range" : "batch";
  const steps = batches.map((b) =>
    effect(
      EffectReceipt(`${name}-${b.id}`, { effect: `${kind}/${b.id}`, flavor: "existence" }),
      batchSql(form, b).map((sql) => activity(SQL_ACTIVITY, { sql, ...(form.settings ? { settings: form.settings } : {}) }, "atMostOnce")),
    ),
  );
  const op = Op({ name: `backfill-${name}`, overview: `Backfill of ${describeForm(form)}`, phases: [phase("Backfill", steps)] });
  return (op as unknown as { props: OpConfig }).props;
}

/** Runs a backfill step to the end, counting batches as they skip or finish. `source` is the module's file, or the step's form. */
export async function runBackfill(source: string | BackfillForm, run: RunBackfillOptions): Promise<{ summary: BackfillSummary; records: StepRecord[] }> {
  const session = run.postgres ? postgresBatches(run.postgres) : run.port ? clickhouseBatches(run.port) : undefined;
  if (!session) throw new YodelError("a backfill step needs the environment's server to run its SQL on, and has none");
  let config: OpConfig;
  let summary: BackfillSummary;
  if (typeof source === "string") {
    config = await loadBackfill(join(run.dir, source), run.text);
    summary = { op: "backfill", file: source, name: config.name, effects: config.phases.reduce((n, p) => n + p.steps.length, 0), skipped: 0, ran: 0 };
  } else {
    const name = run.migrationId.slice(run.migrationId.indexOf("-") + 1);
    const batches = await formBatches(source, (sql) => session.read(sql), run.postgres ? "postgres" : "clickhouse");
    config = await formOp(name, source, batches);
    summary = { op: "backfill", table: source.table, name: config.name, effects: batches.length, skipped: 0, ran: 0 };
    if (batches.length === 0) {
      run.log?.(`    ${source.table} has no rows: no batch to run`);
      await session.abandon();
      return { summary, records: [] };
    }
  }
  const { receiptActivities } = await import("@intentius/chant/op/receipt-store");
  const store = receiptActivities(prefixedStore(run.receipts, `${run.migrationId}/`));
  const activities: Record<string, ActivityFn> = {
    receiptRead: async (args) => {
      // A new batch: nothing of an earlier one is left open.
      await session.next();
      const r = await store.receiptRead(args as unknown as Parameters<typeof store.receiptRead>[0]);
      if (r.applied) summary.skipped++;
      return r;
    },
    receiptWrite: async (args) => {
      let r: Awaited<ReturnType<typeof store.receiptWrite>>;
      try {
        r = await store.receiptWrite(args as unknown as Parameters<typeof store.receiptWrite>[0]);
        await session.done();
      } catch (e) {
        await session.abandon();
        throw e;
      }
      summary.ran++;
      return r;
    },
    receiptStaleness: (args) => store.receiptStaleness(args as unknown as Parameters<typeof store.receiptStaleness>[0]),
    [SQL_ACTIVITY]: async (args) => {
      const written = args.sql;
      if (typeof written !== "string" || written.trim() === "") throw new Error(`${SQL_ACTIVITY}: needs { sql: "<statement>" }`);
      const sql = run.rename ? run.rename(written) : written;
      const settings = isRecord(args.settings) ? (Object.fromEntries(Object.entries(args.settings).map(([k, v]) => [k, String(v)])) as Record<string, string>) : undefined;
      run.log?.(`    ${sql.split("\n")[0] ?? ""}`);
      return { rows: await session.sql(sql, settings) };
    },
  };
  try {
    const records = await runOp(config, {
      cwd: run.projectDir,
      environment: run.environment,
      activities,
      ...(run.base ? { base: run.base } : {}),
      ...(run.signal ? { signal: run.signal } : {}),
      ...(run.onRecord ? { onRecord: run.onRecord } : {}),
    });
    return { summary, records };
  } catch (e) {
    if (e instanceof StepOpFailed) e.summary = summary;
    throw e;
  } finally {
    // A batch stopped part way (a failed step that was not ours, an abort) leaves nothing behind.
    await session.abandon();
  }
}
