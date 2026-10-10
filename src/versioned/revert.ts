/**
 * `yodel revert` (#55): undoing an applied migration from its recorded
 * schemas, through the same plan, gate and history as `yodel apply`.
 *
 * A migration records the schema after it, and its parent records the
 * schema before it, so the reverse is planned offline: chant's
 * `diffStatements` from the migration's recorded schema to its parent's
 * (an empty schema for the first migration). Only the newest migration
 * applied in the environment can be reverted, since a later one was
 * written against it.
 *
 * Statements carry the schema back, never the data. A migration with a
 * data step (a backfill) is refused unless a hand-written revert step is
 * given (`--step <file>`): SQL statements, each ending with `;` at the end
 * of a line, that undo what the data step did. They run first, before the
 * reverse statements, as the migration ran its data step after the
 * statements it needed. A reverse that needs an Op or a manual step (a
 * ClickHouse sort-key change back, a Postgres rename back) is refused:
 * write it as a new migration.
 *
 * The run goes through the project's migrations Op (`./op.ts`), with the
 * migration and the step's file in `YODEL_REVERT` and `YODEL_REVERT_STEP`:
 * its Plan step (`yodel apply <env> --digest`) prints the revert's digest,
 * the gate binds the approval to it, and its Apply step (`yodel apply <env>
 * --execute`) takes the lock, plans the revert again, refuses if the digest
 * moved, checks the approval in chant's gate ledger, and runs it. The
 * history gets a `revert` row for each statement as it starts, succeeds or
 * fails, then a migration row `reverted` (`../history/rows.ts`): the
 * migration is pending again, and `yodel status` shows it reverted.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { diffStatements, type StatementStep } from "@intentius/chant-lexicon-sql/migration-statements";
import { YodelError } from "../project.js";
import { EXIT_NEEDS_OP, EXIT_REFUSED } from "../exit.js";
import { emptyBuild, isCheckpoint, type Migration, type MigrationStep } from "../migrations/index.js";
import { asBackfill, describeStep } from "../steps/index.js";
import { HistoryRecorder, MIGRATION_ROW, newRunContext, statementSha, withLock, appliedBy, type HistoryState } from "../history/index.js";
import { acquireWaiting, inspect, type VersionedEnv } from "./engine.js";
import { sameDigest } from "./digest.js";
import type { VersionedStatus } from "./state.js";

/** The migration `yodel apply --digest` and `--execute` revert instead of applying, set by `yodel revert` for its Op run. */
export const REVERT_ENV = "YODEL_REVERT";
/** The hand-written revert step's file, absolute, set with {@link REVERT_ENV}. */
export const REVERT_STEP_ENV = "YODEL_REVERT_STEP";

/** chant's plan-digest kind for a revert: a revert's digest is never an apply's. */
export const REVERT_DIGEST_KIND = "yodel-revert";

/** A hand-written revert step: its file and the statements in it. */
export interface RevertStepFile {
  /** As given; for messages. */
  file: string;
  /** `sha256:<hex>` of its text. */
  sha: string;
  statements: string[];
}

/** The statements of a SQL file: each ends with `;` at the end of a line; `--` comment lines and blank ones between them are dropped. */
export function splitStatements(text: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (current.length === 0 && (/^\s*--/.test(line) || line.trim() === "")) continue;
    current.push(line);
    if (/;\s*$/.test(line)) {
      out.push(current.join("\n").replace(/;\s*$/, "").trim());
      current = [];
    }
  }
  const rest = current.join("\n").trim();
  if (rest) out.push(rest);
  return out.filter((s) => s !== "");
}

/** Reads a hand-written revert step, relative to `dir`. */
export function readRevertStep(path: string, dir: string): RevertStepFile {
  let text: string;
  try {
    text = readFileSync(resolve(dir, path), "utf8");
  } catch (e) {
    throw new YodelError(`--step ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const statements = splitStatements(text);
  if (statements.length === 0) throw new YodelError(`--step ${path} holds no statement`);
  return { file: path, sha: `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`, statements };
}

/** One statement of a revert, in the order it runs. */
export interface RevertStatement {
  /** `step`: from the hand-written revert step. `reverse`: diffed from the recorded schemas. */
  source: "step" | "reverse";
  step: StatementStep;
}

export interface RevertPlan {
  environment: string;
  migration: Migration;
  /** The migration it goes back to, or `null` for none (the first migration reverted). */
  to: string | null;
  /** The checksum the history recorded when it was applied. */
  checksum: string;
  statements: RevertStatement[];
  /** The migration's data steps, which the hand-written step undoes. */
  dataSteps: string[];
  step?: RevertStepFile;
  /** The indexes in {@link statements} that already succeeded: a revert that failed part way resumes. */
  done: number[];
}

/** A hand-written statement as a step the driver sends. */
function handStatement(sql: string, i: number, dialect: string): StatementStep {
  return {
    kind: "statement",
    object: "revert-step",
    type: "revert-step",
    name: `revert step statement ${String(i + 1)}`,
    sql,
    rule: "revert-step",
    class: "data",
    transactional: dialect === "postgres",
    ...(dialect === "clickhouse" && /^\s*ALTER\s+TABLE\b[\s\S]*\b(UPDATE|DELETE)\b/i.test(sql) ? { waitsForMutation: true } : {}),
  };
}

/**
 * The revert of migration `id` in an environment whose status is `status`,
 * or a YodelError: exit 1 for no such migration, 4 when the history does not
 * match the directory, the migration is not applied, or one after it is;
 * 2 when the reverse needs a step revert does not run, or the migration has
 * a data step and no hand-written revert step is given.
 */
export function planRevert(input: { environment: string; ordered: readonly Migration[]; status: VersionedStatus; state: HistoryState; id: string; step?: RevertStepFile | undefined }): RevertPlan {
  const { ordered, status, id, environment } = input;
  const at = ordered.findIndex((m) => m.id === id);
  const m = ordered[at];
  if (!m) throw new YodelError(`no migration ${id} in the migrations directory`);
  if (status.mismatches.length > 0) {
    throw new YodelError(`refused: the history does not match the migrations directory; nothing was reverted:\n${status.mismatches.map((x) => `  ${x.message}`).join("\n")}`, EXIT_REFUSED);
  }
  // Checkpoints (#63): one an environment started from has no schema before it there, and the migrations before it never ran there.
  const skipped = status.skipped?.find((k) => k.id === id);
  if (skipped) {
    throw new YodelError(
      skipped.reason === "covered"
        ? `refused: ${id} comes before the checkpoint ${skipped.checkpoint ?? ""}, which ${environment} started from: it never ran in ${environment}, so there is nothing to revert. Nothing was reverted.`
        : `refused: ${id} is a checkpoint ${environment} skips, since it ran the migrations before it: it never ran in ${environment}, so there is nothing to revert. Nothing was reverted.`,
      EXIT_REFUSED,
    );
  }
  if (isCheckpoint(m) && status.applied.some((a) => a.id === id)) {
    throw new YodelError(
      `refused: ${id} is the checkpoint ${environment} started from: it created the whole schema, and ${environment} never ran the migrations before it, so there is no earlier schema to go back to. Nothing was reverted.`,
      EXIT_REFUSED,
    );
  }
  const applied = status.applied.find((a) => a.id === id);
  if (!applied) throw new YodelError(`refused: ${id} is not applied in ${environment}, so there is nothing to revert. Nothing was reverted.`, EXIT_REFUSED);
  const later = status.applied.filter((a) => a.index !== undefined && a.index > at).map((a) => a.id);
  if (later.length > 0) {
    throw new YodelError(`refused: ${later.join(", ")} ${later.length === 1 ? "is" : "are"} applied in ${environment} after ${id}, and ${later.length === 1 ? "was" : "were"} written against it; revert ${later.length === 1 ? "it" : "them"} first, newest first. Nothing was reverted.`, EXIT_REFUSED);
  }

  const parent = m.parent === null ? undefined : ordered.find((x) => x.id === m.parent);
  const doc = m.document;
  const before = parent?.document.schema ?? emptyBuild(doc.schema);
  let steps: MigrationStep[];
  try {
    steps = diffStatements(doc.schema, before, {
      ...(doc.defaultDatabase !== undefined ? { defaultDatabase: doc.defaultDatabase } : {}),
      ...(doc.defaultSchema !== undefined ? { defaultSchema: doc.defaultSchema } : {}),
    }).steps;
  } catch (e) {
    throw new YodelError(`the reverse of ${id} cannot be planned from the recorded schemas: ${e instanceof Error ? e.message : String(e)}`);
  }
  const notStatements = steps.filter((s) => s.kind !== "statement");
  if (notStatements.length > 0) {
    throw new YodelError(
      `refused: going back from ${id} to ${parent?.id ?? "an empty schema"} takes a step yodel revert does not run (${notStatements.map((s) => describeStep(s)).join("; ")}); write the change as a new migration (yodel new). Nothing was reverted.`,
      EXIT_NEEDS_OP,
    );
  }
  const dataSteps = doc.steps.flatMap((s, i) => (asBackfill(s) ? [`step ${String(i)}: ${describeStep(s)}`] : []));
  if (dataSteps.length > 0 && !input.step) {
    throw new YodelError(
      `refused: ${id} has a data step the recorded schemas cannot undo (${dataSteps.join("; ")}). Write the statements that undo it in a file and pass --step <file>; they run before the reverse statements. Nothing was reverted.`,
      EXIT_NEEDS_OP,
    );
  }
  const statements: RevertStatement[] = [
    ...(input.step?.statements ?? []).map((sql, i): RevertStatement => ({ source: "step", step: handStatement(sql, i, doc.dialect) })),
    ...steps.map((s): RevertStatement => ({ source: "reverse", step: s as StatementStep })),
  ];
  const rec = input.state.byId.get(id);
  const done = statements.flatMap((s, i) => {
    const r = rec?.reverts.get(i);
    return r?.status === "succeeded" && r.sha === statementSha(s.step.sql) ? [i] : [];
  });
  return { environment, migration: m, to: parent?.id ?? null, checksum: applied.checksum, statements, dataSteps, ...(input.step ? { step: input.step } : {}), done };
}

/** The revert's plan digest: what it runs, what it starts from and the live schema, as chant computes digests. */
export async function revertDigest(venv: VersionedEnv, status: VersionedStatus, plan: RevertPlan): Promise<string> {
  const { computePlanDigest } = await import("@intentius/chant/lifecycle/plan-digest");
  const live = await venv.driver.liveFingerprint();
  return computePlanDigest(REVERT_DIGEST_KIND, {
    environment: venv.environment,
    historyDatabase: venv.location.database,
    topology: venv.topology ?? { kind: "single" },
    applied: status.applied.map((a) => ({ id: a.id, checksum: a.checksum })),
    revert: { id: plan.migration.id, checksum: plan.checksum, to: plan.to, statements: plan.statements.map((s) => statementSha(s.step.sql)), step: plan.step?.sha ?? null, done: plan.done },
    live,
  });
}

/** Plans the revert from the history as it is now, with its digest. Reads only; takes no lock. */
export async function currentRevert(venv: VersionedEnv, ordered: readonly Migration[], id: string, step?: RevertStepFile): Promise<{ plan: RevertPlan; digest: string; status: VersionedStatus }> {
  const { state, status } = await inspect(venv, ordered);
  const plan = planRevert({ environment: venv.environment, ordered, status, state, id, step });
  return { plan, digest: await revertDigest(venv, status, plan), status };
}

export class RevertFailed extends YodelError {
  constructor(
    readonly migration: string,
    readonly statement: number,
    readonly serverError: string,
  ) {
    super(
      `the revert of ${migration} failed at its statement ${String(statement)}: ${serverError}\n` +
        `Fix the cause, then run yodel revert again: it resumes at statement ${String(statement)} and never sends again the statements that succeeded. ${migration} is still applied.`,
      1,
    );
    this.name = "RevertFailed";
  }
}

export interface ExecuteRevertOptions {
  id: string;
  step?: RevertStepFile | undefined;
  /** The digest the Op's gate passed. A revert whose digest moved since is refused. */
  approvedDigest: string;
  /** Checks the approval for the digest computed under the lock; throws to refuse. */
  approve: (digest: string) => Promise<unknown>;
  log: (line: string) => void;
  processEnv?: NodeJS.ProcessEnv;
  lockWaitMs?: number;
}

/** Runs the revert under the lock, after planning it again and checking its digest and approval. Returns the plan run. */
export async function executeRevert(venv: VersionedEnv, ordered: readonly Migration[], options: ExecuteRevertOptions): Promise<RevertPlan> {
  const got = await acquireWaiting(venv, appliedBy(options.processEnv), { waitMs: options.lockWaitMs ?? venv.lockWaitMs ?? 0, log: options.log });
  if ("stoodDown" in got) throw new YodelError("the revert stood down", 1);
  const { lock } = got;
  options.log(lock.notice ? `lock: ${lock.notice}` : `lock: held in ${lock.where}`);
  return withLock(lock, venv.lockTtlMs, async (beat) => {
    await venv.store.ensure();
    await venv.store.allowRevert?.();
    const { state, status } = await inspect(venv, ordered);
    const plan = planRevert({ environment: venv.environment, ordered, status, state, id: options.id, step: options.step });
    const digest = await revertDigest(venv, status, plan);
    if (!(await sameDigest(digest, options.approvedDigest))) {
      throw new YodelError(`refused: the revert's plan moved since it was approved (approved ${options.approvedDigest}, now ${digest}). Nothing was reverted; run yodel revert ${venv.environment} ${options.id} again and approve the new plan.`, 1);
    }
    await options.approve(digest);
    const m = plan.migration;
    const recorder = new HistoryRecorder(venv.store, newRunContext(options.approvedDigest, options.processEnv), state.maxSeq);
    const base = { migration_id: m.id, parent: m.parent ?? "", checksum: plan.checksum, silences: "[]" };
    options.log(`${m.id}: reverting to ${plan.to ?? "an empty schema"}${plan.done.length > 0 ? `, resuming at statement ${String(plan.statements.findIndex((_, i) => !plan.done.includes(i)))}` : ""}`);
    const rowNote = venv.driver.rowNote ?? "";
    for (const [i, s] of plan.statements.entries()) {
      if (plan.done.includes(i)) {
        options.log(`  statement ${String(i)}: succeeded in an earlier run; not sent`);
        continue;
      }
      await beat();
      const row = { ...base, kind: "revert" as const, statement_index: i, statement_sha: statementSha(s.step.sql), note: rowNote };
      await recorder.record({ ...row, status: "started" });
      try {
        await venv.driver.runStatement(s.step, { succeeded: (note) => recorder.record({ ...row, status: "succeeded", note: [rowNote, note].filter(Boolean).join("; ") }), log: options.log });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        await recorder.record({ ...row, status: "failed", error });
        options.log(`  statement ${String(i)}: failed: ${error.split("\n")[0] ?? ""}`);
        throw new RevertFailed(m.id, i, error.split("\n")[0] ?? error);
      }
      options.log(`  statement ${String(i)}: ok (${s.source === "step" ? `the revert step ${plan.step?.file ?? ""}` : `${s.step.rule} ${s.step.class}, ${s.step.name}`})`);
    }
    const note = JSON.stringify({ revert: { to: plan.to, statements: plan.statements.length, ...(plan.step ? { step: plan.step.file, stepSha: plan.step.sha } : {}) } });
    await recorder.record({ ...base, kind: "migration", statement_index: MIGRATION_ROW, statement_sha: "", status: "reverted", note });
    options.log(`${m.id}: reverted`);
    return plan;
  });
}

/** The revert `yodel apply --digest` or `--execute` runs instead, when `yodel revert` started the Op run. */
export function revertFromEnv(env: NodeJS.ProcessEnv, dir: string): { id: string; step?: RevertStepFile } | undefined {
  const id = env[REVERT_ENV];
  if (!id) return undefined;
  const file = env[REVERT_STEP_ENV];
  return { id, ...(file ? { step: readRevertStep(file, dir) } : {}) };
}
