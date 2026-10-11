/**
 * Applying through the project's own `ApplyOp`: yodel finds the Op that
 * applies the environment's build (`nativeApply` with `target: "clickhouse"`
 * or `"postgres"` and that `env`), and runs it with `chant run`. The Op's
 * gate is bound to its Plan phase's digest, so an approval given for one
 * change set never applies another; yodel never resolves the gate itself.
 * `chant approve <op> <gate> --plan <digest>` does, and the next run walks
 * through it. yodel prints `yodel approve <env> --plan <digest>` for a
 * person, which runs that for them (#202).
 */

import type { OpConfig, StepDefinition } from "@intentius/chant/op/types";
import { YodelError, type Environment, type Project, type SqlDialect } from "../project.js";
import { approveCommand, type ApprovalMode } from "../approval-mode/index.js";
import { runChant } from "./process.js";

/** The ApplyOp yodel runs for an environment. */
export interface ApplyOpRef {
  name: string;
  filePath: string;
  target: SqlDialect;
  /** The gate step's name. */
  gate: string;
}

const steps = (config: OpConfig): StepDefinition[] => config.phases.flatMap((p) => p.steps);

/** The environment and target a `nativeApply` step applies, when the Op has one. */
function nativeApplyOf(config: OpConfig): { env?: unknown; target?: unknown } | undefined {
  for (const step of steps(config)) {
    if (step.kind === "activity" && step.fn === "nativeApply") return step.args;
  }
  return undefined;
}

/** The gate the Op stops at, when it is bound to a plan (`plan` set, as ApplyOp sets it). */
function planBoundGate(config: OpConfig): string | undefined {
  for (const step of steps(config)) {
    if (step.kind === "gate" && step.plan !== undefined) return step.gate;
  }
  return undefined;
}

/** How to declare the ApplyOp yodel looks for. */
export function applyOpExample(env: string, dialect: SqlDialect): string {
  return [
    `// ops/apply-${env}.op.ts`,
    `import { ApplyOp } from "@intentius/chant/op";`,
    ``,
    `export const { op } = ApplyOp({ name: "apply-${env}", env: "${env}", target: "${dialect}", gate: {} });`,
  ].join("\n");
}

/**
 * Picks the ApplyOp for `env` from discovered Ops. Pure: takes the Ops as
 * `chant run` would discover them. `name` picks one when several apply the
 * same environment. An Op without a plan-bound gate is refused.
 */
export function selectApplyOp(
  ops: ReadonlyMap<string, { config: OpConfig; filePath: string }>,
  project: Project,
  env: Environment,
  name?: string,
): ApplyOpRef {
  const candidates = [...ops.values()].filter((o) => {
    const apply = nativeApplyOf(o.config);
    return apply?.env === env.name && (apply.target === "clickhouse" || apply.target === "postgres");
  });
  const chosen = name ? candidates.filter((o) => o.config.name === name) : candidates;
  if (chosen.length === 0) {
    if (name && ops.has(name)) throw new YodelError(`Op "${name}" is not an ApplyOp for environment ${env.name} with target clickhouse or postgres`);
    throw new YodelError(
      name
        ? `no Op named "${name}" in ${project.dir}`
        : `no ApplyOp applies environment ${env.name} in ${project.dir}; declare one, for example:\n\n${applyOpExample(env.name, project.dialect)}`,
    );
  }
  if (chosen.length > 1) {
    throw new YodelError(`${String(chosen.length)} Ops apply environment ${env.name} (${chosen.map((o) => o.config.name).join(", ")}); pick one with --op <name>`);
  }
  const [op] = chosen as [(typeof chosen)[number]];
  const target = nativeApplyOf(op.config)?.target as SqlDialect;
  if (target !== project.dialect) {
    throw new YodelError(`Op "${op.config.name}" applies target ${target}, but the project's dialect is ${project.dialect}`);
  }
  const gate = planBoundGate(op.config);
  if (!gate) {
    throw new YodelError(
      `Op "${op.config.name}" (${op.filePath}) has no approval gate bound to its plan, and yodel only applies behind one; ` +
        `give the ApplyOp a gate (gate: {}) or delete: "gated"`,
    );
  }
  return { name: op.config.name, filePath: op.filePath, target, gate };
}

/**
 * Why the project's Ops could not be found. chant discovers Ops through git
 * (the files git knows), so a project that is not in a git repository has
 * none; say so, and what to run (#19).
 */
export function discoveryError(dir: string, e: unknown): YodelError {
  const message = e instanceof Error ? e.message : String(e);
  if (/not in a git repository|not a git repository/i.test(message)) {
    return new YodelError(`yodel apply finds the project's Ops through git, and ${dir} is not in a git repository: run git init, then commit the project (git add -A && git commit -m init)`);
  }
  return new YodelError(`could not discover Ops in ${dir}: ${message}`);
}

/** Discovers the project's Ops the way `chant run` does and picks the ApplyOp for `env`. */
export async function findApplyOp(project: Project, env: Environment, name?: string): Promise<ApplyOpRef> {
  const { discoverOps } = await import("@intentius/chant/op/discover");
  let found: Awaited<ReturnType<typeof discoverOps>>;
  try {
    found = await discoverOps({ cwd: project.dir });
  } catch (e) {
    throw discoveryError(project.dir, e);
  }
  if (found.errors.length > 0 && found.ops.size === 0) {
    throw new YodelError(`could not discover Ops in ${project.dir}:\n${found.errors.join("\n")}`);
  }
  return selectApplyOp(found.ops, project, env, name);
}

/** `chant run`'s exit code for a run that stopped at its gate. */
export const GATED = 3;

export type ApplyRunStatus = "applied" | "gated" | "failed";

export interface ApplyRun {
  status: ApplyRunStatus;
  code: number;
  /** The `chant approve ...` command chant printed for a gated run; yodel prints {@link gatedCommands}' instead. */
  chantApprove?: string;
  /** The plan digest the gate is waiting on. */
  planDigest?: string;
  output: string;
  /** The exit code of the Op's Apply step (`yodel apply --execute`), when it ran. */
  stepExit?: number;
}

/** What a `chant run` of an ApplyOp says about its outcome. */
export function readApplyRun(code: number, output: string): ApplyRun {
  const status: ApplyRunStatus = code === 0 ? "applied" : code === GATED ? "gated" : "failed";
  const chantApprove = /^\s*approve\s*:\s*(chant approve .+?)\s*$/m.exec(output)?.[1];
  const planDigest = /^\s*plan\s*:\s*(\S+)\s*$/m.exec(output)?.[1];
  return { status, code, ...(chantApprove ? { chantApprove } : {}), ...(planDigest ? { planDigest } : {}), output };
}

/**
 * For a run that stopped at its gate (#202): `approve`, the command a person
 * runs (`yodel approve <env> --plan <digest>`, with `--sign` when the gate
 * is sealed), and `chantApprove`, chant's own, for scripts. Empty when chant
 * printed no approve command.
 */
export function gatedCommands(run: Pick<ApplyRun, "chantApprove" | "planDigest">, env: string, mode: ApprovalMode = "ledger"): { approve?: string; chantApprove?: string } {
  if (!run.chantApprove) return {};
  const signed = / --sign\b/.test(run.chantApprove);
  const digest = run.planDigest ?? /--plan\s+(\S+)/.exec(run.chantApprove)?.[1];
  const sealed = mode === "sealed" || signed;
  return {
    approve: approveCommand(env, digest, sealed ? "sealed" : "ledger"),
    chantApprove: sealed && !signed ? `${run.chantApprove} --sign` : run.chantApprove,
  };
}

/** Runs the ApplyOp with `chant run <op>`, its output passed to `onOutput` as it arrives. */
export async function runApplyOp(project: Project, op: ApplyOpRef, options: { env?: NodeJS.ProcessEnv; onOutput?: (text: string) => void } = {}): Promise<ApplyRun> {
  const result = await runChant(["run", op.name, "--gated-exit", String(GATED)], {
    cwd: project.dir,
    ...(options.env ? { env: options.env } : {}),
    ...(options.onOutput ? { onStdout: options.onOutput, onStderr: options.onOutput } : {}),
  });
  return readApplyRun(result.code, `${result.stdout}\n${result.stderr}`);
}
