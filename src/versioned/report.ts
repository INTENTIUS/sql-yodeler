/** The versioned status as text and as JSON, for `yodel status` and `yodel apply --plan`. */

import { describeTopology, type HistoryLocation } from "../history/index.js";
import { outOfOrder, partWay, type VersionedStatus } from "./state.js";

export interface StatusReport {
  environment: string;
  location: HistoryLocation;
  status: VersionedStatus;
  /** The digest `yodel apply` would ask approval for, when it would not refuse. */
  digest?: string | undefined;
  /** Why `yodel apply` would refuse, with its exit code. */
  refusal?: { exitCode: number; message: string } | undefined;
}

export function statusJson(r: StatusReport): Record<string, unknown> {
  const { status } = r;
  return {
    environment: r.environment,
    history: { database: r.location.database, topology: describeTopology(r.location.topology) },
    applied: status.applied.map((a) => ({ id: a.id, checksum: a.checksum, appliedBy: a.appliedBy, recordedAt: a.recordedAt, planDigest: a.planDigest, inDirectory: a.index !== undefined })),
    pending: status.pending.map((p) => ({
      id: p.id,
      checksum: p.checksum,
      outOfOrder: p.outOfOrder,
      partWay: p.partWay ?? null,
      refusedSteps: p.refusedSteps.map(({ index, step }) => ({ index, kind: step.kind, object: step.object, name: step.name, ...(step.kind === "op" ? { op: step.op } : {}) })),
    })),
    outOfOrder: outOfOrder(status).map((p) => p.id),
    partWay: partWay(status).map((p) => ({ id: p.id, resumeAt: p.partWay?.resumeAt, failedStatement: p.partWay?.failedStatement ?? null })),
    mismatches: status.mismatches,
    ...(r.digest ? { planDigest: r.digest } : {}),
    ...(r.refusal ? { refusal: r.refusal } : {}),
  };
}

export function renderStatus(r: StatusReport): string {
  const { status } = r;
  const lines = [`Migrations in ${r.environment} (history ${r.location.database}.history, topology ${describeTopology(r.location.topology)})`, ""];
  lines.push(status.applied.length === 0 ? "Applied: none" : `Applied (${String(status.applied.length)}):`);
  for (const a of status.applied) lines.push(`  ${a.id}${a.index === undefined ? "  (not in the directory)" : ""}  ${a.recordedAt} by ${a.appliedBy}`);
  lines.push("", status.pending.length === 0 ? "Pending: none" : `Pending (${String(status.pending.length)}):`);
  for (const p of status.pending) {
    const marks: string[] = [];
    if (p.outOfOrder) marks.push("out of order");
    if (p.partWay) {
      const pw = p.partWay;
      marks.push(
        pw.status === "failed"
          ? `failed part way at statement ${String(pw.failedStatement ?? pw.resumeAt)}; resumes at statement ${String(pw.resumeAt)}`
          : `stopped part way; resumes at statement ${String(pw.resumeAt)}`,
      );
      if (pw.edited) marks.push("edited since; the statements that ran are unchanged");
    }
    if (p.refusedSteps.length > 0) marks.push(`${String(p.refusedSteps.length)} Op or manual step(s), not run yet (#12)`);
    lines.push(`  ${p.id}${marks.length > 0 ? `  (${marks.join("; ")})` : ""}`);
    if (p.partWay?.error) lines.push(`      error: ${p.partWay.error.split("\n")[0] ?? ""}`);
  }
  const late = outOfOrder(status);
  if (late.length > 0) lines.push("", `Out of order (${String(late.length)}): ${late.map((p) => p.id).join(", ")}; apply with --allow-out-of-order`);
  if (status.mismatches.length > 0) {
    lines.push("", `Checksum mismatches (${String(status.mismatches.length)}):`);
    for (const m of status.mismatches) lines.push(`  ${m.message}`);
  }
  if (r.digest) lines.push("", `Plan digest: ${r.digest}`);
  if (r.refusal) lines.push("", r.refusal.message);
  return `${lines.join("\n")}\n`;
}
