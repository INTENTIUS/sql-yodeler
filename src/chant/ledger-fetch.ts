/**
 * The CI jobs' fetch of `chant/lifecycle` (#326), through chant's reader.
 *
 * A CI checkout fetches one ref, so each job fetches the ledger before it
 * reads an approval. chant's push leases against the remote-tracking ref
 * `refs/remotes/<remote>/chant/lifecycle`, so a read that force-moves it, or
 * the local branch, can make a later push overwrite another writer's
 * records, or be refused as stale. yodel therefore writes neither ref: it
 * asks chant's `fetchLifecycleStatus`, which fetches the way chant's writer
 * expects (un-forced, from the ledger's remote, `CHANT_LIFECYCLE_REMOTE` or
 * `origin`), and says what it found.
 */

import type { Io } from "../command.js";

/** What chant's fetch said, as `fetchLifecycleStatus` (chant lifecycle/git.ts) reports it. */
export type LedgerFetch =
  | { status: "fetched" }
  | { status: "no-remote" }
  | { status: "absent"; remote: string }
  | { status: "ahead"; remote: string }
  | { status: "diverged"; remote: string; stderr: string }
  | { status: "unreachable"; remote: string; stderr: string };

/**
 * The line a job prints for `f`, and its exit code. Only a ledger that has
 * forked from the remote's fails the job: reading it would drop one side's
 * records. A remote that did not answer is said and the job goes on, as an
 * approval chant cannot read still stops at the gate.
 */
export function ledgerFetchLine(f: LedgerFetch): { line: string; code: number; stream: "out" | "err" } {
  switch (f.status) {
    case "fetched":
      return { line: "chant/lifecycle: fetched", code: 0, stream: "out" };
    case "ahead":
      return { line: `chant/lifecycle: fetched from ${f.remote}; this checkout's records not yet pushed were kept on its tip`, code: 0, stream: "out" };
    case "no-remote":
      return { line: "chant/lifecycle: no remote, so the local branch is the ledger", code: 0, stream: "out" };
    case "absent":
      return { line: `chant/lifecycle: ${f.remote} has no chant/lifecycle branch yet, so nothing is approved`, code: 0, stream: "out" };
    case "unreachable":
      return { line: `chant/lifecycle: could not fetch from ${f.remote}${f.stderr.trim() ? ` (${f.stderr.trim().split("\n")[0] ?? ""})` : ""}; an approval there is not read`, code: 0, stream: "err" };
    case "diverged":
      return { line: `chant/lifecycle: this checkout's branch and ${f.remote}'s have diverged, so it is not read; fetch it into a clean checkout`, code: 1, stream: "err" };
  }
}

/** `yodel ci --fetch-ledger`: chant's fetch of the ledger in `dir`'s repository, said in one line. */
export async function fetchLedger(dir: string, io: Pick<Io, "out" | "err">): Promise<number> {
  const { fetchLifecycleStatus } = (await import("@intentius/chant/lifecycle/git")) as { fetchLifecycleStatus: (o: { cwd?: string }) => Promise<LedgerFetch> };
  const said = ledgerFetchLine(await fetchLifecycleStatus({ cwd: dir }));
  io[said.stream](`${said.line}\n`);
  return said.code;
}
