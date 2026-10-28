/**
 * Running the `chant` CLI that yodel depends on, for the commands that have
 * no library surface (`build`, `run`, `lifecycle diff`).
 *
 * Published chant ships TypeScript source, and its own bin runs
 * `node --import <tsx loader> src/cli/main.ts`. yodel does the same with its
 * own copy of tsx, so the chant it runs is the one in its own dependencies,
 * not whatever `chant` is first on PATH. That chant's `bin/` goes first on the
 * child's PATH, because chant's Op activities shell out to `chant` themselves
 * (`lifecycleDiff` runs `chant lifecycle diff`).
 *
 * A child runs in chant's own words, not yodel's (#287): ../chant/apply.ts
 * reads chant's `approve: chant approve ...` line from its output for the
 * `chantApprove` field scripts use. `yodel chant <args>` is the line that
 * runs chant in yodel's words (../commands/chant.ts).
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";

export interface ChantInstall {
  /** The `@intentius/chant` package directory. */
  root: string;
  /** Its CLI entry, `src/cli/main.ts`. */
  main: string;
  /** Its `bin/`, which holds the `chant` script. */
  bin: string;
  /** The tsx loader to run it under, as a file URL. */
  loader: string;
}

let install: ChantInstall | undefined;

/** Where yodel's chant and tsx are installed. */
export function chantInstall(): ChantInstall {
  if (install) return install;
  const require = createRequire(import.meta.url);
  // "." resolves to <root>/src/index.ts; package.json is not an export.
  const root = dirname(dirname(require.resolve("@intentius/chant")));
  install = {
    root,
    main: join(root, "src", "cli", "main.ts"),
    bin: join(root, "bin"),
    loader: pathToFileURL(require.resolve("tsx")).href,
  };
  return install;
}

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

/** The environment a chant child runs with: the caller's, with chant's bin first on PATH. */
export function chantEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { bin } = chantInstall();
  return { ...base, PATH: [bin, base.PATH ?? ""].filter(Boolean).join(delimiter), FORCE_COLOR: "0", NO_COLOR: "1" };
}

/** Runs `chant <args>` in `cwd` and resolves with its exit code and output. Never rejects on a non-zero exit. */
export function runChant(args: readonly string[], options: RunChantOptions): Promise<ChantResult> {
  const { main, loader } = chantInstall();
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--import", loader, main, ...args], {
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
