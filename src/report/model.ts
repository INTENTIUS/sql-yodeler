/**
 * `yodel report` (#57): every environment's migrations side by side, the
 * audit log derived from each environment's history and chant's gate ledger
 * (`./audit.ts`), and the gaps those sources show. Read only: it takes no
 * lock and writes nothing to a server or the ledger.
 */

import type { GateLedgerPort } from "@intentius/chant/op/gate";
import { deriveState, type HistoryRow } from "../history/index.js";
import type { Migration } from "../migrations/index.js";
import { resolveEnvironment, type Project } from "../project.js";
import { closeVersioned, findMigrateOp, gitLedger, openVersioned, type MigrateOpRef } from "../versioned/index.js";
import { WAVES_PIPELINE } from "../waves/record.js";
import { baseEnvironment } from "../tenants/target.js";
import { approvalOf, byTime, deriveAudit, isoTime, type AuditEntry, type AuditGap, type LedgerInput, type WaveLedgerInput } from "./audit.js";

export const REPORT_VERSION = 1;

export type MigrationState = "applied" | "pending" | "failed" | "started" | "reverted";

export interface EnvironmentMigration {
  id: string;
  /** `started`: the runner stopped part way; `failed`: a statement or a check failed. */
  state: MigrationState;
  /** Whether the migrations directory still has it. */
  inDirectory: boolean;
  /** When it was applied, and by whom; for failed and started, its latest migration row's. */
  at?: string;
  by?: string;
  digest?: string;
  /** The approval on the ledger of the digest it was applied under. */
  approvedBy?: string;
  approvedAt?: string;
}

export interface EnvironmentReport {
  name: string;
  /** `<database>.history`. */
  history?: string;
  /** The migrations Op whose gate the ledger is read for. */
  op?: { name: string; gate: string };
  /** Why the environment could not be read; its migrations are then empty. */
  error?: string;
  /** Something read only in part, such as a ledger that could not be read. */
  notes: string[];
  migrations: EnvironmentMigration[];
}

export interface Report {
  version: typeof REPORT_VERSION;
  generatedAt: string;
  project: string;
  dialect: string;
  /** The migrations, in chain order, then any an environment applied that the directory no longer has. */
  migrations: string[];
  /** In the order they were asked for (default: chant.config.ts's sql.profiles). */
  environments: EnvironmentReport[];
  /** Every environment's entries, oldest first. */
  audit: AuditEntry[];
  gaps: AuditGap[];
}

/** What reading one environment needs; tests stand in for the server and the ledger. */
export interface ReportSources {
  rows(project: Project, env: string): Promise<{ rows: HistoryRow[]; history: string }>;
  op(project: Project, env: string): Promise<MigrateOpRef>;
  ledger(project: Project): Promise<GateLedgerPort>;
}

export const liveSources: ReportSources = {
  async rows(project, name) {
    const venv = await openVersioned(project, resolveEnvironment(project, name));
    try {
      return { rows: await venv.store.rows({ sync: false }), history: `${venv.location.database}.history` };
    } finally {
      await closeVersioned(venv);
    }
  },
  op: (project, name) => findMigrateOp(project, resolveEnvironment(project, name)),
  ledger: (project) => gitLedger(project.dir),
};

const firstLine = (e: unknown): string => (e instanceof Error ? (e.message.split("\n")[0] ?? "") : String(e));

/** Reads every environment in `names` and derives the report. An environment that cannot be read is reported with its error. */
export async function collectReport(project: Project, chain: readonly Migration[], names: readonly string[], sources: ReportSources = liveSources, now = new Date()): Promise<Report> {
  const { samePlanDigest } = await import("@intentius/chant/lifecycle/plan-digest");
  const { gateLedgerPath } = await import("@intentius/chant/lifecycle/gate-ledger");
  let port: GateLedgerPort | undefined;
  let portError: string | undefined;
  try {
    port = await sources.ledger(project);
  } catch (e) {
    portError = firstLine(e);
  }

  const environments: EnvironmentReport[] = [];
  const audit: AuditEntry[] = [];
  const gaps: AuditGap[] = [];
  const known = new Set(chain.map((m) => m.id));
  const extra: string[] = [];

  for (const name of names) {
    const env: EnvironmentReport = { name, notes: [], migrations: [] };
    environments.push(env);
    let rows: HistoryRow[];
    try {
      const read = await sources.rows(project, name);
      rows = read.rows;
      env.history = read.history;
    } catch (e) {
      env.error = `the history could not be read: ${firstLine(e)}`;
      continue;
    }

    let ledger: LedgerInput | undefined;
    try {
      const op = await sources.op(project, name);
      env.op = { name: op.name, gate: op.gate };
      if (!port) throw new Error(portError ?? "no ledger");
      const lines = await port.read(op.name);
      ledger = { op: op.name, gate: op.gate, path: gateLedgerPath(op.name), pending: lines.pending, resolutions: lines.resolutions };
    } catch (e) {
      env.notes.push(env.op ? `chant's gate ledger could not be read (${firstLine(e)}); approvals are not shown and not checked` : `no migrations Op for ${name} (${firstLine(e)}); approvals are not shown and not checked`);
    }

    // The apply pipeline's waves (#87): their gates are on the waves' op's ledger, not the migrations Op's.
    let waves: WaveLedgerInput | undefined;
    const k = (project.yodel?.config.waves ?? []).findIndex((w) => w.env === baseEnvironment(name)) + 1;
    if (port && (k > 0 || rows.some((r) => r.kind === "migration" && r.note.includes('"wave"')))) {
      try {
        const { waveGateName } = await import("@intentius/chant/gated-waves");
        const lines = await port.read(WAVES_PIPELINE);
        waves = { op: WAVES_PIPELINE, path: gateLedgerPath(WAVES_PIPELINE), ...(k > 0 ? { gate: waveGateName(WAVES_PIPELINE, k) } : {}), pending: lines.pending, resolutions: lines.resolutions };
      } catch (e) {
        env.notes.push(`the waves' gate ledger could not be read (${firstLine(e)}); wave approvals are not shown and not checked`);
      }
    }

    const derived = deriveAudit({ environment: name, history: env.history ?? "history", rows, ledger, waves, sameDigest: samePlanDigest });
    audit.push(...derived.entries);
    gaps.push(...derived.gaps);

    const state = deriveState(rows);
    const listed = [...chain.map((m) => m.id), ...state.migrations.map((m) => m.id).filter((id) => !known.has(id))];
    for (const id of state.migrations.map((m) => m.id)) {
      if (!known.has(id) && !extra.includes(id)) extra.push(id);
    }
    for (const id of listed) {
      const rec = state.byId.get(id);
      if (!rec) {
        env.migrations.push({ id, state: "pending", inDirectory: true });
        continue;
      }
      const appliedEntry = derived.entries.filter((e) => e.kind === "applied" && e.migration === id).at(-1);
      const approval = appliedEntry
        ? approvalOf(appliedEntry, derived.entries, samePlanDigest)
        : rec.planDigest
          ? derived.entries.filter((a) => a.kind === "approved" && samePlanDigest(a.digest, rec.planDigest)).at(-1)
          : undefined;
      env.migrations.push({
        id,
        state: rec.status === "succeeded" ? "applied" : rec.status,
        inDirectory: known.has(id),
        ...(rec.recordedAt ? { at: isoTime(rec.recordedAt) } : {}),
        ...(rec.appliedBy ? { by: rec.appliedBy } : {}),
        ...(rec.planDigest ? { digest: rec.planDigest } : {}),
        ...(approval?.by ? { approvedBy: approval.by, approvedAt: approval.at } : {}),
      });
    }
  }

  audit.sort(byTime);
  return {
    version: REPORT_VERSION,
    generatedAt: now.toISOString(),
    project: project.dir,
    dialect: project.dialect,
    migrations: [...chain.map((m) => m.id), ...extra],
    environments,
    audit,
    gaps,
  };
}
