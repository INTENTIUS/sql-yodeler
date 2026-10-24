/**
 * The approval: a versioned apply runs as a chant Op, behind a gate bound to
 * the plan digest, the same machinery #6's declarative apply runs through.
 *
 * The project declares one Op per environment:
 *
 *   Plan     shell("yodel apply <env> --digest", { id: "plan" })
 *            prints the digest of the pending migrations and the live schema
 *   Approve  gate(..., { plan: stepOutput(plan, "stdout"), resume: true })
 *            a resolution counts only for that digest (`chant approve <op> <gate> --plan <digest>`);
 *            with `resume`, the run after the approval starts at the gate
 *            (chant#3947): it runs the Plan step again and skips nothing else
 *   Apply    shell("yodel apply <env> --execute", { env: { YODEL_APPROVED_PLAN: stepOutput(plan, "stdout") } })
 *            takes the lock, computes the digest again, refuses if it moved, applies
 *
 * `yodel apply <env>` runs it with `chant run <op>`, as #6 runs an ApplyOp.
 * The gate ledger is chant's (the `chant/lifecycle` branch); yodel keeps no
 * approval store of its own. The digest is checked twice: by the gate, on
 * every run, against the approval; and by the Apply step, under the lock,
 * against the digest the gate passed, so a change between the two (another
 * runner applying, a table altered out of band) refuses too.
 *
 * `chant run <op>` run directly (in CI) needs `yodel` on PATH, e.g.
 * `PATH="$PWD/node_modules/.bin:$PATH"`. When `yodel apply` runs it, yodel
 * puts a `yodel` that runs itself first on the child's PATH.
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { opExportName } from "../chant/export-name.js";
import { tmpdir } from "node:os";
import { delimiter, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OpConfig, StepDefinition } from "@intentius/chant/op/types";
import { YodelError, type Environment, type Project } from "../project.js";
import { chantInstall, runChant } from "../chant/process.js";
import { discoveryError, GATED, readApplyRun, type ApplyRun } from "../chant/apply.js";
import { REVERT_ENV, REVERT_STEP_ENV } from "./revert.js";

/** The env var the Apply step reads the approved digest from. */
export const APPROVED_PLAN_ENV = "YODEL_APPROVED_PLAN";
/** Passes `--allow-out-of-order` through `chant run` to the Op's steps. */
export const ALLOW_OUT_OF_ORDER_ENV = "YODEL_ALLOW_OUT_OF_ORDER";
/** The baseline `yodel apply --digest` and `--execute` record instead of applying, set by `yodel init --baseline` (#115) for its Op run. */
export const BASELINE_ENV = "YODEL_BASELINE";

export interface MigrateOpRef {
  name: string;
  filePath: string;
  gate: string;
  /** The gate declares an `approval` quorum in the Op. Only a quorum at base counts for `--execute` (chant#4324); this one is the change's to edit. */
  quorum: boolean;
  /** The gate declares an approval policy, which only the gate step evaluates. */
  policy?: boolean;
  /**
   * The gate's old names (chant#3949), each with its Op (this Op when the
   * alias names none). An approval recorded under one counts for the gate.
   */
  aliases?: { op: string; gate: string }[];
}

const command = (verb: string) => new RegExp(`^(?:npx\\s+)?yodel\\s+apply\\s+(\\S+)\\s+${verb}(?:\\s|$)`);
const DIGEST = command("--digest");
const EXECUTE = command("--execute");

const steps = (config: OpConfig): StepDefinition[] => config.phases.flatMap((p) => p.steps);

function shellCmd(step: StepDefinition): { cmd: string; id?: string } | undefined {
  if (step.kind !== "activity" || step.fn !== "shellCmd") return undefined;
  const cmd = (step.args as { cmd?: unknown } | undefined)?.cmd;
  return typeof cmd === "string" ? { cmd: cmd.trim(), ...(step.id ? { id: step.id } : {}) } : undefined;
}

/** The parts of a migrations Op for `env`, when `config` is one. */
export function migrateOpParts(config: OpConfig, env: string): { gate: string | undefined; quorum: boolean; policy?: boolean; aliases?: { op: string; gate: string }[] } | undefined {
  const all = steps(config);
  const plan = all.map(shellCmd).find((s) => s && DIGEST.exec(s.cmd)?.[1] === env);
  const execute = all.map(shellCmd).find((s) => s && EXECUTE.exec(s.cmd)?.[1] === env);
  if (!plan || !execute) return undefined;
  const gate = all.find((s) => {
    if (s.kind !== "gate" || s.plan === undefined || typeof s.plan === "string") return false;
    return (s.plan as { step?: unknown }).step === plan.id;
  });
  if (gate?.kind !== "gate") return { gate: undefined, quorum: false };
  const aliases = (gate.aliases ?? []).map((a) => ({ op: a.op ?? config.name, gate: a.gate }));
  return { gate: gate.gate, quorum: gate.approval !== undefined, ...(gate.approval?.policy !== undefined ? { policy: true } : {}), ...(aliases.length > 0 ? { aliases } : {}) };
}

/** How to declare the Op `yodel apply` looks for. */
export function migrateOpExample(env: string): string {
  return [
    `// ops/migrate-${env}.op.ts`,
    `import { Op, phase, gate, shell, stepOutput } from "@intentius/chant/op";`,
    ``,
    `const plan = shell("yodel apply ${env} --digest", { id: "plan" });`,
    `const digest = stepOutput(plan, "stdout");`,
    ``,
    `export const ${opExportName(`migrate-${env}`)} = Op({`,
    `  name: "migrate-${env}",`,
    `  overview: "Apply the pending migrations to ${env}, behind an approval bound to their plan digest",`,
    `  phases: [`,
    `    phase("Plan", [plan]),`,
    `    phase("Approve", [gate("approve-migrate-${env}", { plan: digest, resume: true })]),`,
    `    phase("Apply", [shell("yodel apply ${env} --execute", { env: { ${APPROVED_PLAN_ENV}: digest }, timeout: "2h" })]),`,
    `  ],`,
    `});`,
  ].join("\n");
}

/** Picks the migrations Op for `env` from discovered Ops. Pure. */
export function selectMigrateOp(
  ops: ReadonlyMap<string, { config: OpConfig; filePath: string }>,
  project: Project,
  env: Environment,
  name?: string,
): MigrateOpRef {
  const found = [...ops.values()].flatMap((o) => {
    const parts = migrateOpParts(o.config, env.name);
    return parts ? [{ ...o, parts }] : [];
  });
  const chosen = name ? found.filter((o) => o.config.name === name) : found;
  if (chosen.length === 0) {
    if (name && ops.has(name)) throw new YodelError(`Op "${name}" is not a migrations Op for environment ${env.name} (a Plan step running "yodel apply ${env.name} --digest", a gate bound to it, an Apply step running "yodel apply ${env.name} --execute")`);
    throw new YodelError(
      name
        ? `no Op named "${name}" in ${project.dir}`
        : `no Op applies the migrations to environment ${env.name} in ${project.dir}; declare one, for example:\n\n${migrateOpExample(env.name)}`,
    );
  }
  if (chosen.length > 1) throw new YodelError(`${String(chosen.length)} Ops apply the migrations to ${env.name} (${chosen.map((o) => o.config.name).join(", ")}); pick one with --op <name>`);
  const [op] = chosen as [(typeof chosen)[number]];
  if (!op.parts.gate) {
    throw new YodelError(`Op "${op.config.name}" (${op.filePath}) has no approval gate bound to its Plan step's digest, and yodel only applies behind one; give it gate(..., { plan: stepOutput(plan, "stdout") })`);
  }
  return { name: op.config.name, filePath: op.filePath, gate: op.parts.gate, quorum: op.parts.quorum, ...(op.parts.policy ? { policy: true } : {}), ...(op.parts.aliases ? { aliases: op.parts.aliases } : {}) };
}

export async function findMigrateOp(project: Project, target: Environment, name?: string): Promise<MigrateOpRef> {
  // A tenant (#56) is applied by its environment's Op.
  const env: Environment = target.tenant ? { name: target.tenant.env, profile: target.profile } : target;
  const { discoverOps } = await import("@intentius/chant/op/discover");
  let found: Awaited<ReturnType<typeof discoverOps>>;
  try {
    found = await discoverOps({ cwd: project.dir });
  } catch (e) {
    throw discoveryError(project.dir, e);
  }
  if (found.errors.length > 0 && found.ops.size === 0) throw new YodelError(`could not discover Ops in ${project.dir}:\n${found.errors.join("\n")}`);
  return selectMigrateOp(found.ops, project, env, name);
}

/** This yodel's own entry point: `bin.js` when built, `bin.ts` from source. */
function selfEntry(): string {
  const here = fileURLToPath(import.meta.url);
  return fileURLToPath(new URL(`../bin${extname(here)}`, import.meta.url));
}

/** A directory holding a `yodel` that runs this yodel, for a child's PATH. */
export function yodelShim(): { dir: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "yodel-shim-"));
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const script = `#!/bin/sh\nexec ${q(process.execPath)} --import ${q(chantInstall().loader)} ${q(selfEntry())} "$@"\n`;
  const path = join(dir, "yodel");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return { dir, dispose: () => { rmSync(dir, { recursive: true, force: true }); } };
}

/**
 * Where `yodel apply --execute` (the Op's Apply step) writes its exit code,
 * so the outer `yodel apply` exits with it (5 for the lock, 4 for a refusal)
 * rather than with `chant run`'s 1.
 */
export const STEP_EXIT_ENV = "YODEL_STEP_EXIT_FILE";

/** Records an Op step's exit code where the outer `yodel apply` reads it. Never fails the step. */
export function recordStepExit(code: number, env: NodeJS.ProcessEnv = process.env): void {
  const file = env[STEP_EXIT_ENV];
  if (!file) return;
  try {
    writeFileSync(file, `${String(code)}\n`);
  } catch {
    // The outer run then reports chant run's own exit.
  }
}

/** The exit code the Op's Apply step recorded, when it ran. */
export function readStepExit(file: string): number | undefined {
  try {
    const n = Number(readFileSync(file, "utf8").trim());
    return Number.isInteger(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

/** Runs the migrations Op with `chant run`, with this yodel on PATH and `--allow-out-of-order` passed through. */
export async function runMigrateOp(
  project: Project,
  op: MigrateOpRef,
  options: {
    allowOutOfOrder: boolean;
    env?: NodeJS.ProcessEnv;
    onOutput?: (text: string) => void;
    /** `yodel revert` (#55): the Op's steps plan and run the revert of this migration, with this hand-written step (an absolute path), instead of applying. */
    revert?: { id: string; step?: string | undefined };
    /** `yodel init --baseline` (#115): the Op's steps compare and record this baseline in the environment, instead of applying. */
    baseline?: string;
  },
): Promise<ApplyRun> {
  const shim = yodelShim();
  try {
    const base = options.env ?? process.env;
    // The approved digest only ever comes from the gate, never from the caller's environment.
    // Nor is a revert ever taken from it: only yodel revert sets one; nor a baseline, which only yodel init --baseline sets.
    const rest = Object.fromEntries(Object.entries(base).filter(([k]) => k !== APPROVED_PLAN_ENV && k !== ALLOW_OUT_OF_ORDER_ENV && k !== REVERT_ENV && k !== REVERT_STEP_ENV && k !== BASELINE_ENV));
    const exitFile = join(shim.dir, "step-exit");
    const env: NodeJS.ProcessEnv = {
      ...rest,
      [STEP_EXIT_ENV]: exitFile,
      PATH: [shim.dir, base.PATH ?? ""].filter(Boolean).join(delimiter),
      ...(options.allowOutOfOrder ? { [ALLOW_OUT_OF_ORDER_ENV]: "1" } : {}),
      ...(options.revert ? { [REVERT_ENV]: options.revert.id, ...(options.revert.step ? { [REVERT_STEP_ENV]: options.revert.step } : {}) } : {}),
      ...(options.baseline ? { [BASELINE_ENV]: options.baseline } : {}),
    };
    const result = await runChant(["run", op.name, "--gated-exit", String(GATED)], {
      cwd: project.dir,
      env,
      ...(options.onOutput ? { onStdout: options.onOutput, onStderr: options.onOutput } : {}),
    });
    const run = readApplyRun(result.code, `${result.stdout}\n${result.stderr}`);
    const stepExit = readStepExit(exitFile);
    return stepExit === undefined ? run : { ...run, stepExit };
  } finally {
    shim.dispose();
  }
}
