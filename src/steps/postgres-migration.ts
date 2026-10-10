/**
 * A `PostgresMigrationOp` step: a Postgres column rename (SQLPG205) or type
 * change across kinds (SQLPG208), which `yodel new` writes as a step since
 * Postgres cannot make it in place without breaking readers, run inside the
 * migration as chant's expand-and-contract Op.
 *
 * The Op is chant's own (`PostgresMigrationOp` from the sql lexicon), built
 * from the step's options with the apply's environment, and run by chant's
 * local executor with the lexicon's activities, as `ClickHouseRebuildOp` is
 * (`./rebuild.ts`):
 *
 *   Plan, Expand, Dual write, Backfill, Carry over, Verify, Switch, Retain, Contract
 *
 * What differs from `chant run` of the Op:
 *
 * - The declaration is the migration's recorded schema (`migration.json`'s
 *   `schema`), written to a temporary build file, not a fresh `chant build`.
 * - It is built with `gates: "outer"`: the approval is the migration's (the
 *   step and its options are in the migration's checksum, so in the plan
 *   digest the migrations Op's gate approved), so the Op has neither of its
 *   gates (before the switch, before the contract) and no Contract phase of
 *   its own. The verification still runs before the switch, and a
 *   difference (a row whose new column is not the expression over the old,
 *   a NULL where NOT NULL is declared) fails the step with nothing switched.
 * - After the Retain phase the step runs the lexicon's contract activity
 *   (`postgresMigrationContract`, the Op's own Contract step, with the same
 *   arguments), under the same approval. It drops the old column (and a
 *   rename's trigger) only once its retention date has passed. The
 *   retention is the step's `options.retain` when it sets one, else none
 *   (`0s`): the contract drops the old column in the same run, right after
 *   the switch, as the migration's recorded schema says it is gone. A step
 *   that sets `retain` keeps the old column that long; the step succeeds
 *   with it kept, its note says until when, and dropping it after the date
 *   is `chant run` of the Op's declaration (in `migration.json`), whose
 *   contract is convergent.
 * - It is built with `onFailure: "keep"`, so a step that failed or was
 *   stopped keeps what the expand added and resumes on the next `yodel
 *   apply`. Every phase of the Op re-reads the server and does what is left
 *   of it: the expand finds the new column there and adds nothing, the dual
 *   write finds its trigger, the backfill skips every batch whose receipt
 *   is in `<schema>.__chant_receipts` (each receipt commits with its batch,
 *   so a batch is never filled twice), the carry over builds only the
 *   indexes and constraints not yet built (an INVALID one it left is built
 *   again), the verification runs again over every row, and a switch that
 *   already ran is not run again. To start over instead, drop the new
 *   column, its trigger and function (chant's working objects, named in
 *   their comments; a refusal says so).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActivityStep, OpConfig } from "@intentius/chant/op/types";
import type { ActivityFn } from "@intentius/chant/op/activity-registry";
import type { StepRecord } from "@intentius/chant/op/local-executor";
import type { PgMigrationOptions } from "./kinds.js";
import { runOp, StepOpFailed, type RunOpOptions } from "./run.js";

/** The retention a step runs with when its options set none: the contract runs in the same apply. */
export const STEP_RETAIN = "0s";

/**
 * The Op's Contract step for a config built with `gates: "outer"`: the
 * lexicon's contract activity with the Retain step's arguments. It drops the
 * old column only once its retention date has passed.
 */
export function contractPhase(config: OpConfig): OpConfig["phases"][number] {
  const retain = config.phases.flatMap((p) => p.steps).find((s): s is ActivityStep => s.kind === "activity" && s.fn === "postgresMigrationRetain");
  if (!retain) throw new Error(`PostgresMigrationOp "${config.name}" has no Retain step`);
  return { name: "Contract", steps: [{ kind: "activity", fn: "postgresMigrationContract", ...(retain.args ? { args: retain.args } : {}) }] };
}

/** The Op a step runs. `buildPath` is the recorded schema's file; `projectDir` holds chant.config.ts. */
export async function pgMigrationOpConfig(options: PgMigrationOptions, ctx: { environment: string; projectDir: string; buildPath: string; lockTimeoutMs?: number | undefined }): Promise<OpConfig> {
  const { PostgresMigrationOp } = await import("@intentius/chant-lexicon-sql/postgres/migrate/op");
  const lockTimeoutMs = options.lockTimeoutMs ?? ctx.lockTimeoutMs;
  const { op } = PostgresMigrationOp({
    name: options.name,
    env: ctx.environment,
    table: options.table,
    column: options.column,
    ...(options.using !== undefined ? { using: options.using } : {}),
    retain: options.retain ?? STEP_RETAIN,
    ...(options.batchSize !== undefined ? { batchSize: options.batchSize } : {}),
    ...(options.replicationLag !== undefined ? { replicationLag: options.replicationLag } : {}),
    ...(lockTimeoutMs !== undefined ? { lockTimeoutMs } : {}),
    ...(options.statementTimeoutMs !== undefined ? { statementTimeoutMs: options.statementTimeoutMs } : {}),
    build: false,
    output: ctx.buildPath,
    path: ctx.projectDir,
    gates: "outer",
    onFailure: "keep",
  });
  const config = (op as unknown as { props: OpConfig }).props;
  return { ...config, phases: [...config.phases, contractPhase(config)] };
}

export interface PgMigrationSummary {
  op: "PostgresMigrationOp";
  table: string;
  column: string;
  /** The Plan's state when the step began: `migrate`, or `switched` / `done` when an earlier run got that far. */
  state?: string;
  change?: string;
  /** Backfill batches filled in this run, and skipped (their receipt was there). */
  filled?: number;
  skipped?: number;
  backfilledRows?: number;
  /** Indexes and constraints built on the new column in this run. */
  carried?: number;
  verifiedRows?: number;
  switched?: boolean;
  oldColumn?: string;
  retainUntil?: string;
  /** The contract dropped the old column. */
  dropped?: boolean;
}

/** The migration activities whose results the history's summary keeps. */
const SUMMARIZED = ["postgresMigrationPlan", "postgresMigrationBackfill", "postgresMigrationCarry", "postgresMigrationVerify", "postgresMigrationSwitch", "postgresMigrationContract"] as const;

const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Folds one migration activity's result into the summary. */
export function summarizePg(summary: PgMigrationSummary, fn: string, result: unknown): void {
  const r = (typeof result === "object" && result !== null ? result : {}) as Record<string, unknown>;
  const put = <K extends keyof PgMigrationSummary>(k: K, v: PgMigrationSummary[K] | undefined) => {
    if (v !== undefined) summary[k] = v;
  };
  if (fn === "postgresMigrationPlan") {
    put("state", str(r.state));
    put("change", str(r.change));
  }
  if (fn === "postgresMigrationBackfill") {
    put("filled", num(r.filled));
    put("skipped", num(r.skipped));
    put("backfilledRows", num(r.rows));
  }
  if (fn === "postgresMigrationCarry") put("carried", num(r.built));
  if (fn === "postgresMigrationVerify") put("verifiedRows", num(r.rows));
  if (fn === "postgresMigrationSwitch") {
    put("switched", typeof r.switched === "boolean" ? r.switched : undefined);
    put("oldColumn", str(r.oldColumn));
    put("retainUntil", str(r.retainUntil));
  }
  if (fn === "postgresMigrationContract") {
    put("dropped", typeof r.dropped === "boolean" ? r.dropped : undefined);
    put("oldColumn", str(r.oldColumn));
    put("retainUntil", str(r.retainUntil));
  }
}

export interface RunPgMigrationOptions extends Omit<RunOpOptions, "activities" | "cwd"> {
  projectDir: string;
  /** The migration's recorded schema: the `chant build` output after it. */
  schema: unknown;
  /** The environment's lock timeout, used when the step's options set none. */
  lockTimeoutMs?: number | undefined;
  /** Activities to use in place of the lexicon's, for a test. */
  activities?: Record<string, ActivityFn>;
  log?: (line: string) => void;
}

/** Runs a `PostgresMigrationOp` step to the end. The summary fills in as the activities return, so a failure still says how far it got. */
export async function runPgMigration(
  options: PgMigrationOptions,
  run: RunPgMigrationOptions,
  summary: PgMigrationSummary = { op: "PostgresMigrationOp", table: options.table, column: options.column },
): Promise<{ summary: PgMigrationSummary; records: StepRecord[] }> {
  const dir = mkdtempSync(join(tmpdir(), "yodel-pg-migration-"));
  try {
    const buildPath = join(dir, "schema.json");
    writeFileSync(buildPath, JSON.stringify(run.schema));
    const config = await pgMigrationOpConfig(options, { environment: run.environment, projectDir: run.projectDir, buildPath, lockTimeoutMs: run.lockTimeoutMs });
    const lexicon = run.activities ?? ((await import("@intentius/chant-lexicon-sql/op/activities")) as unknown as Record<string, ActivityFn>);
    const wrapped: Record<string, ActivityFn> = {};
    for (const fn of SUMMARIZED) {
      const inner = lexicon[fn];
      if (!inner) continue;
      wrapped[fn] = async (args, signal) => {
        const result = await inner(args, signal);
        summarizePg(summary, fn, result);
        return result;
      };
    }
    const records = await runOp(config, {
      cwd: run.projectDir,
      environment: run.environment,
      activities: { ...(run.activities ?? {}), ...wrapped },
      ...(run.base ? { base: run.base } : {}),
      ...(run.signal ? { signal: run.signal } : {}),
      ...(run.onRecord ? { onRecord: run.onRecord } : {}),
    }).catch((e: unknown) => {
      if (e instanceof StepOpFailed) e.summary = summary;
      throw e;
    });
    return { summary, records };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
