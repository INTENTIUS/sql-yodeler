/**
 * What moved: why the plan digest now differs from one approved earlier.
 *
 * The digest is a hash of its subject (`./digest.ts`): the environment, the
 * history database, the topology, the applied migrations with their recorded checksums,
 * the pending ones with their checksums and the statements of each already
 * done, and the live schema's fingerprint. A hash says nothing about which
 * of those changed, so yodel works back to the subject it was taken over:
 *
 * - When the older subject is known (the pull request comment carries it,
 *   hidden), the two subjects are compared part by part.
 * - Otherwise it rebuilds candidates from what it can read: the history as
 *   it stood at the approval's time (the rows recorded up to then), each
 *   ordered subset of today's pending migrations (one added after approval
 *   is missing from the older plan), and each pending migration's files as
 *   git has held them (one edited after approval had another checksum). A
 *   candidate whose digest equals the approved one is the subject it was
 *   taken over, and the comparison is exact ("confirmed").
 * - When no candidate matches, today's live schema is not the one it was
 *   approved against (or a part yodel cannot rebuild moved): it says so, and
 *   lists what it saw move (rows recorded since, files committed since).
 */

import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import type { GateLedgerPort } from "@intentius/chant/op/gate";
import { computeChecksum, type Migration } from "../migrations/index.js";
import { deriveState, type HistoryRow } from "../history/index.js";
import { topologyLabel } from "@intentius/chant-lexicon-sql/clickhouse/topology";
import { catalogFingerprint, digestSubject, planDigest, readLiveCatalog, sameDigest, type DigestSubject } from "./digest.js";
import type { VersionedEnv } from "./engine.js";
import type { MigrateOpRef } from "./op.js";
import { compareHistory, type AppliedMigration, type PendingMigration, type VersionedStatus } from "./state.js";

export type MovedPart = "environment" | "history" | "pending" | "live";

export interface Moved {
  part: MovedPart;
  message: string;
}

export interface MoveExplanation {
  approved: string;
  now: string;
  /** A rebuilt (or carried) subject hashes to the approved digest, so `changes` is exact. */
  confirmed: boolean;
  changes: Moved[];
}

/** The subject `currentDigest` hashes, read now. */
export async function currentSubject(venv: VersionedEnv, status: VersionedStatus, toApply: readonly PendingMigration[]): Promise<DigestSubject> {
  const live = catalogFingerprint(await readLiveCatalog(venv.port, venv.scope));
  return digestSubject({ environment: venv.environment, historyDatabase: venv.location.database, topology: venv.topology, applied: status.applied, toApply, live });
}

/** A subject as text safe to carry in an HTML comment: base64url of its JSON. */
export const encodeSubject = (s: DigestSubject): string => Buffer.from(JSON.stringify(s), "utf8").toString("base64url");

export function decodeSubject(text: string): DigestSubject | undefined {
  try {
    const s = JSON.parse(Buffer.from(text, "base64url").toString("utf8")) as Partial<DigestSubject>;
    if (typeof s.environment !== "string" || typeof s.historyDatabase !== "string" || typeof s.live !== "string" || !Array.isArray(s.applied) || !Array.isArray(s.pending)) return undefined;
    return s as DigestSubject;
  } catch {
    return undefined;
  }
}

const list = (ids: readonly string[]) => ids.join(", ");

/**
 * How `after` differs from `before`, part by part. `applied` (today's, with
 * who applied each and when) names the run that applied a migration since.
 */
export function diffSubjects(before: DigestSubject, after: DigestSubject, applied: readonly AppliedMigration[] = []): Moved[] {
  const out: Moved[] = [];
  if (before.environment !== after.environment) out.push({ part: "environment", message: `the environment changed: ${before.environment} -> ${after.environment}` });
  if (before.historyDatabase !== after.historyDatabase) out.push({ part: "environment", message: `the history database changed: ${before.historyDatabase} -> ${after.historyDatabase}` });
  const topology = (s: DigestSubject) => JSON.stringify(Object.entries(s.topology ?? { kind: "single" }).sort(([a], [b]) => a.localeCompare(b)));
  if (topology(before) !== topology(after)) {
    const label = (s: DigestSubject) => topologyLabel(s.topology ?? { kind: "single" });
    out.push({ part: "environment", message: `the topology changed: ${label(before)} -> ${label(after)}` });
  }

  const wasApplied = new Map(before.applied.map((a) => [a.id, a]));
  const isApplied = new Map(after.applied.map((a) => [a.id, a]));
  const who = new Map(applied.map((a) => [a.id, a]));
  const newlyApplied = after.applied.filter((a) => !wasApplied.has(a.id));
  if (newlyApplied.length > 0) {
    const named = newlyApplied.map((a) => {
      const w = who.get(a.id);
      return w ? `${a.id} (by ${w.appliedBy} at ${w.recordedAt})` : a.id;
    });
    out.push({ part: "history", message: `applied since: ${list(named)}` });
  }
  const unapplied = before.applied.filter((a) => !isApplied.has(a.id)).map((a) => a.id);
  if (unapplied.length > 0) out.push({ part: "history", message: `no longer recorded applied: ${list(unapplied)}` });
  const repaired = after.applied.filter((a) => wasApplied.has(a.id) && wasApplied.get(a.id)?.checksum !== a.checksum).map((a) => a.id);
  if (repaired.length > 0) out.push({ part: "history", message: `recorded checksum changed (yodel repair): ${list(repaired)}` });

  const wasPending = new Map(before.pending.map((p) => [p.id, p]));
  const isPending = new Map(after.pending.map((p) => [p.id, p]));
  const added = after.pending.filter((p) => !wasPending.has(p.id) && !wasApplied.has(p.id)).map((p) => p.id);
  if (added.length > 0) out.push({ part: "pending", message: `new pending migration${added.length === 1 ? "" : "s"}: ${list(added)}` });
  const gone = before.pending.filter((p) => !isPending.has(p.id) && !isApplied.has(p.id)).map((p) => p.id);
  if (gone.length > 0) out.push({ part: "pending", message: `no longer pending (gone from the directory): ${list(gone)}` });
  const edited = after.pending.filter((p) => wasPending.has(p.id) && wasPending.get(p.id)?.checksum !== p.checksum).map((p) => p.id);
  if (edited.length > 0) out.push({ part: "pending", message: `files changed: ${list(edited)}` });
  const progressed = after.pending.filter((p) => {
    const b = wasPending.get(p.id);
    return b !== undefined && b.checksum === p.checksum && JSON.stringify(b.done) !== JSON.stringify(p.done);
  });
  for (const p of progressed) out.push({ part: "history", message: `${p.id} ran part way since: statements ${p.done.join(", ") || "none"} done now` });
  const reordered = before.pending.filter((p) => isPending.has(p.id)).map((p) => p.id);
  const nowOrder = after.pending.filter((p) => wasPending.has(p.id)).map((p) => p.id);
  if (JSON.stringify(reordered) !== JSON.stringify(nowOrder)) out.push({ part: "pending", message: `the chain order changed: ${list(reordered)} -> ${list(nowOrder)}` });

  if (before.live !== after.live) out.push({ part: "live", message: "a table, view, dictionary or database in the environment is not as it was" });
  return out;
}

/** The checksums git has held for one migration's files, newest first. Empty outside git. */
export function gitChecksums(migrationsDir: string, id: string, limit = 10): string[] {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: migrationsDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  try {
    const commits = git("log", `-n${String(limit)}`, "--format=%H", "--", id).split("\n").filter(Boolean);
    const out = new Set<string>();
    for (const c of commits) {
      try {
        const sql = git("show", `${c}:./${id}/migration.sql`);
        out.add(computeChecksum({ sql, json: git("show", `${c}:./${id}/migration.json`) }));
      } catch {
        // Deleted at that commit, or not a migration then.
      }
    }
    return [...out];
  } catch {
    return [];
  }
}

/** Migration directories git saw commits to after `sinceIso`, with the newest commit. Empty outside git. */
export function gitChangesSince(migrationsDir: string, sinceIso: string): Array<{ id: string; commit: string; at: string }> {
  try {
    const log = execFileSync("git", ["log", `--since=${sinceIso}`, "--format=@%h %cI", "--name-only", "--relative", "--", "."], {
      cwd: migrationsDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const seen = new Map<string, { id: string; commit: string; at: string }>();
    let commit = "";
    let at = "";
    for (const line of log.split("\n")) {
      if (line.startsWith("@")) [commit, at] = line.slice(1).split(" ") as [string, string];
      else if (line.trim()) {
        const id = line.split("/")[0] ?? "";
        if (id && !seen.has(id)) seen.set(id, { id, commit, at });
      }
    }
    return [...seen.values()];
  } catch {
    return [];
  }
}

/** ClickHouse's `YYYY-MM-DD hh:mm:ss.ffffff` (UTC) or ISO, as epoch ms. */
export const recordedTime = (t: string | undefined): number => (t ? Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : `${t.replace(" ", "T")}Z`) : Number.NaN);

/** Ordered subsets of `items`, every one when there are few, else the prefixes and each with one left out. */
function subsets<T>(items: readonly T[]): T[][] {
  if (items.length <= 10) {
    const out: T[][] = [];
    for (let mask = (1 << items.length) - 1; mask >= 0; mask--) out.push(items.filter((_, i) => (mask & (1 << i)) !== 0));
    return out;
  }
  const out: T[][] = [];
  for (let k = items.length; k >= 0; k--) out.push(items.slice(0, k));
  for (let i = 0; i < items.length; i++) out.push(items.filter((_, j) => j !== i));
  return out;
}

export interface ExplainInput {
  approvedDigest: string;
  /** When the approval was recorded (ISO); lets yodel read the history as it stood then. */
  approvedAt?: string | undefined;
  now: DigestSubject;
  /** The subject the approved digest was shown with, when something kept it (the PR comment). */
  previous?: DigestSubject | undefined;
  /** The chain, as the directory has it today. */
  ordered: readonly Migration[];
  /** Today's applied migrations, for who applied what. */
  applied?: readonly AppliedMigration[];
  /** Every history row, to rebuild the history as it stood at `approvedAt`. */
  rows?: readonly HistoryRow[];
  /** The checksums a migration's files have had (default: none but today's). */
  checksums?: (id: string) => string[];
  /** Directories committed to since `approvedAt`, for the unconfirmed case. */
  changedSince?: (iso: string) => Array<{ id: string; commit: string; at: string }>;
  /** Candidates tried at most. */
  budget?: number;
}

/** Why `input.now` no longer hashes to `input.approvedDigest`. */
export async function explainMove(input: ExplainInput): Promise<MoveExplanation> {
  const now = await planDigest(input.now);
  const done = (confirmed: boolean, changes: Moved[]): MoveExplanation => ({ approved: input.approvedDigest, now, confirmed, changes });
  if (await sameDigest(now, input.approvedDigest)) return done(true, []);
  if (input.previous && (await sameDigest(await planDigest(input.previous), input.approvedDigest))) {
    return done(true, diffSubjects(input.previous, input.now, input.applied));
  }

  // The history as it stood at approval, and as it is.
  const states = [];
  const at = recordedTime(input.approvedAt);
  if (input.rows && Number.isFinite(at)) states.push(deriveState(input.rows.filter((r) => recordedTime(r.recorded_at) <= at)));
  if (input.rows) states.push(deriveState(input.rows));

  let budget = input.budget ?? 20_000;
  const tried = new Set<string>();
  const baselines: DigestSubject[] = [];
  for (const state of states) {
    const status = compareHistory(input.ordered, state);
    const base = digestSubject({ environment: input.now.environment, historyDatabase: input.now.historyDatabase, topology: input.now.topology, applied: status.applied, toApply: status.pending, live: input.now.live });
    // A subject carried from before #9 has no topology; rebuild it the same way.
    if (input.now.topology === undefined) delete base.topology;
    baselines.push(base);
    for (const pending of subsets(base.pending)) {
      const variants = pending.map((p) => [p.checksum, ...(input.checksums?.(p.id) ?? []).filter((c) => c !== p.checksum)]);
      for (const combo of product(variants)) {
        if (budget-- <= 0) break;
        const candidate: DigestSubject = { ...base, pending: pending.map((p, i) => ({ ...p, checksum: combo[i] ?? p.checksum })) };
        const key = JSON.stringify(candidate);
        if (tried.has(key)) continue;
        tried.add(key);
        if (await sameDigest(await planDigest(candidate), input.approvedDigest)) return done(true, diffSubjects(candidate, input.now, input.applied));
      }
    }
  }

  // Unconfirmed: what yodel saw move, and the part it cannot rebuild.
  const base = baselines[0];
  const changes = base ? diffSubjects(base, input.now, input.applied).filter((c) => c.part === "history") : [];
  if (input.approvedAt && input.changedSince) {
    const committed = input.changedSince(input.approvedAt);
    if (committed.length > 0) {
      changes.push({ part: "pending", message: `committed to since approval: ${list(committed.map((c) => `${c.id} (${c.commit} at ${c.at})`))}` });
    }
  }
  changes.push({
    part: "live",
    message:
      "no state yodel can rebuild from the history and git hashes to the approved digest with today's live schema, so a table, view, " +
      "dictionary or database in the environment changed since approval (or a part yodel cannot rebuild did)",
  });
  return done(false, changes);
}

function* product(lists: readonly string[][]): Generator<string[]> {
  if (lists.length === 0) {
    yield [];
    return;
  }
  const [head, ...rest] = lists as [string[], ...string[][]];
  for (const h of head) for (const tail of product(rest)) yield [h, ...tail];
}

/** One line: "the plan moved since it was approved: <part>: <what>; ...". */
export function describeMove(e: MoveExplanation): string {
  if (e.changes.length === 0) return "nothing moved";
  const label: Record<MovedPart, string> = { environment: "environment", history: "history changed", pending: "pending migrations changed", live: "live schema changed" };
  return e.changes.map((c) => `${label[c.part]}: ${c.message}`).join("; ");
}

/** The newest approval of `op`'s gate in the ledger, and whether it holds for `digest` by the gate's rule (for that digest, newer than the gate's newest pending fact). */
export async function latestApproval(ledger: GateLedgerPort, op: Pick<MigrateOpRef, "name" | "gate">, digest: string | undefined): Promise<{ digest: string | undefined; by: string; at: string; holds: boolean } | undefined> {
  const { latestPendingGate } = await import("@intentius/chant/lifecycle/gate-ledger");
  const read = await ledger.read(op.name);
  const newest = read.resolutions.filter((r) => r.gate === op.gate).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)).at(-1);
  if (!newest) return undefined;
  const since = Date.parse(latestPendingGate(read.pending, op.gate)?.timestamp ?? new Date(0).toISOString());
  const holds = digest !== undefined && Date.parse(newest.timestamp) >= since && (await sameDigest(newest.planDigest, digest));
  return { digest: newest.planDigest, by: newest.resolvedBy, at: newest.timestamp, holds };
}

/**
 * {@link explainMove} with what yodel can read itself: today's subject (the
 * pending migrations of `ordered` against the history now, unless `now` is
 * given), the history's rows, and git's copies of the migrations' files.
 */
export async function explainAgainst(
  venv: VersionedEnv,
  ordered: readonly Migration[],
  input: { approvedDigest: string; approvedAt?: string | undefined; now?: DigestSubject | undefined; previous?: DigestSubject | undefined },
): Promise<MoveExplanation> {
  const rows = await venv.store.rows({ sync: false });
  const status = compareHistory(ordered, deriveState(rows));
  const now = input.now ?? (await currentSubject(venv, status, status.pending));
  const dir = ordered[0] ? dirname(ordered[0].dir) : undefined;
  return explainMove({
    approvedDigest: input.approvedDigest,
    approvedAt: input.approvedAt,
    now,
    previous: input.previous,
    ordered,
    applied: status.applied,
    rows,
    ...(dir ? { checksums: (id: string) => gitChecksums(dir, id), changedSince: (iso: string) => gitChangesSince(dir, iso) } : {}),
  });
}
