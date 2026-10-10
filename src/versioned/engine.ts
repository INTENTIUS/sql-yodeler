/**
 * The versioned apply: pending migrations, statement by statement, each
 * statement's start and outcome appended to the history, under the lock,
 * after the plan digest the run was approved under is checked again.
 *
 * Statements are the `statement` steps of each migration's `migration.json`,
 * written for a single node, each rendered for the environment's topology
 * as it is sent (#9, `../topology/render.ts`). A statement whose latest
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
 * On Postgres (#13) a `PostgresMigrationOp` step (a column rename or type
 * change) runs the same way, as chant's expand-and-contract Op
 * (`../steps/postgres-migration.ts`).
 *
 * What is the dialect's (the lock, the live-schema fingerprint, how a
 * statement is sent and its `succeeded` row written) is the driver's
 * (`./driver.ts`): on Postgres a transactional statement and its row commit
 * in one transaction, under `lock_timeout`, retried on a lock timeout
 * (`./postgres/executor.ts`).
 *
 * A migration's pre-migration checks (#52, `./checks.ts`) run under the
 * lock just before its first statement; one that fails refuses (exit 4)
 * with a `failed` migration row naming it, and nothing of it is sent.
 *
 * Manual steps, and Op steps apply does not run (a rebuild in app mode, a
 * step of the other dialect), are refused before anything runs (exit 2).
 */

import type { ClickHouseEndpoint } from "@intentius/chant-lexicon-sql/clickhouse/http";
import { YodelError, type Environment, type Project } from "../project.js";
import { PLAN_NEEDS_OP } from "../chant/plan.js";
import type { Migration } from "../migrations/index.js";
import { environmentSettings } from "../config/settings.js";
import type { Topology } from "../topology/render.js";
import { defaultStepRunner, describeStep, planStep, stepSha, StepOpFailed, type StepRunner } from "../steps/index.js";
import type { ReceiptStore } from "@intentius/chant/op/receipt-store";
import {
  HistoryRecorder,
  HistoryStore,
  httpPort,
  MIGRATION_ROW,
  newRunContext,
  SINGLE,
  statementDone,
  statementSha,
  withLock,
  appliedBy,
  LockHeldError,
  type ClickHousePort,
  type Lock,
  type HistoryLocation,
  type HistoryState,
  type HistoryStoreLike,
  type MigrationRecord,
} from "../history/index.js";
import type { SqlDialect } from "../project.js";
import { clickhouseVersion, postgresVersion, serverAddress, softly, type ServerInfo } from "../server.js";
import { clickhouseDriver } from "./clickhouse.js";
import type { VersionedDriver } from "./driver.js";
import { openPostgres, type PgConnect } from "./postgres/driver.js";
import { compareHistory, outOfOrder, type PendingMigration, type VersionedStatus } from "./state.js";
import { digestSubject, planDigest, sameDigest, type LiveScope } from "./digest.js";
import { checksDue, checksRefusal, failedChecks, runChecks } from "./checks.js";
import type { PolicyOverride } from "./policy.js";

/** Exit code: a checksum mismatch, an applied migration gone from the directory, or an out-of-order migration without `--allow-out-of-order`. */
export const REFUSED = 4;

/** Everything a versioned verb needs about one environment. */
export interface VersionedEnv {
  environment: string;
  dialect: SqlDialect;
  /** The dialect's lock, fingerprint and statement sending (`./driver.ts`). */
  driver: VersionedDriver;
  /** The ClickHouse server; absent on Postgres, whose connections the driver keeps. */
  port?: ClickHousePort;
  store: HistoryStoreLike;
  /** Where the history is: on Postgres, `database` is the history's schema and the topology a single node. */
  location: HistoryLocation;
  /** ClickHouse: the databases the fingerprint covers. Postgres: `databases` is the profile's schemas. */
  scope: LiveScope;
  /** Identifies the server, for the local lock's file name. */
  serverKey: string;
  lockTtlMs: number;
  /** How long an apply waits for a lock another apply holds (`../config/settings.ts`); 0 gives up at once. */
  lockWaitMs?: number;
  /** The project directory: an Op step reads chant.config.ts from it. */
  projectDir?: string;
  /** The server, for the receipt store a backfill step keeps its receipts in. */
  endpoint?: ClickHouseEndpoint;
  /** What each statement is rendered for when it is sent (`../config/settings.ts`). Default: a single node. */
  topology?: Topology;
  /** Where {@link topology} came from: `yodel.config.ts`, `sql.profiles.<env>.topology`, `YODEL_TOPOLOGY` or `default`. */
  topologySource?: string;
  /** Which server this is, with its version (#11), for the header of status, plan and apply. */
  server?: () => Promise<ServerInfo>;
}

/**
 * Binds an environment's server (`sql.profiles.<env>`) and history. `port`
 * (ClickHouse) and `pgConnect` (Postgres) stand in for the server in tests.
 * Close it with {@link closeVersioned} when done: on Postgres it holds a
 * connection.
 */
export async function openVersioned(project: Project, env: Environment, processEnv: NodeJS.ProcessEnv = process.env, port?: ClickHousePort, pgConnect?: PgConnect): Promise<VersionedEnv> {
  const settings = environmentSettings(project, env.name, processEnv);
  if (project.dialect === "postgres") {
    const pg = await openPostgres(project, env, processEnv, settings.historyDatabase, pgConnect);
    return {
      environment: env.name,
      dialect: "postgres",
      driver: pg.driver,
      store: pg.store,
      location: { database: settings.historyDatabase, topology: SINGLE },
      scope: { databases: pg.schemas, historyDatabase: settings.historyDatabase },
      serverKey: pg.endpoint.url,
      lockTtlMs: settings.lockTtlMs,
      lockWaitMs: settings.lockWaitMs,
      projectDir: project.dir,
      server: async () => ({ dialect: "postgres", address: serverAddress("postgres", pg.endpoint.url), version: await softly(() => postgresVersion(pg.client)) }),
    };
  }
  const { resolveClickHouseTarget, isUnresolvedTarget } = await import("@intentius/chant-lexicon-sql/clickhouse/live/bind");
  const target = resolveClickHouseTarget({ environment: env.name, config: project.config, env: processEnv });
  if (isUnresolvedTarget(target)) throw new YodelError(target.detail);
  const endpoint: ClickHouseEndpoint = target.endpoint;
  const location: HistoryLocation = { database: settings.historyDatabase, topology: settings.historyTopology };
  const p = port ?? (await httpPort(endpoint));
  const scope = { databases: target.databases, historyDatabase: settings.historyDatabase };
  return {
    environment: env.name,
    dialect: "clickhouse",
    driver: clickhouseDriver({ port: p, location, scope, serverKey: endpoint.url, lockTtlMs: settings.lockTtlMs, endpoint, topology: settings.topology }),
    port: p,
    store: new HistoryStore(p, location),
    location,
    scope,
    serverKey: endpoint.url,
    lockTtlMs: settings.lockTtlMs,
    lockWaitMs: settings.lockWaitMs,
    projectDir: project.dir,
    endpoint,
    topology: settings.topology,
    topologySource: settings.topologySource,
    server: async () => ({ dialect: "clickhouse", address: serverAddress("clickhouse", endpoint.url), version: await softly(() => clickhouseVersion(p)) }),
  };
}

/** Closes what {@link openVersioned} opened (a Postgres connection). Safe to call twice. */
export const closeVersioned = (venv: VersionedEnv): Promise<void> => venv.driver.close();

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
    `refused: a pending migration has a step yodel apply does not run: a person acts on a manual step, and yodel apply runs only ClickHouseRebuildOp (materialized-view mode) and backfill steps on ClickHouse, and PostgresMigrationOp on Postgres. Nothing was applied:\n${lines.join("\n")}`,
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
  const live = await venv.driver.liveFingerprint();
  return planDigest(digestSubject({ environment: venv.environment, historyDatabase: venv.location.database, topology: venv.topology, applied: status.applied, toApply, live }));
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
  /**
   * Judges the policy (#53) for the digest computed under the lock; throws to
   * refuse. Returns the overrides the run relies on, which each migration's
   * `started` row records. Absent: no policy.
   */
  policy?: (digest: string, toApply: readonly PendingMigration[]) => Promise<PolicyOverride[]>;
  /** Runs an Op step. Default: chant's local executor (`../steps/`). */
  runStep?: StepRunner;
  /** The receipt store a backfill step uses. Default: chant's, on the server. */
  receipts?: ReceiptStore;
  /** How long to wait for a lock another apply holds. Default: the environment's ({@link VersionedEnv.lockWaitMs}). */
  lockWaitMs?: number;
  /**
   * `--stand-down`: asked before the lock is taken and between tries while
   * it waits; a line (`./stand-down.ts`) when a newer commit will apply the
   * environment, and this run then applies nothing.
   */
  standDown?: () => Promise<string | undefined>;
  /** How long to sleep between tries for a held lock. Default 1 s. */
  lockPollMs?: number;
}

/** How long a run waited for the lock, and who held it. */
export interface LockWait {
  ms: number;
  /** Who held it when the run first found it held, as the lock names its owner. */
  heldBy: string;
  where: string;
}

export interface ExecuteResult {
  applied: string[];
  /** Statements not sent because an earlier run had already succeeded with them. */
  skipped: Array<{ id: string; statement: number }>;
  lock: { kind: "keeper" | "local" | "advisory"; where: string; notice?: string; waited?: LockWait };
  /** Set when the run stood down (`--stand-down`) and applied nothing: why. */
  stoodDown?: string;
}

const seconds = (ms: number): string => (ms % 1000 === 0 ? `${String(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`);

/**
 * Takes the lock, waiting up to `waitMs` while another apply holds it: a
 * line naming the holder when the wait starts and whenever the holder
 * changes, a try every `pollMs`. A lock still held at the end of the wait
 * is the {@link LockHeldError} it was (exit 5), saying how long it waited.
 * With `standDown`, a newer commit ends the wait: `{ stoodDown }`.
 */
export async function acquireWaiting(
  venv: Pick<VersionedEnv, "driver">,
  holder: string,
  options: { waitMs: number; pollMs?: number; log: (line: string) => void; standDown?: (() => Promise<string | undefined>) | undefined },
): Promise<{ lock: Lock; waited?: LockWait } | { stoodDown: string }> {
  const started = Date.now();
  let first: LockHeldError | undefined;
  let last = "";
  for (;;) {
    try {
      const lock = await venv.driver.acquireLock(holder);
      if (!first) return { lock };
      const ms = Date.now() - started;
      options.log(`lock: taken after waiting ${seconds(ms)}`);
      return { lock, waited: { ms, heldBy: first.holder, where: first.where } };
    } catch (e) {
      if (!(e instanceof LockHeldError)) throw e;
      first ??= e;
      const left = options.waitMs - (Date.now() - started);
      if (left <= 0) {
        if (options.waitMs <= 0) throw e;
        throw new LockHeldError(e.holder, e.expiresAt, e.where, e.clear, `waited ${seconds(options.waitMs)} (--lock-wait), and it is still held`);
      }
      if (e.holder !== last) options.log(`lock: held by ${e.holder} (${e.where}); waiting up to ${seconds(left)} for it`);
      last = e.holder;
      const line = await options.standDown?.();
      if (line) return { stoodDown: line };
      await new Promise((r) => setTimeout(r, Math.min(options.pollMs ?? 1000, left)));
    }
  }
}

/**
 * Applies the pending migrations: takes the lock, reads the history again
 * under it, refuses on any integrity problem or a digest that moved since
 * approval, then runs each statement not yet succeeded.
 */
export async function executeApply(venv: VersionedEnv, ordered: readonly Migration[], options: ExecuteOptions): Promise<ExecuteResult> {
  const standDown = async (): Promise<string | undefined> => {
    const line = await options.standDown?.();
    if (line) options.log(line);
    return line;
  };
  const early = await standDown();
  if (early) return { applied: [], skipped: [], lock: { kind: "local", where: "(not taken: this run stood down)" }, stoodDown: early };
  const got = await acquireWaiting(venv, appliedBy(options.processEnv), {
    waitMs: options.lockWaitMs ?? venv.lockWaitMs ?? 0,
    ...(options.lockPollMs !== undefined ? { pollMs: options.lockPollMs } : {}),
    log: options.log,
    standDown: options.standDown ? standDown : undefined,
  });
  if ("stoodDown" in got) return { applied: [], skipped: [], lock: { kind: "local", where: "(not taken: this run stood down)" }, stoodDown: got.stoodDown };
  const { lock, waited } = got;
  if (lock.notice) options.log(`lock: ${lock.notice}`);
  else options.log(`lock: held in ${lock.where}`);
  const lockDoc: ExecuteResult["lock"] = { kind: lock.kind, where: lock.where, ...(lock.notice ? { notice: lock.notice } : {}), ...(waited ? { waited } : {}) };

  return withLock(lock, venv.lockTtlMs, async (beat) => {
    await venv.store.ensure();
    const { state, status } = await inspect(venv, ordered);
    const toApply = selectToApply(status, options.allowOutOfOrder);
    // Nothing pending under the lock (another apply, which held it first, applied it all): nothing to send, so nothing to approve.
    if (toApply.length === 0) {
      options.log("nothing pending under the lock: every migration is applied");
      return { applied: [], skipped: [], lock: lockDoc };
    }
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
    // The policy (#53), judged again under the lock for the digest computed here: a denial with no override for it refuses.
    const overrides = options.policy ? await options.policy(digest, toApply) : [];
    const recorder = new HistoryRecorder(venv.store, newRunContext(options.approvedDigest, options.processEnv), state.maxSeq);
    const result: ExecuteResult = { applied: [], skipped: [], lock: lockDoc };
    for (const p of toApply) {
      await applyMigration(venv, p, state.byId.get(p.id), recorder, beat, options, result, overrides);
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
  overrides: readonly PolicyOverride[] = [],
): Promise<void> {
  const m = p.migration;
  const silences = options.silences?.(m) ?? "[]";
  const base = { migration_id: m.id, parent: m.parent ?? "", checksum: p.checksum, silences };
  // The started row's note: the policy overrides the run relied on (#53), and the checks' outcomes (#52).
  const noted: Record<string, unknown> = overrides.length > 0 ? { policy: { overrides } } : {};
  let checksNote = Object.keys(noted).length > 0 ? JSON.stringify(noted) : "";
  if (checksDue(p)) {
    const outcomes = await runChecks(venv.driver, m);
    checksNote = JSON.stringify({ ...noted, checks: outcomes });
    const refusal = checksRefusal(m, outcomes, "under the lock, before its first statement");
    if (refusal) {
      const failed = failedChecks(m, outcomes);
      await recorder.record({ ...base, kind: "migration", statement_index: MIGRATION_ROW, statement_sha: "", status: "failed", error: failed.join("; "), note: checksNote });
      for (const f of failed) options.log(`${m.id}: ${f}`);
      throw refusal;
    }
    for (const o of outcomes) options.log(`${m.id}: check ${o.name} passed (${o.detail})`);
  }
  options.log(`${m.id}: ${p.partWay ? `resuming at statement ${String(p.partWay.resumeAt)}` : "applying"}${p.outOfOrder ? " (out of order, allowed)" : ""}`);
  await recorder.record({ ...base, kind: "migration", statement_index: MIGRATION_ROW, statement_sha: "", status: "started", ...(checksNote ? { note: checksNote } : {}) });

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
    // The neutral statement's sha, so a resume matches on every topology; the note says what it was rendered for.
    const sha = statementSha(step.sql);
    const rowNote = venv.driver.rowNote ?? "";
    const row = { ...base, kind: "statement" as const, statement_index: i, statement_sha: sha, note: rowNote };
    await recorder.record({ ...row, status: "started" });
    try {
      // The driver writes the succeeded row: on Postgres in the statement's own transaction, so the two commit together.
      await venv.driver.runStatement(step, {
        succeeded: (note) => recorder.record({ ...row, status: "succeeded", note: [rowNote, note].filter(Boolean).join("; ") }),
        log: options.log,
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      await recorder.record({ ...row, status: "failed", error });
      await recorder.record({ ...base, kind: "migration", statement_index: MIGRATION_ROW, statement_sha: "", status: "failed", error: `statement ${String(i)}: ${error}` });
      options.log(`  statement ${String(i)}: failed: ${error.split("\n")[0] ?? ""}`);
      throw new ApplyFailed(m.id, i, error.split("\n")[0] ?? error);
    }
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
      ...venv.driver.stepContext(),
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
