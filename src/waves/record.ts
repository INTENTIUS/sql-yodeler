/** A wave's decision as the history records it (#87). Pure, for ../report/audit.ts. */

/** The pipeline's name, and the op chant records the wave gates under. */
export const WAVES_PIPELINE = "yodel-apply";

/**
 * What a wave's apply records of chant's decision, in each migration's
 * `started` history row (`note.wave`): the gate and the set digest it was
 * let through on, so `yodel report` finds the approval on the wave's gate
 * (`<op>-wave-<k>`) and not the migrations Op's, and knows a wave whose
 * policy at the base needed none.
 */
export interface WaveRecord {
  wave: number;
  /** chant's op the wave gates are recorded under (the spec's name), and the wave's gate. */
  op: string;
  gate: string;
  /** The wave's set digest. */
  digest: string;
  status: "approved" | "not-required";
  /** For `not-required`: the policy and the commit it was read at. */
  policy?: string;
  base?: string;
  /** Which approvals counted (#48), when not `ledger`. */
  approval?: string;
  /** Under `pr-review`, the review that approved the wave: the pull request, the head it approved and its approvers. */
  review?: { pr: number; head: string; approvers: string[] };
  /** Under `sealed`, the signer whose seal verified. */
  signer?: string;
}

/** Reads `note.wave` from a history row's note, or undefined. */
export function waveRecordOf(note: string): WaveRecord | undefined {
  if (!note.startsWith("{")) return undefined;
  try {
    const w = (JSON.parse(note) as { wave?: Partial<WaveRecord> }).wave;
    if (!w || typeof w.gate !== "string" || typeof w.digest !== "string" || typeof w.op !== "string") return undefined;
    if (w.status !== "approved" && w.status !== "not-required") return undefined;
    return w as WaveRecord;
  } catch {
    return undefined;
  }
}
