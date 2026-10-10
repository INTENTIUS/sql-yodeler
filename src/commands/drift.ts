import type { Command } from "../command.js";
import { guarded, parseEnvArgs, usage } from "../env-args.js";
import { loadProject, resolveEnvironment } from "../project.js";
import { declarativeTopologyRefusal } from "../config/settings.js";
import { declaredColumns, driftExitCode, readDrift, renderDrift } from "../chant/drift.js";
import { buildSchema } from "../chant/build.js";
import { probeServer, softly } from "../server.js";
import type { Environment, Project } from "../project.js";
import { describeHolders, describeMs, isLockTimeout, lockHolders, lockTimeoutOptions } from "../versioned/postgres/waits.js";
import { DEFAULT_PG_TIMEOUTS } from "../versioned/postgres/executor.js";
import type { PostgresEndpoint } from "@intentius/chant-lexicon-sql/postgres/live/client";

interface PgLockSettings {
  endpoint: PostgresEndpoint;
  schemas: string[] | undefined;
  lockTimeoutMs: number;
}

/** The profile's lock timeout (#18), which chant's read runs under, and where to look for the lock when it passes. */
async function postgresLockSettings(project: Project, env: Environment): Promise<PgLockSettings | undefined> {
  const { resolvePostgresTarget, isUnresolvedTarget } = await import("@intentius/chant-lexicon-sql/postgres/live/bind");
  const target = resolvePostgresTarget({ environment: env.name, config: project.config, env: process.env });
  if (isUnresolvedTarget(target)) return undefined;
  return { endpoint: target.endpoint, schemas: target.schemas, lockTimeoutMs: target.timeouts?.lockTimeoutMs ?? DEFAULT_PG_TIMEOUTS.lockTimeoutMs };
}

/** What the read waited on: `waited 5s for a lock on shop.orders (held by pid 123, psql)`. */
async function lockWait(pg: PgLockSettings): Promise<string> {
  const { connectPostgres } = await import("@intentius/chant-lexicon-sql/postgres/live/client");
  const holders = await softly(async () => {
    const client = await connectPostgres(pg.endpoint, { applicationName: "yodel" });
    try {
      return await lockHolders(client, pg.schemas);
    } finally {
      await client.end();
    }
  });
  return `waited ${describeMs(pg.lockTimeoutMs)} (lockTimeoutMs) for ${describeHolders(holders ?? [])}; run yodel drift again once it is released`;
}

const help = `${usage("drift")}

Reports the declared objects changed out of band or gone from the
environment, from chant lifecycle diff <env> --live. Objects the project does
not declare are never reported.

Options:
  --json           print the drift as JSON
  -C, --dir <dir>  the project directory (default: the working directory)

Exit codes:
  0  no drift
  2  a declared object changed out of band, or is gone
  1  the drift could not be read, or there is none but a declared object
     could not be read (its state is unknown, not clean)
`;

/** `yodel drift <env>`; the exit codes are in `help`. */
export const drift: Command = {
  name: "drift",
  summary: "report declared objects changed out of band or gone",
  implemented: true,
  run: (args, io) =>
    guarded("drift", io, args, help, async () => {
      const { env: name, json, dir } = parseEnvArgs("drift", args);
      const project = await loadProject(dir);
      const env = resolveEnvironment(project, name);
      // chant renders the declaration for sql.profiles.<env>.topology alone; a different one in yodel.config.ts would show every replicated engine as drift.
      const refusal = project.dialect === "clickhouse" ? declarativeTopologyRefusal(project, env.name) : undefined;
      if (refusal) throw refusal;
      const server = await probeServer(project, env);
      const pg = project.dialect === "postgres" ? await postgresLockSettings(project, env) : undefined;
      const result = await readDrift(project, env, pg ? { env: { ...process.env, PGOPTIONS: lockTimeoutOptions(pg.lockTimeoutMs, process.env.PGOPTIONS) } } : {});
      if (pg && result.unobserved.some((u) => isLockTimeout(u.detail) || isLockTimeout(u.reason))) result.lockWait = await lockWait(pg);
      const columns = await declaredColumns(project, result, () => buildSchema(project)).catch(() => ({}));
      if (Object.keys(columns).length > 0) result.columns = columns;
      const code = driftExitCode(result);
      if (json) io.out(`${JSON.stringify({ ...result, dialect: project.dialect, ...(server ? { server } : {}), drifted: code === 2 }, null, 2)}\n`);
      else io.out(renderDrift(result, server));
      return code;
    }),
};
