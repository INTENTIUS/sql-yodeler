import { parseArgs } from "node:util";
import { accessReview, clickhouseAccessRefusal, renderAccessReview } from "../chant/access.js";
import type { Command, Io } from "../command.js";
import { guarded } from "../env-args.js";
import { loadProject, resolveEnvironment, YodelError, type Environment, type Project, type SqlDialect } from "../project.js";
import { buildSchema } from "../chant/build.js";
import { declaredChanges, planEnvironment, planExitCode, planJson, renderPlan, unreadableOf, PLAN_NEEDS_OP } from "../chant/plan.js";
import { findApplyOp, GATED, runApplyOp } from "../chant/apply.js";
import { runnable } from "../chant/runnable.js";
import type { CheckOutcome, Migration } from "../migrations/index.js";
import { migrationSilences } from "../lint/index.js";
import { askedAgainLine, describeMove, explainAgainst, latestApproval } from "../versioned/explain.js";
import { declarativeAccessRefusal, declarativeTopologyRefusal, LOCK_WAIT_ENV, parseDuration } from "../config/settings.js";
import { policyAtBase } from "../config/base.js";
import { newerCommit, STAND_DOWN_ENV, standDownFromEnv, standDownLine } from "../versioned/stand-down.js";
import { describeServer, probeServer, type ServerInfo } from "../server.js";
import { eventFromRun, sendEvent } from "../notify/index.js";
import { EXIT_OUTSTANDING, EXIT_REFUSED } from "../exit.js";
import { describeStep, heldSteps, runApplySteps, stepsAtBase, stepsRefusal, type StepOutcome } from "../apply-steps/index.js";
import type { ApplyStep } from "../config/define.js";
import { enforcePromotion, forecastWave, planWave, readWavePlan, verifyWaveDecision, WavePlanMoved, WAVES_SPEC_FILE, writeWavePlan, type WavePlanFile, type WaveRecord } from "../waves/index.js";
import { applySlot, splitSlot, writeSlotPlan } from "../tenants/wave.js";
import {
  ALLOW_OUT_OF_ORDER_ENV,
  APPROVED_PLAN_ENV,
  checksDue,
  checksRefusal,
  describeResults,
  judgePlan,
  judgeRevert,
  policyRefusal,
  runChecks,
  currentDigest,
  currentRevert,
  executeApply,
  executeRevert,
  revertFromEnv,
  findMigrateOp,
  gitLedger,
  verifyApproval,
  hasMigrations,
  inspect,
  readChain,
  recordStepExit,
  closeVersioned,
  openVersioned,
  renderStatus,
  runMigrateOp,
  selectToApply,
  statusJson,
  statusReport,
  type MigrateOpRef,
  type VersionedEnv,
} from "../versioned/index.js";
import type { ExecuteOptions, ExecuteResult } from "../versioned/engine.js";
import type { StatusReport } from "../versioned/report.js";
import type { RuleResult } from "../versioned/policy.js";

/** When the gate's newest approval does not hold: what moved since (or that approval was asked for again), in one line. */
async function movedSinceApproval(project: Project, venv: VersionedEnv, ordered: readonly Migration[], op: MigrateOpRef, digest: string | undefined) {
  try {
    const latest = await latestApproval(await gitLedger(project.dir), op, digest);
    if (!latest?.digest || latest.holds) return undefined;
    if (latest.sameDigest) {
      return {
        moved: { approved: latest.digest, by: latest.by, at: latest.at, confirmed: true, changes: [], ...(latest.askedAgain ? { askedAgain: latest.askedAgain } : {}) },
        line: `Nothing was applied. The approval of ${latest.digest} (by ${latest.by} at ${latest.at}) ${askedAgainLine(latest)}.`,
      };
    }
    const moved = await explainAgainst(venv, ordered, { approvedDigest: latest.digest, approvedAt: latest.at });
    return {
      moved: { approved: latest.digest, by: latest.by, at: latest.at, confirmed: moved.confirmed, changes: moved.changes },
      line: `Nothing was applied. The approval of ${latest.digest} (by ${latest.by} at ${latest.at}) does not hold: the plan moved since. ${moved.confirmed ? "What moved" : "What moved, as far as yodel can tell"}: ${describeMove(moved)}.`,
    };
  } catch {
    return undefined;
  }
}

/** What a versioned run did, beyond the status it reports. */
export type VersionedOutcome =
  | { status: "planned" | "unchanged" }
  | { status: "refused"; preChecks?: { migration: string; checks: CheckOutcome[] }; refusal?: { exitCode: number; message: string } }
  | { status: "denied"; policy: RuleResult[] }
  | { status: "stood-down"; stoodDown: string; op?: string }
  | { status: "gated"; op: string; gate: string; moved?: NonNullable<Awaited<ReturnType<typeof movedSinceApproval>>>["moved"]; approve?: string; gatePlanDigest?: string }
  | { status: "failed"; op: string; exitCode: number; chantExitCode: number }
  | { status: "applied"; op: string; appliedNow: string[] };

/** What a declarative run (the ApplyOp) did; `plan` is the plan before the run. */
export type DeclarativeOutcome = { plan: Record<string, unknown> } & (
  | { status: "refused" | "unchanged" | "applied" }
  | { status: "gated"; gate: string; approve?: string; planDigest?: string }
  | { status: "failed"; exitCode: number }
  | { status: "incomplete"; remaining: Record<string, unknown> }
);

/** The parts of a `yodel apply --json` document, by path. */
export type ApplyDoc =
  | { mode: "versioned"; report: StatusReport; outcome: VersionedOutcome }
  | { mode: "execute"; environment: string; planDigest: string; result: ExecuteResult; wavePlanDigest?: string }
  | { mode: "wave-plan"; plan: WavePlanFile }
  | { mode: "declarative"; environment: string; dialect: SqlDialect; server?: ServerInfo | undefined; op: string; outcome: DeclarativeOutcome };

/** The document `yodel apply --json` prints (schemas/apply.schema.json). */
export function applyJson(doc: ApplyDoc): Record<string, unknown> {
  if (doc.mode === "versioned") return { ...statusJson(doc.report), mode: "versioned", ...doc.outcome };
  if (doc.mode === "execute") return { environment: doc.environment, status: doc.result.stoodDown ? "stood-down" : "applied", planDigest: doc.planDigest, ...(doc.wavePlanDigest ? { wavePlanDigest: doc.wavePlanDigest } : {}), ...doc.result };
  if (doc.mode === "wave-plan") return { ...doc.plan };
  return { environment: doc.environment, dialect: doc.dialect, ...(doc.server ? { server: doc.server } : {}), op: doc.op, ...doc.outcome };
}

const usage = "usage: yodel apply <env> [--json] [--dir <project>] [--op <name>] [--allow-out-of-order] [--plan] [--lock-wait <duration>] [--stand-down]";

const waveModes = ["wave-plan", "wave-apply"] as const;

const help = `${usage}

Two paths, chosen by the project:

- Versioned: the project has a migrations/ directory holding a migration.
  Applies the pending migrations in chain order, statement by statement,
  recording each in the history table (yodel.config.ts history.database,
  else YODEL_HISTORY_DATABASE, default yodeler) under the apply lock. Each
  statement is rendered for the environment's topology (yodel.config.ts
  topology, else sql.profiles.<env>.topology, else YODEL_TOPOLOGY, default
  single) as it is sent. Runs the project's migrations Op for the
  environment (chant run <op>), whose gate is bound to the plan digest: the
  pending migrations' checksums, the topology, the history and the live
  schema. A run that stops at the gate prints the chant approve command;
  approve, then run yodel apply again. At a terminal, yodel approve <env>
  approves the same plan without the digest to copy: yodel approve <env>,
  then yodel apply <env>. If anything the digest covers changes after
  approval, the gate asks again.

  A migration that failed part way resumes at the statement that failed; a
  statement that succeeded is never sent again. An Op step (a ClickHouse
  rebuild, a backfill) runs in its place among the statements, under the
  same lock and approval; one that failed or was stopped runs again and
  resumes from its receipts, skipping the partitions or batches that
  finished. Every applied migration's
  checksum is checked against its files first, and a mismatch refuses. A
  pending migration the chain puts before an applied one is out of order
  and is refused unless --allow-out-of-order; it is never skipped.

  The policy in yodel.config.ts (policy.rules) is judged over the plan
  before the gate and again under the lock: a rule that denies it refuses
  (exit 4) naming the rule, unless someone policy.overriders lists recorded
  an override for exactly this plan digest (yodel override <env> --rule <id>
  --reason <text>). The history records the overrides a run relied on.

  A migration's pre-migration checks (checks in its migration.json, read-only
  queries) run against the environment: the first pending migration's before
  the gate, and every migration's under the lock just before its first
  statement. One that fails refuses (exit 4), naming it, and nothing of that
  migration is applied.

  <env> can be one tenant of a tenant set, <env>/<tenant> (yodel.config.ts
  environments.<env>.tenants): the environment's profile on the tenant's
  database or schema, each statement with the template's name replaced by
  the tenant's, and a history of its own. A tenant set is applied tenant by
  tenant, or by its wave, which gates once for every tenant. The wave of a
  set given by a query runs slots, <env>/@<i>of<n>, each every tenant the
  query lists when it runs whose name hashes to it.

- Declarative: no migrations. Plans the declared schema against the live
  database, then runs the project's ApplyOp for the environment behind its
  plan-bound gate.

Options:
  --json                print the outcome as JSON
  --op <name>           the Op to run, when more than one applies <env>
  --allow-out-of-order  versioned: apply out-of-order migrations too
  --plan                versioned: print the pending migrations and the plan
                        digest, apply nothing
  --lock-wait <d>       versioned: when another apply holds the lock, wait up
                        to <d> (90, 30s, 10m, 1h) for it, naming the holder,
                        before giving up with exit 5. Default: yodel.config.ts
                        lockWait (seconds), else YODEL_LOCK_WAIT, else 0
  --stand-down          versioned: when the branch this run is for has a newer
                        commit on origin (GITHUB_REF_NAME, CI_COMMIT_BRANCH,
                        else the checked-out branch), apply nothing and exit 0:
                        that commit's own apply applies this environment.
                        Asked before the lock and while waiting for it. Also
                        YODEL_STAND_DOWN=1
  -C, --dir <dir>       the project directory (default: the working directory)

The migrations Op runs two steps of its own, not for direct use:
  --digest   print the plan digest alone (the Op's Plan step)
  --execute  apply under the lock, if the digest is still the one in
             ${APPROVED_PLAN_ENV} and chant's gate ledger holds an approval
             of the Op's gate for it (the Op's Apply step)

The apply pipeline's wave jobs (chant run wave, ${WAVES_SPEC_FILE}) run two more:
  --wave-plan <file>   write the environment's wave plan to <file>: the
                       plan digest, the gate policy at the base commit, and
                       whether a pending step is destructive
  --wave-apply <file>  apply the plan in <file> under the lock, if it is
                       still the plan now and chant's decision for the
                       wave lets it through (an approval of the wave's
                       digest, or a policy at the base commit that needs none)
  --spec <file>        the waves spec (default ${WAVES_SPEC_FILE})

Exit codes:
  0  applied, or nothing to apply, or (--stand-down) stood down for a newer
     commit, applying nothing
  2  a change needs its own Op (declarative), or a pending migration has a
     manual step or an Op step apply does not run (versioned: it runs
     ClickHouseRebuildOp in materialized-view mode and backfill steps on
     ClickHouse, PostgresMigrationOp on Postgres);
     nothing was applied
  3  stopped at the gate, waiting for approval of this plan
  4  versioned: refused, nothing applied: a checksum mismatch, an applied
     migration gone from the directory, an out-of-order migration
     without --allow-out-of-order, a pre-migration check that failed, a
     policy rule that denies the plan with no override, or a pending
     migration the environment this one requires (yodel.config.ts
     waves[].requires, default the wave before) does not record as applied
     with the same checksum
  5  versioned: another apply holds the lock (after --lock-wait, if given)
  1  anything else failed: a statement (the history records where; rerun to
     resume), a plan that moved since approval, a bad config
`;

interface ApplyArgs {
  env: string;
  json: boolean;
  dir: string;
  op: string | undefined;
  allowOutOfOrder: boolean;
  plan: boolean;
  digest: boolean;
  execute: boolean;
  /** `--lock-wait`, in ms; undefined when not given. */
  lockWaitMs: number | undefined;
  standDown: boolean;
  wavePlan: string | undefined;
  waveApply: string | undefined;
  spec: string;
  /** A tenant of a slot (#56): chant decided the slot, so the decision is checked for it. */
  decidedAs?: { target: string; planDigest: string } | undefined;
}

function parseApplyArgs(args: string[]): ApplyArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: "boolean" },
        dir: { type: "string", short: "C" },
        op: { type: "string" },
        "allow-out-of-order": { type: "boolean" },
        plan: { type: "boolean" },
        digest: { type: "boolean" },
        execute: { type: "boolean" },
        "lock-wait": { type: "string" },
        "stand-down": { type: "boolean" },
        "wave-plan": { type: "string" },
        "wave-apply": { type: "string" },
        spec: { type: "string" },
      },
    });
  } catch (e) {
    throw new YodelError(`${e instanceof Error ? e.message : String(e)}\n${usage}`);
  }
  const { values, positionals } = parsed;
  const [env, ...rest] = positionals;
  if (env === undefined || rest.length > 0) throw new YodelError(usage);
  const flag = (k: string) => values[k] === true;
  const str = (k: string) => (typeof values[k] === "string" ? values[k] : undefined);
  const modes = [...["plan", "digest", "execute"].filter(flag), ...waveModes.filter((k) => str(k) !== undefined)];
  if (modes.length > 1) throw new YodelError(`--${modes.join(" and --")} cannot be combined\n${usage}`);
  return {
    env,
    json: flag("json"),
    dir: typeof values.dir === "string" ? values.dir : process.cwd(),
    op: typeof values.op === "string" ? values.op : undefined,
    allowOutOfOrder: flag("allow-out-of-order") || process.env[ALLOW_OUT_OF_ORDER_ENV] === "1",
    plan: flag("plan"),
    digest: flag("digest"),
    execute: flag("execute"),
    lockWaitMs: typeof values["lock-wait"] === "string" ? parseDuration(values["lock-wait"], "--lock-wait") : undefined,
    standDown: flag("stand-down") || standDownFromEnv(process.env),
    wavePlan: str("wave-plan"),
    waveApply: str("wave-apply"),
    spec: str("spec") ?? WAVES_SPEC_FILE,
  };
}

/** `yodel apply <env>`; the exit codes are in `help`. */
export const apply: Command = {
  name: "apply",
  summary: "bring an environment to its declared schema or pending migrations",
  implemented: true,
  run: async (args, io) => {
    const code = await guarded("apply", io, args, help, async () => {
      const a = parseApplyArgs(args);
      const project = await loadProject(a.dir);
      if (splitSlot(a.env)) return slotWave(project, a, io);
      const env = resolveEnvironment(project, a.env);
      if (!env.tenant && project.yodel?.config.environments?.[env.name]?.tenants) {
        throw new YodelError(`${env.name} is a tenant set (yodel.config.ts environments.${env.name}.tenants): apply a tenant, yodel apply ${env.name}/<tenant>, or every tenant through ${env.name}'s wave in the apply pipeline`);
      }
      if (hasMigrations(project)) return versionedApply(project, env, a, io);
      if (a.plan || a.digest || a.execute || a.allowOutOfOrder || a.lockWaitMs !== undefined || args.includes("--stand-down") || a.wavePlan !== undefined || a.waveApply !== undefined) {
        throw new YodelError(`--plan, --digest, --execute, --wave-plan, --wave-apply, --allow-out-of-order, --lock-wait and --stand-down are for versioned migrations, and ${project.dir} has no migrations/ directory with a migration`);
      }
      const refusal = project.dialect === "clickhouse" ? declarativeTopologyRefusal(project, env.name) : declarativeAccessRefusal(project, env.name);
      if (refusal) throw refusal;
      return declarativeApply(project, env, a, io);
    });
    if (args.includes("--execute")) recordStepExit(code);
    return code;
  },
};

/**
 * A slot of a tenant set's wave read at run time (#56), `<env>/@<i>of<n>`:
 * every tenant the set's query lists now that hashes to the slot, planned
 * or applied each against its own history and lock.
 */
async function slotWave(project: Project, a: ApplyArgs, io: Io): Promise<number> {
  if (!hasMigrations(project)) throw new YodelError(`${a.env} is a slot of a tenant set's wave, for versioned migrations, and ${project.dir} has no migrations/ directory with a migration`);
  const ordered = readChain(project);
  const log = (l: string) => { io.err(`${l}\n`); };
  if (a.wavePlan !== undefined) {
    const plan = await writeSlotPlan(project, a.env, ordered, a.wavePlan, { allowOutOfOrder: a.allowOutOfOrder }, log);
    const forecast = await forecastWave(process.cwd(), a.spec, plan);
    if (forecast?.waits) {
      const set = splitSlot(a.env)?.env ?? a.env;
      log(`${set}: wave ${String(forecast.wave)} waits for an approval of ${forecast.digest} (gate ${forecast.policy} at ${forecast.base.slice(0, 12)}) for every tenant. Approve it with yodel approve ${set}, or: ${forecast.approve}`);
    }
    if (a.json) io.out(`${JSON.stringify(plan, null, 2)}\n`);
    return 0;
  }
  if (a.waveApply !== undefined) {
    return applySlot(a.env, a.waveApply, (tenant, file, decidedAs) => versionedApply(project, resolveEnvironment(project, tenant), { ...a, env: tenant, waveApply: file, decidedAs }, io), log);
  }
  throw new YodelError(`${a.env} is a slot of ${splitSlot(a.env)?.env ?? ""}'s wave, which chant run wave plans and applies with --wave-plan and --wave-apply; apply a tenant with yodel apply <env>/<tenant>`);
}

async function versionedApply(project: Project, env: Environment, a: ApplyArgs, io: Io): Promise<number> {
  const ordered = readChain(project);
  const venv = await openVersioned(project, env);
  const outcome: Outcome = {};
  let code: number;
  try {
    code = await versionedApplyWith(project, env, a, io, ordered, venv, outcome);
  } catch (e) {
    // The wave modes run inside chant run wave, which keeps no outcome of its own: a refusal or failure there is told here (#87).
    if (a.wavePlan !== undefined || a.waveApply !== undefined) outcome.doc = waveFailure(env.name, e);
    await closeVersioned(venv);
    if (outcome.doc) await sendEvent(project.yodel?.config.notify, eventFromRun("apply", outcome.doc), { io, verb: "apply" });
    throw e;
  }
  await closeVersioned(venv);
  // Waiting, refused or failed: the webhook in yodel.config.ts notify hears of it (#61).
  if (outcome.doc) await sendEvent(project.yodel?.config.notify, eventFromRun("apply", outcome.doc), { io, verb: "apply" });
  return code;
}

/** The outcome a wave mode's error is: refused (exit 4, or 3 for a wave with no decision that lets it through; nothing applied) or failed. */
export function waveFailure(environment: string, e: unknown): Record<string, unknown> {
  const message = e instanceof Error ? e.message : String(e);
  const exitCode = e instanceof YodelError ? e.exitCode : 1;
  return exitCode === EXIT_REFUSED || exitCode === EXIT_OUTSTANDING ? { environment, status: "refused", refusal: { message } } : { environment, status: "failed", exitCode, reason: message };
}

/** The document a run printed (or would have, with --json), for the event it sends. */
interface Outcome {
  doc?: Record<string, unknown>;
}

async function versionedApplyWith(project: Project, env: Environment, a: ApplyArgs, io: Io, ordered: readonly Migration[], venv: VersionedEnv, outcome: Outcome = {}): Promise<number> {

  // yodel revert (#55) runs this Op with the migration to revert in the environment: its Plan and Apply steps plan and run that instead.
  const revert = a.digest || a.execute ? revertFromEnv(process.env, project.dir) : undefined;
  if (revert && a.digest) {
    io.out(`${(await currentRevert(venv, ordered, revert.id, revert.step)).digest}\n`);
    return 0;
  }
  if (revert && a.execute) {
    const approved = process.env[APPROVED_PLAN_ENV];
    if (!approved) throw new YodelError(`--execute reverts only the plan its Op's gate approved, and ${APPROVED_PLAN_ENV} is not set; run yodel revert ${env.name} ${revert.id}`);
    const op = await findMigrateOp(project, env, a.op);
    const ledger = await gitLedger(project.dir);
    // The policy over the revert (#97), as the base commit has it (#73), as yodel revert judged it before the gate.
    const { policy: basePolicy, note: policyNote } = await policyAtBase(project);
    if (policyNote) io.err(`${policyNote}\n`);
    const plan = await executeRevert(venv, ordered, {
      id: revert.id,
      step: revert.step,
      approvedDigest: approved,
      ...(a.lockWaitMs !== undefined ? { lockWaitMs: a.lockWaitMs } : {}),
      approve: async (digest) => {
        const by = await verifyApproval(ledger, op, digest);
        io.err(`approval: ${op.name} / ${op.gate} for ${digest}, by ${by.resolvedBy} at ${by.timestamp}\n`);
      },
      ...(basePolicy
        ? {
            policy: async (digest, planned) => {
              const results = await judgeRevert({ policy: basePolicy, environment: env.name, dialect: project.dialect, plan: planned, digest, ledger: () => Promise.resolve({ port: ledger, op }) });
              const refusal = policyRefusal(results, env.name, digest, "under the lock", { id: revert.id, step: revert.step?.file });
              if (refusal) throw refusal;
              for (const line of describeResults(results)) io.err(`${line}\n`);
              return results.flatMap((r) => (r.override ? [r.override] : []));
            },
          }
        : {}),
      log: (l) => { io.err(`${l}\n`); },
    });
    io.out(`Reverted: ${plan.migration.id}, back to ${plan.to ?? "an empty schema"}\n`);
    return 0;
  }

  if (a.digest) {
    const { status } = await inspect(venv, ordered);
    const toApply = selectToApply(status, a.allowOutOfOrder);
    io.out(`${await currentDigest(venv, status, toApply)}\n`);
    return 0;
  }

  if (a.wavePlan !== undefined) {
    const plan = await writeWavePlan(project, venv, ordered, a.wavePlan, { allowOutOfOrder: a.allowOutOfOrder });
    io.err(
      `${env.name}: ${plan.empty ? "nothing to apply" : `${String(plan.pending.length)} pending (${plan.pending.join(", ")})`}; gate ${plan.gate} at ${plan.base.slice(0, 12)}` +
        `${plan.destructive ? `; destructive: ${plan.destructiveSteps.map((d) => `${d.migration} step ${String(d.step)} (${d.why})`).join(", ")}` : ""}; plan ${plan.planDigest}\n`,
    );
    // The before steps (#64): the SQL checks as they ran, and each command as one that will run under the lock (#107).
    for (const o of plan.steps ?? []) io.err(`${describeStep(o)}\n`);
    // chant decides the wave right after this; tell the webhook now when it will wait (#87), since chant sends nothing.
    const forecast = await forecastWave(process.cwd(), a.spec, plan);
    if (forecast?.waits) {
      // A tenant set's wave (#56) is approved once for every tenant.
      const how = env.tenant ? `for every tenant of ${env.tenant.env}. Approve it with yodel approve ${env.tenant.env}, or: ` : `. Approve it with yodel approve ${env.name}, or: `;
      io.err(`${env.name}: wave ${String(forecast.wave)} waits for an approval of ${forecast.digest} (gate ${forecast.policy} at ${forecast.base.slice(0, 12)})${how}${forecast.approve}\n`);
      outcome.doc = { environment: env.name, status: "gated", pending: plan.pending.map((id) => ({ id })), gatePlanDigest: forecast.digest, approve: forecast.approve };
    }
    if (a.json) io.out(`${JSON.stringify(applyJson({ mode: "wave-plan", plan }), null, 2)}\n`);
    return 0;
  }

  if (a.waveApply !== undefined) {
    const planned = readWavePlan(a.waveApply);
    const { policy: basePolicy, note: policyNote } = await policyAtBase(project);
    if (policyNote) io.err(`${policyNote}\n`);
    if (planned.environment !== env.name) throw new YodelError(`refused: ${a.waveApply} is ${planned.environment}'s plan, not ${env.name}'s; nothing was applied`, EXIT_REFUSED);
    const cwd = process.cwd();
    let wave: WaveRecord | undefined;
    let before: StepOutcome[] = [];
    const steps = await stepsAtBase(project, env.name);
    if (steps.note) io.err(`${steps.note}\n`);
    const result = await executeApply(venv, ordered, {
      runNote: () => (wave || before.length > 0 ? { ...(wave ? { wave } : {}), ...(before.length > 0 ? { steps: before } : {}) } : undefined),
      ...afterSteps(project, venv, env, steps.steps?.after, io),
      approvedDigest: planned.migrations,
      allowOutOfOrder: a.allowOutOfOrder,
      ...(a.lockWaitMs !== undefined ? { lockWaitMs: a.lockWaitMs } : {}),
      ...(a.standDown ? { standDown: standingDown(project, env) } : {}),
      ...(basePolicy
        ? {
            policy: async (digest, toApply) => {
              const ledger = async () => {
                try {
                  return { port: await gitLedger(project.dir), op: await findMigrateOp(project, env, a.op) };
                } catch {
                  return undefined;
                }
              };
              const results = await judgePlan({ policy: basePolicy, environment: env.name, dialect: project.dialect, toApply, digest, ledger });
              const refusal = policyRefusal(results, env.name, digest, "under the lock");
              if (refusal) throw refusal;
              for (const line of describeResults(results)) io.err(`${line}\n`);
              return results.flatMap((r) => (r.override ? [r.override] : []));
            },
          }
        : {}),
      approve: async () => {
        // Under the lock: the wave plan now, and chant's decision for it.
        const now = await planWave(project, venv, ordered, { allowOutOfOrder: a.allowOutOfOrder });
        if (now.planDigest !== planned.planDigest) {
          throw new WavePlanMoved(`refused: ${env.name}'s wave plan moved since the wave was decided (decided ${planned.planDigest}, now ${now.planDigest}); nothing was applied. Run the wave again.`);
        }
        // The before steps' SQL checks (#64) ran again in that plan, under the lock; a held one needs a person's approval whatever the gate.
        const checked = (now.steps ?? []).filter((o) => !o.deferred);
        for (const o of checked) io.err(`${describeStep(o)}\n`);
        let verified = await verifyWaveDecision(cwd, a.spec, a.decidedAs?.target ?? env.name, a.decidedAs?.planDigest ?? planned.planDigest, now.held ?? []);
        // The commands (#107) run once, here, once the wave may apply: one that fails refuses; a held one needs the approval too.
        const commands = await runBeforeSteps(project, venv, env, steps.steps?.before?.filter((s) => s.sql === undefined), "under the lock", io);
        before = [...checked, ...commands];
        if (heldSteps(commands).length > 0 && verified.wave.status !== "approved") verified = await verifyWaveDecision(cwd, a.spec, a.decidedAs?.target ?? env.name, a.decidedAs?.planDigest ?? planned.planDigest, [...(now.held ?? []), ...heldSteps(commands)]);
        wave = verified.wave;
        io.err(`${verified.line}\n`);
      },
      log: (l) => { io.err(`${l}\n`); },
      silences: migrationSilences,
    });
    if (a.json) io.out(`${JSON.stringify(applyJson({ mode: "execute", environment: env.name, planDigest: planned.migrations, wavePlanDigest: planned.planDigest, result }), null, 2)}\n`);
    else io.out(result.stoodDown ? `${result.stoodDown}\n` : result.applied.length === 0 ? "Nothing to apply.\n" : `Applied: ${result.applied.join(", ")}\n`);
    return 0;
  }

  if (a.execute) {
    const approved = process.env[APPROVED_PLAN_ENV];
    const { policy: basePolicy, note: policyNote } = await policyAtBase(project);
    if (policyNote) io.err(`${policyNote}\n`);
    if (!approved) throw new YodelError(`--execute applies only the plan its Op's gate approved, and ${APPROVED_PLAN_ENV} is not set; run yodel apply ${env.name}`);
    // The env var is only the Op's hand-off; the approval itself is checked in chant's gate ledger, under the lock.
    const op = await findMigrateOp(project, env, a.op);
    const ledger = await gitLedger(project.dir);
    const steps = await stepsAtBase(project, env.name);
    if (steps.note) io.err(`${steps.note}\n`);
    let before: StepOutcome[] = [];
    const result = await executeApply(venv, ordered, {
      runNote: () => (before.length > 0 ? { steps: before } : undefined),
      ...afterSteps(project, venv, env, steps.steps?.after, io),
      approvedDigest: approved,
      allowOutOfOrder: a.allowOutOfOrder,
      ...(a.lockWaitMs !== undefined ? { lockWaitMs: a.lockWaitMs } : {}),
      ...(a.standDown ? { standDown: standingDown(project, env) } : {}),
      approve: async (digest) => {
        // Under the lock: every pending migration ran first where this environment requires (exit 4 otherwise).
        await enforcePromotion(project, env.name, ordered, (await inspect(venv, ordered)).status.pending);
        const by = await verifyApproval(ledger, op, digest);
        io.err(`approval: ${op.name} / ${op.gate} for ${digest}, by ${by.resolvedBy} at ${by.timestamp}\n`);
        // The before steps (#64), under the lock: one that fails refuses; a held one is let through by the Op's approval, which every run of it asks for.
        before = await runBeforeSteps(project, venv, env, steps.steps?.before, "under the lock", io);
      },
      log: (l) => { io.err(`${l}\n`); },
      silences: migrationSilences,
      ...(basePolicy
        ? {
            policy: async (digest, toApply) => {
              const results = await judgePlan({ policy: basePolicy, environment: env.name, dialect: project.dialect, toApply, digest, ledger: () => Promise.resolve({ port: ledger, op }) });
              const refusal = policyRefusal(results, env.name, digest, "under the lock");
              if (refusal) throw refusal;
              for (const line of describeResults(results)) io.err(`${line}\n`);
              return results.flatMap((r) => (r.override ? [r.override] : []));
            },
          }
        : {}),
    });
    if (a.json) io.out(`${JSON.stringify(applyJson({ mode: "execute", environment: env.name, planDigest: approved, result }), null, 2)}\n`);
    else io.out(result.stoodDown ? `${result.stoodDown}\n` : result.applied.length === 0 ? "Nothing to apply.\n" : `Applied: ${result.applied.join(", ")}\n`);
    return 0;
  }

  const report = await statusReport(venv, ordered, { allowOutOfOrder: a.allowOutOfOrder });
  const emit = (doc: VersionedOutcome, code: number) => {
    outcome.doc = applyJson({ mode: "versioned", report, outcome: doc });
    if (a.json) io.out(`${JSON.stringify(outcome.doc, null, 2)}\n`);
    return code;
  };
  if (a.plan) {
    if (!a.json) io.out(renderStatus(report));
    return emit({ status: report.refusal ? "refused" : report.status.pending.length === 0 ? "unchanged" : "planned" }, report.refusal?.exitCode ?? 0);
  }
  if (report.refusal) {
    if (!a.json) io.err(`yodel apply: ${report.refusal.message}\n`);
    return emit({ status: "refused" }, report.refusal.exitCode);
  }
  if (report.status.pending.length === 0) {
    if (!a.json) io.out(`${env.name}${report.server ? ` (${describeServer(report.server)})` : ""} is up to date: every migration is applied.\n`);
    return emit({ status: "unchanged" }, 0);
  }

  const standDown = a.standDown ? standingDown(project, env) : undefined;
  const stood = await standDown?.();
  if (stood) {
    if (!a.json) io.out(`${stood}\n`);
    return emit({ status: "stood-down", stoodDown: stood }, 0);
  }

  // Before the gate: a pending migration the required environment has not applied refuses, and nothing is asked.
  try {
    await enforcePromotion(project, env.name, ordered, report.status.pending);
  } catch (e) {
    if (!(e instanceof YodelError) || e.exitCode !== EXIT_REFUSED) throw e;
    if (!a.json) io.err(`yodel apply: ${e.message}\n`);
    return emit({ status: "refused", refusal: { exitCode: EXIT_REFUSED, message: e.message } }, EXIT_REFUSED);
  }

  // The first pending migration's checks (#52) read the data as it is now: one that fails refuses before anyone is asked to approve. The Apply step runs every migration's again under the lock.
  const first = report.status.pending[0];
  let checked: { migration: string; checks: CheckOutcome[] } | undefined;
  if (first && checksDue(first)) {
    const outcomes = await runChecks(venv.driver, first.migration);
    checked = { migration: first.id, checks: outcomes };
    const refusal = checksRefusal(first.migration, outcomes, "before the gate");
    if (refusal) {
      if (!a.json) io.err(`yodel apply: ${refusal.message}\n`);
      return emit({ status: "refused", preChecks: checked }, refusal.exitCode);
    }
  }

  // The before steps (#64), as the base commit has them: a SQL check that fails refuses before anyone is asked; the Apply step runs them again under the lock.
  // A command runs there alone (#107), once per apply: here the plan only says it will.
  const steps = await stepsAtBase(project, env.name);
  if (steps.note && !a.json) io.err(`${steps.note}\n`);
  try {
    const outcomes = await runBeforeSteps(project, venv, env, steps.steps?.before, "before the gate", a.json ? undefined : io, "plan");
    if (!a.json && heldSteps(outcomes).length > 0) io.out(`before step ${heldSteps(outcomes).join(", ")} failed with onFailure approve: approving this plan lets it through\n`);
  } catch (e) {
    if (!(e instanceof YodelError) || e.exitCode !== EXIT_REFUSED) throw e;
    if (!a.json) io.err(`yodel apply: ${e.message}\n`);
    return emit({ status: "refused", refusal: { exitCode: EXIT_REFUSED, message: e.message } }, EXIT_REFUSED);
  }

  const op = await findMigrateOp(project, env, a.op);
  // The policy (#53), as the base commit has it (#73): a rule that denies this plan, with no override recorded for its digest, refuses before the gate.
  const basePolicy = await policyAtBase(project);
  if (basePolicy.note && !a.json) io.err(`${basePolicy.note}\n`);
  const policy = await judgePlan({
    policy: basePolicy.policy,
    environment: env.name,
    dialect: project.dialect,
    toApply: report.status.pending,
    digest: report.digest,
    ledger: async () => ({ port: await gitLedger(project.dir), op }),
  });
  const denied = policyRefusal(policy, env.name, report.digest, "before the gate");
  if (denied) {
    if (!a.json) io.err(`yodel apply: ${denied.message}\n`);
    return emit({ status: "denied", policy }, denied.exitCode);
  }

  if (!a.json) io.out(renderStatus(report));
  if (!a.json && checked) for (const o of checked.checks) io.out(`check ${o.name} of ${checked.migration} passed (${o.detail}); it runs again under the lock before the first statement\n`);
  if (!a.json) for (const line of describeResults(policy)) io.out(`${line}\n`);
  if (!a.json) io.out(`\nRunning ${op.name} (${op.filePath})\n`);
  // The Op's Apply step (yodel apply --execute) takes these from its environment.
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...(a.lockWaitMs !== undefined ? { [LOCK_WAIT_ENV]: `${String(a.lockWaitMs)}ms` } : {}),
    ...(a.standDown ? { [STAND_DOWN_ENV]: "1" } : {}),
  };
  const run = await runMigrateOp(project, op, { allowOutOfOrder: a.allowOutOfOrder, env: childEnv, onOutput: (t) => { io.err(t); } });
  if (run.status === "gated") {
    const stale = await movedSinceApproval(project, venv, ordered, op, run.planDigest ?? report.digest);
    if (stale && !a.json) io.out(`\n${stale.line}\n`);
    if (!a.json) {
      io.out(`\n${op.name} is waiting at gate "${op.gate}" for approval of this plan${run.planDigest ? ` (${run.planDigest})` : ""}.\n`);
      if (run.approve) {
        io.out(
          `Approve it with:\n  ${runnable(run.approve, project.dir)}\n` +
            `or, at a terminal, with ${runnable(`yodel approve ${env.name}`, project.dir)}, which shows the plan and asks you first;\n` +
            `then run ${runnable(`yodel apply ${env.name}`, project.dir)} again.\n`,
        );
      }
    }
    return emit({ status: "gated", op: op.name, gate: op.gate, ...(stale ? { moved: stale.moved } : {}), ...(run.approve ? { approve: run.approve } : {}), ...(run.planDigest ? { gatePlanDigest: run.planDigest } : {}) }, GATED);
  }

  const after = await statusReport(venv, ordered, { allowOutOfOrder: a.allowOutOfOrder });
  if (run.status === "failed") {
    // The Apply step's own code (5 for the lock, 4 for a refusal) is what a script retries or stops on; chant run reports any failed step as 1.
    const code = run.stepExit !== undefined && run.stepExit !== 0 ? run.stepExit : 1;
    if (!a.json) {
      io.err(`yodel apply: chant run ${op.name} failed (exit ${String(run.code)})${run.stepExit ? `: its Apply step, yodel apply ${env.name} --execute, exited ${String(run.stepExit)}` : ""}\n`);
      io.out(`\n${renderStatus(after)}`);
    }
    outcome.doc = applyJson({ mode: "versioned", report: after, outcome: { status: "failed", op: op.name, exitCode: code, chantExitCode: run.code } });
    if (a.json) io.out(`${JSON.stringify(outcome.doc, null, 2)}\n`);
    return code;
  }
  // The Apply step stood down (a newer commit came while it waited for the lock): what it applied is nothing, and that is not a failure.
  const stoodLate = after.status.pending.length > 0 ? await standDown?.() : undefined;
  if (stoodLate) {
    if (!a.json) io.out(`\n${stoodLate}\n`);
    return emit({ status: "stood-down", stoodDown: stoodLate, op: op.name }, 0);
  }
  if (a.json) {
    io.out(`${JSON.stringify(applyJson({ mode: "versioned", report: after, outcome: { status: "applied", op: op.name, appliedNow: report.status.pending.map((p) => p.id) } }), null, 2)}\n`);
  } else {
    io.out(`\nApplied: ${report.status.pending.map((p) => p.id).join(", ")}.\n`);
  }
  return after.status.pending.length === 0 ? 0 : 1;
}

async function declarativeApply(project: Project, env: Environment, a: ApplyArgs, io: Io): Promise<number> {
  const op = await findApplyOp(project, env, a.op);
  let server: ServerInfo | undefined;
  let printed: Record<string, unknown> | undefined;
  const report = (doc: DeclarativeOutcome, code: number) => {
    printed = applyJson({ mode: "declarative", environment: env.name, dialect: project.dialect, server, op: op.name, outcome: doc });
    if (a.json) io.out(`${JSON.stringify(printed, null, 2)}\n`);
    return code;
  };
  const code = await declarativeRun(project, env, a, io, op, report, (s) => (server = s));
  if (printed) await sendEvent(project.yodel?.config.notify, eventFromRun("apply", printed), { io, verb: "apply" });
  return code;
}

async function declarativeRun(
  project: Project,
  env: Environment,
  a: ApplyArgs,
  io: Io,
  op: Awaited<ReturnType<typeof findApplyOp>>,
  report: (doc: DeclarativeOutcome, code: number) => number,
  setServer: (s: ServerInfo | undefined) => void,
): Promise<number> {
  const json = a.json;

  const build = await buildSchema(project);
  try {
    const chRefusal = project.dialect === "clickhouse" ? clickhouseAccessRefusal(project, env.name, build.output) : undefined;
    if (chRefusal) throw chRefusal;
    const before = await planEnvironment(project, env, build);
    const server = await probeServer(project, env);
    setServer(server);
    if (!json) {
      io.out(`${await renderPlan(before, `Plan for ${env.name} (${server ? describeServer(server) : project.dialect}, sql.profiles.${env.name})`)}\n`);
      const review = renderAccessReview(await accessReview(project, env.name, before.diff.changes, build.output), env.name);
      if (review.length > 0) io.out(`\n${review.join("\n")}\n`);
    }
    if (planExitCode(before) === PLAN_NEEDS_OP) {
      const unreadable = unreadableOf(before);
      if (!json) io.err(`yodel apply: refused: ${unreadable.length > 0 ? `${unreadable.map((u) => u.object).join(", ")} could not be read` : `${String(before.refused.length)} change(s) need their own Op`}; nothing was applied\n`);
      return report({ status: "refused", plan: planJson(before) }, PLAN_NEEDS_OP);
    }
    if (declaredChanges(before, build).length === 0) {
      if (!json) io.out(`${env.name} already matches the declared schema; nothing to apply.\n`);
      return report({ status: "unchanged", plan: planJson(before) }, 0);
    }

    if (!json) io.out(`\nRunning ${op.name} (${op.filePath})\n`);
    const run = await runApplyOp(project, op, { onOutput: (t) => { io.err(t); } });
    if (run.status === "gated") {
      if (!json) {
        io.out(`\n${op.name} is waiting at gate "${op.gate}" for approval of this plan.\n`);
        if (run.approve) io.out(`Approve it with:\n  ${runnable(run.approve, project.dir)}\nthen run ${runnable(`yodel apply ${env.name}`, project.dir)} again.\n`);
      }
      return report({ status: "gated", gate: op.gate, ...(run.approve ? { approve: run.approve } : {}), ...(run.planDigest ? { planDigest: run.planDigest } : {}), plan: planJson(before) }, GATED);
    }
    if (run.status === "failed") {
      if (!json) io.err(`yodel apply: chant run ${op.name} failed (exit ${String(run.code)})\n`);
      return report({ status: "failed", exitCode: run.code, plan: planJson(before) }, 1);
    }

    // The Op completed: check the server now matches, so a change the applier did not attempt is not reported as applied.
    const after = await planEnvironment(project, env, build);
    const remaining = declaredChanges(after, build);
    if (remaining.length > 0) {
      if (!json) io.err(`yodel apply: ${op.name} completed but ${String(remaining.length)} change(s) to declared objects are still planned (a drop the Op's delete mode withholds, or a change it did not attempt):\n${await renderPlan(after, `Plan for ${env.name} after apply`)}\n`);
      return report({ status: "incomplete", plan: planJson(before), remaining: planJson(after) }, 1);
    }
    if (!json) io.out(`\nApplied: ${env.name} matches the declared schema.\n`);
    return report({ status: "applied", plan: planJson(before) }, 0);
  } finally {
    build.dispose();
  }
}

/** `--stand-down`'s question: the line to stand down with, when a newer commit on the run's branch will apply `env`. */
function standingDown(project: Project, env: Environment): () => Promise<string | undefined> {
  return async () => {
    const n = await newerCommit(project.dir);
    return n ? standDownLine(env.name, n) : undefined;
  };
}

/** Runs `env`'s before steps (#64); throws the refusal for one that fails with onFailure fail. */
async function runBeforeSteps(project: Project, venv: VersionedEnv, env: Environment, list: readonly ApplyStep[] | undefined, when: string, io: Io | undefined, commands: "run" | "plan" = "run"): Promise<StepOutcome[]> {
  if (!list || list.length === 0) return [];
  const outcomes = await runApplySteps(venv.driver, list, "before", { dir: project.dir, env: env.name, commands });
  for (const o of outcomes) io?.err(`${describeStep(o)}\n`);
  const refusal = stepsRefusal(env.name, outcomes, when);
  if (refusal) throw refusal;
  return outcomes;
}

/** executeApply's `after` (#64), when `env` has after steps. */
function afterSteps(project: Project, venv: VersionedEnv, env: Environment, list: readonly ApplyStep[] | undefined, io: Io): Pick<ExecuteOptions, "after"> {
  if (!list || list.length === 0) return {};
  return {
    after: async () => {
      const outcomes = await runApplySteps(venv.driver, list, "after", { dir: project.dir, env: env.name });
      for (const o of outcomes) io.err(`${describeStep(o)}\n`);
      const error = stepsRefusal(env.name, outcomes, "under the lock");
      return { note: { steps: outcomes }, ...(error ? { error } : {}) };
    },
  };
}
