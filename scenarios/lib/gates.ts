/**
 * How a claim reads a command that stops at a gate, and approves it as a
 * person would.
 *
 * Exit 3 on chant's table is "waiting for a person", and since #288 it
 * covers more than a gate: `yodel revert` without the hand-written step a
 * data step needs also exits 3, refusing, with no JSON. So a claim that
 * expects a gate checks the document too: status gated, and the approve
 * command to run.
 *
 * A gated request (`yodel cleanup`'s drop, `yodel init --baseline`'s
 * record, #292 on chant#4551) does not count the requester's own approval.
 * The claims run as one shell user, the requester; {@link REVIEWER} is the
 * someone else who approves, named with `chant approve --approver`.
 */

import type { Ran } from "./exec.js";

/** The approver who is not the requester. */
export const REVIEWER = "yodel-claims-reviewer";

/** The argv for `chant` that runs a `chant approve ...` command, as `--json` outputs give it in `chantApprove`, approved as `approver` when given. */
export function chantApproveArgs(command: string | undefined, approver?: string): string[] {
  if (!command?.startsWith("chant approve ")) throw new Error(`no chant approve command to run: ${String(command)}`);
  const args = command.split(" ").filter((a) => a !== "").slice(1);
  if (approver === undefined) return args;
  if (args.includes("--approver") || args.includes("--actor")) throw new Error(`${command} already names its approver`);
  return [...args, "--approver", approver];
}

/** A `--json` document a command printed at a gate. */
export interface GatedDoc {
  status?: string;
  approve?: string;
  chantApprove?: string;
  planDigest?: string;
  gatePlanDigest?: string;
}

/** The first JSON document on stdout, or undefined when there is none. */
function jsonOf(ran: Ran): unknown {
  const at = ran.out.indexOf("{");
  if (at < 0) return undefined;
  try {
    return JSON.parse(ran.out.slice(at)) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The document of a run that stopped at its gate (exit 3, status gated, a
 * chant approve command), or why it did not, naming the exit code, the
 * status, and the command's own `<verb>:` lines on stderr.
 */
export function atGate(ran: Ran, verb: string): { doc: GatedDoc & { chantApprove: string } } | { why: string } {
  const doc = jsonOf(ran) as GatedDoc | undefined;
  if (ran.code === 3 && doc?.status === "gated" && typeof doc.chantApprove === "string") return { doc: { ...doc, chantApprove: doc.chantApprove } };
  const said = ran.err
    .split("\n")
    .filter((l) => l.startsWith(`yodel ${verb}`))
    .join(" ")
    .slice(0, 300);
  return { why: `exit ${String(ran.code)}, ${doc === undefined ? "no JSON on stdout" : `status ${String(doc.status)}`}${said ? `: ${said}` : ""}` };
}

/**
 * Whether a text run of a gated request after the requester's own approval
 * still waits (exit 3) and says that approval does not count.
 */
export function ownApprovalRefused(ran: Ran): boolean {
  return ran.code === 3 && /The approval by .+ does not count: .*own approval/.test(ran.out);
}
