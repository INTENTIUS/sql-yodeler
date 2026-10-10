/**
 * DDL sources (#67): schema that an ORM defines, read from the DDL it
 * prints, beside the declarations in `src/`.
 *
 * ```ts
 * // yodel.config.ts
 * export default defineConfig({
 *   sources: {
 *     prisma: { command: "npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script", schema: "app" },
 *     legacy: { file: "db/legacy.sql" },
 *   },
 * });
 * ```
 *
 * Before each build, yodel runs each source's command (or reads its file)
 * in the project directory and writes the DDL out as declarations in
 * `<sourceDir>/<name>.generated.ts`, the file `chant import` would write.
 * The build, and so plan, new, apply and drift, read it like any other
 * declaration; the ApplyOp's own build finds it there too. Commit it: a
 * build that does not run yodel (chant build, an Op run elsewhere) reads
 * the committed file.
 *
 * Each object has one owner: an object a source creates that `src/` (or
 * another source) also declares is an error, naming both.
 */

import { exec } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { BuildOutput } from "../chant/build.js";
import { YodelError, type Project } from "../project.js";
import { ddlToDeclarations, type DdlObject } from "./ddl.js";

/** One source, in yodel.config.ts `sources.<name>`. */
export interface DdlSource {
  /** A shell command, run in the project directory, that prints the DDL on stdout. */
  command?: string;
  /** A file of DDL, relative to the project directory. */
  file?: string;
  /**
   * The Postgres schema (ClickHouse database) for the names the DDL leaves
   * unqualified, as an ORM does when the schema comes from its connection.
   */
  schema?: string;
}

/** What one source wrote. */
export interface SyncedSource {
  name: string;
  /** The generated file, relative to the project directory. */
  path: string;
  objects: DdlObject[];
}

const SOURCE_NAME = /^[a-z][a-z0-9-]*$/;

/** The generated file a source writes, relative to the project directory. */
export const generatedPath = (project: Project, name: string): string => join(project.sourceDir, `${name}.generated.ts`);

/** Checks `sources` in yodel.config.ts. */
export function checkSources(value: unknown, where: string): Record<string, DdlSource> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new YodelError(`${where}: expected an object keyed by source name`);
  for (const [name, source] of Object.entries(value as Record<string, unknown>)) {
    const at = `${where}.${name}`;
    if (!SOURCE_NAME.test(name)) throw new YodelError(`${at}: a source's name is lowercase letters, digits and -, starting with a letter`);
    if (typeof source !== "object" || source === null || Array.isArray(source)) throw new YodelError(`${at}: expected { command } or { file }`);
    for (const k of Object.keys(source)) if (!["command", "file", "schema"].includes(k)) throw new YodelError(`${at}.${k}: unknown setting (expected command, file, schema)`);
    const s = source as Record<string, unknown>;
    if ((s.command === undefined) === (s.file === undefined)) throw new YodelError(`${at}: give one of command and file`);
    for (const k of ["command", "file", "schema"]) {
      if (s[k] !== undefined && (typeof s[k] !== "string" || s[k] === "")) throw new YodelError(`${at}.${k}: expected a non-empty string`);
    }
  }
  return value as Record<string, DdlSource>;
}

function runCommand(command: string, cwd: string, env: NodeJS.ProcessEnv | undefined): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(command, { cwd, env: env ?? process.env, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new YodelError(`${command} failed (exit ${String(error.code ?? "?")})${stderr.trim() ? `:\n${stderr.trim()}` : ""}`));
      else resolve(stdout);
    });
  });
}

/** Reads one source's DDL. */
async function readDdl(project: Project, name: string, source: DdlSource, env: NodeJS.ProcessEnv | undefined): Promise<{ ddl: string; origin: string }> {
  if (source.command !== undefined) {
    const origin = `sources.${name} (${source.command})`;
    try {
      return { ddl: await runCommand(source.command, project.dir, env), origin };
    } catch (e) {
      throw new YodelError(`yodel.config.ts sources.${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const given = source.file ?? "";
  const file = isAbsolute(given) ? given : join(project.dir, given);
  if (!existsSync(file)) throw new YodelError(`yodel.config.ts sources.${name}: no file ${relative(project.dir, file)}`);
  return { ddl: readFileSync(file, "utf8"), origin: `sources.${name} (${relative(project.dir, file)})` };
}

/**
 * Writes each source's declarations to its generated file, and returns what
 * each declared. A file whose content is unchanged is not rewritten.
 */
export async function syncSources(project: Project, options: { env?: NodeJS.ProcessEnv } = {}): Promise<SyncedSource[]> {
  const sources = project.yodel?.config.sources ?? {};
  const synced: SyncedSource[] = [];
  for (const [name, source] of Object.entries(sources)) {
    const { ddl, origin } = await readDdl(project, name, source, options.env);
    const how = source.command !== undefined ? `the output of: ${source.command}` : `the DDL in ${source.file ?? ""}`;
    const declarations = await ddlToDeclarations(project.dialect, ddl, {
      origin: `yodel.config.ts ${origin}`,
      schema: source.schema,
      header: `Generated by yodel from the DDL source "${name}" in yodel.config.ts,\n${how}\nDo not edit: yodel writes it again before each build.`,
    });
    const path = generatedPath(project, name);
    const full = join(project.dir, path);
    const before = existsSync(full) ? readFileSync(full, "utf8") : undefined;
    if (before !== declarations.content) writeFileSync(full, declarations.content);
    synced.push({ name, path, objects: declarations.objects });
  }
  return synced;
}

/**
 * chant's build refuses two declarations exported under one name. When one
 * of them is a source's, that is an object declared twice: say so, naming
 * the source.
 */
export function duplicateExport(buildOutput: string, synced: readonly SyncedSource[]): YodelError | undefined {
  const name = /Duplicate export name "([^"]+)"/.exec(buildOutput)?.[1];
  if (!name) return undefined;
  const owners = synced.flatMap((s) => s.objects.filter((o) => o.export === name).map((o) => ({ source: s, object: o })));
  const [first] = owners;
  if (!first) return undefined;
  const elsewhere = owners.length > 1 ? `the source "${owners[1]?.source.name ?? ""}"` : "src/";
  return new YodelError(
    `each object has one owner, and ${first.object.name} is declared twice: by ${elsewhere} (export ${name}) and by the source "${first.source.name}" (${first.source.path}). Leave it to one of them.`,
  );
}

/** `schema.name` of a built object, read from its CREATE, or undefined when it cannot be read. */
async function builtName(dialect: BuildOutput["dialect"], type: string | undefined, ddl: string): Promise<string | undefined> {
  try {
    const first = ddl.split(/;\s*\n\s*COMMENT ON\b/i)[0] ?? ddl;
    const [object] = (await ddlToDeclarations(dialect, first, { origin: "build" })).objects;
    return object && (type === undefined || object.type === type) ? object.name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Each object declared once: an object a source creates that another export
 * in the build (in `src/`, or another source) also creates is an error.
 */
export async function checkOwnership(output: BuildOutput, synced: readonly SyncedSource[]): Promise<void> {
  if (synced.length === 0) return;
  const owner = new Map<string, { source: SyncedSource; object: DdlObject }>();
  for (const source of synced) for (const object of source.objects) owner.set(`${object.type} ${object.name}`, { source, object });
  const problems: string[] = [];
  for (const built of output.objects) {
    if (synced.some((s) => s.objects.some((o) => o.export === built.export))) continue;
    const name = await builtName(output.dialect, built.type, built.ddl);
    if (!name) continue;
    const hit = owner.get(`${built.type ?? ""} ${name}`);
    if (hit) problems.push(`${name} is declared by ${built.export} and by the source "${hit.source.name}" (${hit.object.export} in ${hit.source.path})`);
  }
  const seen = new Map<string, string>();
  for (const source of synced) {
    for (const object of source.objects) {
      const key = `${object.type} ${object.name}`;
      const other = seen.get(key);
      if (other && other !== source.name) problems.push(`${object.name} is declared by the sources "${other}" and "${source.name}"`);
      seen.set(key, source.name);
    }
  }
  if (problems.length > 0) throw new YodelError(`each object has one owner, and ${problems.length === 1 ? "one is declared twice" : `${String(problems.length)} are declared twice`}:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
}
