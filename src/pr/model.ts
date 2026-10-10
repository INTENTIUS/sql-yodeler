/**
 * The versioned plan (#16): what `yodel plan <env>` shows for a project
 * with migrations, and what the pull request comment renders. Collected once,
 * rendered as text, markdown or JSON (`./render.ts`).
 *
 * The digest is `statusReport`'s, the value `yodel apply <env> --digest` (the
 * migrations Op's Plan step) prints and the gate binds, so the
 * `chant approve <op> <gate> --plan <digest>` the comment prints is the one
 * the post-merge apply needs. Nothing here writes: no lock, no history row,
 * no ledger entry.
 */

import type { MigrationStep } from "@intentius/chant-lexicon-sql/migration-statements";
import type { GateLedgerPort } from "@intentius/chant/op/gate";
import { YodelError, type Environment, type Project, type SqlDialect } from "../project.js";
import { scanMigrations, type Migration } from "../migrations/index.js";
import { describeTopology } from "../history/index.js";
import { asBackfill } from "../steps/kinds.js";
import { EXIT_REFUSED } from "../exit.js";
import {
  BROKEN_CHAIN,
  findMigrateOp,
  inspect,
  gitLedger,
  migrateOpExample,
  migrationsDir,
  closeVersioned,
  openVersioned,
  outOfOrder,
  planDigest,
  sameDigest,
  statusReport,
  type MigrateOpRef,
  type PendingMigration,
  type VersionedEnv,
} from "../versioned/index.js";
import { currentSubject, explainAgainst, explainMove, latestApproval, type LatestApproval, type MoveExplanation } from "../versioned/explain.js";
import type { DigestSubject } from "../versioned/digest.js";

export interface StepView {
  index: number;
  step: MigrationStep;
  /** Succeeded in an earlier run; not sent again. */
  done: boolean;
  /** An Op or manual step apply does not run, and why; any of them refuses the run. */
  refused?: string | undefined;
  /** A backfill step's module, as the migration's directory holds it. */
  source?: { file: string; text: string } | undefined;
}

export interface PendingView {
  id: string;
  outOfOrder: boolean;
  /** Where a migration that ran part way resumes. */
  resumeAt?: number | undefined;
  steps: StepView[];
}

export type ApprovalView =
  | { kind: "no-op"; message: string }
  | {
      kind: "op";
      op: string;
      gate: string;
      /** The command that approves this plan; absent when there is no digest. */
      command?: string | undefined;
      /** The newest approval of the gate in chant's ledger, when it could be read. */
      latest?: (LatestApproval & { moved?: MoveExplanation | undefined }) | undefined;
      /** Why the ledger was not read. */
      ledgerNote?: string | undefined;
    };

export interface VersionedPlan {
  environment: string;
  dialect: SqlDialect;
  /** `<database>.history (<topology> (<where it came from>))`; Postgres has no topology, so only `<database>.history`. */
  history?: string | undefined;
  appliedCount: number;
  pending: PendingView[];
  /** Directory problems, checksum mismatches, out-of-order migrations. */
  problems: string[];
  /** Why `yodel apply` would refuse, with its exit code. */
  refusal?: { exitCode: number; message: string } | undefined;
  /** The digest the gate binds; absent when apply would refuse or has nothing to do. */
  digest?: string | undefined;
  /** What the digest is taken over, carried in the comment so a later one can say what moved. */
  subject?: DigestSubject | undefined;
  approval?: ApprovalView | undefined;
  /** The comment this one replaces showed another digest: what moved since. */
  sinceLast?: MoveExplanation | undefined;
  notes: string[];
}

export interface CollectOptions {
  allowOutOfOrder?: boolean;
  /** The subject the previous comment carried, when updating one. */
  previous?: DigestSubject | undefined;
  /** The gate ledger; default chant's, in the project's git checkout. `null` skips it. */
  ledger?: GateLedgerPort | null;
  /** The migrations Op; default discovered in the project. */
  op?: MigrateOpRef | null;
  opName?: string | undefined;
  processEnv?: NodeJS.ProcessEnv;
  /** For tests: the environment already bound. */
  venv?: VersionedEnv;
}

const viewOf = (m: Migration, done: readonly number[] = [], outOfOrder = false, resumeAt?: number, refused: PendingMigration["refusedSteps"] = []): PendingView => ({
  id: m.id,
  outOfOrder,
  resumeAt,
  steps: m.document.steps.map((step, index) => {
    const file = asBackfill(step)?.options.file;
    const text = file === undefined ? undefined : m.files.extra?.[file];
    return { index, step, done: done.includes(index), refused: refused.find((r) => r.index === index)?.reason, ...(file !== undefined && text !== undefined ? { source: { file, text } } : {}) };
  }),
});

/** Collects the plan; throws only when the project or the server cannot be read at all. */
export async function collectVersionedPlan(project: Project, env: Environment, options: CollectOptions = {}): Promise<VersionedPlan> {
  const dir = migrationsDir(project);
  const scan = scanMigrations(dir);
  const problems = scan.problems.map((p) => p.message);
  const base = { environment: env.name, dialect: project.dialect, problems, notes: [] as string[] };

  const venv = options.venv ?? (await openVersioned(project, env, options.processEnv));
  try {
    if (!scan.ordered) {
      // Nothing can be planned, but the history still says what is applied.
      const { status } = await inspect(venv, [], { sync: false });
      return { ...base, appliedCount: status.applied.length, pending: [], refusal: { exitCode: EXIT_REFUSED, message: BROKEN_CHAIN } };
    }
    return await collectWith(project, env, options, venv, scan.ordered, base, problems);
  } finally {
    if (!options.venv) await closeVersioned(venv);
  }
}

async function collectWith(
  project: Project,
  env: Environment,
  options: CollectOptions,
  venv: VersionedEnv,
  ordered: readonly Migration[],
  base: { environment: string; dialect: Project["dialect"]; problems: string[]; notes: string[] },
  problems: string[],
): Promise<VersionedPlan> {
  const report = await statusReport(venv, ordered, { allowOutOfOrder: options.allowOutOfOrder === true, sync: false });
  const { status } = report;
  for (const m of status.mismatches) if (!problems.includes(m.message)) problems.push(m.message);
  const late = outOfOrder(status);
  if (late.length > 0) problems.push(`out of order: ${late.map((p) => p.id).join(", ")} (the chain puts ${late.length === 1 ? "it" : "them"} before a migration already applied)`);

  let subject: DigestSubject | undefined;
  if (report.digest) {
    subject = await currentSubject(venv, status, status.pending);
    // Read twice (the report's, then here): if the server moved in between, carry no subject rather than a wrong one.
    if (!(await sameDigest(await planDigest(subject), report.digest))) subject = undefined;
  }

  const plan: VersionedPlan = {
    ...base,
    history: venv.dialect === "postgres" ? `${venv.location.database}.history` : `${venv.location.database}.history (${report.topology ?? describeTopology(venv.location.topology)})`,
    appliedCount: status.applied.length,
    pending: status.pending.map((p) => viewOf(p.migration, p.partWay?.done ?? [], p.outOfOrder, p.partWay?.resumeAt, p.refusedSteps)),
    refusal: report.refusal,
    digest: report.digest,
    subject,
  };

  if (options.previous && subject) {
    const prev = await planDigest(options.previous);
    if (!(await sameDigest(prev, report.digest))) plan.sinceLast = await explainMove({ approvedDigest: prev, now: subject, previous: options.previous, ordered, applied: status.applied });
  }

  plan.approval = await approvalView(project, env, venv, ordered, plan, options);
  return plan;
}

async function approvalView(project: Project, env: Environment, venv: VersionedEnv, ordered: readonly Migration[], plan: VersionedPlan, options: CollectOptions): Promise<ApprovalView> {
  let op: MigrateOpRef;
  try {
    op = options.op ?? (await findMigrateOp(project, env, options.opName));
  } catch (e) {
    if (!(e instanceof YodelError)) throw e;
    return { kind: "no-op", message: e.message.includes("no Op applies") ? `no Op applies the migrations to ${env.name}; declare one, for example:\n\n${migrateOpExample(env.name)}` : e.message };
  }
  const view: Extract<ApprovalView, { kind: "op" }> = {
    kind: "op",
    op: op.name,
    gate: op.gate,
    command: plan.digest ? `chant approve ${op.name} ${op.gate} --plan ${plan.digest}` : undefined,
  };
  if (options.ledger === null) return view;
  try {
    const ledger = options.ledger ?? (await gitLedger(project.dir));
    const latest = await latestApproval(ledger, op, plan.digest);
    if (!latest) return view;
    view.latest = latest;
    if (!latest.holds && !latest.sameDigest && latest.digest && plan.subject) {
      view.latest.moved = await explainAgainst(venv, ordered, { approvedDigest: latest.digest, approvedAt: latest.at, now: plan.subject, previous: options.previous });
    }
  } catch (e) {
    view.ledgerNote = `chant's gate ledger could not be read (${e instanceof Error ? (e.message.split("\n")[0] ?? "") : String(e)}); fetch the chant/lifecycle branch to see approvals here`;
  }
  return view;
}
