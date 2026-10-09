/**
 * The versioned apply on Postgres (#13): binding an environment's server,
 * its history, its lock and its statements.
 *
 * Settings:
 *
 *   the environment's history database (`yodel.config.ts`
 *   `environments.<env>.history.database`, else YODEL_HISTORY_DATABASE,
 *   default `yodeler`) is the history's schema: `<schema>.history`, and the lock's key
 *   YODEL_LOCK_RETRIES      how many more times a statement that hit the lock timeout is tried (default 5)
 *
 * and from `sql.profiles.<env>`, as chant's applier reads them:
 *
 *   lockTimeoutMs       lock_timeout for every statement (default 5000)
 *   statementTimeoutMs  statement_timeout for a catalog change (default 60000)
 *   scanTimeoutMs       statement_timeout for a statement that reads or rewrites rows (default none)
 *   schemas             the schemas the plan digest's fingerprint covers (default every schema but the server's own)
 *
 * Two connections: the work connection, opened on first use, on which the
 * history is read and written and the statements run; and the lock's,
 * opened when the lock is taken and closed when it is released.
 */

import type { PostgresEndpoint } from "@intentius/chant-lexicon-sql/postgres/live/client";
import type { StatementStep } from "@intentius/chant-lexicon-sql/migration-statements";
import { YodelError, type Environment, type Project } from "../../project.js";
import { DEFAULT_HISTORY_DATABASE } from "../../history/index.js";
import { acquireAdvisoryLock, PostgresHistoryStore, type PgLockConnection } from "../../history/postgres/index.js";
import type { VersionedDriver } from "../driver.js";
import { pgCatalogFingerprint, readPgCatalog } from "./catalog.js";
import { DEFAULT_LOCK_RETRIES, DEFAULT_PG_TIMEOUTS, PgStatementError, runPgStatement, type PgTimeouts } from "./executor.js";

/** Opens a connection to the server: chant's `connectPostgres`, or a fake in the tests. */
export type PgConnect = (endpoint: PostgresEndpoint, applicationName: string) => Promise<PgLockConnection>;

export interface PgSettings {
  historySchema: string;
  timeouts: PgTimeouts;
  lockRetries: number;
}

export function pgSettings(target: { timeouts?: Partial<PgTimeouts> }, env: NodeJS.ProcessEnv = process.env, historySchema: string = env.YODEL_HISTORY_DATABASE || DEFAULT_HISTORY_DATABASE): PgSettings {
  const retries = env.YODEL_LOCK_RETRIES ? Number(env.YODEL_LOCK_RETRIES) : DEFAULT_LOCK_RETRIES;
  if (!(Number.isInteger(retries) && retries >= 0)) throw new YodelError(`YODEL_LOCK_RETRIES must be a whole number of retries, got ${JSON.stringify(env.YODEL_LOCK_RETRIES)}`);
  const t = target.timeouts ?? {};
  return {
    historySchema,
    timeouts: {
      lockTimeoutMs: t.lockTimeoutMs ?? DEFAULT_PG_TIMEOUTS.lockTimeoutMs,
      statementTimeoutMs: t.statementTimeoutMs ?? DEFAULT_PG_TIMEOUTS.statementTimeoutMs,
      scanTimeoutMs: t.scanTimeoutMs ?? DEFAULT_PG_TIMEOUTS.scanTimeoutMs,
    },
    lockRetries: retries,
  };
}

const chantConnect: PgConnect = async (endpoint, applicationName) => {
  const { connectPostgres } = await import("@intentius/chant-lexicon-sql/postgres/live/client");
  return connectPostgres(endpoint, { applicationName });
};

/** A connection opened on its first query, so a verb that reads nothing opens none. */
export class LazyConnection implements PgLockConnection {
  private conn: Promise<PgLockConnection> | undefined;

  constructor(private readonly open: () => Promise<PgLockConnection>) {}

  async query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]> {
    this.conn ??= this.open();
    return (await this.conn).query<T>(sql, params);
  }

  async end(): Promise<void> {
    const c = this.conn;
    this.conn = undefined;
    if (c) await (await c.catch(() => undefined))?.end();
  }
}

/** Everything the versioned verbs need about one Postgres environment. */
export interface PostgresEnv {
  endpoint: PostgresEndpoint;
  /** `sql.profiles.<env>.schemas`. */
  schemas: string[] | undefined;
  defaultSchema: string;
  settings: PgSettings;
  client: LazyConnection;
  store: PostgresHistoryStore;
  driver: VersionedDriver;
}

/** Binds `env`'s Postgres server (`sql.profiles.<env>`) and its history. Connects on first use. */
export async function openPostgres(project: Project, env: Environment, processEnv: NodeJS.ProcessEnv = process.env, historySchema?: string, connect: PgConnect = chantConnect): Promise<PostgresEnv> {
  const { resolvePostgresTarget, isUnresolvedTarget } = await import("@intentius/chant-lexicon-sql/postgres/live/bind");
  const target = resolvePostgresTarget({ environment: env.name, config: project.config, env: processEnv });
  if (isUnresolvedTarget(target)) throw new YodelError(target.detail);
  const settings = pgSettings(target, processEnv, historySchema);
  const client = new LazyConnection(() => connect(target.endpoint, "yodel"));
  const store = new PostgresHistoryStore(client, { schema: settings.historySchema });
  const schemas = target.schemas;
  const driver = postgresDriver({ client, connect: () => connect(target.endpoint, "yodel lock"), settings, schemas, store });
  return { endpoint: target.endpoint, schemas, defaultSchema: target.defaultSchema, settings, client, store, driver };
}

export interface PostgresDriverInput {
  client: LazyConnection;
  /** Opens the lock's own connection. */
  connect: () => Promise<PgLockConnection>;
  settings: PgSettings;
  schemas: string[] | undefined;
  store: PostgresHistoryStore;
  sleep?: (ms: number) => Promise<void>;
  retryBaseMs?: number;
}

export function postgresDriver(input: PostgresDriverInput): VersionedDriver {
  const { client, settings } = input;
  return {
    dialect: "postgres",
    async acquireLock(holder) {
      return acquireAdvisoryLock(await input.connect(), { schema: settings.historySchema, holder });
    },
    async liveFingerprint() {
      return pgCatalogFingerprint(await readPgCatalog(client, { schemas: input.schemas, historySchema: settings.historySchema }));
    },
    async runStatement(step: StatementStep, run) {
      try {
        await runPgStatement(client, step, {
          timeouts: settings.timeouts,
          retries: settings.lockRetries,
          succeeded: async (note) => {
            await run.succeeded(note);
          },
          log: run.log,
          ...(input.sleep ? { sleep: input.sleep } : {}),
          ...(input.retryBaseMs !== undefined ? { retryBaseMs: input.retryBaseMs } : {}),
        });
      } catch (e) {
        if (e instanceof PgStatementError) throw new Error(e.error, { cause: e });
        throw e;
      }
    },
    stepContext() {
      return { lockTimeoutMs: settings.timeouts.lockTimeoutMs, postgres: { client, timeouts: settings.timeouts, receiptsSchema: settings.historySchema } };
    },
    close: () => client.end(),
  };
}
