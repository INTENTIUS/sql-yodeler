/**
 * `yodel test` (#54): the cases of a project's `tests/*.test.ts`
 * (`./define.ts`), each run on a database built by replaying the
 * migrations on a throwaway server.
 *
 * Per case, on the server the environment's profile binds:
 *
 * 1. the databases (ClickHouse) or schemas (Postgres) the history names are
 *    emptied, so every case starts from nothing;
 * 2. the migrations up to the case's `at` are replayed as `yodel lint
 *    --replay` replays them: statements, and the rebuild and
 *    PostgresMigrationOp steps apply runs, but not backfills, which would
 *    find no rows;
 * 3. the `seed` statements run;
 * 4. the migrations after `at`, up to `through`, run with every step,
 *    backfills included (their receipts kept in memory, for this case
 *    alone);
 * 5. each expectation is checked, every one even after one fails.
 *
 * A checkpoint (#63) is left out of the chain, as the replay leaves it out.
 *
 * It never runs against an environment yodel applies to: an environment
 * whose history table holds a row is refused, `--reset` or not, and so is a
 * target that already holds what the history names (unless `--reset`), and
 * one another profile on the same server names (unless `--reset-shared`),
 * as the replay refuses them. Nothing is written to a history. The
 * databases are emptied again at the end unless `keep`.
 */

import { relative } from "node:path";
import { pathToFileURL } from "node:url";
import type { ReceiptStore } from "@intentius/chant/op/receipt-store";
import { YodelError, type Environment, type Project } from "../project.js";
import { EXIT_REFUSED } from "../exit.js";
import { environmentSettings } from "../config/settings.js";
import { isCheckpoint, readMigrations, type Migration } from "../migrations/index.js";
import { migrationsDir } from "../versioned/index.js";
import { httpPort } from "../history/index.js";
import { asBackfill, defaultStepRunner, planStep, type StepRunner } from "../steps/index.js";
import type { BackfillStep } from "../steps/kinds.js";
import { NOT_FRESH, openReplay, refuseShared, sharedProfiles, type ReplayDriver } from "../replay/index.js";
import type { Expectation, TestCase } from "./define.js";
import { testFiles } from "./files.js";

export { TESTS_DIR, testFiles } from "./files.js";

/** One test file and its cases. */
export interface TestFile {
  /** Relative to the project directory. */
  file: string;
  cases: TestCase[];
}

/** What a case's run came to. */
export interface CaseResult {
  file: string;
  name: string;
  /** passed: every expectation held. failed: one did not. error: the case could not run (a migration or a seed statement failed, an unknown migration id). */
  status: "passed" | "failed" | "error";
  ms: number;
  /** The expectations that did not hold, one line each. */
  failures: string[];
  error?: string;
  /** The migrations replayed before the seed, and those run after it. */
  before: string[];
  after: string[];
}

export interface TestRun {
  environment: string;
  dialect: Project["dialect"];
  where: string;
  scope: string[];
  /** The target held what the history names, and was emptied first (`reset`). */
  reset: boolean;
  files: string[];
  cases: CaseResult[];
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const firstLine = (s: string): string => s.split("\n")[0] ?? s;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** What is wrong with a case, if anything. */
function caseProblems(c: unknown, i: number): string[] {
  if (!isRecord(c)) return [`case ${String(i)} is not an object`];
  const name = typeof c.name === "string" && c.name !== "" ? c.name : undefined;
  const at = name ?? `case ${String(i)}`;
  const out: string[] = [];
  if (!name) out.push(`case ${String(i)} has no name`);
  for (const k of ["at", "through"] as const) if (c[k] !== undefined && typeof c[k] !== "string") out.push(`${at}: ${k} is a migration id`);
  if (c.seed !== undefined && !(Array.isArray(c.seed) && c.seed.every((s) => typeof s === "string"))) out.push(`${at}: seed is a list of SQL statements`);
  if (!Array.isArray(c.expect) || c.expect.length === 0) out.push(`${at}: expect lists at least one expectation (expectRows, expectValue, expectError)`);
  else if (!c.expect.every((e) => isRecord(e) && typeof e.sql === "string" && ["rows", "value", "error"].includes(String(e.kind)))) out.push(`${at}: every expectation is made with expectRows, expectValue or expectError`);
  return out;
}

/** Imports each test file and returns its cases: the default export, or `tests`. Throws naming what is wrong. */
export async function loadTests(projectDir: string, files = testFiles(projectDir)): Promise<TestFile[]> {
  const out: TestFile[] = [];
  for (const path of files) {
    const file = relative(projectDir, path);
    let mod: Record<string, unknown>;
    try {
      mod = (await import(`${pathToFileURL(path).href}?yodel=${String(Date.now())}`)) as Record<string, unknown>;
    } catch (e) {
      throw new YodelError(`${file}: could not load it: ${message(e)}`);
    }
    const cases = mod.default ?? mod.tests;
    if (!Array.isArray(cases)) throw new YodelError(`${file} exports no cases: export default defineTests([...])`);
    const problems = cases.flatMap((c, i) => caseProblems(c, i));
    if (problems.length > 0) throw new YodelError(`${file}: ${problems.join("; ")}`);
    out.push({ file, cases: cases as TestCase[] });
  }
  return out;
}

/** A value as text, for comparing what a query returned with what a case expects. */
export function asText(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  return JSON.stringify(v);
}

/** What running an expectation's SQL gave: its rows, or the server's error. */
export type Outcome = { rows: Array<Record<string, unknown>> } | { error: string };

const show = (rows: unknown[][]): string => JSON.stringify(rows.map((r) => r.map(asText)));

/** Why `e` does not hold for `outcome`, or undefined when it holds. */
export function expectationFailure(e: Expectation, outcome: Outcome): string | undefined {
  const sql = firstLine(e.sql).slice(0, 120);
  if (e.kind === "error") {
    if (!("error" in outcome)) return `expected an error from ${sql}, and it succeeded`;
    if (e.match === undefined) return undefined;
    const ok = typeof e.match === "string" ? outcome.error.includes(e.match) : new RegExp(e.match.source, e.match.flags.replace("g", "")).test(outcome.error);
    return ok ? undefined : `${sql} failed, but not with ${String(e.match)}: ${firstLine(outcome.error)}`;
  }
  if ("error" in outcome) return `${sql} failed: ${firstLine(outcome.error)}`;
  const rows = outcome.rows.map((r) => Object.values(r));
  if (e.kind === "value") {
    const first = rows[0];
    if (!first || first.length === 0) return `${sql} returned no row; expected ${asText(e.value)}`;
    return asText(first[0]) === asText(e.value) ? undefined : `${sql} returned ${asText(first[0])}; expected ${asText(e.value)}`;
  }
  return show(rows) === show(e.rows) ? undefined : `${sql} returned ${show(rows)}; expected ${show(e.rows)}`;
}

/** A receipt store for one case: a backfill's batches each run once in it, and nothing outlives the case. */
export function memoryReceipts(): ReceiptStore {
  const kept = new Map<string, string>();
  return {
    read: (r) => Promise.resolve(kept.get(r.effect)),
    write: (r, expectation) => {
      kept.set(r.effect, expectation);
      return Promise.resolve();
    },
  };
}

/** What a run needs of the server besides the replay driver: queries, a backfill's step context, whether a history is there. */
interface Session {
  query(sql: string): Promise<Array<Record<string, unknown>>>;
  backfillContext(): Pick<Parameters<StepRunner>[0], "port" | "endpoint" | "postgres">;
  /** Rows in the environment's history table: 0 when it has none. */
  historyRows(): Promise<number>;
  close(): Promise<void>;
}

async function openSession(project: Project, env: Environment, processEnv: NodeJS.ProcessEnv): Promise<Session> {
  const history = environmentSettings(project, env.name, processEnv).historyDatabase;
  if (project.dialect === "postgres") {
    const { resolvePostgresTarget, isUnresolvedTarget } = await import("@intentius/chant-lexicon-sql/postgres/live/bind");
    const target = resolvePostgresTarget({ environment: env.name, config: project.config, env: processEnv });
    if (isUnresolvedTarget(target)) throw new YodelError(target.detail);
    const { connectPostgres } = await import("@intentius/chant-lexicon-sql/postgres/live/client");
    const { DEFAULT_PG_TIMEOUTS } = await import("../versioned/postgres/executor.js");
    const client = await connectPostgres(target.endpoint, { applicationName: "yodel test" });
    const timeouts = { ...DEFAULT_PG_TIMEOUTS, ...(target.timeouts ?? {}) };
    return {
      query: (sql) => client.query(sql),
      backfillContext: () => ({ postgres: { client, timeouts, receiptsSchema: history } }),
      async historyRows() {
        const [t] = await client.query<{ t: string | null }>(`SELECT to_regclass($1)::text AS t`, [`"${history.replace(/"/g, '""')}".history`]);
        if (!t?.t) return 0;
        const [n] = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${history.replace(/"/g, '""')}".history`);
        return Number(n?.n ?? 0);
      },
      close: () => client.end(),
    };
  }
  const { resolveClickHouseTarget, isUnresolvedTarget } = await import("@intentius/chant-lexicon-sql/clickhouse/live/bind");
  const target = resolveClickHouseTarget({ environment: env.name, config: project.config, env: processEnv });
  if (isUnresolvedTarget(target)) throw new YodelError(target.detail);
  const port = await httpPort(target.endpoint);
  const q = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  return {
    query: (sql) => port.query(sql),
    backfillContext: () => ({ port, endpoint: target.endpoint }),
    async historyRows() {
      const [t] = await port.query<{ n: string | number }>(`SELECT count() AS n FROM system.tables WHERE database = ${q(history)} AND name = 'history'`);
      if (Number(t?.n ?? 0) === 0) return 0;
      const [n] = await port.query<{ n: string | number }>(`SELECT count() AS n FROM \`${history.replace(/`/g, "``")}\`.history`);
      return Number(n?.n ?? 0);
    },
    close: () => Promise.resolve(),
  };
}

export interface RunTestsOptions {
  /** Only the cases whose name matches. */
  run?: RegExp;
  /** Empty the target first when it holds what the history names. */
  reset?: boolean;
  /** Other profiles on the same server whose databases or schemas the run may empty. */
  resetShared?: readonly string[];
  /** Leave the last case's database in place. */
  keep?: boolean;
  processEnv?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  /** Runs a backfill step (and every other Op step the replay driver does not). Default: as apply runs it. */
  runStep?: StepRunner;
}

/** Runs the project's test cases on `env`'s server; see the module comment. */
export async function runTests(project: Project, env: Environment, files: readonly TestFile[], options: RunTestsOptions = {}): Promise<TestRun> {
  const processEnv = options.processEnv ?? process.env;
  const log = options.log ?? (() => undefined);
  const runStep = options.runStep ?? defaultStepRunner;
  const ordered = readMigrations(migrationsDir(project));
  const chain = ordered.filter((m) => !isCheckpoint(m));
  const ids = chain.map((m) => m.id);

  const driver: ReplayDriver = await openReplay(project, env, ordered, { processEnv, log });
  let session: Session | undefined;
  // Set once every refusal is behind: only then does anything empty the target.
  let started = false;
  try {
    refuseShared(env, await sharedProfiles(project, env, driver.scope, processEnv), options.resetShared ?? [], project.dialect);
    session = await openSession(project, env, processEnv);
    const rows = await session.historyRows();
    if (rows > 0) {
      throw new YodelError(
        `refused: ${env.name} has a migration history (${String(rows)} rows in ${environmentSettings(project, env.name, processEnv).historyDatabase}.history): it is an environment yodel applies to, and yodel test empties what the history names. ` +
          `Point --env at a throwaway server's profile (chant emulator up --lexicon sql). Nothing was run.`,
        EXIT_REFUSED,
      );
    }
    const occupied = await driver.occupied();
    if (occupied.length > 0 && options.reset !== true) {
      throw new YodelError(
        `refused: yodel test needs a fresh database, and ${driver.where} already holds ${occupied.join(", ")}. ` +
          `Point --env at a throwaway server, or pass --reset to drop ${occupied.length === 1 ? "it" : "them"} first. Nothing was run.`,
        NOT_FRESH,
      );
    }

    started = true;
    const s = session;
    const results: CaseResult[] = [];
    const runMigration = async (m: Migration, backfills: boolean, receipts: ReceiptStore) => {
      for (const [i, step] of m.document.steps.entries()) {
        const st = step as typeof step | BackfillStep;
        if (st.kind === "statement") {
          await driver.statement(m, i, st);
          continue;
        }
        const backfill = asBackfill(st);
        if (backfill) {
          if (!backfills) continue;
          const plan = planStep(st);
          if (plan.run !== "backfill") throw new Error(`${m.id} step ${String(i)}: not a backfill yodel runs`);
          await runStep({ environment: env.name, projectDir: project.dir, migration: m, index: i, plan, log: (l) => { log(`  ${l}`); }, receipts, ...s.backfillContext() });
          continue;
        }
        const plan = planStep(st);
        if (plan.run === "refused") throw new Error(`${m.id} step ${String(i)} cannot run here: ${plan.reason}`);
        const outcome = await driver.opStep(m, i);
        if ("refused" in outcome) throw new Error(`${m.id} step ${String(i)} cannot run here: ${outcome.refused}`);
      }
    };
    const index = (id: string | undefined, what: string): number => {
      if (id === undefined) return ids.length - 1;
      const i = ids.indexOf(id);
      if (i < 0) throw new Error(`${what} ${id}: no such migration in the chain${ordered.some((m) => m.id === id) ? " (a checkpoint is left out of it)" : ""}`);
      return i;
    };

    for (const f of files) {
      for (const c of f.cases) {
        if (options.run && !options.run.test(c.name)) continue;
        const t0 = Date.now();
        const result: CaseResult = { file: f.file, name: c.name, status: "passed", ms: 0, failures: [], before: [], after: [] };
        log(`${f.file}: ${c.name}`);
        try {
          const at = index(c.at, "at");
          const through = index(c.through, "through");
          if (through < at) throw new Error(`through ${String(c.through)} comes before at ${String(c.at)}`);
          const receipts = memoryReceipts();
          await driver.clear();
          for (const m of chain.slice(0, at + 1)) {
            await runMigration(m, false, receipts);
            result.before.push(m.id);
          }
          for (const [i, sql] of (c.seed ?? []).entries()) {
            try {
              await s.query(sql);
            } catch (e) {
              throw new Error(`seed statement ${String(i)} failed: ${firstLine(message(e))}`, { cause: e });
            }
          }
          for (const m of chain.slice(at + 1, through + 1)) {
            try {
              await runMigration(m, true, receipts);
            } catch (e) {
              throw new Error(`${m.id} failed after the seed: ${firstLine(message(e))}`, { cause: e });
            }
            result.after.push(m.id);
          }
          for (const e of c.expect) {
            let outcome: Outcome;
            try {
              outcome = { rows: await s.query(e.sql) };
            } catch (err) {
              outcome = { error: message(err) };
            }
            const failure = expectationFailure(e, outcome);
            if (failure !== undefined) result.failures.push(failure);
          }
          if (result.failures.length > 0) result.status = "failed";
        } catch (e) {
          result.status = "error";
          result.error = firstLine(message(e));
        }
        result.ms = Date.now() - t0;
        log(`  ${result.status}${result.error ? `: ${result.error}` : ""}${result.failures.map((x) => `\n    ${x}`).join("")}`);
        results.push(result);
      }
    }
    return { environment: env.name, dialect: project.dialect, where: driver.where, scope: [...driver.scope], reset: occupied.length > 0, files: files.map((f) => f.file), cases: results };
  } finally {
    if (started && options.keep !== true) await driver.clear().catch((e: unknown) => { log(`could not empty ${driver.scope.join(", ")} afterwards: ${firstLine(message(e))}`); });
    await session?.close();
    await driver.close();
  }
}
