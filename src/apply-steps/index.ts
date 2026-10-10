/**
 * Steps around apply (#64): per environment, `yodel.config.ts`
 * `environments.<env>.steps.before` and `.after`, SQL checks or commands
 * run around the versioned apply.
 *
 * - Read at the base commit (`../config/base.ts`), as the plan policy is:
 *   a pull request that adds, removes or loosens a step is run under the
 *   steps the branch had. A checkout with no base to read runs none.
 * - `before` steps run under the lock before the first migration. SQL
 *   checks also run when the run is planned (the wave plan, or `yodel apply`
 *   before the gate), since they only read; a command, which may have side
 *   effects, runs once per apply, under the lock, and the plan only shows
 *   that it will (#107). One that fails refuses the run (exit 4) unless its
 *   `onFailure` is `approve`: then the wave is held for a person, whatever
 *   its gate, and the plan they approve says which steps failed.
 * - `after` steps run under the lock once the last migration's statements
 *   succeeded. One that fails fails the run (exit 1); the migrations stay
 *   applied.
 * - Every outcome is in the history: the `before` steps' on each
 *   migration's `started` row, the `after` steps' on the last migration's
 *   `succeeded` row (`note.steps`), and `yodel report` lists them.
 */

import { spawnSync } from "node:child_process";
import type { ApplyStep, ApplySteps } from "../config/define.js";
import { loadYodelConfigAtBase } from "../config/base.js";
import { EXIT_REFUSED } from "../exit.js";
import { judgeCheck } from "../migrations/checks.js";
import { YodelError, type Project } from "../project.js";
import type { VersionedDriver } from "../versioned/driver.js";

export type StepWhen = "before" | "after";

/** One step's outcome, as the history records it. */
export interface StepOutcome {
  name: string;
  when: StepWhen;
  kind: "sql" | "command";
  passed: boolean;
  /** What the query returned, or how the command exited, in a few words. */
  detail: string;
  onFailure: "fail" | "approve";
  /** A command not run because the run was only planned: it runs under the lock. */
  deferred?: true;
}

/** The steps that apply to `env`: the base commit's, and a note when the working tree's differ. */
export interface StepsAtBase {
  steps: ApplySteps | undefined;
  sha?: string;
  note?: string;
}

/** `env`'s steps from yodel.config.ts at the base commit. */
export async function stepsAtBase(project: Pick<Project, "dir" | "yodel">, env: string, processEnv: NodeJS.ProcessEnv = process.env): Promise<StepsAtBase> {
  const tree = project.yodel?.config.environments?.[env]?.steps;
  let at;
  try {
    at = await loadYodelConfigAtBase(project.dir, processEnv);
  } catch (e) {
    const why = e instanceof Error ? (e.message.split("\n")[0] ?? "") : String(e);
    return { steps: undefined, ...(tree ? { note: `steps: yodel.config.ts could not be read at the base commit (${why}), so no step runs; the working tree's are not used` } : {}) };
  }
  const steps = at.config?.environments?.[env]?.steps;
  const differs = JSON.stringify(tree ?? null) !== JSON.stringify(steps ?? null);
  return { steps, sha: at.sha, ...(differs ? { note: `steps: ${env}'s steps are read at the base commit ${at.sha.slice(0, 12)}, not from this change` } : {}) };
}

const lastLine = (text: string): string => text.trim().split("\n").at(-1)?.slice(0, 200) ?? "";

/**
 * Runs `list` in order and returns each outcome; a failing step does not
 * stop the ones after it. With `commands: "plan"` (a run being planned, not
 * applied) a command is not run: its outcome says it runs under the lock.
 */
export async function runApplySteps(
  driver: Pick<VersionedDriver, "readCheck">,
  list: readonly ApplyStep[],
  when: StepWhen,
  ctx: { dir: string; env: string; processEnv?: NodeJS.ProcessEnv; commands?: "run" | "plan" },
): Promise<StepOutcome[]> {
  const out: StepOutcome[] = [];
  for (const step of list) {
    const onFailure = step.onFailure ?? "fail";
    if (step.sql !== undefined) {
      try {
        const judged = judgeCheck({ name: step.name, sql: step.sql, ...(step.expect !== undefined ? { expect: step.expect } : {}) }, await driver.readCheck(step.sql, {}));
        out.push({ name: step.name, when, kind: "sql", passed: judged.passed, detail: judged.detail, onFailure });
      } catch (e) {
        out.push({ name: step.name, when, kind: "sql", passed: false, detail: `the query failed: ${(e instanceof Error ? e.message : String(e)).split("\n")[0] ?? ""}`, onFailure });
      }
      continue;
    }
    if (ctx.commands === "plan") {
      out.push({ name: step.name, when, kind: "command", passed: true, detail: "a command: it runs under the lock, not when the run is planned", onFailure, deferred: true });
      continue;
    }
    const ran = spawnSync("sh", ["-c", step.command ?? ""], {
      cwd: ctx.dir,
      encoding: "utf8",
      env: { ...(ctx.processEnv ?? process.env), YODEL_ENV: ctx.env, YODEL_STEP: when },
      timeout: 10 * 60_000,
    });
    const said = lastLine(`${ran.stdout}\n${ran.stderr}`);
    const code = ran.status ?? 1;
    out.push({ name: step.name, when, kind: "command", passed: code === 0 && !ran.error, detail: `exit ${ran.error ? "(did not run)" : String(code)}${said ? `: ${said}` : ""}`, onFailure });
  }
  return out;
}

/** One line for an outcome. */
export const describeStep = (o: StepOutcome): string =>
  o.deferred ? `${o.when} step ${o.name} will run under the lock (${o.detail})` : `${o.when} step ${o.name} ${o.passed ? "passed" : o.onFailure === "approve" ? "failed, held for approval" : "failed"} (${o.detail})`;

/** The `before` steps that failed with `onFailure: "approve"`: the run waits for a person. */
export const heldSteps = (outcomes: readonly StepOutcome[]): string[] => outcomes.filter((o) => !o.passed && o.when === "before" && o.onFailure === "approve").map((o) => o.name);

/** The refusal for a step that failed with `onFailure: "fail"`, or undefined. */
export function stepsRefusal(env: string, outcomes: readonly StepOutcome[], when: string): YodelError | undefined {
  const failed = outcomes.filter((o) => !o.passed && (o.when === "after" || o.onFailure === "fail"));
  if (failed.length === 0) return undefined;
  const after = failed.every((o) => o.when === "after");
  return new YodelError(
    after
      ? `${env}: the migrations are applied, and an after step failed ${when}:\n${failed.map((o) => `  ${describeStep(o)}`).join("\n")}`
      : `refused: a before step of ${env} failed ${when}; nothing was applied:\n${failed.map((o) => `  ${describeStep(o)}`).join("\n")}\n` +
          `Fix the cause and run again, or, for a check a person may wave through, give the step onFailure: "approve" (at the base commit).`,
    after ? 1 : EXIT_REFUSED,
  );
}

/** The steps a history row's note records, if any. */
export function stepsOfNote(note: string): StepOutcome[] {
  if (!note.includes('"steps"')) return [];
  try {
    const steps = (JSON.parse(note) as { steps?: unknown }).steps;
    return Array.isArray(steps) ? (steps as StepOutcome[]) : [];
  } catch {
    return [];
  }
}
