/**
 * The audit log (#57), derived and never written by hand: every entry comes
 * from a row of an environment's history table or a line of chant's gate
 * ledger (`_gates/<op>.jsonl` on the `chant/lifecycle` branch), so the log
 * cannot say something those two do not. Pure: rows and ledger lines in,
 * entries and gaps out.
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
 *   --from`, no digest) needs none.
 */

import { createHash } from "node:crypto";
import type { HistoryRow } from "../history/index.js";

export const AUDIT_KINDS = ["approval-requested", "approved", "override", "silenced", "applied", "refused", "failed", "repaired"] as const;
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
  source: AuditSource;
}

export interface AuditGap {
  environment: string;
  kind: "history-row" | "approval";
  detail: string;
}

/** One environment's ledger, as chant's GateLedgerPort reads it. */
export interface LedgerInput {
  op: string;
  gate: string;
  /** Where the lines are, for the entries' source: `_gates/<op>.jsonl`. */
  path: string;
  pending: ReadonlyArray<{ gate: string; timestamp: string; planDigest?: string | undefined; runId?: string | undefined }>;
  resolutions: ReadonlyArray<{ gate: string; timestamp: string; resolvedBy: string; planDigest?: string | undefined; note?: string | undefined }>;
}

export interface AuditInput {
  environment: string;
  /** `<database>.history`, for the entries' source. */
  history: string;
  rows: readonly HistoryRow[];
  /** Absent when the environment has no migrations Op to read the ledger of. */
  ledger?: LedgerInput | undefined;
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
  const key = JSON.stringify([fields.environment, fields.kind, fields.at, fields.by ?? "", fields.migration ?? "", fields.digest ?? "", fields.detail ?? "", fields.source]);
  return { id: `sha256:${createHash("sha256").update(key).digest("hex").slice(0, 24)}`, ...fields };
}

const CHECK_FAILED = /\bcheck \S+ failed\b/;

function fromHistory(input: AuditInput): AuditEntry[] {
  const { environment, history } = input;
  const out: AuditEntry[] = [];
  const applied = new Set<string>();
  const silenced = new Set<string>();
  for (const r of [...input.rows].sort((a, b) => a.seq - b.seq)) {
    if (r.kind !== "migration") continue;
    const source: AuditSource = { history, seq: r.seq, run: r.run_id };
    const base = { at: isoTime(r.recorded_at ?? ""), environment, by: r.applied_by, migration: r.migration_id, ...(r.plan_digest ? { digest: r.plan_digest } : {}), source };
    if (r.status === "started") {
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
    } else if (r.status === "succeeded") {
      if (applied.has(r.migration_id)) out.push(entry({ ...base, kind: "repaired", detail: r.note || `checksum ${r.checksum}` }));
      else {
        applied.add(r.migration_id);
        out.push(entry({ ...base, kind: "applied", ...(r.note ? { detail: r.note } : {}) }));
      }
    } else {
      out.push(entry({ ...base, kind: CHECK_FAILED.test(r.error) ? "refused" : "failed", detail: r.error }));
    }
  }
  return out;
}

function fromLedger(environment: string, l: LedgerInput): AuditEntry[] {
  const out: AuditEntry[] = [];
  const source: AuditSource = { ledger: l.path, op: l.op, gate: l.gate };
  for (const p of l.pending) {
    if (p.gate !== l.gate) continue;
    out.push(entry({ at: p.timestamp, environment, kind: "approval-requested", ...(p.planDigest ? { digest: p.planDigest } : {}), ...(p.runId ? { detail: `run ${p.runId}` } : {}), source }));
  }
  for (const r of l.resolutions) {
    const override = r.gate.startsWith("override-");
    if (!override && r.gate !== l.gate) continue;
    out.push(
      entry({
        at: r.timestamp,
        environment,
        kind: override ? "override" : "approved",
        by: r.resolvedBy,
        ...(r.planDigest ? { digest: r.planDigest } : {}),
        ...(override ? { detail: `${r.gate.slice("override-".length)}: ${r.note ?? ""}`.trim() } : r.note ? { detail: r.note } : {}),
        source: { ...source, gate: r.gate },
      }),
    );
  }
  return out;
}

/** The entries one environment's history and ledger add up to, oldest first, and the gaps they show. */
export function deriveAudit(input: AuditInput): { entries: AuditEntry[]; gaps: AuditGap[] } {
  const same = input.sameDigest ?? ((a, b) => a === b);
  const entries = [...fromHistory(input), ...(input.ledger ? fromLedger(input.environment, input.ledger) : [])].sort(byTime);
  const gaps: AuditGap[] = [];

  const seqs = new Set(input.rows.map((r) => r.seq));
  const max = Math.max(0, ...seqs);
  const missing: number[] = [];
  for (let s = 1; s <= max; s++) if (!seqs.has(s)) missing.push(s);
  if (missing.length > 0) {
    gaps.push({ environment: input.environment, kind: "history-row", detail: `${input.history} has no row with seq ${missing.join(", ")} of 1..${String(max)}: rows are only ever appended, so ${missing.length === 1 ? "that row was" : "those rows were"} deleted` });
  }

  if (input.ledger) {
    const approvals = entries.filter((e) => e.kind === "approved");
    for (const a of entries.filter((e) => e.kind === "applied" && e.digest)) {
      if (approvals.some((x) => same(x.digest, a.digest))) continue;
      const seq = "history" in a.source ? a.source.seq : 0;
      gaps.push({
        environment: input.environment,
        kind: "approval",
        detail: `${String(a.migration)} was applied under ${String(a.digest)} (${input.history} seq ${String(seq)}), but ${input.ledger.path} holds no approval of ${input.ledger.op} / ${input.ledger.gate} for that digest`,
      });
    }
  }
  return { entries, gaps };
}
