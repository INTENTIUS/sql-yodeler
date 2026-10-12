/**
 * What the bench stands on: a timed command runner, a scratch project of N
 * tables, the emulator asked straight (the oracle), and the history read back.
 *
 *   YODEL_BENCH_CLICKHOUSE_URL   default http://192.168.14.189:8123
 *   YODEL_BENCH_POSTGRES_HOST    default 192.168.14.189
 *   YODEL_BENCH_POSTGRES_PORT    default 5432
 *   YODEL_BENCH_POSTGRES_USER    default postgres
 *   YODEL_BENCH_POSTGRES_PASSWORD default chant
 *
 * Everything the bench writes is in a database or schema named yodel_35_*.
 */

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export type Dialect = "ch" | "pg";
export const dialectName = { ch: "clickhouse", pg: "postgres" } as const;

export const repoRoot = fileURLToPath(new URL("../", import.meta.url));

export const endpoints = {
  clickhouse: process.env.YODEL_BENCH_CLICKHOUSE_URL ?? "http://192.168.14.189:8123",
  pgHost: process.env.YODEL_BENCH_POSTGRES_HOST ?? "192.168.14.189",
  pgPort: Number(process.env.YODEL_BENCH_POSTGRES_PORT ?? 5432),
  pgUser: process.env.YODEL_BENCH_POSTGRES_USER ?? "postgres",
  pgPassword: process.env.YODEL_BENCH_POSTGRES_PASSWORD ?? "chant",
};
export const postgresUrl = () => `postgres://${endpoints.pgHost}:${String(endpoints.pgPort)}/postgres`;

// ---------------------------------------------------------------- timing

export const now = (): number => performance.now();
export const secs = (ms: number): number => Math.round(ms) / 1000;

export interface Ran {
  code: number;
  out: string;
  err: string;
  seconds: number;
}

/** Runs a command to completion, its output appended to `log`; never rejects on a non-zero exit. */
export function run(cmd: string, args: readonly string[], opts: { cwd: string; env: NodeJS.ProcessEnv; log: string; timeoutMs?: number }): Promise<Ran> {
  const timeoutMs = opts.timeoutMs ?? 4 * 3600_000;
  appendFileSync(opts.log, `\n$ ${[cmd, ...args].join(" ")}\n`);
  const t0 = now();
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      out += c;
      appendFileSync(opts.log, c);
    });
    child.stderr.on("data", (c: string) => {
      err += c;
      appendFileSync(opts.log, c);
    });
    const timer = setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Gone already.
      }
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const seconds = secs(now() - t0);
      appendFileSync(opts.log, `-> exit ${String(code ?? 1)} in ${String(seconds)}s\n`);
      resolve({ code: code ?? 1, out, err, seconds });
    });
  });
}

/** The JSON document a command printed on stdout. */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names the document's shape
export function parseJson<T>(ran: Ran): T {
  const at = ran.out.indexOf("{");
  if (at < 0) throw new Error(`no JSON on stdout (exit ${String(ran.code)}): ${ran.err.slice(0, 400)}`);
  return JSON.parse(ran.out.slice(at)) as T;
}

/** Mean, median, p95 and max of a list of seconds; null when it is empty. */
export function spread(xs: number[]): { n: number; total: number; mean: number; p50: number; p95: number; max: number } | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
  const total = s.reduce((a, b) => a + b, 0);
  const r = (x: number) => Math.round(x * 1e6) / 1e6;
  return { n: s.length, total: r(total), mean: r(total / s.length), p50: r(at(0.5)), p95: r(at(0.95)), max: r(s[s.length - 1] ?? 0) };
}

// ---------------------------------------------------------------- the emulator, straight

/** One statement over ClickHouse's HTTP interface; the response text. */
export async function clickhouse(sql: string): Promise<string> {
  const res = await fetch(`${endpoints.clickhouse.replace(/\/+$/, "")}/`, { method: "POST", body: sql, signal: AbortSignal.timeout(3600_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickHouse: ${text.trim()}\n  in: ${sql.slice(0, 300)}`);
  return text;
}

/** Statements through the pg driver; the last result's rows. For setup and reading back, not for the oracle (that is psql). */
export async function postgres<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const client = new pg.Client({
    host: endpoints.pgHost,
    port: endpoints.pgPort,
    database: "postgres",
    user: endpoints.pgUser,
    password: endpoints.pgPassword,
    connectionTimeoutMillis: 15_000,
  });
  await client.connect();
  try {
    const result = (await client.query(sql)) as unknown as pg.QueryResult | pg.QueryResult[];
    const last = Array.isArray(result) ? result[result.length - 1] : result;
    return (last?.rows ?? []) as T[];
  } finally {
    await client.end();
  }
}

export async function scalar(dialect: Dialect, sql: string): Promise<string> {
  if (dialect === "ch") return (await clickhouse(sql)).split("\n")[0]?.split("\t")[0]?.trim() ?? "";
  const first = (await postgres(sql))[0];
  const v = first ? Object.values(first)[0] : undefined;
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" ? String(v) : v == null ? "" : JSON.stringify(v);
}

export async function exec(dialect: Dialect, sql: string): Promise<void> {
  if (dialect === "ch") await clickhouse(sql);
  else await postgres(sql);
}

/** Drops a ClickHouse database or a Postgres schema. */
export async function drop(dialect: Dialect, name: string): Promise<void> {
  if (!name.startsWith("yodel_35_")) throw new Error(`refusing to drop ${name}: the bench owns yodel_35_* only`);
  if (dialect === "ch") {
    await clickhouse(`DROP DATABASE IF EXISTS ${name} SYNC`);
    return;
  }
  // A schema of thousands of tables, dropped in one statement, needs a lock per table in one
  // transaction and runs past max_locks_per_transaction ("out of shared memory"). Its tables go
  // first, a few hundred at a time.
  for (;;) {
    const tables = await postgres<{ t: string }>(`SELECT quote_ident(tablename) AS t FROM pg_tables WHERE schemaname = '${name}' LIMIT 200`);
    if (!tables.length) break;
    await postgres(`DROP TABLE IF EXISTS ${tables.map((r) => `${name}.${r.t}`).join(", ")} CASCADE`);
  }
  await postgres(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
}

/** The emulator's versions, as the servers report them. */
export async function serverVersions(): Promise<{ clickhouse: string; postgres: string }> {
  const ch = (await clickhouse("SELECT version()")).trim();
  const pgv = await scalar("pg", "SELECT version()");
  return { clickhouse: ch, postgres: pgv };
}

/**
 * The oracle: the same statements, sent straight. ClickHouse: one POST per
 * statement to the HTTP interface (no clickhouse-client is needed). Postgres:
 * one psql process over a file of the statements, with \timing on, so each
 * statement's server round trip is psql's own figure. `wall` is the whole
 * run, client start-up included.
 */
export interface OracleRun {
  client: string;
  statements: number;
  wall_seconds: number;
  per_statement: ReturnType<typeof spread>;
}

export async function oracle(dialect: Dialect, statements: string[], work: string, log: string): Promise<OracleRun> {
  if (dialect === "ch") {
    const per: number[] = [];
    const t0 = now();
    for (const sql of statements) {
      const t = now();
      await clickhouse(sql);
      per.push((now() - t) / 1000);
    }
    return { client: "ClickHouse HTTP interface (fetch, one POST per statement)", statements: statements.length, wall_seconds: secs(now() - t0), per_statement: spread(per) };
  }
  const file = join(work, `oracle-${String(Date.now())}.sql`);
  writeFileSync(file, `\\timing on\n${statements.map((s) => `${s.trim().replace(/;\s*$/, "")};`).join("\n")}\n`);
  const ran = await run("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-h", endpoints.pgHost, "-p", String(endpoints.pgPort), "-U", endpoints.pgUser, "-d", "postgres", "-f", file], {
    cwd: work,
    env: { ...process.env, PGPASSWORD: endpoints.pgPassword },
    log,
    timeoutMs: 4 * 3600_000,
  });
  if (ran.code !== 0) throw new Error(`psql exited ${String(ran.code)}: ${ran.err.slice(0, 400)}`);
  const per = [...ran.out.matchAll(/^Time: ([\d.]+) ms/gm)].map((m) => Number(m[1]) / 1000);
  return { client: "psql -f (\\timing on)", statements: statements.length, wall_seconds: ran.seconds, per_statement: spread(per) };
}

/** psql's version, for the record. */
export async function psqlVersion(): Promise<string | null> {
  const ran = await run("psql", ["--version"], { cwd: repoRoot, env: process.env, log: "/dev/null" }).catch(() => undefined);
  return ran?.code === 0 ? ran.out.trim() : null;
}

// ---------------------------------------------------------------- the history

export interface HistoryRow {
  seq: number;
  run_id: string;
  kind: string;
  migration_id: string;
  statement_index: number;
  status: string;
  /** Seconds since the epoch, microseconds. */
  at: number;
}

/** Every history row, in seq order. */
export async function historyRows(dialect: Dialect, history: string): Promise<HistoryRow[]> {
  if (dialect === "ch") {
    const text = await clickhouse(
      `SELECT seq, run_id, kind, migration_id, statement_index, status, toUnixTimestamp64Micro(recorded_at) AS at FROM ${history}.history ORDER BY seq FORMAT JSONEachRow`,
    );
    return text
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => {
        const r = JSON.parse(l) as Record<string, string | number>;
        return { seq: Number(r.seq), run_id: String(r.run_id), kind: String(r.kind), migration_id: String(r.migration_id), statement_index: Number(r.statement_index), status: String(r.status), at: Number(r.at) / 1e6 };
      });
  }
  const rows = await postgres<Record<string, string | number>>(
    `SELECT seq, run_id, kind, migration_id, statement_index, status, extract(epoch FROM recorded_at)::float8 AS at FROM ${history}.history ORDER BY seq`,
  );
  return rows.map((r) => ({ seq: Number(r.seq), run_id: String(r.run_id), kind: String(r.kind), migration_id: String(r.migration_id), statement_index: Number(r.statement_index), status: String(r.status), at: Number(r.at) }));
}

/**
 * What one apply's history rows say about the time it held the lock. yodel
 * takes the lock before the first row it writes and lets go after the last,
 * so the span from the first row to the last is a lower bound on the time
 * the lock was held (the history-table setup before and the release after
 * are outside it). Per statement and per step: from its `started` row to
 * its `succeeded` or `failed` row. Per migration: the same for its migration rows.
 */
export function lockFigures(rows: HistoryRow[], runIds: Set<string>): {
  runs: number;
  history_rows: number;
  lock_held_lower_bound_seconds: number;
  per_migration: ReturnType<typeof spread>;
  per_statement: ReturnType<typeof spread>;
  per_step: ReturnType<typeof spread>;
} {
  const mine = rows.filter((r) => runIds.has(r.run_id));
  let held = 0;
  for (const id of runIds) {
    const r = mine.filter((x) => x.run_id === id);
    if (r.length > 0) held += (r[r.length - 1]?.at ?? 0) - (r[0]?.at ?? 0);
  }
  const spans = (kind: string) => {
    const open = new Map<string, number>();
    const out: number[] = [];
    for (const r of mine.filter((x) => x.kind === kind)) {
      const key = `${r.run_id}/${r.migration_id}/${String(r.statement_index)}`;
      if (r.status === "started") open.set(key, r.at);
      else if (open.has(key)) {
        out.push(r.at - (open.get(key) ?? r.at));
        open.delete(key);
      }
    }
    return spread(out);
  };
  return {
    runs: runIds.size,
    history_rows: mine.length,
    lock_held_lower_bound_seconds: Math.round(held * 1e6) / 1e6,
    per_migration: spans("migration"),
    per_statement: spans("statement"),
    per_step: spans("step"),
  };
}

/** The run ids of rows that are not in `before`. */
export function newRuns(before: HistoryRow[], after: HistoryRow[]): Set<string> {
  const seen = new Set(before.map((r) => r.seq));
  return new Set(after.filter((r) => !seen.has(r.seq)).map((r) => r.run_id));
}

// ---------------------------------------------------------------- the project

export interface MigrationJson {
  id: string;
  steps: Array<{ kind: string; sql?: string }>;
}

const PER_FILE = 100;
export const tableName = (i: number): string => `t${String(i).padStart(5, "0")}`;

/**
 * A scratch project: its own git repository, a node_modules linking this
 * checkout's (with @intentius/sql-yodeler the checkout itself, so `yodel` is
 * the built dist/bin.js), a profile named after the database, the
 * migrations Op, and `size` tables declared, a hundred to a file.
 */
export class Project {
  /** Extra columns declared on every table, in order. */
  columns: string[] = [];

  constructor(
    readonly dialect: Dialect,
    readonly dir: string,
    /** The database (ClickHouse) or schema (Postgres); also the environment's name. */
    readonly db: string,
    public size: number,
    readonly log: string,
  ) {}

  get env(): string {
    return this.db;
  }
  get history(): string {
    return `${this.db}_history`;
  }

  static async create(dialect: Dialect, dir: string, db: string, size: number, log: string): Promise<Project> {
    const p = new Project(dialect, dir, db, size, log);
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "ops"), { recursive: true });
    p.write("package.json", JSON.stringify({ name: "yodel-bench", private: true, type: "module" }, null, 2) + "\n");
    p.write("chant.config.ts", p.config());
    p.write(`ops/migrate-${p.env}.op.ts`, p.migrateOp());
    p.write(".gitignore", "node_modules\ndist\n");
    p.writeTables();
    linkModules(dir);
    await p.git("init", "-q", "-b", "main");
    await p.git("config", "user.name", "yodel bench");
    await p.git("config", "user.email", "yodel-bench@example.invalid");
    await p.git("config", "commit.gpgsign", "false");
    await p.commit("the bench project");
    return p;
  }

  private config(): string {
    if (this.dialect === "ch") {
      return `import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-sql";

export default {
  lexicons: ["sql"],
  sql: { dialect: "clickhouse", profiles: { "${this.env}": { url: "${endpoints.clickhouse}", databases: ["${this.db}"] } } },
} satisfies ChantConfig;
`;
    }
    return `import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-sql";

export default {
  lexicons: ["sql"],
  sql: {
    dialect: "postgres",
    profiles: {
      "${this.env}": { url: "${postgresUrl()}", user: { env: "YODEL_BENCH_POSTGRES_USER" }, password: { env: "YODEL_BENCH_POSTGRES_PASSWORD" }, schemas: ["${this.db}"] },
    },
  },
} satisfies ChantConfig;
`;
  }

  private migrateOp(): string {
    const e = this.env;
    return `import { Op, phase, gate, shell, stepOutput } from "@intentius/chant/op";

const plan = shell("yodel apply ${e} --digest", { id: "plan" });
const digest = stepOutput(plan, "stdout");

export const op = Op({
  name: "migrate-${e}",
  overview: "Apply the pending migrations to ${e}, behind an approval bound to their plan digest",
  phases: [
    phase("Plan", [plan]),
    phase("Approve", [gate("approve-migrate-${e}", { plan: digest })]),
    phase("Apply", [shell("yodel apply ${e} --execute", { env: { YODEL_APPROVED_PLAN: digest }, timeout: "6h" })]),
  ],
});
`;
  }

  /** src/schema.ts (the database or schema) and src/tables_NNN.ts, a hundred tables each, with {@link columns}. */
  writeTables(): void {
    const ch = this.dialect === "ch";
    const lib = `@intentius/chant-lexicon-sql/${dialectName[this.dialect]}`;
    this.write(
      "src/schema.ts",
      ch
        ? `import { database } from "${lib}";\n\nexport const db = database\`\n  CREATE DATABASE ${this.db}\n  ENGINE = Atomic\`;\n`
        : `import { schema } from "${lib}";\n\nexport const db = schema\`\n  CREATE SCHEMA ${this.db}\`;\n`,
    );
    const extra = this.columns.map((c) => `,\n    ${c} ${ch ? "String DEFAULT ''" : "text"}`).join("");
    for (let f = 0; f * PER_FILE < this.size; f++) {
      const parts = [`import { table } from "${lib}";`, `import { db } from "./schema.js";`, ""];
      for (let i = f * PER_FILE; i < Math.min(this.size, (f + 1) * PER_FILE); i++) {
        const t = tableName(i);
        parts.push(
          ch
            ? `export const ${t} = table\`\n  CREATE TABLE \${db}.${t} (\n    id UInt64,\n    v String${extra}\n  )\n  ENGINE = MergeTree\n  ORDER BY id\`;\n`
            : `export const ${t} = table\`\n  CREATE TABLE \${db}.${t} (\n    id bigint PRIMARY KEY,\n    v text${extra}\n  )\`;\n`,
        );
      }
      this.write(`src/tables_${String(f).padStart(3, "0")}.ts`, parts.join("\n"));
    }
  }

  /** Declares a column on every table. */
  addColumn(name: string): void {
    this.columns.push(name);
    this.writeTables();
  }

  envFor(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const base: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k === "CI" || k.startsWith("GITHUB_") || k.startsWith("YODEL_")) continue;
      base[k] = v;
    }
    return {
      ...base,
      YODEL_BENCH_POSTGRES_USER: endpoints.pgUser,
      YODEL_BENCH_POSTGRES_PASSWORD: endpoints.pgPassword,
      YODEL_HISTORY_DATABASE: this.history,
      PATH: [join(this.dir, "node_modules", ".bin"), process.env.PATH ?? ""].join(delimiter),
      FORCE_COLOR: "0",
      NO_COLOR: "1",
      ...extra,
    };
  }

  yodel(args: string[], env: Record<string, string> = {}): Promise<Ran> {
    return run("yodel", args, { cwd: this.dir, env: this.envFor(env), log: this.log });
  }

  chant(args: string[]): Promise<Ran> {
    return run("chant", args, { cwd: this.dir, env: this.envFor(), log: this.log });
  }

  async git(...args: string[]): Promise<void> {
    const ran = await run("git", args, { cwd: this.dir, env: this.envFor(), log: this.log, timeoutMs: 600_000 });
    if (ran.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${ran.err}`);
  }

  async commit(message: string): Promise<void> {
    await this.git("add", "-A");
    await this.git("commit", "-q", "--allow-empty", "-m", message);
  }

  write(file: string, text: string): void {
    const path = join(this.dir, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }

  migration(id: string): MigrationJson {
    return JSON.parse(readFileSync(join(this.dir, "migrations", id, "migration.json"), "utf8")) as MigrationJson;
  }

  migrationIds(): string[] {
    const dir = join(this.dir, "migrations");
    return existsSync(dir) ? readdirSync(dir).filter((d) => existsSync(join(dir, d, "migration.json"))).sort() : [];
  }

  /** The SQL of a migration's statement steps, in order. */
  statements(id: string): string[] {
    return this.migration(id).steps.flatMap((s) => (s.kind === "statement" && s.sql ? [s.sql] : []));
  }

  /** `yodel new <name> --json`, timed; the id written. */
  async newMigration(name: string, extra: string[] = []): Promise<{ id: string; seconds: number }> {
    const ran = await this.yodel(["new", name, "--json", ...extra]);
    if (ran.code !== 0) throw new Error(`yodel new ${name} exited ${String(ran.code)}: ${ran.err.slice(0, 400)}`);
    const doc = parseJson<{ written: boolean; id?: string }>(ran);
    if (!doc.written || !doc.id) throw new Error(`yodel new ${name} wrote no migration`);
    return { id: doc.id, seconds: ran.seconds };
  }

  /**
   * What a person does: yodel apply (the Op stops at its gate), the chant
   * approve it printed, yodel apply again. Each leg timed.
   */
  async approvedApply(env: Record<string, string> = {}): Promise<{ code: number; lock: string | null; gate_seconds: number; approve_seconds: number; execute_seconds: number; seconds: number }> {
    const first = await this.yodel(["apply", this.env, "--json"], env);
    if (first.code !== 3) return { code: first.code, lock: null, gate_seconds: first.seconds, approve_seconds: 0, execute_seconds: 0, seconds: first.seconds };
    const approve = parseJson<{ chantApprove?: string }>(first).chantApprove;
    if (!approve?.startsWith("chant approve ")) throw new Error(`no chant approve command: ${String(approve)}`);
    const approved = await this.chant(approve.split(" ").slice(1));
    if (approved.code !== 0) throw new Error(`${approve} exited ${String(approved.code)}`);
    const second = await this.yodel(["apply", this.env, "--json"], env);
    return {
      code: second.code,
      // The apply's own line naming the lock it took: a KeeperMap row, a local file, a Postgres advisory lock.
      lock: lockKind(second.err),
      gate_seconds: first.seconds,
      approve_seconds: approved.seconds,
      execute_seconds: second.seconds,
      seconds: Math.round((first.seconds + approved.seconds + second.seconds) * 1000) / 1000,
    };
  }
}

/** The lock an apply took, from its "lock: ..." line. */
function lockKind(err: string): string | null {
  const line = /^lock: (.*)$/m.exec(err)?.[1];
  if (line === undefined) return null;
  return /the lock is a file/.test(line) ? "local file: the server has no KeeperMap (keeper_map_path_prefix unset)" : line;
}

/** Every package this checkout has, linked, with @intentius/sql-yodeler the checkout and a .bin holding chant and yodel. */
function linkModules(dir: string): void {
  const from = join(repoRoot, "node_modules");
  const to = join(dir, "node_modules");
  if (!existsSync(join(repoRoot, "dist", "bin.js"))) throw new Error("dist/bin.js is missing: run npm run build first");
  mkdirSync(join(to, "@intentius"), { recursive: true });
  mkdirSync(join(to, ".bin"));
  for (const entry of readdirSync(from)) {
    if (entry === "@intentius" || entry === ".bin" || entry.startsWith(".")) continue;
    symlinkSync(join(from, entry), join(to, entry));
  }
  for (const entry of readdirSync(join(from, "@intentius"))) symlinkSync(join(from, "@intentius", entry), join(to, "@intentius", entry));
  symlinkSync(repoRoot, join(to, "@intentius", "sql-yodeler"));
  symlinkSync("../@intentius/chant/bin/chant", join(to, ".bin", "chant"));
  symlinkSync("../@intentius/sql-yodeler/dist/bin.js", join(to, ".bin", "yodel"));
}

/** Points a statement at another database or schema: `from` as a whole name becomes `to`. */
export const retarget = (sql: string, from: string, to: string): string => sql.replace(new RegExp(`\\b${from}\\b`, "g"), to);
