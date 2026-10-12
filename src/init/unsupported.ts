/**
 * Objects a live database holds that chant's sql lexicon cannot declare
 * (#251). chant's import refuses them by name (INTENTIUS/chant#3911), and
 * `yodel init --from` passes that refusal on; `yodel drift` lists them as
 * unmanaged, read here with the same catalog probes chant's import runs, so
 * the kinds are chant's coverage table's (its object-coverage page).
 */

import type { UndeclarableObject } from "@intentius/chant-lexicon-sql/core/undeclarable";
import { YodelError, type Environment, type Project } from "../project.js";

/** One object of a kind the lexicon cannot declare. */
export type Unsupported = UndeclarableObject;

/** `aggregate app.total(integer)`. */
export const describeUnsupported = (u: Unsupported): string => `${u.kind} ${u.schema ? `${u.schema}.` : ""}${u.name}`;

/** The objects `env` holds that the lexicon cannot declare, in chant's order (by kind, then name). */
export async function findUnsupported(project: Project, env: Environment, processEnv: NodeJS.ProcessEnv = process.env): Promise<Unsupported[]> {
  if (project.dialect === "postgres") {
    const { resolvePostgresTarget, isUnresolvedTarget } = await import("@intentius/chant-lexicon-sql/postgres/live/bind");
    const target = resolvePostgresTarget({ environment: env.name, config: project.config, env: processEnv });
    if (isUnresolvedTarget(target)) throw new YodelError(`${env.name}: ${target.detail}`);
    const schemas = env.profile.schemas ?? target.schemas;
    const { connectPostgres } = await import("@intentius/chant-lexicon-sql/postgres/live/client");
    const { readUndeclarable } = await import("@intentius/chant-lexicon-sql/postgres/live/undeclarable");
    const client = await connectPostgres(target.endpoint, { applicationName: "yodel drift" });
    try {
      return (await readUndeclarable(client, schemas ? { schemas } : {})).objects;
    } finally {
      await client.end();
    }
  }
  const { bindClickHouse } = await import("@intentius/chant-lexicon-sql/clickhouse/live/bind");
  const { readUndeclarable } = await import("@intentius/chant-lexicon-sql/clickhouse/live/undeclarable");
  const target = await bindClickHouse({ environment: env.name, config: project.config, cwd: project.dir, env: processEnv });
  return (await readUndeclarable(target)).objects;
}
