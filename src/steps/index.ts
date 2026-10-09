/**
 * Op steps inside a migration (#12): what `yodel apply` runs besides SQL.
 *
 *   planStep(step)            statement, rebuild, backfill, or refused (with why)
 *   stepSha(step, files)      the hash a step's history rows record
 *   runRebuild(...)           a ClickHouseRebuildOp step (./rebuild.ts)
 *   runBackfill(...)          a backfill step, an Op of effect() batches (./backfill.ts)
 *   runPgMigration(...)       a PostgresMigrationOp step (./postgres-migration.ts)
 *   defaultStepRunner         what the versioned apply calls for an Op step
 */

import type { ReceiptStore } from "@intentius/chant/op/receipt-store";
import type { ClickHouseEndpoint } from "@intentius/chant-lexicon-sql/clickhouse/http";
import type { ClickHousePort } from "../history/index.js";
import type { Migration } from "../migrations/index.js";
import { YodelError } from "../project.js";
import { postgresServerReceipts, runBackfill, serverReceipts, type PgBackfillServer } from "./backfill.js";
import type { StepPlan } from "./kinds.js";
import { rebuildChantConfig, runRebuild } from "./rebuild.js";
import { runPgMigration } from "./postgres-migration.js";

export * from "./kinds.js";
export * from "./run.js";
export * from "./rebuild.js";
export * from "./backfill.js";
export * from "./postgres-migration.js";

/** What running one Op step needs. */
export interface StepContext {
  environment: string;
  /** The project directory, which holds chant.config.ts. */
  projectDir: string;
  /** The ClickHouse server a backfill's SQL runs on; absent on Postgres. */
  port?: ClickHousePort | undefined;
  /** Postgres: the apply's connection a backfill's SQL runs on, its timeouts, and the schema its receipts are kept in (the history's). */
  postgres?: (PgBackfillServer & { receiptsSchema: string }) | undefined;
  /** Postgres: the environment's lock timeout, for a PostgresMigrationOp step whose options set none. */
  lockTimeoutMs?: number | undefined;
  /** The server, for chant's receipt store; the port is enough for everything else. */
  endpoint?: ClickHouseEndpoint | undefined;
  migration: Migration;
  index: number;
  plan: Exclude<StepPlan, { run: "statement" } | { run: "refused" }>;
  log: (line: string) => void;
  /** A backfill's receipt store; default chant's on the server. */
  receipts?: ReceiptStore | undefined;
}

/** Runs one Op step to the end and returns the summary its history row records. Throws `StepOpFailed` when it stops part way. */
export type StepRunner = (ctx: StepContext) => Promise<{ summary: unknown }>;

export const defaultStepRunner: StepRunner = async (ctx) => {
  if (ctx.plan.run === "rebuild") {
    const config = await rebuildChantConfig(ctx.projectDir, ctx.environment);
    const { summary } = await runRebuild(ctx.plan.options, { environment: ctx.environment, projectDir: ctx.projectDir, schema: ctx.migration.document.schema, log: ctx.log, config });
    return { summary };
  }
  if (ctx.plan.run === "pgMigration") {
    const { summary } = await runPgMigration(ctx.plan.options, { environment: ctx.environment, projectDir: ctx.projectDir, schema: ctx.migration.document.schema, lockTimeoutMs: ctx.lockTimeoutMs, log: ctx.log });
    return { summary };
  }
  if (!ctx.port && !ctx.postgres) throw new YodelError("a backfill step runs its SQL on the environment's server, and this environment has none");
  const receipts =
    ctx.receipts ??
    (ctx.postgres
      ? await postgresServerReceipts(ctx.postgres.client, ctx.postgres.receiptsSchema, ctx.environment)
      : ctx.endpoint
        ? await serverReceipts(ctx.endpoint, ctx.environment)
        : undefined);
  if (!receipts) throw new YodelError("a backfill step needs a receipt store, and this environment has no server endpoint for one");
  const { summary } = await runBackfill(ctx.plan.file, {
    environment: ctx.environment,
    projectDir: ctx.projectDir,
    migrationId: ctx.migration.id,
    dir: ctx.migration.dir,
    text: ctx.migration.files.extra?.[ctx.plan.file],
    ...(ctx.postgres ? { postgres: { client: ctx.postgres.client, timeouts: ctx.postgres.timeouts } } : { port: ctx.port }),
    receipts,
    log: ctx.log,
  });
  return { summary };
};
