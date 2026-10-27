/**
 * `yodel report` (#57): every environment's migrations side by side, the
 * audit log derived from each environment's history and chant's gate ledger
 * (`./audit.ts`), and the gaps those sources show. Read only: it takes no
 * lock and writes nothing to a server or the ledger.
 */

import { readGateAuditLedgers } from "@intentius/chant/lifecycle/gate-audit";
import type { GateLedgerPort } from "@intentius/chant/op/gate";
import { deriveState, type HistoryRow } from "../history/index.js";
import type { Migration } from "../migrations/index.js";
import { resolveEnvironment, type Project } from "../project.js";
import { closeVersioned, findMigrateOp, gitLedger, openVersioned, type MigrateOpRef } from "../versioned/index.js";
import { WAVES_PIPELINE, waveRecordOf } from "../waves/record.js";
import { baseEnvironment } from "../tenants/target.js";
import { OVERRIDE_OP } from "@intentius/chant/override-gate";
import { cleanupGate } from "../cleanup/index.js";
import { baselineGate } from "../init/second.js";
import { approvalOf, byTime, deriveAudit, isoTime, type AppliedLine, type AppliesInput, type AuditEntry, type AuditGap, type LedgerInput, type OverrideLedgerInput, type WaveLedgerInput, type WaveRunInput, type WaveRunRecord } from "./audit.js";

export const REPORT_VERSION = 1;

/** The wave gate a history row's note names, if any. */
const waveGateOfNote = (note: string): string | undefined => waveRecordOf(note)?.gate;

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
  /** The apply pipeline's wave job run records (chant#4551); none before chant wrote them. */
  waveRuns?(project: Project): Promise<{ path: string; records: WaveRunRecord[] }>;
  /** `op`'s applies under an approval, `_gates/<op>/applied.jsonl` joined with its finished lines (chant#4551's `applies` table). */
  applies?(project: Project, op: string): Promise<{ path: string; lines: AppliedLine[] }>;
}

/** Where chant writes the waves' run records: the spec names no `labels.Env`, so under `local`, as an Op with none. */
export const WAVE_RUNS_ENV = "local";

/** A run record's `wave` field, when the record is a wave job's (chant#4551). Read structurally: a chant before it writes none. */
export function waveRunOf(record: unknown): WaveRunRecord | undefined {
  if (typeof record !== "object" || record === null) return undefined;
  const r = record as Record<string, unknown>;
  const w = r.wave as Record<string, unknown> | undefined;
  const names = (x: unknown): x is string[] => Array.isArray(x) && x.every((t) => typeof t === "string");
  if (typeof r.id !== "string" || typeof r.started !== "string" || typeof r.ended !== "string" || typeof r.status !== "string") return undefined;
  if (!w || typeof w.spec !== "string" || typeof w.number !== "number" || typeof w.name !== "string" || typeof w.job !== "string" || typeof w.exitCode !== "number") return undefined;
  if (!names(w.applied) || !names(w.failed) || !names(w.moved)) return undefined;
  const blocked = typeof w.blocked === "object" && w.blocked !== null ? (w.blocked as Record<string, string>) : undefined;
  return {
    id: r.id,
    started: r.started,
    ended: r.ended,
    status: r.status,
    wave: { spec: w.spec, number: w.number, name: w.name, job: w.job, ...(typeof w.digest === "string" ? { digest: w.digest } : {}), exitCode: w.exitCode, applied: w.applied, failed: w.failed, moved: w.moved, ...(blocked ? { blocked } : {}) },
  };
}

/** The ledger's run records and applies, read from the local chant/lifecycle branch without fetching. */
const ledgerReads: Required<Pick<ReportSources, "waveRuns" | "applies">> = {
  async waveRuns(project) {
    const { readRunLedger, runLedgerFile } = await import("@intentius/chant/lifecycle/run-ledger");
    const { records } = await readRunLedger(WAVE_RUNS_ENV, WAVES_PIPELINE, { cwd: project.dir });
    return { path: `${WAVE_RUNS_ENV}/${runLedgerFile(WAVES_PIPELINE)}`, records: records.flatMap((r) => waveRunOf(r) ?? []) };
  },
  async applies(project, op) {
    const { appliedGatePath, finishedApply, parseAppliedGateFile } = await import("@intentius/chant/lifecycle/gate-applied");
    const { readBlobFromPath } = await import("@intentius/chant/lifecycle/git");
    const { dir, file } = appliedGatePath(op);
    const text = await readBlobFromPath(dir, file, { cwd: project.dir });
    if (!text) return { path: `${dir}/${file}`, lines: [] };
    const { applied, finished } = parseAppliedGateFile(text);
    return {
      path: `${dir}/${file}`,
      lines: applied.map((a): AppliedLine => {
        const done = finishedApply(finished, a);
        const detail = (done as { detail?: unknown } | undefined)?.detail;
        return {
          gate: a.gate,
          planDigest: a.planDigest,
          timestamp: a.timestamp,
          ...(a.approvedBy ? { approvedBy: a.approvedBy } : {}),
          ...(a.approvedAt ? { approvedAt: a.approvedAt } : {}),
          ...(a.runId ? { runId: a.runId } : {}),
          ...(done ? { finished: { timestamp: done.timestamp, result: done.result, ...(typeof detail === "object" && detail !== null ? { detail: detail as Record<string, string | number | boolean> } : {}) } } : {}),
        };
      }),
    };
  },
};

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
  ...ledgerReads,
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

  // The apply pipeline's run records (#292, chant#4551): read once, matched to each environment below.
  let runs: WaveRunInput | undefined;
  let runsNote: string | undefined;
  if (sources.waveRuns && (project.yodel?.config.waves ?? []).length > 0) {
    try {
      const { waveGateName } = await import("@intentius/chant/gated-waves");
      const read = await sources.waveRuns(project);
      runs = { path: read.path, gateOf: (k) => waveGateName(WAVES_PIPELINE, k), records: read.records };
    } catch (e) {
      runsNote = `the waves' run records could not be read (${firstLine(e)}); the history's notes name the waves`;
    }
  }
  const appliesOf = new Map<string, Promise<{ path: string; lines: AppliedLine[] } | undefined>>();
  const readApplies = (op: string) => {
    let read = appliesOf.get(op);
    if (!read) {
      read = sources.applies ? sources.applies(project, op).catch(() => undefined) : Promise.resolve(undefined);
      appliesOf.set(op, read);
    }
    return read;
  };

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
      const [read] = await readGateAuditLedgers(port, [op.name]);
      ledger = { op: op.name, gate: op.gate, path: gateLedgerPath(op.name), lines: read?.lines ?? [] };
    } catch (e) {
      env.notes.push(env.op ? `chant's gate ledger could not be read (${firstLine(e)}); approvals are not shown and not checked` : `no migrations Op for ${name} (${firstLine(e)}); approvals are not shown and not checked`);
    }

    // The apply pipeline's waves (#87): their gates are on the waves' op's ledger, not the migrations Op's.
    let waves: WaveLedgerInput | undefined;
    const k = (project.yodel?.config.waves ?? []).findIndex((w) => w.env === baseEnvironment(name)) + 1;
    if (port && (k > 0 || rows.some((r) => r.kind === "migration" && r.note.includes('"wave"')))) {
      try {
        const { waveGateName } = await import("@intentius/chant/gated-waves");
        const [read] = await readGateAuditLedgers(port, [WAVES_PIPELINE]);
        waves = { op: WAVES_PIPELINE, path: gateLedgerPath(WAVES_PIPELINE), ...(k > 0 ? { gate: waveGateName(WAVES_PIPELINE, k) } : {}), lines: read?.lines ?? [] };
      } catch (e) {
        env.notes.push(`the waves' gate ledger could not be read (${firstLine(e)}); wave approvals are not shown and not checked`);
      }
    }

    // The overrides (`yodel override`) are on chant's override gate, under the migrations Op's name.
    let overrides: OverrideLedgerInput | undefined;
    if (port && env.op) {
      try {
        const [read] = await readGateAuditLedgers(port, [OVERRIDE_OP]);
        overrides = { op: env.op.name, path: gateLedgerPath(OVERRIDE_OP), lines: read?.lines ?? [] };
      } catch (e) {
        env.notes.push(`the override gate's ledger could not be read (${firstLine(e)}); overrides are not shown`);
      }
    }

    if (runsNote) env.notes.push(runsNote);
    // The approvals spent on this environment's gates (chant's applies table): its migrations gate, the cleanup and baseline requests (#292), and its wave's gate.
    const applies: AppliesInput[] = [];
    if (env.op) {
      const read = await readApplies(env.op.name);
      if (read) applies.push({ op: env.op.name, path: read.path, gates: new Set([env.op.gate, cleanupGate(env.op.gate), baselineGate(env.op.gate)]), lines: read.lines });
    }
    if (waves) {
      const read = await readApplies(WAVES_PIPELINE);
      const gates = new Set([...(waves.gate ? [waves.gate] : []), ...rows.flatMap((r) => (r.kind === "migration" && r.status === "started" ? (waveGateOfNote(r.note) ?? []) : []))]);
      if (read) applies.push({ op: WAVES_PIPELINE, path: read.path, gates, lines: read.lines });
    }

    const derived = deriveAudit({ environment: name, history: env.history ?? "history", rows, ledger, overrides, waves, runs, applies, sameDigest: samePlanDigest });
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
