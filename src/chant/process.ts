/**
 * Running the `chant` CLI that yodel depends on, for the commands that have
 * no library surface (`build`, `run`, `lifecycle diff`).
 *
 * The chant it runs is the one in yodel's own dependencies, not whatever
 * `chant` is first on PATH: chant's `bundledChant`, spawned with
 * `chantArgv` and `chantEnv` from `@intentius/chant/chant-install` (chant
 * issue 4800), which put that chant's bin first on the child's PATH, because
 * chant's Op activities shell out to `chant` themselves (`lifecycleDiff`
 * runs `chant lifecycle diff`).
 *
 * A child runs in chant's own words, not yodel's (#287): ../chant/apply.ts
 * reads chant's `approve: chant approve ...` line from its output for the
 * `chantApprove` field scripts use. `yodel chant <args>` is the line that
 * runs chant in yodel's words (../commands/chant.ts).
 */

import { spawn } from "node:child_process";
import { chantArgv, chantEnv as chantInstallEnv } from "@intentius/chant/chant-install";
import { fallbackImportArgs } from "./resolve-fallback.js";

export interface ChantResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunChantOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Called with each chunk as it arrives, for output a person watches (an Op run). */
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
}

/** The environment a chant child runs with: the caller's, with chant's bin first on PATH, and no colour. */
export function chantEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...chantInstallEnv(base), FORCE_COLOR: "0", NO_COLOR: "1" };
}

/** Runs `chant <args>` in `cwd` and resolves with its exit code and output. Never rejects on a non-zero exit. */
export function runChant(args: readonly string[], options: RunChantOptions): Promise<ChantResult> {
  const [node = process.execPath, ...argv] = chantArgv(args, { nodeArgs: fallbackImportArgs() });
  return new Promise((resolvePromise, reject) => {
    const child = spawn(node, argv, {
      cwd: options.cwd,
      env: chantEnv(options.env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      options.onStdout?.(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      options.onStderr?.(chunk);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolvePromise({ code: code ?? (signal ? 128 : 1), stdout, stderr });
    });
  });
}

/** The last line of `stdout` that parses as a JSON object: chant prints its `--json` document as one line, after any log lines. */
export function lastJsonLine(stdout: string): unknown {
  const lines = stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{"));
  for (const line of lines.reverse()) {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      // A log line that happens to start with "{"; keep looking.
    }
  }
  // A pretty-printed document spans lines; try the whole of stdout from its first "{".
  const at = stdout.indexOf("{");
  if (at >= 0) {
    try {
      return JSON.parse(stdout.slice(at)) as unknown;
    } catch {
      // Not JSON.
    }
  }
  return undefined;
}
