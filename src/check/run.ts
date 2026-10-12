/**
 * `yodel check` (#1): another tool's migrations, replayed and linted.
 *
 * The directory's migrations run, in the tool's order, against a
 * throwaway server (a profile bound to the emulator, `replay` by default).
 * After the ones already on the base branch, and again after each new one,
 * the server's schema is read the way `yodel init --from` reads it and
 * built. Each new migration then becomes the change between two builds:
 * yodel's classifier names what it does (a drop, a rewrite, a lock, a
 * statement that can fail on the rows there), and every `yodel lint` rule
 * runs on it, the project's own policies included. Nothing is applied to
 * an environment that matters: the scope is emptied before and after.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { YodelError, type Environment, type Project } from "../project.js";
import { buildSchema, type BuildOutput } from "../chant/build.js";
import { importLive } from "../init/live.js";
import { createMigration, writeMigration, type Migration } from "../migrations/index.js";
import { lintMigrations, type Finding, type LintOptions, type LintReport } from "../lint/index.js";
import type { ForeignMigration } from "./readers.js";

/** The server a check replays into: its schemas or databases, emptied before and after. */
export interface CheckServer {
  where: string;
  /** The schemas (Postgres) or databases (ClickHouse) the profile reads. */
  scope: readonly string[];
  /** The ones of {@link scope} that hold anything. */
  occupied(): Promise<string[]>;
  clear(): Promise<void>;
  /** Runs one statement of a migration; throws the server's error. */
  run(sql: string): Promise<void>;
  /** The default schema or database, for the classifier. */
  defaults: { defaultSchema?: string; defaultDatabase?: string };
  close(): Promise<void>;
}

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
const bq = (s: string) => `\`${s.replace(/`/g, "``")}\``;

/** The check server for `env`, the profile's scope on its server. */
export async function openCheckServer(project: Project, env: Environment, processEnv: NodeJS.ProcessEnv = process.env): Promise<CheckServer> {
  if (project.dialect === "postgres") {
    const { resolvePostgresTarget, isUnresolvedTarget, redactUrl } = await import("@intentius/chant-lexicon-sql/postgres/live/bind");
    const target = resolvePostgresTarget({ environment: env.name, config: project.config, env: processEnv });
    if (isUnresolvedTarget(target)) throw new YodelError(target.detail);
    const scope = target.schemas ?? [target.defaultSchema];
    const { connectPostgres } = await import("@intentius/chant-lexicon-sql/postgres/live/client");
    const client = await connectPostgres(target.endpoint, { applicationName: "yodel check" });
    const path = scope.map(ident).join(", ");
    return {
      where: `${redactUrl(target.endpoint.url)} (${target.source})`,
      scope,
      defaults: { defaultSchema: target.defaultSchema },
      async occupied() {
        const rows = await client.query<{ nspname: string; n: string | number }>(
          `SELECT n.nspname,
                  (SELECT count(*) FROM pg_catalog.pg_class c WHERE c.relnamespace = n.oid)
                + (SELECT count(*) FROM pg_catalog.pg_type t WHERE t.typnamespace = n.oid AND t.typtype IN ('e', 'd'))
                + (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace = n.oid) AS n
             FROM pg_catalog.pg_namespace n WHERE n.nspname = ANY($1::text[]) ORDER BY n.nspname`,
          [scope],
        );
        return rows.filter((r) => Number(r.n) > 0).map((r) => r.nspname);
      },
      async clear() {
        for (const s of scope) await client.query(`DROP SCHEMA IF EXISTS ${ident(s)} CASCADE; CREATE SCHEMA ${ident(s)}`);
      },
      async run(sql: string) {
        await client.query(`SELECT pg_catalog.set_config('search_path', $1, false)`, [path]);
        await client.query(sql);
      },
      close: () => client.end(),
    };
  }
  const { resolveClickHouseTarget, isUnresolvedTarget } = await import("@intentius/chant-lexicon-sql/clickhouse/live/bind");
  const target = resolveClickHouseTarget({ environment: env.name, config: project.config, env: processEnv });
  if (isUnresolvedTarget(target)) throw new YodelError(target.detail);
  const scope = target.databases ?? [target.defaultDatabase];
  const { httpPort } = await import("../history/index.js");
  const port = await httpPort(target.endpoint);
  const quote = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  return {
    where: `${target.endpoint.url} (${target.source})`,
    scope,
    defaults: { defaultDatabase: target.defaultDatabase },
    async occupied() {
      const rows = await port.query<{ database: string }>(`SELECT DISTINCT database FROM system.tables WHERE database IN (${scope.map(quote).join(", ")}) ORDER BY database`);
      return rows.map((r) => r.database);
    },
    async clear() {
      for (const d of scope) {
        await port.query(`DROP DATABASE IF EXISTS ${bq(d)} SYNC`);
        await port.query(`CREATE DATABASE ${bq(d)}`);
      }
    },
    async run(sql: string) {
      await port.query(sql, { settings: { mutations_sync: "2" } });
    },
    close: () => Promise.resolve(),
  };
}

/** The server's schema in scope, read as `yodel init --from` reads it and built; an empty build when it holds nothing. */
export async function snapshot(project: Project, env: Environment, processEnv: NodeJS.ProcessEnv = process.env): Promise<BuildOutput> {
  const live = await importLive(project, env, processEnv);
  if (live.files.length === 0) return { dialect: project.dialect, objects: [] };
  // Built from a source directory of its own inside the project, so the declarations resolve the project's packages.
  const dir = mkdtempSync(join(project.dir, ".yodel-check-"));
  try {
    const { writeFileSync } = await import("node:fs");
    for (const f of live.files) writeFileSync(join(dir, f.path), f.content);
    // The project's DDL sources (#67) are not this schema's: the build reads the server's alone.
    const yodel = project.yodel ? { ...project.yodel, config: { ...project.yodel.config } } : undefined;
    if (yodel) delete yodel.config.sources;
    const scratch: Project = { ...project, sourceDir: relative(project.dir, dir), yodel };
    const build = await buildSchema(scratch, { env: processEnv });
    try {
      return build.output;
    } finally {
      build.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A migration name yodel accepts, from the other tool's. */
export function migrationName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug === "" ? "migration" : /^[a-z]/.test(slug) ? slug : `m-${slug}`;
}

/** What a check found: the lint report over the new migrations, each finding on the other tool's file. */
export interface CheckResult {
  report: LintReport;
  /** The other tool's migrations, in order. */
  migrations: string[];
  /** The ones new since the base, which were linted. */
  checked: string[];
  where: string;
}

export interface CheckOptions {
  /** The migrations directory, absolute: the findings' files are relative to it. */
  dir: string;
  /** The files new or changed since the base; the rest only replay. */
  isNew: (m: ForeignMigration) => boolean;
  /** Empty the scope first when it holds anything. */
  reset: boolean;
  /** Leave the replayed schema in place. */
  keep: boolean;
  lint: LintOptions;
  processEnv?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

/** Runs `migrations` in order into `server` and lints each new one; see the module comment. */
export async function runCheck(project: Project, env: Environment, server: CheckServer, migrations: readonly ForeignMigration[], options: CheckOptions): Promise<CheckResult> {
  const log = options.log ?? (() => undefined);
  const processEnv = options.processEnv ?? process.env;
  const occupied = await server.occupied();
  if (occupied.length > 0 && !options.reset) {
    throw new YodelError(`${server.where} already holds ${occupied.join(", ")}; yodel check replays into an empty scope (a throwaway server). Pass --reset to empty it first, never on a server whose data matters`, 4);
  }
  await server.clear();
  const work = mkdtempSync(join(project.dir, ".yodel-check-migrations-"));
  try {
    const ours: Migration[] = [];
    const byId = new Map<string, ForeignMigration>();
    const start = Date.UTC(2000, 0, 1);
    let previous: Migration | undefined;
    let before: BuildOutput | undefined;
    const record = (name: string, build: BuildOutput, i: number): Migration | undefined => {
      const made = createMigration({ name, build, previous, now: new Date(start + i * 60_000), ...server.defaults });
      if (made.id === undefined) return undefined;
      const path = writeMigration(work, made);
      const m: Migration = { id: made.id, dir: path, parent: previous?.id ?? null, checksum: made.document.checksum, document: made.document, files: made.files };
      ours.push(m);
      previous = m;
      return m;
    };
    let i = 0;
    for (const m of migrations) {
      const fresh = options.isNew(m);
      if (fresh && before === undefined) {
        // The schema the base branch's migrations leave: the starting point the new ones are classified against.
        before = await snapshot(project, env, processEnv);
        record("base", before, i++);
      }
      log(`${m.file}: ${String(m.statements.length)} statement${m.statements.length === 1 ? "" : "s"}`);
      for (const s of m.statements) {
        try {
          await server.run(s.sql);
        } catch (e) {
          throw new YodelError(`${m.file}:${String(s.line)}: the server refused it: ${e instanceof Error ? e.message.split("\n")[0] ?? "" : String(e)}`, 3);
        }
      }
      if (!fresh) continue;
      const after = await snapshot(project, env, processEnv);
      const made = record(migrationName(m.name), after, i++);
      if (made) byId.set(made.id, m);
      else log(`${m.file}: changes nothing the schema shows`);
    }
    const lint = await lintMigrations(work, options.lint);
    return { report: onForeignFiles(lint, byId, options.dir), migrations: migrations.map((m) => m.file), checked: migrations.filter(options.isNew).map((m) => m.file), where: server.where };
  } finally {
    rmSync(work, { recursive: true, force: true });
    if (!options.keep) await server.clear().catch(() => undefined);
  }
}

/** The rules a `-- yodel:allow` line in the other tool's file can name: the statement rules a finding on it carries. */
const SILENCEABLE = new Set(["destructive", "pg-rewrite", "pg-lock", "pg-signature", "pg-access", "data-dependent", "naming", "ch-mutation", "ch-rebuild", "ch-access"]);

/**
 * The lint report on the other tool's files: findings on the base
 * migration dropped, the rest moved onto the file that made the change, a
 * `-- yodel:allow <rule> <reason>` line in that file silencing that rule
 * there, and a pg-lock finding left out when the file builds or drops the
 * index CONCURRENTLY (the classifier reads the schema, which does not say).
 */
export function onForeignFiles(report: LintReport, byId: ReadonlyMap<string, ForeignMigration>, dir: string): LintReport {
  const findings: Finding[] = [];
  const used = new Set<string>();
  for (const f of report.findings) {
    const m = f.migration === undefined ? undefined : byId.get(f.migration);
    if (!m) continue;
    if (f.rule === "pg-lock" && concurrently(m, f.object)) continue;
    if (f.rule === "silence" || f.rule === "checksum" || f.rule === "migration-sql") continue;
    const line = lineOf(m, f.object);
    const moved: Finding = { ...f, message: f.message.replace(/^step \d+: /, ""), migration: m.file, file: m.file, ...(line !== undefined ? { line } : {}) };
    delete moved.step;
    delete moved.silenced;
    const allow = SILENCEABLE.has(f.rule) || f.rule.startsWith("SQL") || /^[A-Z]/.test(f.rule) ? m.allows.find((a) => a.rule === f.rule && a.reason !== "") : undefined;
    if (allow) used.add(`${m.file}\0${allow.rule}`);
    findings.push(allow ? { ...moved, silenced: allow.reason } : moved);
  }
  for (const m of byId.values()) {
    for (const a of m.allows) {
      if (a.reason === "") findings.push({ rule: "silence", level: "error", migration: m.file, file: m.file, line: a.line, message: `yodel:allow ${a.rule} gives no reason; write one after the rule` });
      else if (!used.has(`${m.file}\0${a.rule}`)) findings.push({ rule: "silence", level: "warning", migration: m.file, file: m.file, line: a.line, message: `yodel:allow ${a.rule} silences nothing in ${m.file}` });
    }
  }
  const live = findings.filter((f) => f.silenced === undefined);
  return {
    ...report,
    dir,
    migrations: [...byId.values()].map((m) => m.file),
    findings,
    silences: {},
    errors: live.filter((f) => f.level === "error").length,
    warnings: live.filter((f) => f.level === "warning").length,
    silenced: findings.length - live.length,
  };
}

/** The bare name of a step's object, `schema.table` or `table`. */
const bare = (object: string | undefined): string | undefined => object?.split(".").pop()?.replace(/\(.*$/, "").replace(/"/g, "");

/** The line of the statement in `m` that names `object`; the first statement's line otherwise. */
function lineOf(m: ForeignMigration, object: string | undefined): number | undefined {
  const name = bare(object);
  const hit = name ? m.statements.find((s) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(s.sql)) : undefined;
  return (hit ?? m.statements[0])?.line;
}

/** Whether `m` builds or drops the index named by `object` CONCURRENTLY. */
function concurrently(m: ForeignMigration, object: string | undefined): boolean {
  const name = bare(object);
  if (!name) return false;
  return m.statements.some((s) => /\bCONCURRENTLY\b/i.test(s.sql) && new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(s.sql));
}
