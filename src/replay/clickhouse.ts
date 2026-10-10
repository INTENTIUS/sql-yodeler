/**
 * Replaying a ClickHouse history: the server `sql.profiles.<env>` binds (the
 * emulator, `chant emulator up --lexicon sql`), statements sent as
 * `yodel apply` sends them (rendered for the environment's topology, a
 * mutation waited for), rebuild steps run as apply runs them, and each
 * migration's recorded schema compared with what the server then holds, the
 * way `chant sql plan` compares a build with a server (chant's normalizer,
 * then the server's own formatter for expressions the rules leave
 * different).
 *
 * The comparison reads every database the history names, so an object the
 * replay made that the recorded schema leaves out is a difference too, and
 * so is a database a migration should have dropped. chant's working objects
 * (a rebuild's retained `__chant_old` table) are not read, as a plan does
 * not read them.
 */

import type { ClickHouseEndpoint } from "@intentius/chant-lexicon-sql/clickhouse/http";
import type { StatementStep } from "@intentius/chant-lexicon-sql/migration-statements";
import { YodelError, type Environment, type Project } from "../project.js";
import { environmentSettings } from "../config/settings.js";
import { httpPort, type ClickHousePort } from "../history/index.js";
import type { Migration } from "../migrations/index.js";
import { renderForEnvironment } from "../topology/render.js";
import { defaultStepRunner, planStep, type RebuildReceiptStore, type StepRunner } from "../steps/index.js";
import type { OpStepOutcome, ReplayChange, ReplayDriver } from "./replay.js";

const SYSTEM = new Set(["system", "information_schema", "INFORMATION_SCHEMA"]);
const DEFAULT = "default";

const ident = (s: string) => `\`${s.replace(/`/g, "``")}\``;
const quote = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

export interface ClickHouseReplayOptions {
  processEnv?: NodeJS.ProcessEnv;
  /** The server, in place of an HTTP port to the bound endpoint. */
  port?: ClickHousePort;
  /** Runs a rebuild step. Default: chant's local executor, as apply runs it. */
  runStep?: StepRunner;
  log?: (line: string) => void;
}

/** The databases a ClickHouse build output names, with bare names in `defaultDatabase`. */
export async function clickhouseDatabases(schema: unknown, defaultDatabase: string): Promise<string[]> {
  const { schemaFromBuildOutput } = await import("@intentius/chant-lexicon-sql/clickhouse/plan/schema");
  return [...new Set(schemaFromBuildOutput(JSON.stringify(schema), defaultDatabase).map((o) => o.canonical.database ?? o.canonical.name))];
}

/** The replay driver for `env`, a ClickHouse environment, over the history `ordered`. */
export async function clickhouseReplay(project: Project, env: Environment, ordered: readonly Migration[], options: ClickHouseReplayOptions = {}): Promise<ReplayDriver> {
  const processEnv = options.processEnv ?? process.env;
  const settings = environmentSettings(project, env.name, processEnv);
  const { resolveClickHouseTarget, isUnresolvedTarget } = await import("@intentius/chant-lexicon-sql/clickhouse/live/bind");
  const target = resolveClickHouseTarget({ environment: env.name, config: project.config, env: processEnv });
  if (isUnresolvedTarget(target)) throw new YodelError(target.detail);
  const endpoint: ClickHouseEndpoint = target.endpoint;
  const topology = settings.topology;
  const defaultDatabase = (m: Migration) => m.document.defaultDatabase ?? target.defaultDatabase;

  const named = new Set<string>();
  for (const m of ordered) for (const d of await clickhouseDatabases(m.document.schema, defaultDatabase(m))) named.add(d);
  const scope = [...named].sort();
  const system = scope.filter((d) => SYSTEM.has(d));
  if (system.length > 0) throw new YodelError(`the history declares objects in ${system.join(", ")}, the server's own database; there is nothing a replay can start fresh there`);
  if (scope.includes(settings.historyDatabase)) {
    throw new YodelError(`the history declares objects in ${settings.historyDatabase}, the migration history's own database (${env.name}); the replay empties every database it replays into, so it refuses to touch that one`);
  }

  const port = options.port ?? (await httpPort(endpoint));
  const log = options.log ?? (() => undefined);
  const runStep = options.runStep ?? defaultStepRunner;

  const tablesInDefault = async () =>
    (await port.query<{ name: string }>(`SELECT name FROM system.tables WHERE database = ${quote(DEFAULT)} AND NOT is_temporary ORDER BY name`)).map((r) => r.name);

  return {
    dialect: "clickhouse",
    where: `${endpoint.url} (${target.source})`,
    scope,

    async occupied() {
      const others = scope.filter((d) => d !== DEFAULT);
      const there = others.length === 0 ? [] : (await port.query<{ name: string }>(`SELECT name FROM system.databases WHERE name IN (${others.map(quote).join(", ")}) ORDER BY name`)).map((r) => r.name);
      if (scope.includes(DEFAULT) && (await tablesInDefault()).length > 0) there.unshift(`${DEFAULT} (not empty)`);
      return there;
    },

    async clear() {
      for (const d of scope) {
        if (d !== DEFAULT) await port.query(`DROP DATABASE IF EXISTS ${ident(d)} SYNC`);
        else for (const t of await tablesInDefault()) await port.query(`DROP TABLE IF EXISTS ${ident(DEFAULT)}.${ident(t)} SYNC`);
      }
    },

    async statement(_m: Migration, _index: number, step: StatementStep) {
      await port.query(renderForEnvironment(step.sql, topology), step.waitsForMutation ? { settings: { mutations_sync: "2" } } : {});
    },

    async opStep(m: Migration, index: number, opts: { receipts?: RebuildReceiptStore } = {}): Promise<OpStepOutcome> {
      const step = m.document.steps[index];
      if (!step) return { refused: `${m.id} has no step ${String(index)}` };
      const plan = planStep(step);
      if (plan.run !== "rebuild") return { refused: plan.run === "refused" ? plan.reason : `step ${String(index)} is not one the replay runs` };
      const { summary } = await runStep({ environment: env.name, projectDir: project.dir, port, endpoint, migration: m, index, plan, log: (line) => { log(`  ${line}`); }, ...(opts.receipts ? { rebuildReceipts: opts.receipts } : {}) });
      const s = summary as { swapped?: boolean } | undefined;
      return { ran: true, ...(s?.swapped !== undefined ? { note: s.swapped ? "swapped" : "not swapped" } : {}) };
    },

    async compare(m: Migration): Promise<ReplayChange[]> {
      const { keyedByQualifiedName, schemaFromBuildOutput, schemaFromServer } = await import("@intentius/chant-lexicon-sql/clickhouse/plan/schema");
      const { diffSchemas } = await import("@intentius/chant-lexicon-sql/clickhouse/plan/diff");
      const { dropFormattingOnly } = await import("@intentius/chant-lexicon-sql/clickhouse/plan/server-format");
      const db = defaultDatabase(m);
      const declared = keyedByQualifiedName(schemaFromBuildOutput(JSON.stringify(m.document.schema), db, topology));
      const live = await schemaFromServer({ ...target, databases: scope, defaultDatabase: db }, new Set(scope));
      const diff = diffSchemas(live, declared);
      const changes = await dropFormattingOnly(endpoint, diff.changes);
      const label = new Map(declared.map((o) => [o.key, `${o.exportName} (${o.key})`]));
      return changes.map((c) => ({ ...c, object: label.get(c.object) ?? c.object }));
    },

    close: () => Promise.resolve(),
  };
}
