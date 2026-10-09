/**
 * The versioned apply: pending migrations, statement by statement, each
 * statement's start and outcome appended to the history, under the lock,
 * after the plan digest the run was approved under is checked again.
 *
 * Statements are the `statement` steps of each migration's `migration.json`,
 * sent as they are there (not rendered again). A statement whose latest
 * history row is `succeeded` is never sent again, so a migration that failed
 * part way resumes at the statement that failed. A statement whose latest
 * row is `started` (the runner stopped while it ran) is sent again: the
 * history cannot tell whether the server ran it.
 *
 * An Op step (#12) runs in its place among the statements: the statements
 * before it first, the ones after it only once it succeeded. A
 * `ClickHouseRebuildOp` step runs chant's rebuild Op, a backfill step the
 * author's Op of `effect()` batches (`../steps/`), each in this process
 * under the same lock, and behind the same approval: the step and any file
 * it runs are in the migration's checksum, so in the plan digest. Its rows
 * are `kind = 'step'`, with the step's summary (receipts skipped, work done)
 * in `note`. A step that failed or was stopped runs again on the next run
 * and resumes from its receipts: the partitions or batches that finished
 * are skipped.
 *
 * Manual steps, and Op steps apply does not run (a rebuild in app mode,
 * `PostgresMigrationOp`), are refused before anything runs (exit 2).
 */

import type { ClickHouseEndpoint } from "@intentius/chant-lexicon-sql/clickhouse/http";
import { YodelError, type Environment, type Project } from "../project.js";
import { PLAN_NEEDS_OP } from "../chant/plan.js";
import type { Migration } from "../migrations/index.js";
import { defaultStepRunner, describeStep, planStep, stepSha, StepOpFailed, type StepRunner } from "../steps/index.js";
import type { ReceiptStore } from "@intentius/chant/op/receipt-store";
import {
  acquireLock,
  DEFAULT_HISTORY_DATABASE,
  DEFAULT_LOCK_TTL_MS,
  HistoryRecorder,
  HistoryStore,
  httpPort,
  MIGRATION_ROW,
  newRunContext,
  parseHistoryTopology,
  serverMessage,
  statementDone,
  statementSha,
  withLock,
  appliedBy,
  type ClickHousePort,
  type HistoryLocation,
  type HistoryState,
  type MigrationRecord,
} from "../history/index.js";
import { compareHistory, outOfOrder, type PendingMigration, type VersionedStatus } from "./state.js";
import { catalogFingerprint, digestSubject, planDigest, readLiveCatalog, sameDigest, type LiveScope } from "./digest.js";

/** Exit code: a checksum mismatch, an applied migration gone from the directory, or an out-of-order migration without `--allow-out-of-order`. */
export const REFUSED = 4;

/** Everything a versioned verb needs about one environment. */
export interface VersionedEnv {
  environment: string;
  port: ClickHousePort;
  store: HistoryStore;
  location: HistoryLocation;
  scope: LiveScope;
  /** Identifies the server, for the local lock's file name. */
  serverKey: string;
  lockTtlMs: number;
  /** The project directory: an Op step reads chant.config.ts from it. */
  projectDir?: string;
  /** The server, for the receipt store a backfill step keeps its receipts in. */
  endpoint?: ClickHouseEndpoint;
}

/**
 * The history's settings for an environment. Until #9's `yodel.config.ts`
 * sets them per environment, from the process environment:
 *
 *   YODEL_HISTORY_DATABASE  the database the history and lock live in (default `yodeler`)
 *   YODEL_TOPOLOGY          single | cluster:<name> | replicated[:<cluster>] | cloud (default single)
 *   YODEL_LOCK_TTL          the lock's TTL in seconds (default 900)
 */
export interface HistorySettings {
  historyDatabase: string;
  topology: HistoryLocation["topology"];
  lockTtlMs: number;
}

export function historySettings(env: NodeJS.ProcessEnv = process.env): HistorySettings {
  const ttl = env.YODEL_LOCK_TTL ? Number(env.YODEL_LOCK_TTL) : undefined;
  if (ttl !== undefined && !(Number.isFinite(ttl) && ttl > 0)) throw new YodelError(`YODEL_LOCK_TTL must be a number of seconds, got ${JSON.stringify(env.YODEL_LOCK_TTL)}`);
  return {
    historyDatabase: env.YODEL_HISTORY_DATABASE || DEFAULT_HISTORY_DATABASE,
    topology: parseHistoryTopology(env.YODEL_TOPOLOGY || "single"),
    lockTtlMs: ttl !== undefined ? ttl * 1000 : DEFAULT_LOCK_TTL_MS,
  };
}

/** Binds an environment's server (`sql.profiles.<env>`) and history. ClickHouse only, for now (Postgres is #13). */
export async function openVersioned(project: Project, env: Environment, processEnv: NodeJS.ProcessEnv = process.env, port?: ClickHousePort): Promise<VersionedEnv> {
  if (project.dialect !== "clickhouse") throw new YodelError("versioned migrations are ClickHouse only for now; Postgres is #13");
  const settings = historySettings(processEnv);
  const { resolveClickHouseTarget, isUnresolvedTarget } = await import("@intentius/chant-lexicon-sql/clickhouse/live/bind");
  const target = resolveClickHouseTarget({ environment: env.name, config: project.config, env: processEnv });
  if (isUnresolvedTarget(target)) throw new YodelError(target.detail);
  const endpoint: ClickHouseEndpoint = target.endpoint;
  const location: HistoryLocation = { database: settings.historyDatabase, topology: settings.topology };
  const p = port ?? (await httpPort(endpoint));
  return {
    environment: env.name,
    port: p,
    store: new HistoryStore(p, location),
    location,
    scope: { databases: target.databases, historyDatabase: settings.historyDatabase },
    serverKey: endpoint.url,
    lockTtlMs: settings.lockTtlMs,
    projectDir: project.dir,
    endpoint,
  };
}

/** The history and how the directory compares with it. Reads only; takes no lock. */
export async function inspect(venv: VersionedEnv, ordered: readonly Migration[], options: { sync?: boolean } = {}): Promise<{ state: HistoryState; status: VersionedStatus }> {
  const state = await venv.store.state(options);
  return { state, status: compareHistory(ordered, state) };
}

/** The refusal for an integrity problem, or `undefined`. */
export function integrityRefusal(status: VersionedStatus, allowOutOfOrder: boolean): YodelError | undefined {
  if (status.mismatches.length > 0) {
    return new YodelError(`refused: the history does not match the migrations directory; nothing was applied:\n${status.mismatches.map((m) => `  ${m.message}`).join("\n")}`, REFUSED);
  }
  const late = outOfOrder(status);
  if (late.length > 0 && !allowOutOfOrder) {
    const newest = status.applied.filter((a) => a.index !== undefined).at(-1)?.id ?? "";
    return new YodelError(
      `refused: ${late.map((p) => p.id).join(", ")} ${late.length === 1 ? "is" : "are"} out of order: the chain puts ${late.length === 1 ? "it" : "them"} before ${newest}, which is already applied. ` +
        `Nothing was applied. Pass --allow-out-of-order to apply ${late.length === 1 ? "it" : "them"} now (in chain order); ${late.length === 1 ? "it is" : "they are"} never skipped.`,
      REFUSED,
    );
  }
  return undefined;
}

/** The refusal for the steps among `toApply` that apply does not run (manual steps, Ops it does not run), or `undefined`. */
export function stepRefusal(toApply: readonly PendingMigration[]): YodelError | undefined {
  const lines = toApply.flatMap((p) => p.refusedSteps.map(({ index, reason }) => `  ${p.id} step ${String(index)}: ${reason}`));
  if (lines.length === 0) return undefined;
  return new YodelError(
    `refused: a pending migration has a step yodel apply does not run: a person acts on a manual step, and yodel apply runs only ClickHouseRebuildOp (materialized-view mode) and backfill steps. Nothing was applied:\n${lines.join("\n")}`,
    PLAN_NEEDS_OP,
  );
}

/** What a run would apply, in chain order, or the refusal. */
export function selectToApply(status: VersionedStatus, allowOutOfOrder: boolean): PendingMigration[] {
  const refusal = integrityRefusal(status, allowOutOfOrder) ?? stepRefusal(status.pending);
  if (refusal) throw refusal;
  return status.pending;
}

/** The plan digest of applying `toApply` from the server's state now. */
export async function currentDigest(venv: VersionedEnv, status: VersionedStatus, toApply: readonly PendingMigration[]): Promise<string> {
  const live = catalogFingerprint(await readLiveCatalog(venv.port, venv.scope));
  return planDigest(digestSubject({ environment: venv.environment, historyDatabase: venv.location.database, applied: status.applied, toApply, live }));
}

export class ApplyFailed extends YodelError {
  constructor(
    readonly migration: string,
    readonly statement: number,
    readonly serverError: string,
  ) {
    super(
      `${migration} failed at statement ${String(statement)}: ${serverError}\n` +
        `Fix the cause (on the server, or that statement in the migration's files), then run yodel apply again: ` +
        `it resumes at statement ${String(statement)} and never sends again the statements that succeeded.`,
      1,
    );
    this.name = "ApplyFailed";
  }
}

/** An Op step failed or stopped part way; the next run resumes it from its receipts. */
export class StepFailed extends YodelError {
  constructor(
    readonly migration: string,
    readonly step: number,
    readonly detail: string,
  ) {
    super(
      `${migration} failed at step ${String(step)}: ${detail}\n` +
        `Fix the cause, then run yodel apply again: it resumes at step ${String(step)}, whose finished work (the partitions or batches with a receipt) is not done again, ` +
        `and never sends again the statements that succeeded.`,
      1,
    );
    this.name = "StepFailed";
  }
}

export interface ExecuteOptions {
  /** The digest the Op's gate handed the Apply step. A run whose digest has moved since is refused. */
  approvedDigest: string;
  /**
   * Checks the approval itself, given the digest computed under the lock;
   * throws to refuse. `--execute` looks it up in chant's gate ledger
   * (`./approval.ts`). Required: the digest alone is never an approval.
   */
  approve: (digest: string) => Promise<unknown>;
  allowOutOfOrder: boolean;
  /** Progress, one line at a time. */
  log: (line: string) => void;
  /** The silences in force for a migration, as JSON text for the history's `silences` field. Default `"[]"`. */
  silences?: (m: Migration) => string;
  processEnv?: NodeJS.ProcessEnv;
  /** Runs an Op step. Default: chant's local executor (`../steps/`). */
  runStep?: StepRunner;
  /** The receipt store a backfill step uses. Default: chant's, on the server. */
  receipts?: ReceiptStore;
}

export interface ExecuteResult {
  applied: string[];
  /** Statements not sent because an earlier run had already succeeded with them. */
  skipped: Array<{ id: string; statement: number }>;
  lock: { kind: "keeper" | "local"; where: string; notice?: string };
}

/**
 * Applies the pending migrations: takes the lock, reads the history again
 * under it, refuses on any integrity problem or a digest that moved since
 * approval, then runs each statement not yet succeeded.
 */
export async function executeApply(venv: VersionedEnv, ordered: readonly Migration[], options: ExecuteOptions): Promise<ExecuteResult> {
  const lock = await acquireLock(venv.port, {
    database: venv.location.database,
    topology: venv.location.topology,
    holder: appliedBy(options.processEnv),
    ttlMs: venv.lockTtlMs,
    serverKey: venv.serverKey,
  });
  if (lock.notice) options.log(`lock: ${lock.notice}`);
  else options.log(`lock: held in ${lock.where}`);

  return withLock(lock, venv.lockTtlMs, async (beat) => {
    await venv.store.ensure();
    const { state, status } = await inspect(venv, ordered);
    const toApply = selectToApply(status, options.allowOutOfOrder);
    const digest = await currentDigest(venv, status, toApply);
    if (!(await sameDigest(digest, options.approvedDigest))) {
      const { describeMove, explainAgainst } = await import("./explain.js");
      const moved = await explainAgainst(venv, ordered, { approvedDigest: options.approvedDigest });
      throw new YodelError(
        `refused: the plan moved since it was approved (approved ${options.approvedDigest}, now ${digest}): ${describeMove(moved)}. ` +
          `Nothing was applied; run yodel apply ${venv.environment} again and approve the new plan.`,
        1,
      );
    }
    await options.approve(digest);
    const recorder = new HistoryRecorder(venv.store, newRunContext(options.approvedDigest, options.processEnv), state.maxSeq);
    const result: ExecuteResult = { applied: [], skipped: [], lock: { kind: lock.kind, where: lock.where, ...(lock.notice ? { notice: lock.notice } : {}) } };
    for (const p of toApply) {
      await applyMigration(venv, p, state.byId.get(p.id), recorder, beat, options, result);
      result.applied.push(p.id);
    }
    return result;
  });
}

async function applyMigration(
  venv: VersionedEnv,
  p: PendingMigration,
  rec: MigrationRecord | undefined,
  recorder: HistoryRecorder,
  beat: () => Promise<void>,
  options: ExecuteOptions,
  result: ExecuteResult,
): Promise<void> {
  const port: ClickHousePort = venv.port;
  const m = p.migration;
  const silences = options.silences?.(m) ?? "[]";
  const base = { migration_id: m.id, parent: m.parent ?? "", checksum: p.checksum, silences };
  options.log(`${m.id}: ${p.partWay ? `resuming at statement ${String(p.partWay.resumeAt)}` : "applying"}${p.outOfOrder ? " (out of order, allowed)" : ""}`);
  await recorder.record({ ...base, kind: "migration", statement_index: MIGRATION_ROW, statement_sha: "", status: "started" });

  for (const [i, step] of m.document.steps.entries()) {
    if (statementDone(rec, i)) {
      options.log(`  statement ${String(i)}: succeeded in an earlier run; not sent`);
      result.skipped.push({ id: m.id, statement: i });
      continue;
    }
    if (step.kind !== "statement") {
      await beat();
      await runOpStep(venv, p, i, recorder, base, options);
      continue;
    }
    await beat();
    const sha = statementSha(step.sql);
    const row = { ...base, kind: "statement" as const, statement_index: i, statement_sha: sha };
    await recorder.record({ ...row, status: "started" });
    try {
      await port.query(step.sql, step.waitsForMutation ? { settings: { mutations_sync: "2" } } : {});
    } catch (e) {
      const error = serverMessage(e);
      await recorder.record({ ...row, status: "failed", error });
      await recorder.record({ ...base, kind: "migration", statement_index: MIGRATION_ROW, statement_sha: "", status: "failed", error: `statement ${String(i)}: ${error}` });
      options.log(`  statement ${String(i)}: failed: ${error.split("\n")[0] ?? ""}`);
      throw new ApplyFailed(m.id, i, error.split("\n")[0] ?? error);
    }
    await recorder.record({ ...row, status: "succeeded" });
    options.log(`  statement ${String(i)}: ok (${step.rule} ${step.class}, ${step.name})`);
  }
  await recorder.record({ ...base, kind: "migration", statement_index: MIGRATION_ROW, statement_sha: "", status: "succeeded" });
  options.log(`${m.id}: applied`);
}

type RowBase = { migration_id: string; parent: string; checksum: string; silences: string };

/** Runs Op step `i` of `p`, recording its start and outcome. */
async function runOpStep(venv: VersionedEnv, p: PendingMigration, i: number, recorder: HistoryRecorder, base: RowBase, options: ExecuteOptions): Promise<void> {
  const m = p.migration;
  const step = m.document.steps[i];
  if (!step) throw new YodelError(`${m.id} has no step ${String(i)}`);
  const plan = planStep(step);
  if (plan.run === "statement" || plan.run === "refused" || p.refusedSteps.some((r) => r.index === i)) {
    throw stepRefusal([p]) ?? new YodelError(`${m.id} step ${String(i)}: ${plan.run === "refused" ? plan.reason : "not a step yodel apply runs"}`, PLAN_NEEDS_OP);
  }
  const row = { ...base, kind: "step" as const, statement_index: i, statement_sha: stepSha(step, m.files) };
  const resumed = p.partWay !== undefined && p.partWay.resumeAt === i;
  options.log(`  step ${String(i)}: ${describeStep(step)}${resumed ? " (resuming from its receipts)" : ""}`);
  await recorder.record({ ...row, status: "started" });
  const run = options.runStep ?? defaultStepRunner;
  let summary: unknown;
  try {
    ({ summary } = await run({
      environment: venv.environment,
      projectDir: venv.projectDir ?? process.cwd(),
      port: venv.port,
      endpoint: venv.endpoint,
      migration: m,
      index: i,
      plan,
      log: options.log,
      receipts: options.receipts,
    }));
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    const note = e instanceof StepOpFailed && e.summary !== undefined ? JSON.stringify(e.summary) : "";
    await recorder.record({ ...row, status: "failed", error: detail, note });
    await recorder.record({ ...base, kind: "migration", statement_index: MIGRATION_ROW, statement_sha: "", status: "failed", error: `step ${String(i)}: ${detail}` });
    options.log(`  step ${String(i)}: failed: ${detail.split("\n")[0] ?? ""}${note ? ` (${note})` : ""}`);
    throw new StepFailed(m.id, i, detail.split("\n")[0] ?? detail);
  }
  const note = JSON.stringify(summary ?? {});
  await recorder.record({ ...row, status: "succeeded", note });
  options.log(`  step ${String(i)}: ok ${note}`);
}
