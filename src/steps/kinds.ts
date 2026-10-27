/**
 * What each step of a migration is to `yodel apply`, and the hash its
 * history rows record.
 *
 * A migration's `steps` (in `migration.json`) are chant's: a `statement`
 * apply sends as SQL, an `op` step naming the Op that makes a change no
 * statement makes, or a `manual` step a person acts on. Apply runs two kinds
 * of Op step itself, inside the migration and under its lock and gate:
 *
 * - `ClickHouseRebuildOp`, the step `yodel new` writes for a ClickHouse sort
 *   key, engine or key-column change (`./rebuild.ts`);
 * - `backfill`, a data backfill: written as a form in the step's options
 *   (a table, a key and a batch size, or a list of batches, and the SQL of
 *   one batch), or as an Op of `effect()` steps in a module in the
 *   migration's directory (`./backfill.ts`);
 * - `PostgresMigrationOp`, the step `yodel new` writes for a Postgres column
 *   rename or type change across kinds (`./postgres-migration.ts`, #13).
 *
 * Everything else (a manual step, a rebuild in app mode) is refused before
 * anything runs, with exit 3.
 */

import { createHash } from "node:crypto";
import type { MigrationStep } from "@intentius/chant-lexicon-sql/migration-statements";
import { normalizeLineEndings, sortKeys, type MigrationFiles } from "../migrations/document.js";

/** The `op` of a backfill step. */
export const BACKFILL_OP = "backfill";
/** The module a backfill step runs, in the migration's directory, unless its `options.file` names another. */
export const BACKFILL_FILE = "backfill.ts";
export const REBUILD_OP = "ClickHouseRebuildOp";
export const PG_MIGRATION_OP = "PostgresMigrationOp";

type OpStep = Extract<MigrationStep, { kind: "op" }>;

/**
 * A backfill written as a form, yodel's own terms for the common case: the
 * step's options in `migration.json`, which yodel turns into an Op of
 * `effect()` batches, one receipt each.
 *
 * Batches are either ranges of an integer `key` of `table`, `batchSize`
 * wide (`{from}` and `{to}` in the SQL, from inclusive, to exclusive, read
 * from the table's smallest and largest key when the step runs), or the
 * values `batches` lists (`{batch}` in the SQL). `sql` is one statement, or
 * several run in order, for one batch.
 */
export interface BackfillForm {
  table: string;
  key?: string;
  batchSize?: number;
  batches?: Array<string | number>;
  sql: string | string[];
  /** Settings for each statement: ClickHouse query settings (`mutations_sync`), Postgres `set_config` for the batch's transaction. */
  settings?: Record<string, string>;
}

/**
 * A backfill step in `migration.json`. chant's `OpStep` shape, so every
 * reader of steps sees an Op step. Its options are a {@link BackfillForm},
 * or name the module that exports the Op:
 *
 *     { "kind": "op", "object": "backfill", "type": "Yodel::Backfill", "name": "<migration name>",
 *       "op": "backfill", "importPath": "./backfill.ts", "options": { "file": "backfill.ts" },
 *       "declaration": "...", "changes": [], "detail": "..." }
 */
export interface BackfillStep extends Omit<OpStep, "op" | "options"> {
  op: typeof BACKFILL_OP;
  options: { file: string } | BackfillForm;
}

export type DualWrite = { mode: "materialized-view"; cutoverColumn: string; cutoverDelay?: string } | { mode: "app" };

export interface RebuildOptions {
  name: string;
  table: string;
  dualWrite: DualWrite;
  /** How long the old table is kept after the swap; default chant's (7 days). */
  retain?: string;
}

/** A `PostgresMigrationOp` step's options: chant's `{ name, env, table, column }`, and what the author may add (`using`, `retain`, ...). */
export interface PgMigrationOptions {
  name: string;
  table: string;
  column: string;
  using?: string;
  /** How long the old column is kept after the switch; default none, so the contract runs in the same apply. */
  retain?: string;
  batchSize?: number;
  replicationLag?: { max?: string; wait?: string } | false;
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
}

export type StepPlan =
  | { run: "statement" }
  | { run: "rebuild"; options: RebuildOptions }
  | { run: "pgMigration"; options: PgMigrationOptions }
  | { run: "backfill"; file: string; form?: undefined }
  | { run: "backfill"; form: BackfillForm; file?: undefined }
  | { run: "refused"; reason: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const optional = <T>(o: Record<string, unknown>, key: string, ok: (v: unknown) => v is T): T | undefined | null => {
  const v = o[key];
  if (v === undefined) return undefined;
  return ok(v) ? v : null;
};
const isString = (v: unknown): v is string => typeof v === "string" && v !== "";
const isPositiveInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

/** The step as a backfill step, when it is one. */
export const asBackfill = (step: MigrationStep | BackfillStep): BackfillStep | undefined =>
  step.kind === "op" && (step.op as string) === BACKFILL_OP ? (step as unknown as BackfillStep) : undefined;

/** The file a backfill step names: relative to the migration's directory, `/`-separated, inside it. */
function backfillFile(options: unknown): string | undefined {
  const file = isRecord(options) ? options.file : undefined;
  if (typeof file !== "string" || file === "") return undefined;
  const parts = file.split("/");
  if (parts.some((p) => p === "" || p === "." || p === ".." || p.startsWith(".")) || file.includes("\\")) return undefined;
  return file;
}

/** The placeholders a form's SQL takes: `{from}` and `{to}` with a key, `{batch}` with a list. */
export const formPlaceholders = (form: Pick<BackfillForm, "key">): string[] => (form.key !== undefined ? ["{from}", "{to}"] : ["{batch}"]);

/** What is wrong with a backfill form, if anything. */
export function formProblems(options: unknown): string[] {
  if (!isRecord(options)) return ["a backfill form is an object"];
  const o = options;
  const problems: string[] = [];
  const known = new Set(["table", "key", "batchSize", "batches", "sql", "settings"]);
  for (const k of Object.keys(o)) if (!known.has(k)) problems.push(`"${k}" is not a field of a backfill (${[...known].join(", ")})`);
  if (!isString(o.table)) problems.push(`"table" names the table the backfill fills, for example "shop.orders"`);
  const sql = typeof o.sql === "string" ? [o.sql] : Array.isArray(o.sql) ? o.sql : undefined;
  if (!sql || sql.length === 0 || !sql.every((x) => typeof x === "string" && x.trim() !== "")) problems.push(`"sql" is the SQL of one batch: a statement, or a list of them`);
  const byKey = o.key !== undefined || o.batchSize !== undefined;
  if (byKey && o.batches !== undefined) problems.push(`give "key" and "batchSize", or "batches", not both`);
  else if (byKey) {
    if (!isString(o.key)) problems.push(`"key" is an integer column of the table, the batches are ranges of it`);
    if (!isPositiveInt(o.batchSize)) problems.push(`"batchSize" is how wide each range of the key is, a positive integer`);
  } else if (o.batches !== undefined) {
    if (!Array.isArray(o.batches) || o.batches.length === 0 || !o.batches.every((b) => typeof b === "string" || (typeof b === "number" && Number.isFinite(b)))) {
      problems.push(`"batches" lists the batches, strings or numbers, for example ["202601", "202602"]`);
    } else if (new Set(o.batches.map(String)).size !== o.batches.length) problems.push(`"batches" lists a batch twice`);
  } else problems.push(`give "key" and "batchSize" (ranges of an integer key), or "batches" (a list)`);
  if (o.settings !== undefined && !(isRecord(o.settings) && Object.values(o.settings).every((v) => typeof v === "string" || typeof v === "number"))) problems.push(`"settings" maps a setting's name to its value`);
  if (sql && problems.length === 0) {
    const want = formPlaceholders(o);
    const text = sql.join("\n");
    if (!want.some((p) => text.includes(p))) problems.push(`"sql" uses none of ${want.join(" and ")}, so every batch would run the same statement`);
  }
  return problems;
}

/** The step's options as a form, when they are one (no `file`). */
export function asForm(options: unknown): BackfillForm | undefined {
  if (!isRecord(options) || "file" in options) return undefined;
  if (formProblems(options).length > 0) return undefined;
  const o = options as unknown as BackfillForm;
  return {
    table: o.table,
    ...(o.key !== undefined ? { key: o.key, batchSize: o.batchSize as number } : { batches: o.batches as Array<string | number> }),
    sql: o.sql,
    ...(o.settings ? { settings: Object.fromEntries(Object.entries(o.settings as Record<string, unknown>).map(([k, v]) => [k, String(v)])) } : {}),
  };
}

/** One line saying how a form batches: `shop.orders by id, 10000 a batch` or `shop.orders, 3 batches`. */
export function describeForm(form: BackfillForm): string {
  return form.key !== undefined ? `${form.table} by ${form.key}, ${String(form.batchSize)} a batch` : `${form.table}, ${String(form.batches?.length ?? 0)} batch${form.batches?.length === 1 ? "" : "es"} (${(form.batches ?? []).join(", ")})`;
}

/** How `yodel apply` treats one step. */
export function planStep(step: MigrationStep | BackfillStep): StepPlan {
  if (step.kind === "statement") return { run: "statement" };
  if (step.kind === "manual") return { run: "refused", reason: `a manual step for ${step.object} (${step.name}): no statement and no Op makes it; ${step.detail}` };
  const backfill = asBackfill(step);
  if (backfill) {
    if (isRecord(backfill.options) && !("file" in backfill.options)) {
      const form = asForm(backfill.options);
      return form ? { run: "backfill", form } : { run: "refused", reason: `a backfill step whose form is not one yodel runs: ${formProblems(backfill.options).join("; ")}` };
    }
    const file = backfillFile(backfill.options);
    return file ? { run: "backfill", file } : { run: "refused", reason: `a backfill step whose options.file is not a file in the migration's directory (${JSON.stringify(backfill.options)})` };
  }
  if (step.op === REBUILD_OP) {
    const o = step.options;
    const dw = isRecord(o.dualWrite) ? o.dualWrite : undefined;
    if (typeof o.name !== "string" || typeof o.table !== "string" || !dw) {
      return { run: "refused", reason: `${REBUILD_OP} for ${step.object} (${step.name}) without its name, table and dualWrite options` };
    }
    if (dw.mode === "app") {
      return {
        run: "refused",
        reason:
          `${REBUILD_OP} for ${step.object} (${step.name}) in app mode: the application has to stop writing to ${o.table} while it is rebuilt, ` +
          `which needs the Op's own writes gate; yodel apply runs materialized-view mode only. Run the Op with chant run (migration.json holds its declaration)`,
      };
    }
    if (dw.mode !== "materialized-view" || typeof dw.cutoverColumn !== "string") {
      return { run: "refused", reason: `${REBUILD_OP} for ${step.object} (${step.name}): dualWrite ${JSON.stringify(dw)} is not one yodel apply runs` };
    }
    const retain = optional(o, "retain", isString);
    if (retain === null) return { run: "refused", reason: `${REBUILD_OP} for ${step.object} (${step.name}): options.retain is ${JSON.stringify(o.retain)}, which is not a duration` };
    return { run: "rebuild", options: { name: o.name, table: o.table, dualWrite: dw as DualWrite, ...(retain ? { retain } : {}) } };
  }
  if (step.op === PG_MIGRATION_OP) return planPgMigration(step);
  return { run: "refused", reason: `${step.op} for ${step.object} (${step.name}), not SQL: yodel apply does not run that Op` };
}

const isLag = (v: unknown): v is PgMigrationOptions["replicationLag"] => v === false || (isRecord(v) && Object.values(v).every((x) => typeof x === "string"));

function planPgMigration(step: OpStep): StepPlan {
  const o = step.options;
  const bad = (what: string): StepPlan => ({ run: "refused", reason: `${PG_MIGRATION_OP} for ${step.object} (${step.name}): ${what}` });
  if (!isString(o.name) || !isString(o.table) || !isString(o.column)) return bad("without its name, table and column options");
  const using = optional(o, "using", isString);
  const retain = optional(o, "retain", isString);
  const batchSize = optional(o, "batchSize", isPositiveInt);
  const lockTimeoutMs = optional(o, "lockTimeoutMs", isPositiveInt);
  const statementTimeoutMs = optional(o, "statementTimeoutMs", isPositiveInt);
  const replicationLag = optional(o, "replicationLag", isLag);
  for (const [k, v] of Object.entries({ using, retain, batchSize, lockTimeoutMs, statementTimeoutMs, replicationLag })) {
    if (v === null) return bad(`options.${k} is ${JSON.stringify(o[k])}, which is not one it takes`);
  }
  return {
    run: "pgMigration",
    options: {
      name: o.name,
      table: o.table,
      column: o.column,
      ...(using ? { using } : {}),
      ...(retain ? { retain } : {}),
      ...(batchSize ? { batchSize } : {}),
      ...(lockTimeoutMs ? { lockTimeoutMs } : {}),
      ...(statementTimeoutMs ? { statementTimeoutMs } : {}),
      ...(replicationLag !== undefined && replicationLag !== null ? { replicationLag } : {}),
    },
  };
}

/** One line naming a step, for logs and refusals. */
export function describeStep(step: MigrationStep | BackfillStep): string {
  if (step.kind === "statement") return `${step.rule} ${step.class}, ${step.name}`;
  if (step.kind === "manual") return `manual step for ${step.object} (${step.name})`;
  const backfill = asBackfill(step);
  if (backfill) {
    const form = asForm(backfill.options);
    return form ? `backfill of ${describeForm(form)}` : `backfill ${"file" in backfill.options ? backfill.options.file : "(a form yodel does not run)"}`;
  }
  return `${step.op} for ${step.object} (${step.name})`;
}

/**
 * The hash a step's history rows record: for a statement, its SQL's (the
 * history's `statementSha`); for an Op step, its canonical JSON and, for a
 * backfill, the text of the module it runs. A step that ran and has since
 * changed is how a part-way migration's edit is caught.
 */
export function stepSha(step: MigrationStep | BackfillStep, files?: Pick<MigrationFiles, "extra">): string {
  const hash = createHash("sha256");
  if (step.kind === "statement") return `sha256:${hash.update(step.sql, "utf8").digest("hex")}`;
  hash.update(JSON.stringify(sortKeys(step)), "utf8");
  const backfill = asBackfill(step);
  if (backfill && "file" in backfill.options) {
    const file = backfill.options.file;
    const text = files?.extra?.[file];
    hash.update(`\n${file} ${text === undefined ? "missing" : String(Buffer.byteLength(normalizeLineEndings(text), "utf8"))}\n${normalizeLineEndings(text ?? "")}`, "utf8");
  }
  return `sha256:${hash.digest("hex")}`;
}
