/**
 * The audit log (#57), derived and never written by hand: every entry comes
 * from a row of an environment's history table or a line of chant's gate
 * ledger (`_gates/<op>.jsonl` on the `chant/lifecycle` branch), so the log
 * cannot say something those two do not. Pure: rows and ledger lines in,
 * entries and gaps out. chant reads the ledger lines (`deriveGateAudit`,
 * `@intentius/chant/lifecycle/gate-audit`); this file joins them with the
 * history.
 *
 * Entries, by where they come from:
 *
 * | kind                 | source                                                        |
 * |----------------------|---------------------------------------------------------------|
 * | `approval-requested` | a pending fact on the ledger: a run stopped at the gate       |
 * | `approved`           | a resolution of the migrations Op's gate                      |
 * | `override`           | a resolution of an `override-<rule>` gate (`yodel override`)  |
 * | `silenced`           | a `-- yodel:allow` silence on a migration's first started row |
 * | `applied`            | the migration row that first recorded a migration succeeded   |
 * | `refused`            | a failed migration row naming a pre-migration check           |
 * | `failed`             | any other failed migration row                                |
 * | `repaired`           | a succeeded migration row after it was applied (`yodel repair`) |
 *
 * Each entry's `id` is a hash of what it says and where it came from, so
 * deriving again from the same sources gives the same ids, and an audit.jsonl
 * written earlier can be checked against the sources now (`./jsonl.ts`).
 *
 * Gaps are what the sources show is missing from themselves:
 *
 * - `history-row`: the history's seqs run from 1 with no hole (every run
 *   appends at the highest seq plus one, under the lock); a hole is a row
 *   that was deleted.
 * - `approval`: a migration applied under a plan digest that the ledger
 *   holds no approval of the environment's gate for. A baseline (`yodel init
 *   --from`, no digest) needs none. A migration a wave of the apply pipeline
 *   applied (#87) was approved on the wave's gate (`<op>-wave-<k>`), for the
 *   wave's set digest its `started` row records (`note.wave`); a wave whose
 *   policy at the base needed no approval records that instead, and needs
 *   none.
 */

import { createHash } from "node:crypto";
import { deriveGateAudit, type GateLedgerLine } from "@intentius/chant/lifecycle/gate-audit";
import type { HistoryRow } from "../history/index.js";
import { waveRecordOf } from "../waves/record.js";
import { describeStep, stepsOfNote } from "../apply-steps/index.js";

export const AUDIT_KINDS = ["approval-requested", "approved", "override", "silenced", "applied", "refused", "failed", "repaired", "reverted", "step"] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

export type AuditSource = { ledger: string; op: string; gate: string } | { history: string; seq: number; run: string };

export interface AuditEntry {
  /** A hash of everything below: the same sources always give the same id. */
  id: string;
  /** When it happened, ISO 8601 UTC: the ledger line's timestamp, or the history row's `recorded_at`. */
  at: string;
  environment: string;
  kind: AuditKind;
  /** Who: the approver, or who ran the apply. */
  by?: string;
  migration?: string;
  /** The plan digest it is about. */
  digest?: string;
  /** The silence, the override's rule and reason, the error, the repair's reason. */
  detail?: string;
  /** `applied` by a wave of the apply pipeline: the wave's gate, its set digest, and whether it was approved or needed no approval. */
  wave?: { gate: string; digest: string; status: "approved" | "not-required" };
  source: AuditSource;
}

export interface AuditGap {
  environment: string;
  kind: "history-row" | "approval";
  detail: string;
}

/** One environment's ledger, as chant's `readGateAuditLedgers` reads it. */
export interface LedgerInput {
  op: string;
  gate: string;
  /** Where the lines are, for the entries' source: `_gates/<op>.jsonl`. */
  path: string;
  lines: readonly GateLedgerLine[];
}

/** The apply pipeline's wave gates on the ledger (`_gates/<op>.jsonl` of the waves' op). */
export interface WaveLedgerInput {
  op: string;
  path: string;
  /** The wave gate yodel.config.ts gives the environment now, if any; the gates its history's waves recorded are read too. */
  gate?: string | undefined;
  lines: readonly GateLedgerLine[];
}

export interface AuditInput {
  environment: string;
  /** `<database>.history`, for the entries' source. */
  history: string;
  rows: readonly HistoryRow[];
  /** Absent when the environment has no migrations Op to read the ledger of. */
  ledger?: LedgerInput | undefined;
  /** The waves' gate ledger, when the project's apply pipeline runs waves. */
  waves?: WaveLedgerInput | undefined;
  /** Whether two digests are the same plan (chant's samePlanDigest). Default: equal strings. */
  sameDigest?: (a: string | undefined, b: string | undefined) => boolean;
}

/** `2026-10-10 09:12:44.123456` (the history's UTC) as ISO 8601. An ISO time is returned as it is. */
export function isoTime(t: string): string {
  if (!t) return "";
  if (/T.*(Z|[+-]\d\d:?\d\d)$/.test(t)) return t;
  return `${t.replace(" ", "T")}Z`;
}

/** A key that orders ISO times written to the millisecond (the ledger) and the microsecond (the history) together. */
export function timeKey(t: string): string {
  const m = /^(.*?)(?:\.(\d+))?Z$/.exec(t);
  return m ? `${m[1] ?? ""}.${(m[2] ?? "").padEnd(6, "0")}Z` : t;
}

/** Oldest first. */
export const byTime = (a: { at: string }, b: { at: string }): number => {
  const x = timeKey(a.at);
  const y = timeKey(b.at);
  return x < y ? -1 : x > y ? 1 : 0;
};

function entry(fields: Omit<AuditEntry, "id">): AuditEntry {
  // An entry with no wave hashes as it did before waves were recorded, so audit files written then still match.
  const key = JSON.stringify([fields.environment, fields.kind, fields.at, fields.by ?? "", fields.migration ?? "", fields.digest ?? "", fields.detail ?? "", fields.source, ...(fields.wave ? [fields.wave] : [])]);
  return { id: `sha256:${createHash("sha256").update(key).digest("hex").slice(0, 24)}`, ...fields };
}

const CHECK_FAILED = /\bcheck \S+ failed\b/;

function fromHistory(input: AuditInput): AuditEntry[] {
  const { environment, history } = input;
  const out: AuditEntry[] = [];
  const applied = new Set<string>();
  const silenced = new Set<string>();
  /** Each migration's wave, from its latest started row. */
  const waveOf = new Map<string, AuditEntry["wave"]>();
  /** The steps around apply (#64) a run recorded: the before steps are on every migration's started row of the run, listed once. */
  const stepsSeen = new Set<string>();
  const steps = (r: HistoryRow, at: Omit<AuditEntry, "id" | "kind">) => {
    for (const o of stepsOfNote(r.note)) {
      const key = `${r.run_id}\u0000${o.when}\u0000${o.name}`;
      if (stepsSeen.has(key)) continue;
      stepsSeen.add(key);
      // A before step is the run's, not one migration's; an after step ran after the last.
      out.push(entry({ at: at.at, environment: at.environment, ...(at.by ? { by: at.by } : {}), ...(o.when === "after" ? { migration: r.migration_id } : {}), source: at.source, kind: "step", detail: describeStep(o) }));
    }
  };
  for (const r of [...input.rows].sort((a, b) => a.seq - b.seq)) {
    if (r.kind !== "migration") continue;
    const source: AuditSource = { history, seq: r.seq, run: r.run_id };
    const base = { at: isoTime(r.recorded_at ?? ""), environment, by: r.applied_by, migration: r.migration_id, ...(r.plan_digest ? { digest: r.plan_digest } : {}), source };
    if (r.status === "started") {
      steps(r, base);
      const w = waveRecordOf(r.note);
      if (w) waveOf.set(r.migration_id, { gate: w.gate, digest: w.digest, status: w.status });
      else waveOf.delete(r.migration_id);
      let list: Array<{ step?: number; rule?: string; reason?: string }> = [];
      try {
        list = JSON.parse(r.silences || "[]") as typeof list;
      } catch {
        list = [];
      }
      for (const s of list) {
        const key = `${r.migration_id}\u0000${String(s.step)}\u0000${s.rule ?? ""}\u0000${s.reason ?? ""}`;
        if (silenced.has(key)) continue;
        silenced.add(key);
        out.push(entry({ ...base, kind: "silenced", detail: `step ${String(s.step)}: ${s.rule ?? ""} ${s.reason ?? ""}`.trim() }));
      }
    } else if (r.status === "reverted") {
      // yodel revert (#55): applied again later, it is applied, not repaired.
      applied.delete(r.migration_id);
      out.push(entry({ ...base, kind: "reverted", ...(r.note ? { detail: r.note } : {}) }));
    } else if (r.status === "succeeded") {
      // The after steps' outcomes are entries of their own, not the applied entry's detail.
      const note = stepsOfNote(r.note).length > 0 ? "" : r.note;
      if (applied.has(r.migration_id)) out.push(entry({ ...base, kind: "repaired", detail: note || `checksum ${r.checksum}` }));
      else {
        applied.add(r.migration_id);
        const wave = waveOf.get(r.migration_id);
        out.push(entry({ ...base, kind: "applied", ...(note ? { detail: note } : {}), ...(wave ? { wave } : {}) }));
      }
      steps(r, base);
    } else {
      out.push(entry({ ...base, kind: CHECK_FAILED.test(r.error) ? "refused" : "failed", detail: r.error }));
    }
  }
  return out;
}

/**
 * The entries of `l`'s lines about `gates`, as chant's reader gives them:
 * requests and approvals, and with `overrides` the `override-<rule>`
 * resolutions (`yodel override`).
 */
function fromLedger(environment: string, l: { op: string; path: string; lines: readonly GateLedgerLine[] }, gates: ReadonlySet<string>, overrides: boolean): AuditEntry[] {
  const out: AuditEntry[] = [];
  for (const e of deriveGateAudit({ ledgers: [{ op: l.op, path: l.path, lines: l.lines }] }).entries) {
    const source: AuditSource = { ledger: l.path, op: l.op, gate: e.gate };
    const digest = e.digest ? { digest: e.digest } : {};
    if (e.kind === "approval-requested" && gates.has(e.gate)) {
      out.push(entry({ at: e.at, environment, kind: "approval-requested", ...digest, ...(e.runId ? { detail: `run ${e.runId}` } : {}), source }));
    } else if (e.kind === "approved" && gates.has(e.gate)) {
      out.push(entry({ at: e.at, environment, kind: "approved", ...(e.by ? { by: e.by } : {}), ...digest, ...(e.note ? { detail: e.note } : {}), source }));
    } else if (overrides && e.kind === "override-recorded" && e.gate.startsWith("override-")) {
      out.push(entry({ at: e.at, environment, kind: "override", ...(e.by ? { by: e.by } : {}), ...digest, detail: `${e.gate.slice("override-".length)}: ${e.note ?? ""}`.trim(), source }));
    }
  }
  return out;
}

/** The wave gates' lines that are this environment's: its configured wave gate, and every gate its history's waves recorded. */
function fromWaves(environment: string, w: WaveLedgerInput, history: readonly AuditEntry[]): AuditEntry[] {
  const gates = new Set([...(w.gate ? [w.gate] : []), ...history.flatMap((e) => (e.wave ? [e.wave.gate] : []))]);
  return fromLedger(environment, w, gates, false);
}

/**
 * The approval an `applied` entry was let through by, among `entries`: on
 * the wave's gate for the wave's set digest when a wave applied it, else
 * on the migrations gate for its plan digest. Undefined when none is there.
 */
export function approvalOf(applied: AuditEntry, entries: readonly AuditEntry[], same: (a: string | undefined, b: string | undefined) => boolean = (a, b) => a === b): AuditEntry | undefined {
  const approvals = entries.filter((e) => e.kind === "approved" && e.environment === applied.environment);
  const wave = applied.wave;
  if (wave) return approvals.filter((x) => "ledger" in x.source && x.source.gate === wave.gate && same(x.digest, wave.digest)).at(-1);
  return approvals.filter((x) => same(x.digest, applied.digest)).at(-1);
}

/** The entries one environment's history and ledger add up to, oldest first, and the gaps they show. */
export function deriveAudit(input: AuditInput): { entries: AuditEntry[]; gaps: AuditGap[] } {
  const same = input.sameDigest ?? ((a, b) => a === b);
  const history = fromHistory(input);
  const entries = [...history, ...(input.ledger ? fromLedger(input.environment, input.ledger, new Set([input.ledger.gate]), true) : []), ...(input.waves ? fromWaves(input.environment, input.waves, history) : [])].sort(byTime);
  const gaps: AuditGap[] = [];

  const seqs = new Set(input.rows.map((r) => r.seq));
  const max = Math.max(0, ...seqs);
  const missing: number[] = [];
  for (let s = 1; s <= max; s++) if (!seqs.has(s)) missing.push(s);
  if (missing.length > 0) {
    gaps.push({ environment: input.environment, kind: "history-row", detail: `${input.history} has no row with seq ${missing.join(", ")} of 1..${String(max)}: rows are only ever appended, so ${missing.length === 1 ? "that row was" : "those rows were"} deleted` });
  }

  for (const a of entries.filter((e) => (e.kind === "applied" || e.kind === "reverted") && e.digest)) {
    const seq = "history" in a.source ? a.source.seq : 0;
    const wave = a.wave;
    if (wave) {
      // A wave's policy at the base let it through with no approval; the run checked that under the lock.
      if (wave.status === "not-required" || !input.waves || approvalOf(a, entries, same)) continue;
      gaps.push({
        environment: input.environment,
        kind: "approval",
        detail: `${String(a.migration)} was applied by a wave under ${wave.digest} (${input.history} seq ${String(seq)}), but ${input.waves.path} holds no approval of ${input.waves.op} / ${wave.gate} for that digest`,
      });
      continue;
    }
    if (!input.ledger || approvalOf(a, entries, same)) continue;
    gaps.push({
      environment: input.environment,
      kind: "approval",
      detail: `${String(a.migration)} was ${a.kind} under ${String(a.digest)} (${input.history} seq ${String(seq)}), but ${input.ledger.path} holds no approval of ${input.ledger.op} / ${input.ledger.gate} for that digest`,
    });
  }
  return { entries, gaps };
}
