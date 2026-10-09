/**
 * Running an Op step's Op in this process, with chant's local executor
 * (`runOpLocally`, the executor `chant run` uses), inside the versioned
 * apply that holds the lock.
 *
 * The activities are the ones `chant run` loads for a sql project (core's,
 * and the sql lexicon's, the rebuild's among them), plus what the step adds
 * (a backfill's receipt store and its `yodelSql`). Nothing is written to the
 * run ledger: the history table is the record of what ran.
 *
 * A step's Op has no gate of its own here. The migration it is part of was
 * approved under the plan digest, which covers the step through the
 * migration's checksum; a gate left in the Op is refused before it runs.
 */

import type { OpConfig, StepDefinition } from "@intentius/chant/op/types";
import type { ActivityFn } from "@intentius/chant/op/activity-registry";
import type { StepRecord } from "@intentius/chant/op/local-executor";
import { YodelError } from "../project.js";

/** A step's Op stopped part way. The history records it failed; the next run resumes it. */
export class StepOpFailed extends YodelError {
  /** How far it got, for the history's note: set by the step that ran it. */
  summary: unknown;

  constructor(
    readonly op: string,
    readonly detail: string,
    readonly records: StepRecord[],
  ) {
    super(`${op}: ${detail}`, 1);
    this.name = "StepOpFailed";
  }
}

const allSteps = (config: Pick<OpConfig, "phases" | "onFailure">): StepDefinition[] =>
  [...config.phases, ...(config.onFailure ?? [])].flatMap((p) => p.steps.flatMap((s) => (s.kind === "effect" ? [s, ...s.steps] : [s])));

/** The gates in an Op, by name. */
export const gatesOf = (config: Pick<OpConfig, "phases" | "onFailure">): string[] => allSteps(config).flatMap((s) => (s.kind === "gate" ? [s.gate ?? "unnamed"] : []));

/** The first failing record's error, for the message. */
export function failureOf(records: readonly StepRecord[]): string {
  const failed = records.find((r) => r.status === "fail");
  return failed ? `${failed.phase} / ${failed.fn} failed: ${failed.error ?? "no error given"}` : "the Op failed";
}

export interface RunOpOptions {
  /** The project directory: chant's config is read from it. */
  cwd: string;
  /** The environment, handed to the activities through the run context. */
  environment: string;
  /** Activities added to (or replacing) the ones chant loads. */
  activities?: Record<string, ActivityFn>;
  /** The activities to use instead of loading chant's, for a test. */
  base?: Map<string, ActivityFn>;
  signal?: AbortSignal;
  onRecord?: (record: StepRecord) => void;
}

/** Runs `config` to the end. Resolves with its records; throws {@link StepOpFailed} when it fails, or stops at a gate or a decision point. */
export async function runOp(config: OpConfig, options: RunOpOptions): Promise<StepRecord[]> {
  const gates = gatesOf(config);
  if (gates.length > 0) {
    throw new StepOpFailed(config.name, `it has a gate (${gates.join(", ")}); a step's Op runs behind the migration's own gate and may not have one of its own`, []);
  }
  const { loadActivities, loadProfiles } = await import("@intentius/chant/op/activity-registry");
  const { runOpLocally, OpRunFailure } = await import("@intentius/chant/op/local-executor");
  const activities = options.base ? new Map(options.base) : await loadActivities(["sql"]);
  for (const [name, fn] of Object.entries(options.activities ?? {})) activities.set(name, fn);
  const profiles = await loadProfiles();
  try {
    const result = await runOpLocally(config, activities, profiles, options.signal, {
      cwd: options.cwd,
      env: options.environment,
      ...(options.onRecord ? { onRecord: options.onRecord } : {}),
    });
    if (result.status !== "ok") throw new StepOpFailed(config.name, `it stopped (${result.status}) instead of running to the end`, result.records);
    return result.records;
  } catch (e) {
    if (e instanceof StepOpFailed) throw e;
    if (e instanceof OpRunFailure) {
      const cause = e.cause instanceof Error ? e.cause.message : typeof e.cause === "string" ? e.cause : undefined;
      const failedStep = e.result.records.some((r) => r.status === "fail");
      throw new StepOpFailed(config.name, failedStep ? failureOf(e.result.records) : (cause ?? "the Op failed"), e.result.records);
    }
    throw new StepOpFailed(config.name, e instanceof Error ? e.message : String(e), []);
  }
}
