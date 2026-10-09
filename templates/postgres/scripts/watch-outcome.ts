/**
 * `tsx scripts/watch-outcome.ts <op>`: after `chant run <op>` in the drift
 * watch's CI job, fails the job when that run found drift.
 *
 * `chant run` exits 0 when a watch completes, drift or not; the drift is the
 * run's `Drift` outcome, in its record on the local chant/lifecycle branch.
 * This reads the newest record of the Op and exits 1 when the run failed or
 * found drift, so a scheduled run that found drift shows red. The report
 * itself is in the `chant run` output above it.
 */

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export interface RunRecord {
  op: string;
  id: string;
  status: string;
  ended?: string;
  outcomes?: Record<string, unknown>;
}

const git = (args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** Every run record of `op` on chant/lifecycle, in no particular order. */
export function runRecords(op: string): RunRecord[] {
  const files = git(["ls-tree", "-r", "--name-only", "chant/lifecycle"])
    .split("\n")
    .filter((f) => f.endsWith(`/runs__${op}.jsonl`));
  return files.flatMap((f) =>
    git(["show", `chant/lifecycle:${f}`])
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as RunRecord),
  );
}

/** The newest record, by when it ended. */
export function newest(records: readonly RunRecord[]): RunRecord | undefined {
  return [...records].sort((a, b) => (a.ended ?? "").localeCompare(b.ended ?? "")).at(-1);
}

/** What the job says, and its exit code. */
export function verdict(op: string, record: RunRecord | undefined): { line: string; code: number } {
  if (!record) return { line: `${op}: no run record on chant/lifecycle`, code: 1 };
  if (record.status !== "ok") return { line: `${op}: run ${record.id} ended ${record.status}`, code: 1 };
  if (record.outcomes?.Drift === true) return { line: `${op}: drift found (run ${record.id}); the report is above`, code: 1 };
  return { line: `${op}: no drift (run ${record.id})`, code: 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const op = process.argv[2];
  if (!op) {
    console.error("usage: tsx scripts/watch-outcome.ts <op>");
    process.exitCode = 1;
  } else {
    const { line, code } = verdict(op, newest(runRecords(op)));
    (code === 0 ? console.log : console.error)(line);
    process.exitCode = code;
  }
}
