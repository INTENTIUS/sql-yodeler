/** The versioned status as text and as JSON, for `yodel status` and `yodel apply --plan`. */

import type { SqlDialect } from "../project.js";
import { describeTopology, type HistoryLocation } from "../history/index.js";
import { describeStep } from "../steps/index.js";
import { describeServer, type ServerInfo } from "../server.js";
import { outOfOrder, partWay, type VersionedStatus } from "./state.js";

export interface StatusReport {
  environment: string;
  /** The server the history was read from (#11). */
  server?: ServerInfo | undefined;
  /** Postgres has no topology: its report leaves it out. Default ClickHouse. */
  dialect?: SqlDialect | undefined;
  location: HistoryLocation;
  /** The topology statements are rendered for, and where it came from: `cluster:main (yodel.config.ts)`. Default: the history's. */
  topology?: string | undefined;
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
    ...(r.server ? { server: r.server } : {}),
    ...(r.dialect === "postgres"
      ? { history: { database: r.location.database } }
      : { history: { database: r.location.database, topology: describeTopology(r.location.topology) }, topology: r.topology ?? describeTopology(r.location.topology) }),
    applied: status.applied.map((a) => ({
      id: a.id,
      checksum: a.checksum,
      appliedBy: a.appliedBy,
      recordedAt: a.recordedAt,
      planDigest: a.planDigest,
      inDirectory: a.index !== undefined,
      ...(a.repairs ? { repairs: a.repairs.map((r) => ({ checksum: r.checksum, by: r.by, at: r.at, reason: r.reason })) } : {}),
    })),
    pending: status.pending.map((p) => ({
      id: p.id,
      checksum: p.checksum,
      outOfOrder: p.outOfOrder,
      partWay: p.partWay ?? null,
      ...(p.reverted ? { reverted: p.reverted } : {}),
      opSteps: p.opSteps.map(({ index, step }) => ({ index, kind: step.kind, object: step.object, name: step.name, ...(step.kind === "op" ? { op: step.op } : {}) })),
      refusedSteps: p.refusedSteps.map(({ index, step, reason }) => ({ index, kind: step.kind, object: step.object, name: step.name, ...(step.kind === "op" ? { op: step.op } : {}), reason })),
    })),
    outOfOrder: outOfOrder(status).map((p) => p.id),
    partWay: partWay(status).map((p) => ({ id: p.id, resumeAt: p.partWay?.resumeAt, failedStatement: p.partWay?.failedStatement ?? null })),
    mismatches: status.mismatches,
    ...(status.skipped ? { skipped: status.skipped } : {}),
    ...(r.digest ? { planDigest: r.digest } : {}),
    ...(r.refusal ? { refusal: r.refusal } : {}),
  };
}

export function renderStatus(r: StatusReport): string {
  const { status } = r;
  const topology = r.dialect === "postgres" ? "" : `, topology ${r.topology ?? describeTopology(r.location.topology)}`;
  const server = r.server ? `${describeServer(r.server)}, ` : "";
  const lines = [`Migrations in ${r.environment} (${server}history ${r.location.database}.history${topology})`, ""];
  lines.push(status.applied.length === 0 ? "Applied: none" : `Applied (${String(status.applied.length)}):`);
  for (const a of status.applied) {
    lines.push(`  ${a.id}${a.index === undefined ? "  (not in the directory)" : ""}  ${a.recordedAt} by ${a.appliedBy}`);
    for (const r of a.repairs ?? []) lines.push(`      repaired ${r.at} by ${r.by}: ${r.reason}`);
  }
  lines.push("", status.pending.length === 0 ? "Pending: none" : `Pending (${String(status.pending.length)}):`);
  for (const p of status.pending) {
    const marks: string[] = [];
    if (p.outOfOrder) marks.push("out of order");
    if (p.reverted) marks.push(`reverted ${p.reverted.at} by ${p.reverted.by}`);
    if (p.partWay) {
      const pw = p.partWay;
      marks.push(
        pw.status === "failed"
          ? `failed part way at statement ${String(pw.failedStatement ?? pw.resumeAt)}; resumes at statement ${String(pw.resumeAt)}`
          : `stopped part way; resumes at statement ${String(pw.resumeAt)}`,
      );
      if (pw.edited) marks.push("edited since; the statements that ran are unchanged");
    }
    if (p.opSteps.length > 0) marks.push(p.opSteps.map(({ index, step }) => `step ${String(index)}: ${describeStep(step)}`).join(", "));
    if (p.refusedSteps.length > 0) marks.push(`${String(p.refusedSteps.length)} step(s) yodel apply does not run`);
    lines.push(`  ${p.id}${marks.length > 0 ? `  (${marks.join("; ")})` : ""}`);
    if (p.partWay?.error) lines.push(`      error: ${p.partWay.error.split("\n")[0] ?? ""}`);
  }
  if (status.skipped) {
    lines.push("", `Skipped (${String(status.skipped.length)}), never run here:`);
    for (const k of status.skipped) lines.push(`  ${k.id}  (${k.reason === "covered" ? `before ${k.checkpoint ?? "the checkpoint"}, the checkpoint this environment starts from` : "a checkpoint; this environment ran the migrations it creates"})`);
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
