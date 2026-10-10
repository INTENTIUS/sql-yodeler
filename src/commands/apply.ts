import { parseArgs } from "node:util";
import type { Command, Io } from "../command.js";
import { guarded } from "../env-args.js";
import { loadProject, resolveEnvironment, YodelError, type Environment, type Project, type SqlDialect } from "../project.js";
import { buildSchema } from "../chant/build.js";
import { declaredChanges, planEnvironment, planExitCode, planJson, renderPlan, PLAN_NEEDS_OP } from "../chant/plan.js";
import { findApplyOp, GATED, runApplyOp } from "../chant/apply.js";
import { runnable } from "../chant/runnable.js";
import type { CheckOutcome, Migration } from "../migrations/index.js";
import { migrationSilences } from "../lint/index.js";
import { askedAgainLine, describeMove, explainAgainst, latestApproval } from "../versioned/explain.js";
import { declarativeTopologyRefusal, LOCK_WAIT_ENV, parseDuration } from "../config/settings.js";
import { newerCommit, STAND_DOWN_ENV, standDownFromEnv, standDownLine } from "../versioned/stand-down.js";
import { describeServer, probeServer, type ServerInfo } from "../server.js";
import { eventFromRun, sendEvent } from "../notify/index.js";
import { EXIT_REFUSED } from "../exit.js";
import { enforcePromotion, planWave, readWavePlan, verifyWaveDecision, WAVES_SPEC_FILE, writeWavePlan, type WavePlanFile } from "../waves/index.js";
import {
  ALLOW_OUT_OF_ORDER_ENV,
  APPROVED_PLAN_ENV,
  checksDue,
  checksRefusal,
  describeResults,
  judgePlan,
  policyRefusal,
  runChecks,
  currentDigest,
  executeApply,
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
import type { ExecuteResult } from "../versioned/engine.js";
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
      const env = resolveEnvironment(project, a.env);
      if (hasMigrations(project)) return versionedApply(project, env, a, io);
      if (a.plan || a.digest || a.execute || a.allowOutOfOrder || a.lockWaitMs !== undefined || args.includes("--stand-down") || a.wavePlan !== undefined || a.waveApply !== undefined) {
        throw new YodelError(`--plan, --digest, --execute, --wave-plan, --wave-apply, --allow-out-of-order, --lock-wait and --stand-down are for versioned migrations, and ${project.dir} has no migrations/ directory with a migration`);
      }
      const refusal = project.dialect === "clickhouse" ? declarativeTopologyRefusal(project, env.name) : undefined;
      if (refusal) throw refusal;
      return declarativeApply(project, env, a, io);
    });
    if (args.includes("--execute")) recordStepExit(code);
    return code;
  },
};

async function versionedApply(project: Project, env: Environment, a: ApplyArgs, io: Io): Promise<number> {
  const ordered = readChain(project);
  const venv = await openVersioned(project, env);
  const outcome: Outcome = {};
  let code: number;
  try {
    code = await versionedApplyWith(project, env, a, io, ordered, venv, outcome);
  } finally {
    await closeVersioned(venv);
  }
  // Waiting, refused or failed: the webhook in yodel.config.ts notify hears of it (#61).
  if (outcome.doc) await sendEvent(project.yodel?.config.notify, eventFromRun("apply", outcome.doc), { io, verb: "apply" });
  return code;
}

/** The document a run printed (or would have, with --json), for the event it sends. */
interface Outcome {
  doc?: Record<string, unknown>;
}

async function versionedApplyWith(project: Project, env: Environment, a: ApplyArgs, io: Io, ordered: readonly Migration[], venv: VersionedEnv, outcome: Outcome = {}): Promise<number> {

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
    if (a.json) io.out(`${JSON.stringify(applyJson({ mode: "wave-plan", plan }), null, 2)}\n`);
    return 0;
  }

  if (a.waveApply !== undefined) {
    const planned = readWavePlan(a.waveApply);
    if (planned.environment !== env.name) throw new YodelError(`refused: ${a.waveApply} is ${planned.environment}'s plan, not ${env.name}'s; nothing was applied`, EXIT_REFUSED);
    const cwd = process.cwd();
    const result = await executeApply(venv, ordered, {
      approvedDigest: planned.migrations,
      allowOutOfOrder: a.allowOutOfOrder,
      ...(a.lockWaitMs !== undefined ? { lockWaitMs: a.lockWaitMs } : {}),
      ...(a.standDown ? { standDown: standingDown(project, env) } : {}),
      ...(project.yodel?.config.policy
        ? {
            policy: async (digest, toApply) => {
              const ledger = async () => {
                try {
                  return { port: await gitLedger(project.dir), op: await findMigrateOp(project, env, a.op) };
                } catch {
                  return undefined;
                }
              };
              const results = await judgePlan({ policy: project.yodel?.config.policy, environment: env.name, dialect: project.dialect, toApply, digest, ledger });
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
          throw new YodelError(`refused: ${env.name}'s wave plan moved since the wave was decided (decided ${planned.planDigest}, now ${now.planDigest}); nothing was applied. Run the wave again.`, 1);
        }
        io.err(`${await verifyWaveDecision(cwd, a.spec, env.name, planned.planDigest)}\n`);
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
    if (!approved) throw new YodelError(`--execute applies only the plan its Op's gate approved, and ${APPROVED_PLAN_ENV} is not set; run yodel apply ${env.name}`);
    // The env var is only the Op's hand-off; the approval itself is checked in chant's gate ledger, under the lock.
    const op = await findMigrateOp(project, env, a.op);
    const ledger = await gitLedger(project.dir);
    const result = await executeApply(venv, ordered, {
      approvedDigest: approved,
      allowOutOfOrder: a.allowOutOfOrder,
      ...(a.lockWaitMs !== undefined ? { lockWaitMs: a.lockWaitMs } : {}),
      ...(a.standDown ? { standDown: standingDown(project, env) } : {}),
      approve: async (digest) => {
        // Under the lock: every pending migration ran first where this environment requires (exit 4 otherwise).
        await enforcePromotion(project, env.name, ordered, (await inspect(venv, ordered)).status.pending);
        const by = await verifyApproval(ledger, op, digest);
        io.err(`approval: ${op.name} / ${op.gate} for ${digest}, by ${by.resolvedBy} at ${by.timestamp}\n`);
      },
      log: (l) => { io.err(`${l}\n`); },
      silences: migrationSilences,
      ...(project.yodel?.config.policy
        ? {
            policy: async (digest, toApply) => {
              const results = await judgePlan({ policy: project.yodel?.config.policy, environment: env.name, dialect: project.dialect, toApply, digest, ledger: () => Promise.resolve({ port: ledger, op }) });
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

  const op = await findMigrateOp(project, env, a.op);
  // The policy (#53): a rule that denies this plan, with no override recorded for its digest, refuses before the gate.
  const policy = await judgePlan({
    policy: project.yodel?.config.policy,
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
    const before = await planEnvironment(project, env, build);
    const server = await probeServer(project, env);
    setServer(server);
    if (!json) io.out(`${await renderPlan(before, `Plan for ${env.name} (${server ? describeServer(server) : project.dialect}, sql.profiles.${env.name})`)}\n`);
    if (planExitCode(before) === PLAN_NEEDS_OP) {
      if (!json) io.err(`yodel apply: refused: ${String(before.refused.length)} change(s) need their own Op; nothing was applied\n`);
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
