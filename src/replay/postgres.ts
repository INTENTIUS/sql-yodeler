/**
 * Replaying a Postgres history: the server `sql.profiles.<env>` binds (the
 * emulator), each statement sent with `search_path` set to the migration's
 * default schema, and each migration's recorded schema compared with the
 * server the way `chant sql plan` compares a build with one
 * (`planAgainstClient`: chant's normalizer, then the server's own
 * formatting for expressions the rules leave different).
 *
 * Statements are sent one by one outside a transaction, so a
 * `CONCURRENTLY` statement runs as written. The comparison reads every
 * schema the history names.
 *
 * A `PostgresMigrationOp` step (a column rename, a type change across
 * kinds) runs through the same step runner `yodel apply` uses: expand, dual
 * write, backfill (of no rows), switch, contract, with the old column
 * dropped as the recorded schema says.
 */

import type { StatementStep } from "@intentius/chant-lexicon-sql/migration-statements";
import type { PostgresClient } from "@intentius/chant-lexicon-sql/postgres/live/client";
import { YodelError, type Environment, type Project } from "../project.js";
import { environmentSettings } from "../config/settings.js";
import type { Migration } from "../migrations/index.js";
import { defaultStepRunner, planStep, type StepRunner } from "../steps/index.js";
import type { OpStepOutcome, ReplayChange, ReplayDriver } from "./replay.js";

const SYSTEM = new Set(["pg_catalog", "information_schema", "pg_toast"]);
const PUBLIC = "public";

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

export interface PostgresReplayOptions {
  processEnv?: NodeJS.ProcessEnv;
  /** Runs a PostgresMigrationOp step. Default: chant's local executor, as apply runs it. */
  runStep?: StepRunner;
  log?: (line: string) => void;
}

/** The schemas a Postgres build output names, with bare names in `defaultSchema`. */
export async function postgresSchemas(schema: unknown, defaultSchema: string): Promise<string[]> {
  const { pgSchemaFromBuildOutput } = await import("@intentius/chant-lexicon-sql/postgres/plan/schema");
  const out = new Set<string>();
  for (const o of pgSchemaFromBuildOutput(JSON.stringify(schema), defaultSchema)) {
    if (o.canonical.kind === "schema") out.add(o.canonical.name);
    else if (o.canonical.schema) out.add(o.canonical.schema);
  }
  return [...out];
}

/** The replay driver for `env`, a Postgres environment, over the history `ordered`. */
export async function postgresReplay(project: Project, env: Environment, ordered: readonly Migration[], options: PostgresReplayOptions = {}): Promise<ReplayDriver> {
  const processEnv = options.processEnv ?? process.env;
  const settings = environmentSettings(project, env.name, processEnv);
  const { resolvePostgresTarget, isUnresolvedTarget, redactUrl } = await import("@intentius/chant-lexicon-sql/postgres/live/bind");
  const target = resolvePostgresTarget({ environment: env.name, config: project.config, env: processEnv });
  if (isUnresolvedTarget(target)) throw new YodelError(target.detail);
  const defaultSchema = (m: Migration) => m.document.defaultSchema ?? target.defaultSchema;
  const runStep = options.runStep ?? defaultStepRunner;
  const log = options.log ?? (() => undefined);

  const named = new Set<string>();
  for (const m of ordered) for (const s of await postgresSchemas(m.document.schema, defaultSchema(m))) named.add(s);
  const scope = [...named].sort();
  const system = scope.filter((s) => SYSTEM.has(s) || s.startsWith("pg_"));
  if (system.length > 0) throw new YodelError(`the history declares objects in ${system.join(", ")}, the server's own schema; there is nothing a replay can start fresh there`);
  if (scope.includes(settings.historyDatabase)) {
    throw new YodelError(`the history declares objects in ${settings.historyDatabase}, the migration history's own schema (${env.name}); the replay empties every schema it replays into, so it refuses to touch that one`);
  }

  const { connectPostgres } = await import("@intentius/chant-lexicon-sql/postgres/live/client");
  // Two sessions: the catalog is read with an empty search_path (as chant reads it), statements are sent with the migration's.
  const reader: PostgresClient = await connectPostgres(target.endpoint, { applicationName: "yodel replay" });
  let writer: PostgresClient;
  try {
    writer = await connectPostgres(target.endpoint, { applicationName: "yodel replay" });
  } catch (e) {
    await reader.end();
    throw e;
  }

  const publicObjects = async (): Promise<number> => {
    const [row] = await reader.query<{ n: string | number }>(
      `SELECT (SELECT count(*) FROM pg_catalog.pg_class c WHERE c.relnamespace = n.oid)
            + (SELECT count(*) FROM pg_catalog.pg_type t WHERE t.typnamespace = n.oid AND t.typtype IN ('e', 'd'))
            + (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace = n.oid) AS n
         FROM pg_catalog.pg_namespace n WHERE n.nspname = $1`,
      [PUBLIC],
    );
    return Number(row?.n ?? 0);
  };

  return {
    dialect: "postgres",
    where: `${redactUrl(target.endpoint.url)} (${target.source})`,
    scope,

    async occupied() {
      const others = scope.filter((s) => s !== PUBLIC);
      const there = (await reader.query<{ nspname: string }>(`SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname = ANY($1::text[]) ORDER BY nspname`, [others])).map((r) => r.nspname);
      if (scope.includes(PUBLIC) && (await publicObjects()) > 0) there.unshift(`${PUBLIC} (not empty)`);
      return there;
    },

    async clear() {
      for (const s of scope) {
        if (s !== PUBLIC) await writer.query(`DROP SCHEMA IF EXISTS ${ident(s)} CASCADE`);
        else await writer.query(`DROP SCHEMA IF EXISTS ${PUBLIC} CASCADE; CREATE SCHEMA ${PUBLIC}`);
      }
    },

    async statement(m: Migration, _index: number, step: StatementStep) {
      await writer.query(`SELECT pg_catalog.set_config('search_path', $1, false)`, [ident(defaultSchema(m))]);
      await writer.query(step.sql);
    },

    async opStep(m: Migration, index: number): Promise<OpStepOutcome> {
      const step = m.document.steps[index];
      if (!step) return { refused: `${m.id} has no step ${String(index)}` };
      const plan = planStep(step);
      if (plan.run !== "pgMigration") return { refused: plan.run === "refused" ? plan.reason : `step ${String(index)} is not one the replay runs on Postgres` };
      const { summary } = await runStep({
        environment: env.name,
        projectDir: project.dir,
        lockTimeoutMs: target.timeouts?.lockTimeoutMs,
        migration: m,
        index,
        plan,
        log: (line) => {
          log(`  ${line}`);
        },
      });
      const s = summary as { switched?: boolean; dropped?: boolean } | undefined;
      const note = [s?.switched ? "switched" : undefined, s?.dropped ? "old column dropped" : undefined].filter(Boolean).join(", ");
      return { ran: true, ...(note ? { note } : {}) };
    },

    async compare(m: Migration): Promise<ReplayChange[]> {
      const { pgSchemaFromBuildOutput } = await import("@intentius/chant-lexicon-sql/postgres/plan/schema");
      const { planAgainstClient } = await import("@intentius/chant-lexicon-sql/postgres/plan/commands");
      const ds = defaultSchema(m);
      const recorded = m.document.schema as { postgresMajor?: unknown };
      const major = m.document.major ?? (typeof recorded.postgresMajor === "number" ? recorded.postgresMajor : undefined);
      const { declared, diff } = await planAgainstClient(reader, { ...target, schemas: scope, defaultSchema: ds }, pgSchemaFromBuildOutput(JSON.stringify(m.document.schema), ds), {
        ...(major !== undefined ? { major } : {}),
        environment: env.name,
      });
      const label = new Map(declared.map((o) => [o.key, `${o.canonical.exportName ?? o.key} (${o.key.split(" ")[1] ?? o.key})`]));
      return diff.changes.map((c) => ({ ...c, object: label.get(c.object) ?? c.object }));
    },

    async close() {
      await writer.end();
      await reader.end();
    },
  };
}
