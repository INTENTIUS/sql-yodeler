/**
 * The approval check `yodel apply <env> --execute` makes itself, against
 * chant's gate ledger, before it sends anything.
 *
 * `YODEL_APPROVED_PLAN` is how the Op hands the digest to the Apply step, but
 * it is never enough on its own: anyone can set an environment variable.
 * `--execute` reads the ledger the gate step reads (the `chant/lifecycle`
 * branch, through chant's `gitGateLedgerPort`) for the environment's
 * migrations Op, and requires an approval of its gate for exactly the digest
 * it computes under the lock, by the rule chant's gate applies
 * (`evaluateGate`):
 *
 * - the resolution is for this gate and for this plan digest
 *   (`latestResolutionForPlan`; one recorded before plan-bound gates never
 *   counts);
 * - it is newer than the newest pending fact for the gate, so an approval
 *   from before the gate last asked does not answer it;
 * - the workspace's approval rule for the gate (`identity.gates`), when one
 *   applies, accepts it;
 * - one the gate step carried from an alias (`carriedFrom`, chant#3949)
 *   counts only while the gate still lists that alias, as chant's gate reads
 *   it (`op/gate.ts:815` in chant 0.124.46).
 *
 * A gate with a quorum or policy (`approval`) is refused here: counting a
 * quorum is the gate step's, and `--execute` fails closed rather than
 * approximate it.
 */

import type { GateLedgerPort } from "@intentius/chant/op/gate";
import { YodelError } from "../project.js";
import type { MigrateOpRef } from "./op.js";

const EPOCH = new Date(0).toISOString();

/** Exit code of a refusal for want of an approval: the same as a run stopped at the gate. */
export const NOT_APPROVED = 3;

/** Throws unless the ledger holds an approval of `op`'s gate for `digest`. Returns who approved it. */
export async function verifyApproval(port: GateLedgerPort, op: MigrateOpRef, digest: string): Promise<{ resolvedBy: string; timestamp: string; review?: { pr: number; head: string; approvers: string[] }; signer?: string }> {
  if (op.quorum) {
    throw new YodelError(`--execute cannot check gate "${op.gate}" of ${op.name}: it declares an approval quorum or policy, which only the gate step counts; run yodel apply without --execute`, NOT_APPROVED);
  }
  const { latestPendingGate, latestResolutionForPlan } = await import("@intentius/chant/lifecycle/gate-ledger");
  const ledger = await port.read(op.name);
  const rule = (await port.approvalRule?.(op.gate)) ?? null;
  const declared = (from: { op: string; gate: string }) => (op.aliases ?? []).some((a) => a.op === from.op && a.gate === from.gate);
  const listed = ledger.resolutions.filter((r) => r.gate !== op.gate || r.carriedFrom === undefined || declared(r.carriedFrom));
  const resolutions = listed.filter((r) => r.gate !== op.gate || rule === null || rule.refuses(r) === null);
  const since = latestPendingGate(ledger.pending, op.gate)?.timestamp ?? EPOCH;
  const found = latestResolutionForPlan(resolutions, op.gate, since, digest);
  const r = found.resolution;
  if (r) return { resolvedBy: r.resolvedBy, timestamp: r.timestamp, ...(r.review ? { review: r.review } : {}), ...(r.seal ? { signer: r.seal.signer } : {}) };
  // An approval of this digest the gate's rule does not count (#48: one not sealed by a signer at base), and why.
  const uncounted = rule === null ? undefined : latestResolutionForPlan(listed, op.gate, since, digest).resolution;
  const why = uncounted ? rule?.refuses(uncounted) : null;
  const other = why
    ? ` (the approval by ${uncounted?.resolvedBy ?? "?"} at ${uncounted?.timestamp ?? "?"} does not count: ${why})`
    : found.mismatched
      ? ` (the newest approval of that gate is for ${found.mismatched.planDigest ?? "no plan"}, by ${found.mismatched.resolvedBy} at ${found.mismatched.timestamp})`
      : "";
  throw new YodelError(
    `refused: chant's gate ledger holds no approval of ${op.name} / ${op.gate} for plan ${digest}${other}. Nothing was applied. ` +
      `Run yodel apply without --execute; it stops at the gate and prints the command that approves its plan.`,
    NOT_APPROVED,
  );
}

/** The ledger as the gate step reads it, in the project's checkout. */
export async function gitLedger(cwd: string): Promise<GateLedgerPort> {
  const { gitGateLedgerPort } = await import("@intentius/chant/op/gate");
  return gitGateLedgerPort({ cwd });
}
