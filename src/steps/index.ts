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
import { loadProject, resolveEnvironment, YodelError, type ProjectConfig, type TenantOf } from "../project.js";
import { renameIdentifier } from "../tenants/target.js";
import { runBackfill, serverReceipts, type PgBackfillServer } from "./backfill.js";
import type { StepPlan } from "./kinds.js";
import { rebuildChantConfig, runRebuild, type RebuildReceiptStore } from "./rebuild.js";
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
  /** The server, for the backfill's receipt store; the port is enough for everything else. */
  endpoint?: ClickHouseEndpoint | undefined;
  migration: Migration;
  index: number;
  plan: Exclude<StepPlan, { run: "statement" } | { run: "refused" }>;
  log: (line: string) => void;
  /** A backfill's receipt store; default the sql lexicon's on the server. */
  receipts?: ReceiptStore | undefined;
  /** A rebuild's partition receipts; default the sql lexicon's on the server (`chant_receipts.receipts`). `yodel test` keeps each case's apart (#112). */
  rebuildReceipts?: RebuildReceiptStore | undefined;
  /** The tenant the step runs on (#56): what the step names in the template is renamed to the tenant. */
  tenant?: TenantOf | undefined;
}

/** `value` with the template renamed in every string it holds (#56), as statements are. */
export function renameDeep(value: unknown, rename: (s: string) => string): unknown {
  if (typeof value === "string") return rename(value);
  if (Array.isArray(value)) return value.map((v) => renameDeep(v, rename));
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renameDeep(v, rename)]));
  return value;
}

/**
 * What an Op step runs with on a tenant (#56): its options and the recorded
 * schema with the template renamed to the tenant, and the project's chant
 * config with the tenant's profile in it, which the Op's activities bind
 * with in place of chant.config.ts.
 */
export async function tenantStep(projectDir: string, environment: string, tenant: TenantOf): Promise<{ rename: (s: string) => string; config: ProjectConfig }> {
  const project = await loadProject(projectDir);
  resolveEnvironment(project, environment);
  return { rename: (s) => renameIdentifier(s, tenant.template, tenant.name), config: project.config };
}

/** Runs one Op step to the end and returns the summary its history row records. Throws `StepOpFailed` when it stops part way. */
export type StepRunner = (ctx: StepContext) => Promise<{ summary: unknown }>;

export const defaultStepRunner: StepRunner = async (ctx) => {
  const tenant = ctx.tenant ? await tenantStep(ctx.projectDir, ctx.environment, ctx.tenant) : undefined;
  const schema = tenant ? renameDeep(ctx.migration.document.schema, tenant.rename) : ctx.migration.document.schema;
  if (ctx.plan.run === "rebuild") {
    const options = tenant ? { ...ctx.plan.options, table: tenant.rename(ctx.plan.options.table) } : ctx.plan.options;
    const config = await rebuildChantConfig(ctx.projectDir, ctx.environment, process.env, tenant?.config);
    const { summary } = await runRebuild(options, { environment: ctx.environment, projectDir: ctx.projectDir, schema, log: ctx.log, config, ...(ctx.rebuildReceipts ? { receipts: ctx.rebuildReceipts } : {}) });
    return { summary };
  }
  if (ctx.plan.run === "pgMigration") {
    const options = tenant ? { ...ctx.plan.options, table: tenant.rename(ctx.plan.options.table) } : ctx.plan.options;
    const { summary } = await runPgMigration(options, { environment: ctx.environment, projectDir: ctx.projectDir, schema, lockTimeoutMs: ctx.lockTimeoutMs, log: ctx.log, config: tenant?.config });
    return { summary };
  }
  if (!ctx.port && !ctx.postgres) throw new YodelError("a backfill step runs its SQL on the environment's server, and this environment has none");
  const receipts =
    ctx.receipts ??
    (ctx.postgres
      ? await serverReceipts({ postgres: ctx.postgres.client, schema: ctx.postgres.receiptsSchema }, ctx.environment)
      : ctx.endpoint
        ? await serverReceipts({ clickhouse: ctx.endpoint }, ctx.environment)
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
    ...(tenant ? { rename: tenant.rename } : {}),
  });
  return { summary };
};
