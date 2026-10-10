/**
 * The replay check, dialect-free: every migration, in chain order, into a
 * database that starts empty, and after each one the database compared with
 * the schema that migration records (`migration.json`'s `schema`). The first
 * migration whose result differs fails the check, named, with what differs.
 *
 * A migration's recorded schema is what the next `yodel new` diffs from, so
 * a recorded schema that its statements do not produce (a hand edit to
 * either file, a rebase that recomputed one and not the other, a statement
 * chant renders differently from what the server makes) would rot every
 * migration after it. Replaying catches that while it is one migration.
 *
 * Steps, as replay treats them:
 *
 * - a `statement` is sent as `yodel apply` sends it;
 * - a `ClickHouseRebuildOp` step (materialized-view mode) or a
 *   `PostgresMigrationOp` step runs, as apply runs it: it changes the
 *   table's schema, so the replay needs it;
 * - a backfill step is skipped: it moves data, and the replayed database has
 *   none, so it changes nothing the comparison reads;
 * - anything else (a manual step, an Op apply does not run) cannot be
 *   replayed: the check stops there, naming it ({@link ReplayResult} outcome
 *   `unreplayable`).
 *
 * A checkpoint (#63) is left out of the chain: it creates its parent's
 * recorded schema from nothing. After the chain, each checkpoint is
 * replayed on its own into the database emptied again, and compared with
 * its recorded schema, the one the chain was shown to give. So a fresh
 * environment that starts from it ends where one that ran the chain does.
 *
 * The database is the replay's: it must be fresh when the replay starts
 * (every database or schema the history names absent, the default one
 * empty), or emptied first when the caller says so (`reset`), and it is
 * emptied again at the end unless `keep`. Nothing is recorded in a history
 * table; no lock is taken.
 */

import type { ClassifiedChange } from "@intentius/chant-lexicon-sql/core/classifier";
import type { StatementStep } from "@intentius/chant-lexicon-sql/migration-statements";
import { YodelError, type SqlDialect } from "../project.js";
import { isCheckpoint, type Migration } from "../migrations/index.js";
import { asBackfill, describeStep, planStep, type BackfillStep } from "../steps/kinds.js";

/** Exit code: the target is not fresh and `reset` was not given; nothing was run. */
export const NOT_FRESH = 4;
/** Exit code: a step the replay cannot run (a manual step, an Op it does not run). */
export const UNREPLAYABLE = 2;

/** One difference between the replayed database and a recorded schema: `before` is the replay's, `after` the record's. */
export type ReplayChange = ClassifiedChange;

/** What an Op step did in the replay. */
export type OpStepOutcome = { ran: true; note?: string } | { refused: string };

/** What the replay needs from a dialect: a server it owns for the run. */
export interface ReplayDriver {
  dialect: SqlDialect;
  /** The server, for messages (no credentials). */
  where: string;
  /** The databases (ClickHouse) or schemas (Postgres) the history names: the replay empties and compares all of them. */
  scope: readonly string[];
  /** The ones of {@link scope} that are not fresh: there (or, for the default one, not empty). */
  occupied(): Promise<string[]>;
  /** Empties {@link scope}: drops each one, and empties the default one. */
  clear(): Promise<void>;
  /** Sends one statement step of `m`, as apply sends it. Throws the server's error. */
  statement(m: Migration, index: number, step: StatementStep): Promise<void>;
  /** Runs an Op step that is neither a backfill nor refused by {@link planStep}; or says why it cannot. */
  opStep(m: Migration, index: number): Promise<OpStepOutcome>;
  /** The replayed database against `m`'s recorded schema. Empty when they match. */
  compare(m: Migration): Promise<ReplayChange[]>;
  close(): Promise<void>;
}

/** One migration the replay got through. */
export interface ReplayedMigration {
  id: string;
  statements: number;
  /** Op steps run, as `step <i>: <what>`. */
  ran: string[];
  /** Steps skipped, as `step <i>: <what> (<why>)`. */
  skipped: string[];
  /** A checkpoint (#63), replayed on its own into an empty database after the chain. */
  checkpoint?: true;
}

export type ReplayResult = {
  dialect: SqlDialect;
  where: string;
  scope: string[];
  /** Whether the target held anything at the start, and was emptied (`reset`). */
  reset: boolean;
  /** Whether the replayed database was left in place (`keep`). */
  kept: boolean;
  /** The migrations that replayed to their recorded schema, in order. */
  matched: ReplayedMigration[];
  /** How many migrations the history has. */
  total: number;
} & (
  | { outcome: "matches" }
  | { outcome: "differs"; migration: ReplayedMigration; changes: ReplayChange[] }
  | { outcome: "failed"; migration: string; step: number; error: string }
  | { outcome: "unreplayable"; migration: string; step: number; reason: string }
);

export interface ReplayOptions {
  /** Empty the target first when it is not fresh. Without it, a target that is not fresh is refused ({@link NOT_FRESH}). */
  reset?: boolean;
  /** Leave the replayed database in place at the end, to look at. Default: emptied. */
  keep?: boolean;
  /** Progress, one line at a time. */
  log?: (line: string) => void;
}

const firstLine = (s: string): string => s.split("\n")[0] ?? s;
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Replays `ordered` (first to newest) through `driver`; see the module comment. Throws only for a target that is not fresh, or a server that fails outside a statement. */
export async function replayMigrations(ordered: readonly Migration[], driver: ReplayDriver, options: ReplayOptions = {}): Promise<ReplayResult> {
  const log = options.log ?? (() => undefined);
  const base = { dialect: driver.dialect, where: driver.where, scope: [...driver.scope], total: ordered.length, kept: options.keep === true };
  if (ordered.length === 0) return { ...base, reset: false, kept: false, matched: [], outcome: "matches" };

  const occupied = await driver.occupied();
  if (occupied.length > 0) {
    if (options.reset !== true) {
      throw new YodelError(
        `refused: the replay needs a fresh database, and ${driver.where} already holds ${occupied.join(", ")}. ` +
          `Point the replay at a throwaway emulator (chant emulator up --lexicon sql), or pass --reset to drop ${occupied.length === 1 ? "it" : "them"} first. Nothing was run.`,
        NOT_FRESH,
      );
    }
    log(`emptying ${occupied.join(", ")} on ${driver.where}`);
    await driver.clear();
  }

  const matched: ReplayedMigration[] = [];
  const reset = occupied.length > 0;
  type Failure = Exclude<ReplayResult, { outcome: "matches" }>;
  /** Replays one migration's steps on what the database holds now, then compares; a failure, or the migration replayed. */
  const replayOne = async (m: Migration): Promise<ReplayedMigration | Failure> => {
    const done: ReplayedMigration = { id: m.id, statements: 0, ran: [], skipped: [], ...(isCheckpoint(m) ? { checkpoint: true } : {}) };
    log(`${m.id}: replaying${isCheckpoint(m) ? " (a checkpoint, into an empty database)" : ""}`);
    for (const [i, step] of m.document.steps.entries()) {
      const s = step as typeof step | BackfillStep;
      if (s.kind === "statement") {
        try {
          await driver.statement(m, i, s);
        } catch (e) {
          return { ...base, reset, matched, outcome: "failed", migration: m.id, step: i, error: firstLine(message(e)) };
        }
        done.statements++;
        continue;
      }
      if (asBackfill(s)) {
        done.skipped.push(`step ${String(i)}: ${describeStep(s)} (moves data; the replayed database has none)`);
        continue;
      }
      const plan = planStep(s);
      const outcome: OpStepOutcome = plan.run === "refused" ? { refused: plan.reason } : await driver.opStep(m, i);
      if ("refused" in outcome) {
        return { ...base, reset, matched, outcome: "unreplayable", migration: m.id, step: i, reason: outcome.refused };
      }
      done.ran.push(`step ${String(i)}: ${describeStep(s)}${outcome.note ? ` (${outcome.note})` : ""}`);
    }
    const changes = await driver.compare(m);
    if (changes.length > 0) {
      log(`${m.id}: differs from its recorded schema (${String(changes.length)} difference${changes.length === 1 ? "" : "s"})`);
      return { ...base, reset, matched, outcome: "differs", migration: done, changes };
    }
    log(`${m.id}: matches its recorded schema`);
    return done;
  };
  const failed = (r: ReplayedMigration | Failure): r is Failure => "outcome" in r;

  try {
    // The chain, first to newest. A checkpoint (#63) creates its parent's schema from nothing, so on top of the chain it would only fail: it is replayed on its own below.
    const checkpoints: Migration[] = [];
    for (const m of ordered) {
      if (isCheckpoint(m)) {
        checkpoints.push(m);
        log(`${m.id}: a checkpoint; replayed on its own, into an empty database, after the chain`);
        continue;
      }
      const r = await replayOne(m);
      if (failed(r)) return r;
      matched.push(r);
    }
    // Each checkpoint into an empty database: its statements must give its recorded schema, its parent's, which the chain was just shown to give.
    for (const m of checkpoints) {
      await driver.clear();
      const r = await replayOne(m);
      if (failed(r)) return r;
      matched.push(r);
    }
    return { ...base, reset, matched, outcome: "matches" };
  } finally {
    // Emptying afterwards is housekeeping: its failure is reported, never put in place of the result.
    if (options.keep !== true) await driver.clear().catch((e: unknown) => { log(`could not empty ${driver.scope.join(", ")} afterwards: ${firstLine(message(e))}`); });
  }
}
