/**
 * Drift: the declared objects whose live definition changed out of band, or
 * that are gone from the server. Read from `chant lifecycle diff <env> --live
 * --json`, the sql lexicon's section of it:
 *
 * - `deep.drifted[].changes[]`: a declared object whose live definition
 *   differs, property by property, declared against live; a column is
 *   addressed by its name (`columns[#country].default.expr`), and a
 *   ClickHouse grant declared and not held is `absent` on its grant;
 * - `deep.pending`: a change on no one object's properties, which an apply
 *   would undo: a column the server has and the declaration does not, a
 *   privilege granted by hand (chant issue 4944);
 * - `resources.missing`: a declared object the server does not have;
 * - `resources.unobserved` and `deep.unobserved`: a declared object chant
 *   could not read (no credentials, a kind it cannot observe). Not drift, and
 *   not clean either: that part of the environment is unknown.
 *
 * An object the project does not declare is never reported: chant only reads
 * what the project declares, and only touches what carries its marker.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LiveDiffResult, UnobservedResource } from "@intentius/chant/lifecycle/live-diff";
import type { DeepDiffResult, DeepEntityDrift } from "@intentius/chant/lifecycle/deep-diff";
import type { DeepPendingChange } from "@intentius/chant/deep-observation";
import { YodelError, type Environment, type Project } from "../project.js";
import { runChant } from "@intentius/chant/chant-install";
import { describeServer, type ServerInfo } from "../server.js";
import type { BuildOutput } from "./build.js";
import { CH_ACCESS_TYPES } from "./access.js";
import { EXIT_DRIFT } from "../exit.js";

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
  /** Changes on no one object's properties that an apply would undo, such as a column or a privilege added by hand. Absent when there are none. */
  pending?: DeepPendingChange[];
  /** Declared objects chant could not read. */
  unobserved: UnobservedResource[];
  /** Postgres: a read gave up at the lock timeout, and what it waited on (#18). */
  lockWait?: string | undefined;
  /** What the server was compared with (#49): `src/`, or the schema the newest applied migration records. */
  against?: DriftAgainst;
  /** Objects on the server of a kind yodel cannot declare (#251), as `<kind> <name>`: unmanaged, never drift. */
  unmanaged?: string[];
}

/**
 * The declaration drift compares the server with: the project's `src/`,
 * or the recorded schema of the newest migration the environment's history
 * records as applied (`migration` null when none is applied yet).
 */
export type DriftAgainst = { source: "src" } | { source: "history"; migration: string | null };

/**
 * The recorded schema as declarations chant can build: one file, written
 * by the sql lexicon's import generator from each object's DDL, each named
 * by its export as the build named it. Written under the project directory,
 * so the generated imports resolve from the project's node_modules, in a
 * directory {@link RecordedSource.dispose} removes.
 */
export interface RecordedSource {
  dir: string;
  dispose: () => void;
}

export async function writeRecordedSource(projectDir: string, schema: BuildOutput): Promise<RecordedSource> {
  const { sqlTemplateGenerator } = await import("@intentius/chant-lexicon-sql/import-generator");
  // chant's ClickHouse generator writes no user, role, row policy or grant (#46); those go in a file of their own, each its recorded DDL.
  const access = schema.objects.filter((o) => CH_ACCESS_TYPES.has(o.type ?? ""));
  const resources = schema.objects.filter((o) => !CH_ACCESS_TYPES.has(o.type ?? "")).map((o) => {
    const own = o as typeof o & { database?: unknown; schema?: unknown; name?: unknown };
    const where = typeof own.database === "string" ? { database: own.database } : typeof own.schema === "string" ? { schema: own.schema } : {};
    return { type: o.type ?? "", logicalId: o.export, properties: { ...where, name: typeof own.name === "string" ? own.name : o.export, ddl: o.ddl } };
  });
  const dir = mkdtempSync(join(projectDir, ".yodel-recorded-"));
  const dispose = () => {
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    for (const f of resources.length === 0 ? [] : sqlTemplateGenerator.generate({ resources, parameters: [] })) {
      const path = join(dir, f.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, f.content);
    }
    if (access.length > 0) writeFileSync(join(dir, "access.ts"), recordedAccessSource(access));
  } catch (e) {
    dispose();
    throw new YodelError(`the recorded schema could not be written as declarations: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { dir, dispose };
}

const CH_ACCESS_TAG: Readonly<Record<string, string>> = { "ClickHouse::User": "user", "ClickHouse::Role": "role", "ClickHouse::RowPolicy": "policy", "ClickHouse::Grant": "grant" };

/** ClickHouse access objects of a recorded schema as declarations: each its DDL in its tag, names as text (the recorded DDL has them resolved). */
export function recordedAccessSource(objects: ReadonlyArray<{ export: string; type?: string; ddl: string }>): string {
  const tags = [...new Set(objects.map((o) => CH_ACCESS_TAG[o.type ?? ""] ?? ""))].filter(Boolean).sort();
  const lines = [`import { ${tags.join(", ")} } from "@intentius/chant-lexicon-sql/clickhouse";`, ""];
  for (const o of objects) lines.push(`export const ${o.export} = ${CH_ACCESS_TAG[o.type ?? ""] ?? "grant"}\`${o.ddl.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${")}\`;`);
  return `${lines.join("\n")}\n`;
}

/** Whether the drift has anything an apply would change: an object changed or gone, or a pending change. */
export const hasDrift = (drift: Drift): boolean => drift.changed.length > 0 || drift.missing.length > 0 || (drift.pending?.length ?? 0) > 0;

/** `2` on drift; `1` when there is none but part of the environment could not be read; `0` when clean. */
export function driftExitCode(drift: Drift): number {
  if (hasDrift(drift)) return EXIT_DRIFT;
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
  const changed = new Map<string, DeepEntityDrift>();
  for (const d of sql.deep?.drifted ?? []) {
    if (d.changes.length === 0) continue;
    const had = changed.get(d.name);
    changed.set(d.name, had ? { ...had, changes: [...had.changes, ...d.changes] } : d);
  }
  const pending = sql.deep?.pending ?? [];
  return {
    environment,
    changed: [...changed.values()],
    missing: [...(sql.resources?.missing ?? [])].sort(),
    ...(pending.length > 0 ? { pending: [...pending] } : {}),
    unobserved: [...unobserved.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** Runs `chant lifecycle diff <env> --live --json` in the project and reads the drift from it. */
export async function readDrift(project: Project, env: Environment, options: { env?: NodeJS.ProcessEnv; src?: string } = {}): Promise<Drift> {
  // chant scopes the build to sourceDir (chant issue 4794); `src` is a directory the caller names.
  const result = await runChant(["lifecycle", "diff", env.name, "--live", "--json", ...(options.src ? ["--src", options.src] : [])], {
    cwd: project.dir,
    noColor: true,
    resolveFallback: true,
    ...(options.env ? { env: options.env } : {}),
  });
  const doc = result.json;
  if (result.code !== 0 || doc === undefined) {
    const detail = (result.stderr || result.stdout).trim();
    throw new YodelError(`chant lifecycle diff ${env.name} --live failed (exit ${String(result.code)})${detail ? `:\n${detail}` : ""}`);
  }
  return driftFromLifecycle(env.name, doc);
}

const show = (v: unknown) => (v === undefined ? "(none)" : typeof v === "string" ? v : JSON.stringify(v));

/** What the server was compared with, in words. */
export function describeAgainst(against: DriftAgainst | undefined): string | undefined {
  if (!against) return undefined;
  if (against.source === "src") return "Compared with the declared schema in src/.";
  return against.migration
    ? `Compared with the schema ${against.migration} records, the newest migration the history records as applied.`
    : "No migration is applied yet, so the history records no schema to compare with.";
}

/** The drift as text. */
export function renderDrift(drift: Drift, server?: ServerInfo): string {
  const lines: string[] = [`Drift in ${drift.environment}${server ? ` (${describeServer(server)})` : ""}`, ""];
  const against = describeAgainst(drift.against);
  if (against) lines.push(against, "");
  if (!hasDrift(drift)) {
    lines.push(drift.unobserved.length > 0 ? "No drift in the declared objects that could be read." : "No drift: every declared object matches the server.");
  }
  if (drift.changed.length > 0) {
    lines.push("Changed out of band:");
    for (const e of drift.changed) {
      lines.push(`  ${e.name} (${e.type})`);
      for (const c of e.changes) {
        lines.push(c.kind === "absent" ? `    ${c.path}: declared ${show(c.declared)}, absent live` : `    ${c.path}: declared ${show(c.declared)}, live ${show(c.live)}`);
      }
    }
  }
  if (drift.missing.length > 0) {
    if (drift.changed.length > 0) lines.push("");
    lines.push("Gone (declared, not on the server):");
    for (const name of drift.missing) lines.push(`  ${name}`);
  }
  if (drift.pending?.length) {
    if (drift.changed.length > 0 || drift.missing.length > 0) lines.push("");
    lines.push("Added on the server, which the next apply undoes:");
    for (const p of drift.pending) lines.push(`  ${p.subject}: ${p.change}`);
  }
  if (drift.unobserved.length > 0) {
    lines.push("", "Could not be read, so their state is unknown:");
    for (const u of drift.unobserved) lines.push(`  ${u.name}: ${u.reason}${u.detail ? ` (${u.detail})` : ""}`);
    if (drift.lockWait) lines.push("", `The read ${drift.lockWait}.`);
  }
  if (drift.unmanaged?.length) {
    lines.push("", "Unmanaged (a kind yodel cannot declare, so never drift):");
    for (const u of drift.unmanaged) lines.push(`  ${u}`);
  }
  return `${lines.join("\n")}\n`;
}
