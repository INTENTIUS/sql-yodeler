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
 * A gate with a quorum is counted here by chant's own tally (`tallyGateApprovals`)
 * under the quorum the workspace declaration sets at the base commit
 * (`identity.gates.<gate>.quorum`, chant#4324), never the Op's own. A quorum
 * only the Op declares, and a policy, are refused: `--execute` fails closed
 * rather than count what the change itself can edit or approximate a policy.
 */

import type { GateLedgerPort } from "@intentius/chant/op/gate";
import type { GateResolutionRecord } from "@intentius/chant/lifecycle/gate-ledger";
import type { ReleaseAdmission } from "@intentius/chant/lifecycle/release-ledger";
import { YodelError } from "../project.js";
import type { MigrateOpRef } from "./op.js";

const EPOCH = new Date(0).toISOString();

/** Exit code of a refusal for want of an approval: the same as a run stopped at the gate. */
export const NOT_APPROVED = 3;

/** What {@link verifyApproval} found: the approval that counted, and what the release record says of it (#277). */
export interface VerifiedApproval {
  resolvedBy: string;
  timestamp: string;
  review?: { pr: number; head: string; approvers: string[] };
  signer?: string;
  /** Every approver of the plan that counted, comma joined, from chant's `admissionOf`: the release record's `approver`. */
  approver: string;
  /** The resolution that admitted the apply (`{ op, gate, resolvedAt }`, chant#4020): the release record's `admission`. */
  admission: ReleaseAdmission;
}

/**
 * Throws unless the ledger holds an approval of `op`'s gate for `digest`. Returns who approved it.
 *
 * A gate whose workspace declaration at base sets `identity.gates.<gate>.quorum`
 * (chant#4324) is counted by chant's own tally under those rules: distinct
 * humans, roles from `.chant/trust.json` at base, none of it from the Op being
 * run. A quorum the Op alone declares is refused, since the Op is part of the
 * change; so is a policy, which only the gate step evaluates.
 */
export async function verifyApproval(port: GateLedgerPort, op: MigrateOpRef, digest: string): Promise<VerifiedApproval> {
  if (op.policy) {
    throw new YodelError(`--execute cannot check gate "${op.gate}" of ${op.name}: it declares an approval policy, which only the gate step evaluates; run yodel apply without --execute`, NOT_APPROVED);
  }
  const { latestPendingGate, latestResolutionForPlan } = await import("@intentius/chant/lifecycle/gate-ledger");
  const ledger = await port.read(op.name);
  const rule = (await port.approvalRule?.(op.gate)) ?? null;
  // The quorum at base (chant#4324), the only one counted: the Op's own is the change's to edit.
  const atBase = rule?.requirement.quorum ?? undefined;
  if (op.quorum && atBase === undefined) {
    throw new YodelError(
      `--execute cannot check gate "${op.gate}" of ${op.name}: its approval quorum is declared only in the Op, which this change can edit, and the workspace declaration at the base commit sets none; ` +
        `declare it as identity.gates.${op.gate}.quorum in chant.workspace.json on the base branch, or run yodel apply without --execute`,
      NOT_APPROVED,
    );
  }
  const declared = (from: { op: string; gate: string }) => (op.aliases ?? []).some((a) => a.op === from.op && a.gate === from.gate);
  const listed = ledger.resolutions.filter((r) => r.gate !== op.gate || r.carriedFrom === undefined || declared(r.carriedFrom));
  const resolutions = listed.filter((r) => r.gate !== op.gate || rule === null || rule.refuses(r) === null);
  const standing = latestPendingGate(ledger.pending, op.gate);
  const since = standing?.timestamp ?? EPOCH;
  let found: { resolution?: GateResolutionRecord | undefined; mismatched?: GateResolutionRecord | undefined };
  // The approvals that counted toward the gate: one, or the quorum's.
  let counted: GateResolutionRecord[];
  let waiting = "";
  if (atBase !== undefined) {
    const { tallyGateApprovals, humanQuorumSince } = await import("@intentius/chant/op/gate");
    const { quorumRules, quorumRulesFor, quorumWaiting, UNPROVEN_JUDGE } = await import("@intentius/chant/op/gate-quorum");
    const { samePlanDigest } = await import("@intentius/chant/lifecycle/plan-digest");
    // As chant's gate step reads it: the rules this run takes (the Op runs with no environment, so a rule with `targets` does not cover it), and who an approval proves.
    const rules = quorumRulesFor(quorumRules(atBase), []);
    const judge = (await port.quorumJudge?.(op.gate)) ?? UNPROVEN_JUDGE;
    const humansSince = standing && samePlanDigest(standing.planDigest, digest) ? humanQuorumSince(ledger.pending, standing) : since;
    const tally = tallyGateApprovals(resolutions, op.gate, since, digest, { ...(rules.length > 0 ? { quorum: rules } : {}), mode: "log-only" }, humansSince, judge);
    found = { resolution: tally.met ? tally.counted[tally.counted.length - 1] : undefined, mismatched: tally.mismatched };
    counted = tally.counted;
    waiting = tally.met || !tally.rules ? "" : ` (the quorum at base is not met: ${quorumWaiting(tally.rules)})`;
  } else {
    found = latestResolutionForPlan(resolutions, op.gate, since, digest);
    counted = resolutions.filter((x) => x.gate === op.gate && Date.parse(x.timestamp) >= Date.parse(since));
  }
  const r = found.resolution;
  if (r) {
    // The release record's approver and admission come from chant's admissionOf, over the approvals that count here, bound to the digest of the one found.
    const { admissionOf } = await import("@intentius/chant/lifecycle/release-ledger");
    const admitted = admissionOf(counted, { op: op.name, gate: op.gate, ...(r.planDigest !== undefined ? { planDigest: r.planDigest } : {}) }) ?? {
      approver: r.resolvedBy,
      admission: { op: op.name, gate: op.gate, resolvedAt: r.timestamp },
    };
    return { resolvedBy: r.resolvedBy, timestamp: r.timestamp, ...(r.review ? { review: r.review } : {}), ...(r.seal ? { signer: r.seal.signer } : {}), ...admitted };
  }
  // An approval of this digest the gate's rule does not count (#48: one not sealed by a signer at base), and why.
  const uncounted = rule === null ? undefined : latestResolutionForPlan(listed, op.gate, since, digest).resolution;
  const why = uncounted ? rule?.refuses(uncounted) : null;
  const other = waiting !== ""
    ? waiting
    : why
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
