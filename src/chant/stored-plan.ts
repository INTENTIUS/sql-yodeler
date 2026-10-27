/**
 * The plan a gate's pending fact cites (#292, chant#4551). A wave planned
 * through the sql capability (#291) hands chant the change set of its runs'
 * parts; chant stores it under its digest in `_change-sets/` on
 * chant/lifecycle and the wave's pending fact cites it as `changeSet`.
 * `yodel approve` shows that stored plan, the one the approval was asked
 * for, beside the plan as it reads now.
 *
 * A pending fact written by a chant before chant#4551, or by a wave that ran
 * yodel's own plan callbacks, cites none: {@link storedPlanText} is then
 * undefined and nothing changes. The field is read structurally, so this
 * compiles against a published chant without it.
 */
import type { GateLedgerPort } from "@intentius/chant/op/gate";

/** The change-set digest the newest pending fact of `gate` cites for `digest`, if any. */
export async function citedChangeSet(ledger: GateLedgerPort, op: string, gate: string, digest: string): Promise<string | undefined> {
  const { pending } = await ledger.read(op);
  const fact = pending.filter((p) => p.gate === gate && p.planDigest === digest).at(-1);
  const cited = (fact as { changeSet?: unknown } | undefined)?.changeSet;
  return typeof cited === "string" && cited !== "" ? cited : undefined;
}

/**
 * The stored plan the pending fact of `gate` cites for `digest`, rendered as
 * chant's plan summary, with a line naming where it is stored. Undefined
 * when the fact cites none or nothing is stored under it; a stored file that
 * is not that change set is said so.
 */
export async function storedPlanText(dir: string, ledger: GateLedgerPort, op: string, gate: string, digest: string): Promise<string | undefined> {
  let cited: string | undefined;
  try {
    cited = await citedChangeSet(ledger, op, gate, digest);
  } catch {
    return undefined;
  }
  if (!cited) return undefined;
  const { readStoredChangeSet } = await import("@intentius/chant/lifecycle/change-set-store");
  const read = await readStoredChangeSet(cited, { cwd: dir }).catch((e: unknown) => ({ status: "malformed" as const, message: e instanceof Error ? e.message : String(e) }));
  if (read.status === "missing") return undefined;
  if (read.status === "malformed") return `The plan this approval was asked for (${cited}) cannot be shown: ${read.message}\n`;
  const { groupChangeSet, renderPlanSummaryText } = await import("@intentius/chant/plan-summary");
  return `The plan this approval was asked for, as chant stored it (${cited}, chant change-set show ${cited}):\n${renderPlanSummaryText(groupChangeSet(read.document))}`;
}
