/**
 * Running a command from a claim: every one has a timeout, and on timeout
 * its whole process group is killed, so nothing a claim starts can hang the
 * run. Each command and its output go to stdout, which is the claim's log,
 * so the runner sees the log grow while a claim is working.
 */

import { spawn } from "node:child_process";

export interface Ran {
  code: number;
  out: string;
  err: string;
  timedOut: boolean;
}

export interface RunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Milliseconds before the command and its children are killed. Default 5 minutes. */
  timeoutMs?: number;
  /** Echo stdout to the log (default true). */
  echo?: boolean;
}

const indent = (text: string) =>
  text
    .split("\n")
    .filter((l, i, all) => l !== "" || i < all.length - 1)
    .map((l) => `    ${l}`)
    .join("\n");

/** Runs `cmd args`, resolving with its exit code and output; never rejects on a non-zero exit. */
export function run(cmd: string, args: readonly string[], options: RunOptions): Promise<Ran> {
  const timeoutMs = options.timeoutMs ?? 300_000;
  const shown = [cmd, ...args].map((a) => (/[\s"'$]/.test(a) ? JSON.stringify(a) : a)).join(" ");
  process.stdout.write(`  $ ${shown}\n`);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let out = "";
    let err = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      out += c;
      if (options.echo !== false) process.stdout.write(indent(c) + "\n");
    });
    child.stderr.on("data", (c: string) => {
      err += c;
      process.stdout.write(indent(c) + "\n");
    });
    const timer = setTimeout(() => {
      timedOut = true;
      process.stdout.write(`  timed out after ${String(timeoutMs / 1000)}s: ${shown}; killing its process group\n`);
      killGroup(child.pid);
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const exit = timedOut ? 124 : (code ?? (signal ? 128 : 1));
      process.stdout.write(`  -> exit ${String(exit)}\n`);
      resolve({ code: exit, out, err, timedOut });
    });
  });
}

/** SIGKILL a process group started with `detached: true`; quiet when it is gone. */
export function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}
