import { parseArgs } from "node:util";
import type { Command, Io } from "../command.js";
import { guarded } from "../env-args.js";
import { loadProject, resolveEnvironment, YodelError, type Environment, type Project } from "../project.js";
import { buildSchema } from "../chant/build.js";
import { declaredChanges, planEnvironment, planExitCode, planJson, renderPlan, PLAN_NEEDS_OP } from "../chant/plan.js";
import { findApplyOp, GATED, runApplyOp } from "../chant/apply.js";
import { readMigrations, type Migration } from "../migrations/index.js";
import { describeMove, explainAgainst, latestApproval } from "../versioned/explain.js";
import {
  ALLOW_OUT_OF_ORDER_ENV,
  APPROVED_PLAN_ENV,
  currentDigest,
  executeApply,
  findMigrateOp,
  gitLedger,
  verifyApproval,
  hasMigrations,
  inspect,
  migrationsDir,
  openVersioned,
  renderStatus,
  runMigrateOp,
  selectToApply,
  statusJson,
  statusReport,
  type MigrateOpRef,
  type VersionedEnv,
} from "../versioned/index.js";

/** When the gate's newest approval is for another digest: what moved since, in one line. */
async function movedSinceApproval(project: Project, venv: VersionedEnv, ordered: readonly Migration[], op: MigrateOpRef, digest: string | undefined) {
  try {
    const latest = await latestApproval(await gitLedger(project.dir), op, digest);
    if (!latest?.digest || latest.holds) return undefined;
    const moved = await explainAgainst(venv, ordered, { approvedDigest: latest.digest, approvedAt: latest.at });
    return {
      moved: { approved: latest.digest, by: latest.by, at: latest.at, confirmed: moved.confirmed, changes: moved.changes },
      line: `Nothing was applied. The approval of ${latest.digest} (by ${latest.by} at ${latest.at}) does not hold: the plan moved since. ${moved.confirmed ? "What moved" : "What moved, as far as yodel can tell"}: ${describeMove(moved)}.`,
    };
  } catch {
    return undefined;
  }
}

const usage = "usage: yodel apply <env> [--json] [--dir <project>] [--op <name>] [--allow-out-of-order] [--plan]";

const help = `${usage}

Two paths, chosen by the project:

- Versioned: the project has a migrations/ directory holding a migration.
  Applies the pending migrations in chain order, statement by statement,
  recording each in the history table (YODEL_HISTORY_DATABASE, default
  yodeler) under the apply lock. Runs the project's migrations Op for the
  environment (chant run <op>), whose gate is bound to the plan digest: the
  pending migrations' checksums, the history and the live schema. A run
  that stops at the gate prints the chant approve command; approve, then
  run yodel apply again. If anything the digest covers changes after
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

- Declarative: no migrations. Plans the declared schema against the live
  database, then runs the project's ApplyOp for the environment behind its
  plan-bound gate.

Options:
  --json                print the outcome as JSON
  --op <name>           the Op to run, when more than one applies <env>
  --allow-out-of-order  versioned: apply out-of-order migrations too
  --plan                versioned: print the pending migrations and the plan
                        digest, apply nothing
  -C, --dir <dir>       the project directory (default: the working directory)

The migrations Op runs two steps of its own, not for direct use:
  --digest   print the plan digest alone (the Op's Plan step)
  --execute  apply under the lock, if the digest is still the one in ${APPROVED_PLAN_ENV}
             and chant's gate ledger holds an approval of the Op's gate for it
             (the Op's Apply step)

Exit codes:
  0  applied, or nothing to apply
  2  a change needs its own Op (declarative), or a pending migration has a
     manual step or an Op step apply does not run (versioned: it runs
     ClickHouseRebuildOp in materialized-view mode and backfill steps);
     nothing was applied
  3  stopped at the gate, waiting for approval of this plan
  4  versioned: refused, nothing applied: a checksum mismatch, an applied
     migration gone from the directory, or an out-of-order migration
     without --allow-out-of-order
  5  versioned: another apply holds the lock
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
      },
    });
  } catch (e) {
    throw new YodelError(`${e instanceof Error ? e.message : String(e)}\n${usage}`);
  }
  const { values, positionals } = parsed;
  const [env, ...rest] = positionals;
  if (env === undefined || rest.length > 0) throw new YodelError(usage);
  const flag = (k: string) => values[k] === true;
  const modes = ["plan", "digest", "execute"].filter(flag);
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
  };
}

/** `yodel apply <env>`; the exit codes are in `help`. */
export const apply: Command = {
  name: "apply",
  summary: "bring an environment to the declared schema or the pending migrations",
  implemented: true,
  run: (args, io) =>
    guarded("apply", io, args, help, async () => {
      const a = parseApplyArgs(args);
      const project = await loadProject(a.dir);
      const env = resolveEnvironment(project, a.env);
      if (hasMigrations(project)) return versionedApply(project, env, a, io);
      if (a.plan || a.digest || a.execute || a.allowOutOfOrder) {
        throw new YodelError(`--plan, --digest, --execute and --allow-out-of-order are for versioned migrations, and ${project.dir} has no migrations/ directory with a migration`);
      }
      return declarativeApply(project, env, a, io);
    }),
};

async function versionedApply(project: Project, env: Environment, a: ApplyArgs, io: Io): Promise<number> {
  const ordered = readMigrations(migrationsDir(project));
  const venv = await openVersioned(project, env);

  if (a.digest) {
    const { status } = await inspect(venv, ordered);
    const toApply = selectToApply(status, a.allowOutOfOrder);
    io.out(`${await currentDigest(venv, status, toApply)}\n`);
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
      approve: async (digest) => {
        const by = await verifyApproval(ledger, op, digest);
        io.err(`approval: ${op.name} / ${op.gate} for ${digest}, by ${by.resolvedBy} at ${by.timestamp}\n`);
      },
      log: (l) => { io.err(`${l}\n`); },
    });
    if (a.json) io.out(`${JSON.stringify({ environment: env.name, status: "applied", planDigest: approved, ...result }, null, 2)}\n`);
    else io.out(result.applied.length === 0 ? "Nothing to apply.\n" : `Applied: ${result.applied.join(", ")}\n`);
    return 0;
  }

  const report = await statusReport(venv, ordered, { allowOutOfOrder: a.allowOutOfOrder });
  const emit = (doc: Record<string, unknown>, code: number) => {
    if (a.json) io.out(`${JSON.stringify({ ...statusJson(report), mode: "versioned", ...doc }, null, 2)}\n`);
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
    if (!a.json) io.out(`${env.name} is up to date: every migration is applied.\n`);
    return emit({ status: "unchanged" }, 0);
  }

  if (!a.json) io.out(renderStatus(report));
  const op = await findMigrateOp(project, env, a.op);
  if (!a.json) io.out(`\nRunning ${op.name} (${op.filePath})\n`);
  const run = await runMigrateOp(project, op, { allowOutOfOrder: a.allowOutOfOrder, onOutput: (t) => { io.err(t); } });
  if (run.status === "gated") {
    const stale = await movedSinceApproval(project, venv, ordered, op, run.planDigest ?? report.digest);
    if (stale && !a.json) io.out(`\n${stale.line}\n`);
    if (!a.json) {
      io.out(`\n${op.name} is waiting at gate "${op.gate}" for approval of this plan${run.planDigest ? ` (${run.planDigest})` : ""}.\n`);
      if (run.approve) io.out(`Approve it with:\n  ${run.approve}\nthen run yodel apply ${env.name} again.\n`);
    }
    return emit({ status: "gated", op: op.name, gate: op.gate, ...(stale ? { moved: stale.moved } : {}), ...(run.approve ? { approve: run.approve } : {}), ...(run.planDigest ? { gatePlanDigest: run.planDigest } : {}) }, GATED);
  }

  const after = await statusReport(venv, ordered, { allowOutOfOrder: a.allowOutOfOrder });
  if (run.status === "failed") {
    if (!a.json) {
      io.err(`yodel apply: chant run ${op.name} failed (exit ${String(run.code)})\n`);
      io.out(`\n${renderStatus(after)}`);
    }
    if (a.json) io.out(`${JSON.stringify({ ...statusJson(after), mode: "versioned", status: "failed", op: op.name, exitCode: run.code }, null, 2)}\n`);
    return 1;
  }
  if (a.json) {
    io.out(`${JSON.stringify({ ...statusJson(after), mode: "versioned", status: "applied", op: op.name, appliedNow: report.status.pending.map((p) => p.id) }, null, 2)}\n`);
  } else {
    io.out(`\nApplied: ${report.status.pending.map((p) => p.id).join(", ")}.\n`);
  }
  return after.status.pending.length === 0 ? 0 : 1;
}

async function declarativeApply(project: Project, env: Environment, a: ApplyArgs, io: Io): Promise<number> {
  const json = a.json;
  const op = await findApplyOp(project, env, a.op);
  const report = (doc: Record<string, unknown>, code: number) => {
    if (json) io.out(`${JSON.stringify({ environment: env.name, dialect: project.dialect, op: op.name, ...doc }, null, 2)}\n`);
    return code;
  };

  const build = await buildSchema(project);
  try {
    const before = await planEnvironment(project, env, build);
    if (!json) io.out(`${await renderPlan(before, `Plan for ${env.name} (${project.dialect}, sql.profiles.${env.name})`)}\n`);
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
        if (run.approve) io.out(`Approve it with:\n  ${run.approve}\nthen run yodel apply ${env.name} again.\n`);
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
