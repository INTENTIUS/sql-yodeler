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
 * - `backfill`, a data backfill the author writes as an Op of `effect()`
 *   steps in a module in the migration's directory (`./backfill.ts`).
 *
 * Everything else (a manual step, `PostgresMigrationOp`, a rebuild in app
 * mode) is refused before anything runs, with exit 2.
 */

import { createHash } from "node:crypto";
import type { MigrationStep } from "@intentius/chant-lexicon-sql/migration-statements";
import { normalizeLineEndings, sortKeys, type MigrationFiles } from "../migrations/document.js";

/** The `op` of a backfill step. */
export const BACKFILL_OP = "backfill";
/** The module a backfill step runs, in the migration's directory, unless its `options.file` names another. */
export const BACKFILL_FILE = "backfill.ts";
export const REBUILD_OP = "ClickHouseRebuildOp";

type OpStep = Extract<MigrationStep, { kind: "op" }>;

/**
 * A backfill step in `migration.json`. chant's `OpStep` shape, so every
 * reader of steps sees an Op step:
 *
 *     { "kind": "op", "object": "backfill", "type": "Yodel::Backfill", "name": "<migration name>",
 *       "op": "backfill", "importPath": "./backfill.ts", "options": { "file": "backfill.ts" },
 *       "declaration": "...", "changes": [], "detail": "..." }
 */
export interface BackfillStep extends Omit<OpStep, "op" | "options"> {
  op: typeof BACKFILL_OP;
  options: { file: string };
}

export type DualWrite = { mode: "materialized-view"; cutoverColumn: string; cutoverDelay?: string } | { mode: "app" };

export interface RebuildOptions {
  name: string;
  table: string;
  dualWrite: DualWrite;
}

export type StepPlan =
  | { run: "statement" }
  | { run: "rebuild"; options: RebuildOptions }
  | { run: "backfill"; file: string }
  | { run: "refused"; reason: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

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

/** How `yodel apply` treats one step. */
export function planStep(step: MigrationStep | BackfillStep): StepPlan {
  if (step.kind === "statement") return { run: "statement" };
  if (step.kind === "manual") return { run: "refused", reason: `a manual step for ${step.object} (${step.name}): no statement and no Op makes it; ${step.detail}` };
  const backfill = asBackfill(step);
  if (backfill) {
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
    return { run: "rebuild", options: { name: o.name, table: o.table, dualWrite: dw as DualWrite } };
  }
  return { run: "refused", reason: `${step.op} for ${step.object} (${step.name}), not SQL: yodel apply does not run that Op` };
}

/** One line naming a step, for logs and refusals. */
export function describeStep(step: MigrationStep | BackfillStep): string {
  if (step.kind === "statement") return `${step.rule} ${step.class}, ${step.name}`;
  if (step.kind === "manual") return `manual step for ${step.object} (${step.name})`;
  const backfill = asBackfill(step);
  if (backfill) return `backfill ${backfill.options.file}`;
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
  if (backfill) {
    const file = backfill.options.file;
    const text = files?.extra?.[file];
    hash.update(`\n${file} ${text === undefined ? "missing" : String(Buffer.byteLength(normalizeLineEndings(text), "utf8"))}\n${normalizeLineEndings(text ?? "")}`, "utf8");
  }
  return `sha256:${hash.digest("hex")}`;
}
