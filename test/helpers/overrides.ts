/**
 * chant's override gate's lines, as `yodel override` records them: the
 * denial of a plan, then the overrides that answer it.
 */

import { OVERRIDE_OP, overrideDigest, overridePending, type AppliedOverrideRecord, type GateResolutionRecord } from "@intentius/chant/override-gate";
import type { OverrideSource } from "../../src/versioned/index.js";

export const DENIED_AT = "2026-10-10T11:00:00.000Z";
export const OVERRIDDEN_AT = "2026-10-10T12:00:00.000Z";

export interface OverrideLine {
  by: string;
  note?: string;
  /** Default {@link OVERRIDDEN_AT}. */
  timestamp?: string;
  /** The plan and rules it overrides; default the denial's. */
  digest?: string;
  rules?: readonly string[];
}

/** An override of `subject`'s plan `digest` denied by `rules`. */
export function overrideLine(subject: string, digest: string, rules: readonly string[], o: Omit<OverrideLine, "digest" | "rules">): GateResolutionRecord {
  return { version: 1, op: OVERRIDE_OP, gate: subject, resolvedBy: o.by, timestamp: o.timestamp ?? OVERRIDDEN_AT, planDigest: overrideDigest(subject, digest, rules), ...(o.note ? { note: o.note } : {}) };
}

/** The ledger with the denial of `digest` by `rules` at `deniedAt`, and `overrides` after it. */
export function overrideSource(subject: string, digest: string, rules: readonly string[], overrides: readonly OverrideLine[] = [], extra: { deniedAt?: string; applied?: AppliedOverrideRecord[] } = {}): OverrideSource {
  return {
    subject,
    ledger: {
      pending: [overridePending({ subject, planDigest: digest, rules, timestamp: extra.deniedAt ?? DENIED_AT, expiresAt: "2026-10-17T00:00:00.000Z" })],
      resolutions: overrides.map((o) => overrideLine(subject, o.digest ?? digest, o.rules ?? rules, o)),
      applied: extra.applied ?? [],
    },
  };
}
