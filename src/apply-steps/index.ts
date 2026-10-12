/**
 * Steps around apply (#64): per environment, `yodel.config.ts`
 * `environments.<env>.steps.before` and `.after`, SQL checks or commands
 * run around the versioned apply, as chant's Op waves stage hooks (#206).
 *
 * - Each step is a hook ({@link stepHooks}). A SQL check runs `yodel apply
 *   <env> --step-sql`, which yodel runs in process ({@link runStepHooks}); a
 *   command runs `sh -c`. `yodel ci` writes them into yodel-waves.json,
 *   with `hooks.apply.runBy: "apply"`, and chant reads them there at the
 *   base commit, as it reads the gate policy.
 * - `before` SQL checks are `before.plan` hooks: chant runs them when it
 *   plans the wave, and one that fails with `onFailure: "approve"` holds the
 *   wave for a person, whatever its gate, before the apply is called. Every
 *   `before` step is also a `before.apply` hook, and every `after` step an
 *   `after.apply` hook: the apply runs those under its lock, through
 *   chant's runner, before the first migration and once the last one
 *   succeeded. A command, which may have side effects, runs once per apply,
 *   under the lock, never when the wave is planned (#107).
 * - In order: a step that fails stops the ones after it, unless its
 *   `onFailure` is `approve`. A `before` step that fails refuses the run
 *   (exit 4); an `after` step that fails fails it (exit 1), the migrations
 *   applied.
 * - Outside the waves (`yodel apply <env>`) the same hooks are made from
 *   yodel.config.ts at the base commit ({@link stepsAtBase}, {@link
 *   stepsHooksFile}): the SQL checks run before the gate, and every step
 *   under the lock, where the Op's approval lets a held one through.
 * - Every outcome is in the history: the `before` steps' on each
 *   migration's `started` row, the `after` steps' on the last migration's
 *   `succeeded` row (`note.steps`), and `yodel report` lists them.
 */

import { spawnSync } from "node:child_process";
import type { OpWaveApplyHooksRun, OpWaveExec, OpWaveHook, OpWaveHookMoment, OpWaveHooks, OpWaveHooksFile } from "@intentius/chant/op";
import type { ApplyStep, ApplySteps } from "../config/define.js";
import { loadYodelConfigAtBase } from "../config/base.js";
import { EXIT_OUTSTANDING, EXIT_REFUSED } from "../exit.js";
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

/** The flag a SQL step's hook runs `yodel apply <env>` with; {@link runStepHooks} runs it in process. */
export const STEP_SQL_FLAG = "--step-sql";

/** One step as a hook: a SQL check through `yodel apply {target} --step-sql`, a command through `sh -c`. */
function stepHook(step: ApplyStep, when: StepWhen): OpWaveHook {
  const command =
    step.sql !== undefined
      ? ["yodel", "apply", "{target}", STEP_SQL_FLAG, step.sql, "--step", step.name, "--step-when", when, ...(step.expect !== undefined ? ["--step-expect", JSON.stringify(step.expect)] : []), ...(step.onFailure === "approve" ? ["--step-on-failure", "approve"] : [])]
      : ["sh", "-c", step.command ?? ""];
  // chant has no approve after the apply: an after step that fails fails the run, whatever it says.
  return { name: step.name, command, perRun: true, ...(when === "before" && step.onFailure === "approve" ? { onFailure: "approve" as const } : {}) };
}

/**
 * `steps` as stage hooks: the `before` SQL checks before the plan, every
 * `before` step before the apply and every `after` step after it, the
 * apply-stage ones run by the apply. Undefined for no steps.
 */
export function stepHooks(steps: ApplySteps | undefined): OpWaveHooks | undefined {
  const before = steps?.before ?? [];
  const after = steps?.after ?? [];
  if (before.length === 0 && after.length === 0) return undefined;
  const checks = before.filter((s) => s.sql !== undefined);
  return {
    apply: { runBy: "apply" },
    before: { ...(checks.length > 0 ? { plan: checks.map((s) => stepHook(s, "before")) } : {}), ...(before.length > 0 ? { apply: before.map((s) => stepHook(s, "before")) } : {}) },
    ...(after.length > 0 ? { after: { apply: after.map((s) => stepHook(s, "after")) } } : {}),
  };
}

/**
 * The hooks file for an apply outside the waves: `env`'s steps as {@link
 * stepHooks} has them, by moment. `approved`: an approval of the plan stands
 * (the Op's gate passed), so a held step does not stop the apply.
 */
export function stepsHooksFile(steps: ApplySteps | undefined, env: string, options: { approved: boolean; base?: string }): OpWaveHooksFile {
  const hooks = stepHooks(steps);
  const byMoment: Partial<Record<OpWaveHookMoment, OpWaveHook[]>> = {
    ...(hooks?.before?.plan ? { "before-plan": hooks.before.plan } : {}),
    ...(hooks?.before?.apply ? { "before-apply": hooks.before.apply } : {}),
    ...(hooks?.after?.apply ? { "after-apply": hooks.after.apply } : {}),
  };
  return {
    version: 1,
    opWaves: "yodel-apply",
    op: `migrate-${env}`,
    wave: env,
    number: 0,
    ...(options.base ? { base: options.base } : {}),
    approved: options.approved,
    runBy: "apply",
    runs: [{ target: env, op: `migrate-${env}` }],
    runsFile: "",
    hooks: byMoment,
    outcomes: [],
  };
}

const lastLine = (text: string): string => text.trim().split("\n").at(-1)?.slice(0, 200) ?? "";

/** A SQL step's hook argv, read back: the step it runs, or undefined for any other argv. */
export function sqlStepOfArgv(argv: readonly string[]): (ApplyStep & { sql: string; when: StepWhen }) | undefined {
  if (argv[0] !== "yodel" || argv[1] !== "apply") return undefined;
  const at = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const sql = at(STEP_SQL_FLAG);
  const name = at("--step");
  if (sql === undefined || name === undefined) return undefined;
  const expect = at("--step-expect");
  const parsed = expect !== undefined ? (JSON.parse(expect) as NonNullable<ApplyStep["expect"]>) : undefined;
  return {
    name,
    sql,
    when: at("--step-when") === "after" ? "after" : "before",
    ...(parsed !== undefined ? { expect: parsed } : {}),
    ...(at("--step-on-failure") === "approve" ? { onFailure: "approve" as const } : {}),
  };
}

/** Runs one SQL step on `driver`, judged like a pre-migration check. */
export async function runSqlStep(driver: Pick<VersionedDriver, "readCheck">, step: ApplyStep & { sql: string }): Promise<{ passed: boolean; detail: string }> {
  try {
    const judged = judgeCheck({ name: step.name, sql: step.sql, ...(step.expect !== undefined ? { expect: step.expect } : {}) }, await driver.readCheck(step.sql, {}));
    return { passed: judged.passed, detail: judged.detail };
  } catch (e) {
    return { passed: false, detail: `the query failed: ${(e instanceof Error ? e.message : String(e)).split("\n")[0] ?? ""}` };
  }
}

/** What {@link runStepHooks} ran: chant's verdict, and each step's outcome as the history records it. */
export interface StepHooksRun {
  run: OpWaveApplyHooksRun;
  outcomes: StepOutcome[];
}

/**
 * Runs one moment's hooks of `file` through chant's runner, under the
 * apply's lock (or before the gate, for `before-plan`): a SQL step in
 * process on `driver`, a command with `YODEL_ENV` and `YODEL_STEP` set and
 * its last line kept for the history. With `skip`, runs none and tells
 * chant why (an apply that changes nothing).
 */
export async function runStepHooks(
  file: OpWaveHooksFile,
  moment: OpWaveHookMoment,
  ctx: { driver: Pick<VersionedDriver, "readCheck">; dir: string; env: string; processEnv?: NodeJS.ProcessEnv; log?: (line: string) => void; skip?: string },
): Promise<StepHooksRun> {
  const { runOpWaveApplyHooks } = await import("@intentius/chant/op");
  const when: StepWhen = moment.startsWith("after") ? "after" : "before";
  const hooks = file.hooks[moment] ?? [];
  // chant's runner is synchronous and a SQL step is not: each SQL step runs here first, in order, and the runner reads its verdict.
  const checked = new Map<string, { passed: boolean; detail: string }>();
  if (ctx.skip === undefined) {
    for (const hook of hooks) {
      const step = sqlStepOfArgv(hook.command);
      if (step) checked.set(hook.name ?? step.name, await runSqlStep(ctx.driver, step));
    }
  }
  const details: Array<{ kind: StepOutcome["kind"]; detail: string }> = [];
  const exec: OpWaveExec = (argv, cwd, env) => {
    const step = sqlStepOfArgv(argv);
    if (step) {
      const got = checked.get(step.name) ?? { passed: false, detail: "the check did not run" };
      details.push({ kind: "sql", detail: got.detail });
      return got.passed ? 0 : 1;
    }
    const ran = spawnSync(argv[0] ?? "sh", argv.slice(1), {
      cwd,
      encoding: "utf8",
      env: { ...(ctx.processEnv ?? process.env), ...env, YODEL_ENV: ctx.env, YODEL_STEP: when },
      timeout: 10 * 60_000,
    });
    const said = lastLine(`${ran.stdout}\n${ran.stderr}`);
    const code = ran.error ? 127 : (ran.status ?? 1);
    details.push({ kind: "command", detail: `exit ${ran.error ? "(did not run)" : String(code)}${said ? `: ${said}` : ""}` });
    return code;
  };
  const run = runOpWaveApplyHooks(file, moment, { cwd: ctx.dir, exec, log: ctx.log ?? (() => undefined), ...(ctx.skip !== undefined ? { skip: ctx.skip } : {}) });
  const onFailureOf = new Map(hooks.map((h) => [h.name ?? h.command.join(" "), h.onFailure ?? "fail"]));
  const outcomes = run.outcomes
    .filter((o) => o.outcome !== "skipped")
    .map((o, i): StepOutcome => ({
      name: o.name,
      when,
      kind: details[i]?.kind ?? "command",
      passed: o.outcome === "passed",
      detail: details[i]?.detail ?? `exit ${String(o.exit)}`,
      onFailure: onFailureOf.get(o.name) ?? "fail",
    }));
  return { run, outcomes };
}

/** One line for an outcome. */
export const describeStep = (o: StepOutcome): string =>
  o.deferred ? `${o.when} step ${o.name} will run under the lock (${o.detail})` : `${o.when} step ${o.name} ${o.passed ? "passed" : o.onFailure === "approve" ? "failed, held for approval" : "failed"} (${o.detail})`;

/** The `before` steps that failed with `onFailure: "approve"`: the run waits for a person. */
export const heldSteps = (outcomes: readonly StepOutcome[]): string[] => outcomes.filter((o) => !o.passed && o.when === "before" && o.onFailure === "approve").map((o) => o.name);

/**
 * The refusal for a moment's hooks that did not let the apply go on, or
 * undefined: a `before` step that failed (exit 4, nothing applied), a held
 * one with no approval standing (exit 3), an `after` step that failed (exit
 * 1, the migrations applied).
 */
export function stepsRefusal(env: string, ran: StepHooksRun, when: string, approve?: string): YodelError | undefined {
  if (ran.run.proceed) return undefined;
  const lines = (os: readonly StepOutcome[]) => os.map((o) => `  ${describeStep(o)}`).join("\n");
  const failed = ran.outcomes.filter((o) => !o.passed && o.onFailure === "fail");
  if (ran.run.moment === "after-apply") return new YodelError(`${env}: the migrations are applied, and an after step failed ${when}:\n${lines(failed)}`, 1);
  if (ran.run.failed || failed.length > 0) {
    return new YodelError(
      `refused: a before step of ${env} failed ${when}; nothing was applied:\n${lines(failed)}\n` +
        `Fix the cause and run again, or, for a check a person may wave through, give the step onFailure: "approve" (at the base commit).`,
      EXIT_REFUSED,
    );
  }
  const held = ran.outcomes.filter((o) => !o.passed && o.onFailure === "approve");
  const why = held.length > 0 ? lines(held) : ran.run.held.map((h) => `  ${h}`).join("\n");
  return new YodelError(`refused: a before step of ${env} failed with onFailure approve ${when}, and no approval of this plan stands; nothing was applied:\n${why}${approve ? `\nApprove it with: ${approve}` : ""}`, EXIT_OUTSTANDING);
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
