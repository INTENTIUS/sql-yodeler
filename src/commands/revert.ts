import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Command, Io } from "../command.js";
import { guarded } from "../env-args.js";
import { loadProject, resolveEnvironment, YodelError, type Environment, type Project } from "../project.js";
import { GATED, gatedCommands } from "../chant/apply.js";
import { migrationsApprovalAtBase } from "../approval-mode/index.js";
import { runnable, runnableAsWriter } from "../chant/runnable.js";
import { permissionRefusal, readerRefusal } from "../credentials.js";
import { LOCK_WAIT_ENV, parseDuration } from "../config/settings.js";
import { MIGRATION_ID } from "../migrations/index.js";
import { describeServer } from "../server.js";
import { policyAtBase } from "../config/base.js";
import { EXIT_REFUSED } from "../exit.js";
import type { WaveGate } from "../config/define.js";
import { destructiveSteps, gateAtBase, type DestructiveStep } from "../waves/index.js";
import {
  closeVersioned,
  currentRevert,
  describeResults,
  findMigrateOp,
  gitLedger,
  judgeRevert,
  openVersioned,
  policyRefusal,
  readChain,
  readRevertStep,
  renderStatus,
  runMigrateOp,
  statusReport,
  type RevertPlan,
  type RuleResult,
} from "../versioned/index.js";

const usage = "usage: yodel revert <env> <id> [--step <file>] [--dry-run] [--json] [--op <name>] [--lock-wait <duration>] [--dir <project>]";

const help = `${usage}

Undoes migration <id> in <env>: plans the statements that take the schema
from <id>'s recorded schema back to its parent's (an empty schema for the
first migration), offline, from migration.json alone. Only the newest
migration applied in <env> can be reverted; a later one was written against
it. <env> and <id> may come in either order.

The revert runs through the environment's migrations Op, as yodel apply
does: its Plan step prints the revert's digest (the statements, the history
and the live schema), its gate binds the approval to that digest, and its
Apply step plans the revert again under the lock, refuses if the digest
moved, and runs it. A run that stops at the gate prints the yodel approve
command; approve, then run yodel revert again. The history gets a revert row
for each statement and a migration row reverted: <id> is then pending
again, and yodel status shows it reverted. Delete it, or rewrite it with
yodel new --replace, before the next yodel apply, which would apply it
again.

The policy in yodel.config.ts (policy.rules), as the base commit has it, is
judged over the revert's statements before the gate, and again under the
lock: a rule that refuses drops refuses a revert that drops what the
migration added (exit 4), unless an override is recorded for the revert's
digest (yodel override <env> --revert <id> --rule <rule> --reason <why>).
In an environment yodel.config.ts waves names, the revert waits at the
migrations Op's gate whatever the wave's gate policy: under on-destructive,
a destructive revert waits for an approval, and so does any other.

Statements carry the schema back, never data. A migration with a data step
(a backfill) is refused unless --step names a file of statements that undo
it, each ending with ; at the end of a line; they run before the reverse
statements, and are in the digest. A reverse that needs an Op or a manual
step is refused: write it as a new migration.

Options:
  --step <file>    a hand-written revert step: SQL that undoes the
                   migration's data step (relative to the project directory)
  --dry-run        print the revert's statements and digest; run nothing
  --json           print the outcome as JSON
  --op <name>      the Op to run, when more than one applies <env>
  --lock-wait <d>  when another apply holds the lock, wait up to <d> for it
  -C, --dir <dir>  the project directory (default: the working directory)

Exit codes:
  0  reverted, or (--dry-run) planned
  2  refused, nothing reverted: the migration has a data step and no --step,
     or the reverse needs an Op or a manual step
  3  stopped at the gate, waiting for approval of this revert
  4  refused, nothing reverted: <id> is not applied in <env>, a migration
     after it is, the history does not match the migrations directory, or
     a policy rule denies the revert and no override is recorded for its
     digest, the run holds <env>'s reader (YODEL_CREDENTIALS is not writer
     or writer:<env>), or the server refused the user a privilege
  5  another apply holds the lock
  1  anything else failed: a statement (the history records where; rerun to
     resume), a revert whose plan moved since approval, a bad config
`;

interface RevertArgs {
  env: string;
  id: string;
  step: string | undefined;
  dryRun: boolean;
  json: boolean;
  op: string | undefined;
  lockWaitMs: number | undefined;
  dir: string;
}

function parseRevertArgs(args: string[]): RevertArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        step: { type: "string" },
        "dry-run": { type: "boolean" },
        json: { type: "boolean" },
        op: { type: "string" },
        "lock-wait": { type: "string" },
        dir: { type: "string", short: "C" },
      },
    });
  } catch (e) {
    throw new YodelError(`${e instanceof Error ? e.message : String(e)}\n${usage}`);
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 2) throw new YodelError(usage);
  const [first = "", second = ""] = positionals;
  // The migration is the one named like an id; the other is the environment.
  const [id, env] = MIGRATION_ID.test(first) && !MIGRATION_ID.test(second) ? [first, second] : [second, first];
  const str = (k: string) => (typeof values[k] === "string" ? values[k] : undefined);
  return {
    env,
    id,
    step: str("step"),
    dryRun: values["dry-run"] === true,
    json: values.json === true,
    op: str("op"),
    lockWaitMs: typeof values["lock-wait"] === "string" ? parseDuration(values["lock-wait"], "--lock-wait") : undefined,
    dir: str("dir") ?? process.cwd(),
  };
}

/** The wave of the environment a revert runs in (#97), when yodel.config.ts waves names it. */
export interface RevertWave {
  /** The wave's gate policy, as the base commit has it. */
  gate: WaveGate;
  base: string;
  /** The revert's statements the wave's gate counts as destructive (what on-destructive waits on). */
  destructiveSteps: DestructiveStep[];
  /** Whether the wave's gate policy asks for an approval of this revert. The revert waits at the migrations Op's gate either way. */
  policyWaits: boolean;
}

/** What the wave gate `gate` makes of the revert `plan`: the statements it counts as destructive, the way a wave plan counts a migration's steps, and whether it asks for an approval. */
export function revertWaveOf(gate: WaveGate, base: string, dialect: "clickhouse" | "postgres", plan: RevertPlan): RevertWave {
  const steps = destructiveSteps(dialect, [{ id: plan.migration.id, migration: { document: { ...plan.migration.document, steps: plan.statements.map((s) => s.step) } } }]);
  return { gate, base, destructiveSteps: steps, policyWaits: plan.statements.length > 0 && (gate === "always" || (gate === "on-destructive" && steps.length > 0)) };
}

/** `env`'s wave gate at the base commit for the revert `plan`, or undefined when no wave names `env`. */
async function revertWave(project: Parameters<typeof gateAtBase>[0], env: string, plan: RevertPlan): Promise<RevertWave | undefined> {
  if (!(project.yodel?.config.waves ?? []).some((w) => w.env === env)) return undefined;
  const { gate, at } = await gateAtBase(project, env);
  return revertWaveOf(gate, at.sha, project.dialect === "postgres" ? "postgres" : "clickhouse", plan);
}

function describeWave(env: string, wave: RevertWave): string {
  const destructive = wave.destructiveSteps.length > 0 ? `destructive (${wave.destructiveSteps.map((d) => `statement ${String(d.step)}: ${d.why}`).join(", ")})` : "not destructive";
  return `wave gate ${wave.gate} for ${env} at ${wave.base.slice(0, 12)}: the revert is ${destructive}; ${wave.policyWaits ? "it waits for an approval" : "the gate policy alone would let it through, and it waits at the migrations Op's gate all the same"}`;
}

/** The revert as JSON (schemas/revert.schema.json), with what happened. */
export function revertJson(plan: RevertPlan, digest: string, outcome: Record<string, unknown>): Record<string, unknown> {
  return {
    environment: plan.environment,
    migration: plan.migration.id,
    to: plan.to,
    planDigest: digest,
    statements: plan.statements.map((s, i) => ({ index: i, source: s.source, sql: s.step.sql, rule: s.step.rule, class: s.step.class, ...(s.step.destructive ? { destructive: true } : {}), done: plan.done.includes(i) })),
    dataSteps: plan.dataSteps,
    ...(plan.step ? { step: { file: plan.step.file, sha: plan.step.sha, statements: plan.step.statements.length } } : {}),
    ...outcome,
  };
}

function renderPlan(plan: RevertPlan, digest: string): string {
  const lines = [`Revert of ${plan.migration.id} in ${plan.environment}, back to ${plan.to ?? "an empty schema"}:`];
  for (const [i, s] of plan.statements.entries()) {
    const what = s.source === "step" ? `the revert step ${plan.step?.file ?? ""}` : `${s.step.rule} ${s.step.class}${s.step.destructive ? ", destructive" : ""}, ${s.step.name}`;
    lines.push(`  ${String(i)}: ${what}${plan.done.includes(i) ? " (succeeded in an earlier run; not sent again)" : ""}`, `     ${s.step.sql.split("\n").join("\n     ")}`);
  }
  if (plan.statements.length === 0) lines.push("  (no statement: the recorded schemas are the same)");
  for (const d of plan.dataSteps) lines.push(`  data step ${d}: undone by the revert step`);
  lines.push(`Plan digest: ${digest}`);
  return `${lines.join("\n")}\n`;
}

/** `yodel revert <env> <id>`; the exit codes are in `help`. */
export const revert: Command = {
  name: "revert",
  summary: "undo the newest applied migration from its recorded schemas",
  implemented: true,
  run: (args, io) => guarded("revert", io, args, help, () => run(parseRevertArgs(args), io)),
};

async function run(a: RevertArgs, io: Io): Promise<number> {
  const project = await loadProject(a.dir);
  const env = resolveEnvironment(project, a.env);
  // The reader cannot write (#159): a revert refuses before the gate, naming the variable that picks the writer.
  const command = runnable(`yodel revert ${a.env} ${a.id}${a.step !== undefined ? ` --step ${a.step}` : ""}`, project.dir);
  const asReader = a.dryRun ? undefined : readerRefusal(env.profile, command);
  if (asReader) throw new YodelError(asReader, EXIT_REFUSED);
  try {
    return await revertIn(project, env, a, io);
  } catch (e) {
    const denied = permissionRefusal(e, env.profile, command);
    if (denied) throw new YodelError(denied, EXIT_REFUSED);
    throw e;
  }
}

async function revertIn(project: Project, env: Environment, a: RevertArgs, io: Io): Promise<number> {
  const ordered = readChain(project);
  const step = a.step !== undefined ? readRevertStep(a.step, project.dir) : undefined;
  const venv = await openVersioned(project, env);
  try {
    const { plan, digest } = await currentRevert(venv, ordered, a.id, step);
    // The policy (#53) over the revert (#97), as the base commit has it (#73), with the overrides recorded for this revert's digest.
    const basePolicy = await policyAtBase(project);
    if (basePolicy.note && !a.json) io.err(`${basePolicy.note}\n`);
    const op = a.dryRun ? undefined : await findMigrateOp(project, env, a.op);
    const policy: RuleResult[] = await judgeRevert({
      policy: basePolicy.policy,
      environment: env.name,
      dialect: project.dialect,
      plan,
      digest,
      ledger: async () => {
        try {
          return { port: await gitLedger(project.dir), op: op ?? (await findMigrateOp(project, env, a.op)) };
        } catch {
          return undefined;
        }
      },
    });
    const wave = await revertWave(project, env.name, plan);
    const extra = { ...(policy.length > 0 ? { policy } : {}), ...(wave ? { wave } : {}) };
    const emit = (outcome: Record<string, unknown>, code: number) => {
      if (a.json) io.out(`${JSON.stringify(revertJson(plan, digest, { ...outcome, ...extra }), null, 2)}\n`);
      return code;
    };
    if (!a.json) {
      io.out(renderPlan(plan, digest));
      for (const line of describeResults(policy)) io.out(`${line}\n`);
      if (wave) io.out(`${describeWave(env.name, wave)}\n`);
    }
    if (a.dryRun || !op) return emit({ status: "planned" }, 0);
    const denied = policyRefusal(policy, env.name, digest, "before the gate", { id: plan.migration.id, step: a.step });
    if (denied) {
      if (!a.json) io.err(`yodel revert: ${denied.message}\n`);
      return emit({ status: "denied" }, EXIT_REFUSED);
    }

    if (!a.json) io.out(`\nRunning ${op.name} (${op.filePath}) to revert ${plan.migration.id}\n`);
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...(a.lockWaitMs !== undefined ? { [LOCK_WAIT_ENV]: `${String(a.lockWaitMs)}ms` } : {}) };
    const ran = await runMigrateOp(project, op, {
      allowOutOfOrder: false,
      env: childEnv,
      revert: { id: plan.migration.id, ...(a.step !== undefined ? { step: resolve(project.dir, a.step) } : {}) },
      onOutput: (t) => { io.err(t); },
    });
    if (ran.status === "gated") {
      const commands = gatedCommands(ran, env.name, (await migrationsApprovalAtBase(project, env.name)).mode);
      if (!a.json) {
        io.out(`\n${op.name} is waiting at gate "${op.gate}" for approval of this revert${ran.planDigest ? ` (${ran.planDigest})` : ""}.\n`);
        if (commands.approve) io.out(`Approve it at a terminal with:\n  ${runnable(commands.approve, project.dir)}\nthen run ${runnableAsWriter(`yodel revert ${env.name} ${plan.migration.id}${a.step !== undefined ? ` --step ${a.step}` : ""}`, project.dir, env.profile)} again.\n`);
      }
      return emit({ status: "gated", op: op.name, gate: op.gate, ...commands, ...(ran.planDigest ? { gatePlanDigest: ran.planDigest } : {}) }, GATED);
    }
    if (ran.status === "failed") {
      const code = ran.stepExit !== undefined && ran.stepExit !== 0 ? ran.stepExit : 1;
      if (!a.json) io.err(`yodel revert: chant run ${op.name} failed (exit ${String(ran.code)})${ran.stepExit ? `: its Apply step exited ${String(ran.stepExit)}` : ""}\n`);
      return emit({ status: "failed", op: op.name, exitCode: code }, code);
    }
    const after = await statusReport(venv, ordered);
    const reverted = after.status.pending.find((p) => p.id === plan.migration.id)?.reverted !== undefined;
    if (!reverted) {
      if (!a.json) io.err(`yodel revert: ${op.name} completed, but ${env.name}'s history does not record ${plan.migration.id} reverted\n`);
      return emit({ status: "failed", op: op.name, exitCode: 1 }, 1);
    }
    if (!a.json) io.out(`\nReverted ${plan.migration.id} in ${env.name}${after.server ? ` (${describeServer(after.server)})` : ""}, back to ${plan.to ?? "an empty schema"}.\n\n${renderStatus(after)}`);
    return emit({ status: "reverted", op: op.name }, 0);
  } finally {
    await closeVersioned(venv);
  }
}
