/**
 * `yodel init --baseline <env>` (#115): records the project's baseline
 * applied in another environment that already holds its schema (staging,
 * prod), without running it.
 *
 * The baseline is the project's first migration. The environment's live
 * schema is planned against the schema the baseline records, offline from
 * `migration.json`: the plan must be empty. A difference refuses (exit 4),
 * naming each object and what differs, and nothing is recorded.
 *
 * The record goes through the environment's migrations Op, as `yodel
 * revert` does (`../versioned/revert.ts`), with the baseline's id in
 * `YODEL_BASELINE`: its Plan step (`yodel apply <env> --digest`) compares
 * again and prints the baseline's digest (the baseline, the empty history
 * and the live schema), the gate binds the approval to it, and its Apply
 * step (`yodel apply <env> --execute`) takes the lock, checks that the
 * history is still empty, compares again, refuses if the digest moved,
 * checks the approval in chant's gate ledger and appends the one history
 * row ({@link baselineRow}), with the digest it was approved under.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { YodelError, type Environment, type Project } from "../project.js";
import { EXIT_REFUSED } from "../exit.js";
import type { Build, BuildOutput } from "../chant/build.js";
import type { ClassifiedChange } from "@intentius/chant-lexicon-sql/core/classifier";
import { planEnvironment, renderPlan, unreadableOf } from "../chant/plan.js";
import { clickhouseAccessRefusal } from "../chant/access.js";
import { declarativeAccessRefusal, declarativeTopologyRefusal } from "../config/settings.js";
import type { Migration } from "../migrations/index.js";
import { appliedBy, withLock, type HistoryRow } from "../history/index.js";
import { sameDigest } from "../versioned/digest.js";
import { BASELINE_ENV } from "../versioned/op.js";
import type { VersionedEnv } from "../versioned/engine.js";
import { baselineRow, historyRefusal } from "./baseline.js";

/** chant's plan-digest kind for recording a baseline: never an apply's or a revert's. */
export const BASELINE_DIGEST_KIND = "yodel-baseline";

/** The note a baseline row recorded by `yodel init --baseline` carries. */
export const recordedBaselineNote = (environment: string): string =>
  `baseline: recorded by yodel init --baseline ${environment}, whose live schema matched the schema it records; its statements were not run`;

/** The project's baseline: its first migration. Refuses a project with none. */
export function projectBaseline(ordered: readonly Migration[]): Migration {
  const first = ordered[0];
  if (!first) {
    throw new YodelError(
      "refused: the project has no migrations, so there is no baseline to record; adopt an environment with yodel init --from <env> first. Nothing was recorded.",
      EXIT_REFUSED,
    );
  }
  return first;
}

/** The refusals before anything is read: the same as yodel drift's, since the comparison is a plan of a recorded schema. */
export function baselineConfigRefusal(project: Project, env: Environment, schema: BuildOutput): YodelError | undefined {
  if (project.dialect === "clickhouse") return declarativeTopologyRefusal(project, env.name) ?? clickhouseAccessRefusal(project, env.name, schema, "the baseline's recorded schema");
  return declarativeAccessRefusal(project, env.name);
}

/** A recorded schema as a build file the planner reads, in a temporary directory its dispose removes. */
function recordedBuild(schema: BuildOutput): Build {
  const dir = mkdtempSync(join(tmpdir(), "yodel-baseline-"));
  const path = join(dir, "schema.json");
  writeFileSync(path, JSON.stringify(schema));
  return { path, output: schema, dispose: () => { rmSync(dir, { recursive: true, force: true }); } };
}

/** One difference between the environment and the baseline, as a person reads it. */
export function describeChange(c: ClassifiedChange): string {
  const values = c.before !== undefined || c.after !== undefined ? `: ${c.before ?? "(none)"} in the environment, ${c.after ?? "(none)"} in the baseline` : "";
  return `${c.object} ${c.field}${values} (${c.rule})`;
}

export interface BaselineComparison {
  /** Each difference, one line each; empty when the environment holds the baseline's schema. */
  differences: string[];
  /** chant's plan of the baseline against the environment, as text, when there is a difference. */
  plan?: string;
}

/**
 * Plans the baseline's recorded schema against `env`'s live database. Every
 * change counts: an object the baseline declares that differs or is
 * missing, and an object the environment has in the project's databases or
 * schemas that the baseline does not declare.
 */
export async function compareBaseline(project: Project, env: Environment, baseline: Migration, processEnv: NodeJS.ProcessEnv = process.env): Promise<BaselineComparison> {
  const build = recordedBuild(baseline.document.schema);
  try {
    const plan = await planEnvironment(project, env, build, { env: processEnv });
    const changes: ClassifiedChange[] = [...plan.diff.changes, ...plan.refused];
    const differences = [
      ...changes.map(describeChange),
      ...unreadableOf(plan).map((u) => `${u.object}: ${u.type} that chant cannot read (${u.reason})`),
    ];
    if (differences.length === 0) return { differences };
    return { differences: [...new Set(differences)], plan: await renderPlan(plan, `Plan of ${baseline.id} against ${env.name}`) };
  } finally {
    build.dispose();
  }
}

/** The refusal for a difference: names each one, and records nothing. */
export function differenceRefusal(env: string, baseline: string, cmp: BaselineComparison): YodelError {
  return new YodelError(
    `refused: ${env}'s live schema is not the schema ${baseline} records, so the baseline cannot be recorded applied there. ` +
      `${String(cmp.differences.length)} difference${cmp.differences.length === 1 ? "" : "s"}:\n${cmp.differences.map((d) => `  ${d}`).join("\n")}\n` +
      `Make ${env} hold the baseline's schema (or empty it, and let yodel apply run the baseline), then run yodel init --baseline ${env} again. Nothing was recorded.`,
    EXIT_REFUSED,
  );
}

/** Refuses when `env`'s history records anything: the baseline is the first thing a history records. */
async function historyEmpty(venv: VersionedEnv): Promise<void> {
  const refusal = historyRefusal(await venv.store.state(), `${venv.location.database}.history`);
  if (refusal) throw refusal;
}

/** The record's plan digest: the baseline, where the history is, and the live schema, as chant computes digests. */
export async function baselineDigest(venv: VersionedEnv, baseline: Pick<Migration, "id" | "checksum">): Promise<string> {
  const { computePlanDigest } = await import("@intentius/chant/lifecycle/plan-digest");
  const live = await venv.driver.liveFingerprint();
  return computePlanDigest(BASELINE_DIGEST_KIND, {
    environment: venv.environment,
    historyDatabase: venv.location.database,
    topology: venv.topology ?? { kind: "single" },
    baseline: { id: baseline.id, checksum: baseline.checksum },
    live,
  });
}

/**
 * The Plan step's half (and `yodel init --baseline` before the Op): refuses
 * a history that records anything and a live schema that differs, and
 * returns the digest the gate binds.
 */
export async function planBaseline(project: Project, env: Environment, venv: VersionedEnv, baseline: Migration, processEnv: NodeJS.ProcessEnv = process.env): Promise<string> {
  const refusal = baselineConfigRefusal(project, env, baseline.document.schema);
  if (refusal) throw refusal;
  await historyEmpty(venv);
  const cmp = await compareBaseline(project, env, baseline, processEnv);
  if (cmp.differences.length > 0) throw differenceRefusal(env.name, baseline.id, cmp);
  return baselineDigest(venv, baseline);
}

export interface RecordBaselineOptions {
  /** The digest the Op's gate passed. A record whose digest moved since is refused. */
  approvedDigest: string;
  /** Checks the approval for the digest computed under the lock; throws to refuse. */
  approve: (digest: string) => Promise<unknown>;
  log: (line: string) => void;
  processEnv?: NodeJS.ProcessEnv;
}

/** The Apply step's half: under the lock, plans again, checks the digest and the approval, and appends the baseline's row. */
export async function executeBaseline(project: Project, env: Environment, venv: VersionedEnv, baseline: Migration, options: RecordBaselineOptions): Promise<HistoryRow> {
  const processEnv = options.processEnv ?? process.env;
  const by = appliedBy(processEnv);
  const lock = await venv.driver.acquireLock(by);
  if (lock.notice) options.log(`lock: ${lock.notice}`);
  return withLock(lock, venv.lockTtlMs, async () => {
    const digest = await planBaseline(project, env, venv, baseline, processEnv);
    if (!(await sameDigest(digest, options.approvedDigest))) {
      throw new YodelError(`the baseline's plan moved since it was approved (approved ${options.approvedDigest}, now ${digest}); nothing was recorded. Run yodel init --baseline ${env.name} again.`);
    }
    await options.approve(digest);
    await venv.store.ensure();
    const state = await venv.store.state();
    const refusal = historyRefusal(state, `${venv.location.database}.history`);
    if (refusal) throw refusal;
    const row = { ...baselineRow(baseline, { seq: state.maxSeq + 1, runId: randomUUID(), appliedBy: by, environment: env.name }), plan_digest: digest, note: recordedBaselineNote(env.name) };
    await venv.store.append([row]);
    options.log(`recorded ${baseline.id} applied in ${venv.location.database}.history as a baseline; none of its statements was run`);
    return row;
  });
}

/** The baseline `yodel init --baseline` asked the Op to record, from its environment. */
export const baselineFromEnv = (env: NodeJS.ProcessEnv): string | undefined => env[BASELINE_ENV] || undefined;
