/**
 * Commands yodel prints for a person to run (#14): `chant approve ...`,
 * `yodel apply ...`. In a project that installs chant and yodel locally,
 * neither is on PATH, only in node_modules/.bin, so a printed `chant approve`
 * fails with "command not found". Such a command is printed as `npx chant
 * ...` instead, which runs the project's own copy. When the tool is on PATH,
 * or the project does not install it (where `npx` would fetch an unrelated
 * package of that name), the command is printed as it is.
 */

import { accessSync, constants } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { writerPrefix } from "../credentials.js";

const executable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Whether `name` is an executable on `PATH`, not counting `node_modules/.bin`
 * directories: `npx yodel` puts the project's on yodel's PATH, but the
 * person's shell does not have it.
 */
export function onPath(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.PATH ?? "")
    .split(delimiter)
    .some((d) => d !== "" && !/[\\/]node_modules[\\/]\.bin[\\/]?$/.test(d) && executable(join(d, name)));
}

/** Whether `dir` or a directory above it has `node_modules/.bin/<name>`. */
export function installedLocally(name: string, dir: string): boolean {
  for (let d = dir; ; d = dirname(d)) {
    if (executable(join(d, "node_modules", ".bin", name))) return true;
    if (dirname(d) === d) return false;
  }
}

/** `command` as a person can run it in `projectDir`: prefixed with `npx ` when its tool is installed there but not on PATH. */
export function runnable(command: string, projectDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const tool = command.split(" ", 1)[0] ?? "";
  if (tool === "" || tool === "npx" || onPath(tool, env) || !installedLocally(tool, projectDir)) return command;
  return `npx ${command}`;
}

/**
 * A command that writes, as a person can run it in `projectDir` (#159):
 * {@link runnable}, after `YODEL_CREDENTIALS=writer:<env> ` when `profile`
 * has a reader and a writer of its own, so the printed command does not run
 * as the reader.
 */
export function runnableAsWriter(command: string, projectDir: string, profile: unknown, env: NodeJS.ProcessEnv = process.env): string {
  return `${writerPrefix(profile)}${runnable(command, projectDir, env)}`;
}
