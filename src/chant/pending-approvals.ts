/**
 * chant's `pendingApprovals` (chant#5480): what waits for approval in an
 * environment, across Op waves, pipeline stages, components and the Op
 * ledgers named in `ops`. yodel approve asks it where a `--plan` waits.
 *
 * It exists from chant {@link PENDING_APPROVALS_FLOOR}. The module is
 * imported by a name the compiler does not resolve, so yodel builds against
 * an older chant too; {@link loadPendingApprovals} is undefined there, and
 * yodel approve searches the gates it lists itself.
 */

/** The first chant with the call: `PENDING_APPROVALS_FLOOR` in `@intentius/chant/lifecycle/pending-approvals`. */
export const PENDING_APPROVALS_FLOOR = "0.124.117";

/** One standing fact, the parts yodel reads of chant's `PendingApproval`. */
export interface PendingApproval {
  kind: "wave" | "stage" | "component" | "op";
  op: string;
  gate: string;
  digest?: string;
  environment?: string;
  releaseDigest?: string;
  changeSet?: string;
  matched?: "planDigest" | "changeSet" | "releaseDigest";
  description?: string;
  timestamp: string;
  expiresAt: string;
}

/** What chant's `pendingApprovals` takes, the parts yodel passes. */
export interface PendingApprovalsInput {
  cwd: string;
  env: string;
  plan?: string;
  ops?: readonly string[];
  pipeline?: string | null;
}

/** chant's `pendingApprovals`. */
export type PendingApprovalsFn = (input: PendingApprovalsInput) => Promise<PendingApproval[]>;

/** The installed chant's `pendingApprovals`, or undefined below the floor. */
export async function loadPendingApprovals(): Promise<PendingApprovalsFn | undefined> {
  const name = "@intentius/chant/lifecycle/pending-approvals";
  try {
    const mod = (await import(/* @vite-ignore */ name)) as { PENDING_APPROVALS_FLOOR?: unknown; pendingApprovals?: PendingApprovalsFn };
    return "PENDING_APPROVALS_FLOOR" in mod && typeof mod.pendingApprovals === "function" ? mod.pendingApprovals : undefined;
  } catch {
    return undefined;
  }
}
