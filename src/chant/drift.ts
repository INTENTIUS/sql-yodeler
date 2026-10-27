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

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LiveDiffResult, UnobservedResource } from "@intentius/chant/lifecycle/live-diff";
import type { DeepDiffResult, DeepEntityDrift, DeepEntityUnclaimed } from "@intentius/chant/lifecycle/deep-diff";
import { YodelError, type Environment, type Project } from "../project.js";
import { lastJsonLine, runChant } from "./process.js";
import { describeServer, type ServerInfo } from "../server.js";
import type { Build, BuildOutput } from "./build.js";
import { CH_ACCESS_TYPES } from "./access.js";
import { planEnvironment } from "./plan.js";
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
  /** Declared objects chant could not read. */
  unobserved: UnobservedResource[];
  /** Postgres: a read gave up at the lock timeout, and what it waited on (#18). */
  lockWait?: string | undefined;
  /** Each changed table's declared column names, by position, so `columns[3]` reads as the column's name (#19). */
  columns?: Record<string, string[]>;
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
 * A stable fingerprint of the drift: the environment and what drifted
 * (each changed object's changes, declared and live, and the objects gone),
 * order-free, so two reads of the same drift give the same one and a
 * tracking issue updated with it changes only when the drift does. Objects
 * that could not be read are not drift and are left out.
 */
export function driftFingerprint(drift: Drift): string {
  const changed = drift.changed
    .map((e) => ({
      name: e.name,
      type: e.type,
      changes: e.changes.map((c) => ({ path: c.path, kind: c.kind, declared: c.declared ?? null, live: c.live ?? null })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const subject = JSON.stringify({ environment: drift.environment, changed, missing: [...drift.missing].sort() });
  return `sha256:${createHash("sha256").update(subject, "utf8").digest("hex")}`;
}

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

/**
 * ClickHouse grants (#46), which `chant lifecycle diff` leaves unobserved (a
 * grant is compared as part of its grantee's grants): yodel plans `build`
 * against the environment and reads each `grants <grantee>` change as drift.
 * A grant declared and not held is `absent`; one held and not declared
 * (granted by hand, which the next apply revokes) is `changed`, declared
 * nothing. A grantee the server does not have is gone. The grant
 * declarations come off `unobserved`, since they were compared.
 */
export async function withClickHouseGrants(drift: Drift, project: Project, env: Environment, build: Build): Promise<Drift> {
  const grants = build.output.objects.filter((o) => o.type === "ClickHouse::Grant");
  if (grants.length === 0) return drift;
  const plan = await planEnvironment(project, env, build);
  const byGrantee = new Map<string, DeepEntityDrift>();
  const missing: string[] = [];
  for (const c of plan.diff.changes) {
    if (!c.object.startsWith("grants ")) continue;
    if (c.rule === "SQLCH200") {
      missing.push(c.object);
      continue;
    }
    if (c.rule !== "SQLCH273" && c.rule !== "SQLCH274") continue;
    const e = byGrantee.get(c.object) ?? { name: c.object, type: "ClickHouse::Grant", changes: [] };
    e.changes.push(c.rule === "SQLCH273" ? { path: c.field, kind: "absent", declared: c.after } : { path: c.field, kind: "changed", live: c.before });
    byGrantee.set(c.object, e);
  }
  const compared = new Set(grants.map((o) => o.export));
  return {
    ...drift,
    changed: [...drift.changed, ...byGrantee.values()],
    missing: [...drift.missing, ...missing].sort(),
    unobserved: drift.unobserved.filter((u) => !compared.has(u.name)),
  };
}


/** `2` on drift; `1` when there is none but part of the environment could not be read; `0` when clean. */
export function driftExitCode(drift: Drift): number {
  if (drift.changed.length > 0 || drift.missing.length > 0) return EXIT_DRIFT;
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
  for (const d of [...(sql.deep?.drifted ?? []), ...extraColumns(sql.deep?.unclaimed ?? [])]) {
    if (d.changes.length === 0) continue;
    const had = changed.get(d.name);
    changed.set(d.name, had ? { ...had, changes: [...had.changes, ...d.changes] } : d);
  }
  return {
    environment,
    changed: [...changed.values()],
    missing: [...(sql.resources?.missing ?? [])].sort(),
    unobserved: [...unobserved.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/**
 * Columns on the server that a declared table does not declare (#273), as
 * drift: `column <name>`, declared none, live its type. chant reports a live
 * column past the declared ones as unclaimed fields `columns[N].*`, which it
 * does not count as drift, since nothing in src/ set them. A group with its
 * own `name` is a whole column; a field of a declared column that src/ does
 * not set (`columns[2].default`) has no name of its own and stays unclaimed.
 */
export function extraColumns(unclaimed: readonly DeepEntityUnclaimed[]): DeepEntityDrift[] {
  const out: DeepEntityDrift[] = [];
  for (const u of unclaimed) {
    const byIndex = new Map<string, Record<string, unknown>>();
    for (const f of u.fields) {
      const m = /^columns\[(\d+)\]\.(.+)$/.exec(f.path);
      if (!m?.[1] || !m[2]) continue;
      const column = byIndex.get(m[1]) ?? {};
      column[m[2]] = f.live;
      byIndex.set(m[1], column);
    }
    const changes = [...byIndex.values()]
      .filter((c) => typeof c.name === "string")
      .map((c) => ({ path: `column ${String(c.name)}`, kind: "changed" as const, live: c.type ?? null }));
    if (changes.length > 0) out.push({ name: u.name, type: u.type, changes });
  }
  return out;
}

/** Runs `chant lifecycle diff <env> --live --json` in the project and reads the drift from it. */
export async function readDrift(project: Project, env: Environment, options: { env?: NodeJS.ProcessEnv; src?: string } = {}): Promise<Drift> {
  // Always scoped to the declared schema: a build of the project root reads every .sql file in it, migrations and ORM DDL included.
  const result = await runChant(["lifecycle", "diff", env.name, "--live", "--json", "--src", options.src ?? project.sourceDir], {
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
  if (drift.unmanaged?.length) {
    lines.push("", "Unmanaged (a kind yodel cannot declare, so never drift):");
    for (const u of drift.unmanaged) lines.push(`  ${u}`);
  }
  return `${lines.join("\n")}\n`;
}

const code = (v: unknown) => `\`${show(v).replace(/`/g, "'")}\``;

/**
 * The drift as markdown, for the tracking issue: the environment and
 * server, what it was compared with, each changed object with its changes,
 * the objects gone, the run that found it, and the fingerprint.
 */
export function renderDriftMarkdown(drift: Drift, server: ServerInfo | undefined, extra: { fingerprint: string; run?: string }): string {
  const lines: string[] = [`**${drift.environment}**${server ? ` (${describeServer(server)})` : ""} has drifted: declared objects were changed out of band, or are gone.`, ""];
  const against = describeAgainst(drift.against);
  if (against) lines.push(against, "");
  if (drift.changed.length > 0) {
    lines.push("Changed out of band:", "");
    for (const e of drift.changed) {
      lines.push(`- \`${e.name}\` (${e.type})`);
      for (const c of e.changes) {
        const path = describePath(c.path, drift.columns?.[e.name]);
        lines.push(c.kind === "absent" ? `  - ${path}: declared ${code(c.declared)}, absent live` : `  - ${path}: declared ${code(c.declared)}, live ${code(c.live)}`);
      }
    }
    lines.push("");
  }
  if (drift.missing.length > 0) {
    lines.push("Gone (declared, not on the server):", "");
    for (const name of drift.missing) lines.push(`- \`${name}\``);
    lines.push("");
  }
  if (drift.unobserved.length > 0) {
    lines.push("Could not be read, so their state is unknown:", "");
    for (const u of drift.unobserved) lines.push(`- \`${u.name}\`: ${u.reason}`);
    lines.push("");
  }
  lines.push(`Run \`yodel drift ${drift.environment}\` to see it again. yodel closes this issue when the drift is gone.`);
  if (extra.run) lines.push("", `Found by ${extra.run}`);
  lines.push("", `<sub>drift fingerprint ${extra.fingerprint}</sub>`);
  return `${lines.join("\n")}\n`;
}
