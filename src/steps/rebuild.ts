/**
 * A `ClickHouseRebuildOp` step: the change ClickHouse cannot make with
 * `ALTER` (a sort key, an engine, a key column's type or name), run inside
 * the migration as chant's rebuild Op.
 *
 * The Op is chant's own (`ClickHouseRebuildOp` from the sql lexicon), built
 * from the step's options with the apply's environment, and run by chant's
 * local executor with the lexicon's rebuild activities:
 *
 *   Plan, Create, Dual write (materialized-view mode), Backfill, Verify, Swap, Retain
 *
 * Three things differ from running the Op with `chant run`:
 *
 * - The declaration is the migration's recorded schema (`migration.json`'s
 *   `schema`), written to a temporary build file, not a fresh `chant build`:
 *   the table is rebuilt as this migration declares it, however far the
 *   declared schema has moved on since.
 * - Its gates are left out. The swap gate's approval is the migration's:
 *   the step's options are in the migration's checksum, which is in the plan
 *   digest the migrations Op's gate approved. The verification still runs
 *   before the swap, and a difference fails the step with nothing swapped.
 *   The old table is kept, `<table>__chant_old`, until its retention date
 *   (7 days); the Op's drop gate and Drop phase are not part of the step.
 * - Its onFailure (which drops the new table) is left out, so a step that
 *   failed or was killed part way resumes from the backfill's receipts on
 *   the next `yodel apply`: every partition with a receipt is skipped. To
 *   start the rebuild over instead, drop `<table>__chant_new` and
 *   `<table>__chant_dual`.
 *
 * The activities render their DDL for the topology chant resolves from
 * `sql.profiles.<env>.topology`. When the environment's topology comes from
 * elsewhere (`yodel.config.ts`, or `YODEL_TOPOLOGY`, #9), the step hands
 * every rebuild activity chant's config with that topology set on the
 * profile ({@link rebuildChantConfig}), so the rebuild renders for the same
 * topology as the migration's statements.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpConfig, PhaseDefinition } from "@intentius/chant/op/types";
import type { ActivityFn } from "@intentius/chant/op/activity-registry";
import type { StepRecord } from "@intentius/chant/op/local-executor";
import type { Topology } from "@intentius/chant-lexicon-sql/clickhouse/topology";
import type { RebuildOptions } from "./kinds.js";
import { environmentSettings } from "../config/settings.js";
import { loadProject, type ProjectConfig } from "../project.js";
import { runOp, StepOpFailed, type RunOpOptions } from "./run.js";

/** The rebuild activities whose results the history's summary keeps. */
const SUMMARIZED = ["clickhouseRebuildPlan", "clickhouseRebuildBackfill", "clickhouseRebuildVerify", "clickhouseRebuildSwap", "clickhouseRebuildRetain"] as const;

/** `config` with `sql.profiles.<environment>.topology` set to `topology`. Pure; `config` is not changed. */
export function withProfileTopology(config: ProjectConfig, environment: string, topology: Topology): ProjectConfig {
  const profiles = config.sql?.profiles ?? {};
  const profile = profiles[environment];
  if (!profile) return config;
  return { ...config, sql: { ...config.sql, profiles: { ...profiles, [environment]: { ...profile, topology } } } };
}

/**
 * The chant config a rebuild step's activities bind with: the project's,
 * with the environment's resolved topology on its profile when chant would
 * not find it there itself. `undefined` when chant's own resolution already
 * gives the same topology (set in the profile, or no topology anywhere).
 */
export async function rebuildChantConfig(projectDir: string, environment: string, env: NodeJS.ProcessEnv = process.env): Promise<ProjectConfig | undefined> {
  const project = await loadProject(projectDir);
  const settings = environmentSettings(project, environment, env);
  if (settings.topologySource === "default" || settings.topologySource === `sql.profiles.${environment}.topology`) return undefined;
  return withProfileTopology(project.config, environment, settings.topology);
}

/** The activity of the phase left out: the old table's drop, which waits for its retention and its own gate. */
const LEFT_OUT = new Set(["clickhouseRebuildDrop"]);

/** `ClickHouseRebuildOp`'s phases as a step runs them: no gates, no Drop, no onFailure. */
export function stepPhases(config: OpConfig): PhaseDefinition[] {
  return config.phases
    .map((p) => ({ ...p, steps: p.steps.filter((s) => s.kind !== "gate" && !(s.kind === "activity" && LEFT_OUT.has(s.fn))) }))
    .filter((p) => p.steps.length > 0);
}

/** The Op a rebuild step runs. `buildPath` is the recorded schema's file; `projectDir` holds chant.config.ts. */
export async function rebuildOpConfig(options: RebuildOptions, ctx: { environment: string; projectDir: string; buildPath: string }): Promise<OpConfig> {
  const { ClickHouseRebuildOp } = await import("@intentius/chant-lexicon-sql/clickhouse/rebuild/op");
  const { op } = ClickHouseRebuildOp({
    name: options.name,
    env: ctx.environment,
    table: options.table,
    dualWrite: options.dualWrite,
    build: false,
    output: ctx.buildPath,
    path: ctx.projectDir,
  });
  const full = (op as unknown as { props: OpConfig }).props;
  const rest: OpConfig = { ...full, phases: stepPhases(full) };
  delete rest.onFailure;
  return rest;
}

export interface RebuildSummary {
  op: "ClickHouseRebuildOp";
  table: string;
  /** The Plan's state when the step began: `rebuild`, or `swapped` / `done` when an earlier run got that far. */
  state?: string;
  partitions?: number;
  /** Partitions copied in this run. */
  copied?: number;
  /** Partitions skipped: their receipt matched (copied by an earlier run). */
  skipped?: number;
  /** Partitions found partly copied and cleared before copying again. */
  cleared?: number;
  /** Rows copied by both the backfill and the dual-write view, deleted and copied again. */
  repaired?: number;
  /** Rows compared in the whole table, old against new. */
  verifiedRows?: number;
  swapped?: boolean;
  oldTable?: string;
  retainUntil?: string;
}

const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Folds one rebuild activity's result into the summary. */
export function summarize(summary: RebuildSummary, fn: string, result: unknown): void {
  const r = (typeof result === "object" && result !== null ? result : {}) as Record<string, unknown>;
  const put = <K extends keyof RebuildSummary>(k: K, v: RebuildSummary[K] | undefined) => {
    if (v !== undefined) summary[k] = v;
  };
  if (fn === "clickhouseRebuildPlan") put("state", str(r.state));
  if (fn === "clickhouseRebuildBackfill") {
    put("partitions", num(r.partitions));
    put("copied", num(r.copied));
    put("skipped", num(r.skipped));
    put("cleared", num(r.cleared));
    put("repaired", num(r.repaired));
  }
  if (fn === "clickhouseRebuildVerify") put("verifiedRows", num(r.rows));
  if (fn === "clickhouseRebuildSwap") {
    put("swapped", typeof r.swapped === "boolean" ? r.swapped : undefined);
    put("oldTable", str(r.oldTable));
    put("retainUntil", str(r.retainUntil));
  }
  if (fn === "clickhouseRebuildRetain") {
    put("oldTable", str(r.oldTable));
    put("retainUntil", str(r.retainUntil));
  }
}

export interface RunRebuildOptions extends Omit<RunOpOptions, "activities" | "cwd"> {
  projectDir: string;
  /** The migration's recorded schema: the `chant build` output after it. */
  schema: unknown;
  /** Activities to use in place of the lexicon's, for a test. */
  activities?: Record<string, ActivityFn>;
  log?: (line: string) => void;
  /** The chant config the rebuild activities bind with (see {@link rebuildChantConfig}). Default: they load chant.config.ts. */
  config?: ProjectConfig | undefined;
}

/** Runs a rebuild step to the end. The summary is filled in as the activities return, so a failure still says how far it got. */
export async function runRebuild(options: RebuildOptions, run: RunRebuildOptions, summary: RebuildSummary = { op: "ClickHouseRebuildOp", table: options.table }): Promise<{ summary: RebuildSummary; records: StepRecord[] }> {
  const dir = mkdtempSync(join(tmpdir(), "yodel-rebuild-"));
  try {
    const buildPath = join(dir, "schema.json");
    writeFileSync(buildPath, JSON.stringify(run.schema));
    const config = await rebuildOpConfig(options, { environment: run.environment, projectDir: run.projectDir, buildPath });
    const lexicon = run.activities ?? ((await import("@intentius/chant-lexicon-sql/op/activities")) as unknown as Record<string, ActivityFn>);
    const wrapped: Record<string, ActivityFn> = {};
    // A rebuild activity takes its config as a third argument (chant's ClickHouseRebuildDeps).
    const deps = run.config ? { config: run.config } : undefined;
    const summarized: readonly string[] = SUMMARIZED;
    for (const fn of Object.keys(lexicon).filter((f) => f.startsWith("clickhouseRebuild") && (deps !== undefined || summarized.includes(f)))) {
      const inner = lexicon[fn] as ((args: Record<string, unknown>, signal?: AbortSignal, deps?: unknown) => Promise<unknown>) | undefined;
      if (!inner) continue;
      wrapped[fn] = async (args, signal) => {
        const result = await (deps ? inner(args, signal, deps) : inner(args, signal));
        if (summarized.includes(fn)) summarize(summary, fn, result);
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
