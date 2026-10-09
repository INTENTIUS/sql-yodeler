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
 * Op steps (`ClickHouseRebuildOp`) and manual steps are refused before
 * anything runs (exit 2); running them inside a migration is #12.
 */

import type { ClickHouseEndpoint } from "@intentius/chant-lexicon-sql/clickhouse/http";
import { YodelError, type Environment, type Project } from "../project.js";
import { PLAN_NEEDS_OP } from "../chant/plan.js";
import type { Migration } from "../migrations/index.js";
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

/** The refusal for Op and manual steps among `toApply`, or `undefined`. */
export function stepRefusal(toApply: readonly PendingMigration[]): YodelError | undefined {
  const lines = toApply.flatMap((p) =>
    p.refusedSteps.map(({ index, step }) =>
      step.kind === "op"
        ? `  ${p.id} step ${String(index)}: ${step.op} for ${step.object} (${step.name}), not SQL`
        : `  ${p.id} step ${String(index)}: a manual step for ${step.object} (${step.name})`,
    ),
  );
  if (lines.length === 0) return undefined;
  return new YodelError(`refused: a pending migration has a step yodel apply does not run yet; running Op and manual steps inside a migration is #12. Nothing was applied:\n${lines.join("\n")}`, PLAN_NEEDS_OP);
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
      throw new YodelError(
        `refused: the plan moved since it was approved (approved ${options.approvedDigest}, now ${digest}): the pending migrations, the history or the live schema changed. ` +
          `Nothing was applied; run yodel apply ${venv.environment} again and approve the new plan.`,
        1,
      );
    }
    await options.approve(digest);
    const recorder = new HistoryRecorder(venv.store, newRunContext(options.approvedDigest, options.processEnv), state.maxSeq);
    const result: ExecuteResult = { applied: [], skipped: [], lock: { kind: lock.kind, where: lock.where, ...(lock.notice ? { notice: lock.notice } : {}) } };
    for (const p of toApply) {
      await applyMigration(venv.port, p, state.byId.get(p.id), recorder, beat, options, result);
      result.applied.push(p.id);
    }
    return result;
  });
}

async function applyMigration(
  port: ClickHousePort,
  p: PendingMigration,
  rec: MigrationRecord | undefined,
  recorder: HistoryRecorder,
  beat: () => Promise<void>,
  options: ExecuteOptions,
  result: ExecuteResult,
): Promise<void> {
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
    if (step.kind !== "statement") throw stepRefusal([p]) ?? new YodelError(`${m.id} step ${String(i)} is not a statement`, PLAN_NEEDS_OP);
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
