/**
 * Building the declared schema: `chant build <sourceDir> --lexicon sql`, the
 * same build the project's ApplyOp runs, written to a file the planner reads.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YodelError, type Project, type SqlDialect } from "../project.js";
import { runChant } from "./process.js";
import { checkOwnership, duplicateExport, syncSources } from "../sources/index.js";

/** One declared object as the sql lexicon's build output holds it. */
export interface BuiltObject {
  export: string;
  type?: string;
  ddl: string;
  dependsOn?: string[];
}

/** The sql lexicon's build output (`dist/schema.json`). */
export interface BuildOutput {
  dialect: SqlDialect;
  objects: BuiltObject[];
  [key: string]: unknown;
}

export interface Build {
  /** The build output file. */
  path: string;
  output: BuildOutput;
  /** Removes the file and its directory, when yodel made them. */
  dispose: () => void;
}

/**
 * Builds the project's declared schema. Writes to `out` when given, else to
 * a temporary directory that {@link Build.dispose} removes. A build that
 * fails, or that holds another dialect than the project's, is an error.
 */
export async function buildSchema(project: Project, options: { out?: string; env?: NodeJS.ProcessEnv; empty?: boolean } = {}): Promise<Build> {
  const tmp = options.out ? undefined : mkdtempSync(join(tmpdir(), "yodel-build-"));
  const path = options.out ?? join(tmp ?? ".", "schema.json");
  const dispose = () => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  };
  try {
    // The DDL sources (#67) first: their declarations are part of the build.
    const synced = await syncSources(project, options.env ? { env: options.env } : {});
    // --root-only: a project with its own chant.workspace.json (a template's, or one `yodel upgrade` wrote) is a
    // declared workspace root, where chant build refuses with WSP000 unless told to build the root project alone.
    const result = await runChant(["build", project.sourceDir, "--lexicon", "sql", "--root-only", "-o", path], {
      cwd: project.dir,
      ...(options.env ? { env: options.env } : {}),
    });
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      const duplicate = duplicateExport(detail, synced);
      if (duplicate) throw duplicate;
      throw new YodelError(`chant build failed in ${project.dir}${detail ? `:\n${detail}` : ""}`);
    }
    let output: BuildOutput;
    try {
      output = JSON.parse(readFileSync(path, "utf8")) as BuildOutput;
    } catch (e) {
      throw new YodelError(`chant build wrote no readable output at ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
    // A source directory that declares nothing builds no dialect; `empty` takes it as an empty schema of the project's.
    // chant's output type always has both; a build of nothing has neither.
    const raw = output as { dialect?: unknown; objects?: unknown[] };
    if (options.empty === true && raw.dialect === undefined && (raw.objects ?? []).length === 0) output = { ...output, dialect: project.dialect, objects: [] };
    if (output.dialect !== project.dialect) {
      throw new YodelError(`the build holds ${output.dialect} objects, but the project's dialect is ${project.dialect}`);
    }
    await checkOwnership(output, synced);
    return { path, output, dispose };
  } catch (e) {
    dispose();
    throw e;
  }
}
