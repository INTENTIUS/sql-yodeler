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
import { environmentAccess } from "../config/settings.js";
import { clickhouseAccessDeclarations } from "./clickhouse-access.js";

export interface LiveImport {
  /** What the server holds, as chant's import IR: one resource per object. */
  ir: TemplateIR;
  /** The declaration files, paths relative to the source directory (chant's sql generator writes one, `schema.ts`). */
  files: GeneratedFile[];
  /** What the import left out or could not carry, as chant reports it. */
  warnings: string[];
  /** Live objects left out as another tool's (`<database>.<name>`), which a plan then shows as undeclared. */
  leftOut: string[];
  /** ClickHouse, where the environment manages access (#46): the users, roles, row policies and grants adopted into `access.ts`, as `<kind> <name>`. */
  access?: string[];
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
  const warnings = [...(exported.warnings ?? [])];
  const leftOut: string[] = [];
  const resources = project.dialect === "clickhouse" ? await withoutRunnerTables(exported.resources, warnings, leftOut) : exported.resources;
  const ir: TemplateIR = { resources, parameters: exported.parameters ?? [] };
  const { sqlTemplateGenerator } = await import("@intentius/chant-lexicon-sql/import-generator");
  const files = ir.resources.length === 0 ? [] : sqlTemplateGenerator.generate(ir);
  if (project.dialect === "clickhouse" && accessManaged(project, env.name)) {
    const adopted = await clickhouseAccessDeclarations(project, env, ir, processEnv).catch((e: unknown) => {
      throw new YodelError(`reading ${env.name}'s users, roles, row policies and grants failed: ${e instanceof Error ? e.message : String(e)}`);
    });
    warnings.push(...adopted.warnings);
    if (adopted.file) files.push(adopted.file);
    return { ir, files, warnings, leftOut, access: adopted.objects };
  }
  return { ir, files, warnings, leftOut };
}

/**
 * ClickHouse: leaves out a table another migration runner keeps its history
 * in (golang-migrate's and dbmate's `schema_migrations`, goose's
 * `goose_db_version`, ...), with the warning chant's Postgres import gives
 * for the same table (#17). chant's ClickHouse import adopts them; declaring
 * one would have chant change what that tool owns. The names are chant's own
 * list, `FOREIGN_TABLES`.
 */
export async function withoutRunnerTables(resources: TemplateIR["resources"], warnings: string[], leftOut: string[] = []): Promise<TemplateIR["resources"]> {
  const { FOREIGN_TABLES } = await import("@intentius/chant-lexicon-sql/postgres/live/catalog");
  return resources.filter((r) => {
    const p = r.properties as { database?: string; name?: string };
    const tool = r.type === "ClickHouse::Table" && p.name !== undefined && Object.hasOwn(FOREIGN_TABLES, p.name) ? FOREIGN_TABLES[p.name] : undefined;
    if (tool === undefined) return true;
    leftOut.push(`${p.database ? `${p.database}.` : ""}${String(p.name)}`);
    warnings.push(`${p.database ? `${p.database}.` : ""}${String(p.name)} is kept by ${tool}; left out, since declaring it would have chant change what that tool owns`);
    return false;
  });
}

/** Whether environment `name` manages access: yodel.config.ts's `environments.<env>.access`, then the profile's, then off. */
export function accessManaged(project: Pick<Project, "yodel" | "profileAccess">, name: string): boolean {
  const chant = project.profileAccess?.[name];
  return environmentAccess(project.yodel?.config.environments?.[name], chant !== undefined ? { access: chant } : undefined, name).access;
}
