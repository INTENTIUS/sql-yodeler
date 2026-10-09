/**
 * Reading a live database as declarations: the library functions behind
 * `chant import --from <env>`, called in process with the project's own
 * config, so the server read is the one `sql.profiles.<env>` binds and the
 * files written are the ones `chant import --from` writes.
 *
 * chant's import already strips its ownership marker from every comment it
 * reads, so the declarations say what an author would, and an object that
 * carries no marker (one made by hand) reads the same as one chant made.
 */

import type { GeneratedFile } from "@intentius/chant/import/generator";
import type { TemplateIR } from "@intentius/chant/import/parser";
import { YodelError, type Environment, type Project } from "../project.js";

export interface LiveImport {
  /** What the server holds, as chant's import IR: one resource per object. */
  ir: TemplateIR;
  /** The declaration files, paths relative to the source directory (chant's sql generator writes one, `schema.ts`). */
  files: GeneratedFile[];
  /** What the import left out or could not carry, as chant reports it. */
  warnings: string[];
}

/** The objects an import read, as `<type> <name>` lines for people. */
export function describeImported(ir: TemplateIR): string[] {
  return ir.resources.map((r) => {
    const p = r.properties as { database?: string; schema?: string; name?: string };
    const where = p.database ?? p.schema;
    return `${r.type.replace(/^(ClickHouse|Postgres)::/, "")} ${where ? `${where}.` : ""}${p.name ?? r.logicalId}`;
  });
}

/**
 * Reads the environment's live database and generates its declarations,
 * exactly as `chant import --from <env>` does. Nothing is written.
 */
export async function importLive(project: Project, env: Environment, processEnv: NodeJS.ProcessEnv = process.env): Promise<LiveImport> {
  const options = { environment: env.name, config: project.config as never, cwd: project.dir, env: processEnv };
  let exported: { resources: TemplateIR["resources"]; parameters?: TemplateIR["parameters"]; warnings?: string[] };
  try {
    if (project.dialect === "postgres") {
      const { exportResources } = await import("@intentius/chant-lexicon-sql/postgres/import/live-export");
      exported = await exportResources(options);
    } else {
      const { exportResources } = await import("@intentius/chant-lexicon-sql/clickhouse/import/live-export");
      exported = await exportResources(options);
    }
  } catch (e) {
    throw new YodelError(`reading ${env.name}'s live schema failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const ir: TemplateIR = { resources: exported.resources, parameters: exported.parameters ?? [] };
  const { sqlTemplateGenerator } = await import("@intentius/chant-lexicon-sql/import-generator");
  const files = ir.resources.length === 0 ? [] : sqlTemplateGenerator.generate(ir);
  return { ir, files, warnings: exported.warnings ?? [] };
}
