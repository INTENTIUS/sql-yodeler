/**
 * Building the declared schema: `chant build <sourceDir> --lexicon sql`, the
 * same build the project's ApplyOp runs, written to a file the planner reads.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YodelError, type Project, type SqlDialect } from "../project.js";
import { runChant } from "./process.js";

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
export async function buildSchema(project: Project, options: { out?: string; env?: NodeJS.ProcessEnv } = {}): Promise<Build> {
  const tmp = options.out ? undefined : mkdtempSync(join(tmpdir(), "yodel-build-"));
  const path = options.out ?? join(tmp ?? ".", "schema.json");
  const dispose = () => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  };
  try {
    const result = await runChant(["build", project.sourceDir, "--lexicon", "sql", "-o", path], {
      cwd: project.dir,
      ...(options.env ? { env: options.env } : {}),
    });
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      throw new YodelError(`chant build failed in ${project.dir}${detail ? `:\n${detail}` : ""}`);
    }
    let output: BuildOutput;
    try {
      output = JSON.parse(readFileSync(path, "utf8")) as BuildOutput;
    } catch (e) {
      throw new YodelError(`chant build wrote no readable output at ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (output.dialect !== project.dialect) {
      throw new YodelError(`the build holds ${output.dialect} objects, but the project's dialect is ${project.dialect}`);
    }
    return { path, output, dispose };
  } catch (e) {
    dispose();
    throw e;
  }
}
