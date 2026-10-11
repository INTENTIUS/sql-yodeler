/**
 * The drift watch's tracking issue (#49): one open issue per project and
 * environment, found by its marker, opened when drift is found, updated
 * while it lasts, and closed, with a comment, when it is gone. chant's
 * `trackIssue` (#210) finds and writes it on each forge; yodel says what
 * the run found.
 *
 * Only open issues are read, so a closed one is never reopened: drift found
 * again after a close opens a new issue. The issue counts as current while
 * its title is the same and its body carries the drift's fingerprint, so a
 * body that names a new run does not edit it on every scheduled run.
 */

import type { PrForge } from "@intentius/chant/pr-forge";

/**
 * The marker an environment's tracking issue carries, so the next run finds
 * it. Keyed by the project's directory in its repository (`.` at the root),
 * so two projects in one repository keep their own issues.
 */
export function driftIssueMarker(project: string, environment: string): string {
  const clean = (s: string) => s.replace(/\s+/g, "_").replace(/-->/g, "");
  return `<!-- yodel:drift project=${clean(project || ".")} env=${clean(environment)} -->`;
}

/** What the run found, as the tracking issue needs it. */
export type DriftOutcome =
  | { kind: "drift"; title: string; body: string; fingerprint: string }
  | { kind: "clean"; comment: string }
  /** The drift could not be read, or part of the environment could not: the issue is left as it is. */
  | { kind: "unknown"; why: string };

/** The tracking issue a run touched. */
export interface TrackedIssue {
  number: number;
  url?: string | undefined;
}

export type IssueAction =
  | { action: "opened" | "updated" | "unchanged" | "closed"; issue: TrackedIssue }
  | { action: "none" }
  | { action: "left"; why: string; issue?: TrackedIssue };

/** Brings the environment's tracking issue in line with the outcome; see the module comment. */
export async function trackDrift(forge: Pick<PrForge, "trackIssue">, marker: string, outcome: DriftOutcome): Promise<IssueAction> {
  const finding = outcome.kind === "drift" ? { title: outcome.title, body: `${marker}\n${outcome.body}` } : null;
  const r = await forge.trackIssue(marker, finding, {
    ...(outcome.kind === "drift" ? { sameWhen: outcome.fingerprint } : {}),
    ...(outcome.kind === "clean" ? { closeOnClear: true, clearComment: outcome.comment } : {}),
  });
  const issue = r.number !== undefined ? { number: r.number, ...(r.url ? { url: r.url } : {}) } : undefined;
  if (outcome.kind === "unknown") return { action: "left", why: outcome.why, ...(issue ? { issue } : {}) };
  if (r.action === "none" || r.action === "left" || !issue) return { action: "none" };
  return { action: r.action, issue };
}
