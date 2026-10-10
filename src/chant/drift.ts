/**
 * Drift: the declared objects whose live definition changed out of band, or
 * that are gone from the server. Read from `chant lifecycle diff <env> --live
 * --json`, the sql lexicon's section of it:
 *
 * - `deep.drifted[].changes[]`: a declared object whose live definition
 *   differs, property by property, declared against live;
 * - `resources.missing`: a declared object the server does not have;
 * - `resources.unobserved` and `deep.unobserved`: a declared object chant
 *   could not read (no credentials, a kind it cannot observe). Not drift, and
 *   not clean either: that part of the environment is unknown.
 *
 * An object the project does not declare is never reported: chant only reads
 * what the project declares, and only touches what carries its marker.
 */

import type { LiveDiffResult, UnobservedResource } from "@intentius/chant/lifecycle/live-diff";
import type { DeepDiffResult, DeepEntityDrift } from "@intentius/chant/lifecycle/deep-diff";
import { YodelError, type Environment, type Project } from "../project.js";
import { lastJsonLine, runChant } from "./process.js";
import { describeServer, type ServerInfo } from "../server.js";

/** The `lexicons.sql` section of `chant lifecycle diff --live --json`. */
export interface SqlLiveDiff {
  resources?: LiveDiffResult;
  deep?: DeepDiffResult;
}

export interface Drift {
  environment: string;
  /** Declared objects whose live definition differs from the declaration. */
  changed: DeepEntityDrift[];
  /** Declared objects the server does not have. */
  missing: string[];
  /** Declared objects chant could not read. */
  unobserved: UnobservedResource[];
  /** Postgres: a read gave up at the lock timeout, and what it waited on (#18). */
  lockWait?: string | undefined;
  /** Each changed table's declared column names, by position, so `columns[3]` reads as the column's name (#19). */
  columns?: Record<string, string[]>;
}

/** Exit code: an owned object changed or is gone. */
export const DRIFTED = 2;

/** `2` on drift; `1` when there is none but part of the environment could not be read; `0` when clean. */
export function driftExitCode(drift: Drift): number {
  if (drift.changed.length > 0 || drift.missing.length > 0) return DRIFTED;
  return drift.unobserved.length > 0 ? 1 : 0;
}

/** The drift in a parsed `chant lifecycle diff --live --json` document. */
export function driftFromLifecycle(environment: string, doc: unknown): Drift {
  const lexicons = (doc as { lexicons?: Record<string, SqlLiveDiff> } | undefined)?.lexicons;
  if (!lexicons) {
    const stacks = (doc as { stacks?: unknown } | undefined)?.stacks;
    throw new YodelError(
      stacks
        ? "chant lifecycle diff reported per stack; a yodel project is one database and one stack"
        : "chant lifecycle diff --json printed no lexicons",
    );
  }
  const sql = lexicons.sql ?? {};
  const unobserved = new Map<string, UnobservedResource>();
  for (const u of [...(sql.resources?.unobserved ?? []), ...(sql.deep?.unobserved ?? [])]) {
    if (!unobserved.has(u.name)) unobserved.set(u.name, u);
  }
  return {
    environment,
    changed: (sql.deep?.drifted ?? []).filter((d) => d.changes.length > 0),
    missing: [...(sql.resources?.missing ?? [])].sort(),
    unobserved: [...unobserved.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** Runs `chant lifecycle diff <env> --live --json` in the project and reads the drift from it. */
export async function readDrift(project: Project, env: Environment, options: { env?: NodeJS.ProcessEnv } = {}): Promise<Drift> {
  const result = await runChant(["lifecycle", "diff", env.name, "--live", "--json"], {
    cwd: project.dir,
    ...(options.env ? { env: options.env } : {}),
  });
  const doc = lastJsonLine(result.stdout);
  if (result.code !== 0 || doc === undefined) {
    const detail = (result.stderr || result.stdout).trim();
    throw new YodelError(`chant lifecycle diff ${env.name} --live failed (exit ${String(result.code)})${detail ? `:\n${detail}` : ""}`);
  }
  return driftFromLifecycle(env.name, doc);
}

const COLUMN_PATH = /^columns\[(\d+)\]/;

/**
 * The declared column names of each changed object whose drift is named by
 * column position (chant's ClickHouse tables keep columns as a list, so a
 * change reads `columns[3].default.expr`). Read from the project's build,
 * with the dialect's own tag, the way chant reads the declaration.
 */
export async function declaredColumns(project: Project, drift: Drift, build: () => Promise<{ output: { objects: Array<{ export: string; ddl: string }> }; dispose: () => void }>): Promise<Record<string, string[]>> {
  const wanted = new Set(drift.changed.filter((e) => e.changes.some((c) => COLUMN_PATH.test(c.path))).map((e) => e.name));
  if (wanted.size === 0) return {};
  const b = await build();
  try {
    const tag =
      project.dialect === "postgres"
        ? (await import("@intentius/chant-lexicon-sql/postgres/entities")).table
        : (await import("@intentius/chant-lexicon-sql/clickhouse/entities")).table;
    const out: Record<string, string[]> = {};
    for (const o of b.output.objects) {
      if (!wanted.has(o.export)) continue;
      try {
        const strings = Object.assign([o.ddl], { raw: [o.ddl] }) as unknown as TemplateStringsArray;
        const columns = (tag(strings).props as { columns?: unknown }).columns;
        if (Array.isArray(columns)) out[o.export] = columns.map((c) => { const n = (c as { name?: unknown }).name; return typeof n === "string" ? n : ""; });
      } catch {
        // Not a table this tag reads: its paths stay as chant gives them.
      }
    }
    return out;
  } finally {
    b.dispose();
  }
}

/** `columns[3].default.expr` as `column country: default.expr`, when the declaration names column 3. */
export function describePath(path: string, columns: readonly string[] | undefined): string {
  const m = COLUMN_PATH.exec(path);
  const name = m && columns ? columns[Number(m[1])] : undefined;
  if (!m || !name) return path;
  const rest = path.slice(m[0].length).replace(/^\./, "");
  return `column ${name}${rest ? ` ${rest}` : ""}`;
}

const show = (v: unknown) => (v === undefined ? "(none)" : typeof v === "string" ? v : JSON.stringify(v));

/** The drift as text. */
export function renderDrift(drift: Drift, server?: ServerInfo): string {
  const lines: string[] = [`Drift in ${drift.environment}${server ? ` (${describeServer(server)})` : ""}`, ""];
  if (drift.changed.length === 0 && drift.missing.length === 0) {
    lines.push(drift.unobserved.length > 0 ? "No drift in the declared objects that could be read." : "No drift: every declared object matches the server.");
  }
  if (drift.changed.length > 0) {
    lines.push("Changed out of band:");
    for (const e of drift.changed) {
      lines.push(`  ${e.name} (${e.type})`);
      for (const c of e.changes) {
        const path = describePath(c.path, drift.columns?.[e.name]);
        lines.push(c.kind === "absent" ? `    ${path}: declared ${show(c.declared)}, absent live` : `    ${path}: declared ${show(c.declared)}, live ${show(c.live)}`);
      }
    }
  }
  if (drift.missing.length > 0) {
    if (drift.changed.length > 0) lines.push("");
    lines.push("Gone (declared, not on the server):");
    for (const name of drift.missing) lines.push(`  ${name}`);
  }
  if (drift.unobserved.length > 0) {
    lines.push("", "Could not be read, so their state is unknown:");
    for (const u of drift.unobserved) lines.push(`  ${u.name}: ${u.reason}${u.detail ? ` (${u.detail})` : ""}`);
    if (drift.lockWait) lines.push("", `The read ${drift.lockWait}.`);
  }
  return `${lines.join("\n")}\n`;
}
