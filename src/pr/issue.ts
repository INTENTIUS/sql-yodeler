/**
 * The drift watch's tracking issue (#49): one open issue per project and
 * environment, found by its marker, opened when drift is found, updated
 * while it lasts, and closed, with a comment, when it is gone. chant's
 * `keepDriftIssue` (`@intentius/chant/drift-issue`, chant issue 4790)
 * decides, writes the body and fingerprints the drift; yodel gives its words,
 * its marker and the run's drift as chant's drift records.
 *
 * Only open issues are read, so a closed one is never reopened: drift found
 * again after a close opens a new issue. The issue counts as current while
 * its title is the same and its body carries the drift's fingerprint, so a
 * body that names a new run does not edit it on every scheduled run.
 */

import type { DriftIssueRecord, DriftIssueWords } from "@intentius/chant/drift-issue";
import type { PrForge } from "@intentius/chant/pr-forge";
import { describeAgainst, describePath, type Drift } from "../chant/drift.js";
import { describeServer, type ServerInfo } from "../server.js";

/**
 * The marker an environment's tracking issue carries, so the next run finds
 * it. Keyed by the project's directory in its repository (`.` at the root),
 * so two projects in one repository keep their own issues.
 */
export function driftIssueMarker(project: string, environment: string): string {
  const clean = (s: string) => s.replace(/\s+/g, "_").replace(/-->/g, "");
  return `<!-- yodel:drift project=${clean(project || ".")} env=${clean(environment)} -->`;
}

/** The tracking issue a run touched. */
export interface TrackedIssue {
  number: number;
  url?: string | undefined;
}

export type IssueAction =
  | { action: "opened" | "updated" | "unchanged" | "closed"; issue: TrackedIssue }
  | { action: "none" }
  | { action: "left"; why: string; issue?: TrackedIssue };

/**
 * The drift as chant's records, through chant's `lexiconDriftRecords`
 * (chant issue 4896) over the sql section the drift was read from, with
 * what yodel adds to it: the ClickHouse grants, the extra columns and a
 * column by its name. An object gone is `missing`, the sql lexicon's
 * `absent`.
 */
export async function driftRecords(drift: Drift, observedAt: string): Promise<DriftIssueRecord[]> {
  const { lexiconDriftRecords } = await import("@intentius/chant/drift-record");
  const changed = drift.changed.map((e) => ({ ...e, changes: e.changes.map((c) => ({ ...c, path: describePath(c.path, drift.columns?.[e.name]) })) }));
  return lexiconDriftRecords({
    member: drift.environment,
    observedAt,
    section: { resources: { missing: drift.missing, unobserved: drift.unobserved } as never, deep: { drifted: changed } as never, absent: "missing" },
  });
}

/** The drift's fingerprint: chant's `driftRunFingerprint` over the environment's records, the value the tracking issue keeps. */
export async function driftFingerprint(drift: Drift): Promise<string> {
  const { driftRunFingerprint } = await import("@intentius/chant/drift-issue");
  return driftRunFingerprint([{ stack: drift.environment, records: await driftRecords(drift, new Date(0).toISOString()) }]);
}

/** yodel's words for chant's drift issue, for one run's drift and server. */
export function driftIssueWords(drift: Drift, server: ServerInfo | undefined): DriftIssueWords {
  const env = drift.environment;
  return {
    product: "yodel",
    title: () => {
      const names = [...drift.changed.map((e) => e.name), ...drift.missing];
      const shown = names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${String(names.length - 3)} more` : names.join(", ");
      return `Drift in ${env}: ${shown}`;
    },
    intro: () => {
      const against = describeAgainst(drift.against);
      return `**${env}**${server ? ` (${describeServer(server)})` : ""} has drifted: declared objects were changed out of band, or are gone.${against ? `\n\n${against}` : ""}`;
    },
    address: "Object",
    values: { before: "declared", after: "live" },
    advice: () => `Run \`yodel drift ${env}\` to see it again. yodel closes this issue when the drift is gone.`,
    foundBy: (url) => `Found by ${url}`,
    cleared: () => `No drift in ${env} now: every declared object matches the server. Closed by yodel drift.`,
  };
}

/**
 * Brings the environment's tracking issue in line with the run: chant's
 * `keepDriftIssue` over the drift's records. `unknown` is why the drift
 * could not be read, which leaves the issue as it is.
 */
export async function trackDrift(
  forge: Pick<PrForge, "trackIssue">,
  marker: string,
  run: { drift: Drift; server?: ServerInfo | undefined; runUrl?: string | undefined; unknown?: string | undefined; now?: string },
): Promise<IssueAction> {
  const { keepDriftIssue } = await import("@intentius/chant/drift-issue");
  const observedAt = run.now ?? new Date().toISOString();
  const r = await keepDriftIssue(forge, {
    words: driftIssueWords(run.drift, run.server),
    environment: run.drift.environment,
    records: await driftRecords(run.drift, observedAt),
    marker,
    observedAt,
    ...(run.runUrl ? { runUrl: run.runUrl } : {}),
    ...(run.unknown !== undefined ? { unknown: run.unknown } : {}),
  });
  const issue = r.number !== undefined ? { number: r.number, ...(r.url ? { url: r.url } : {}) } : undefined;
  if (r.action === "left") return { action: "left", why: r.why ?? "", ...(issue ? { issue } : {}) };
  if (r.action === "none" || !issue) return { action: "none" };
  return { action: r.action, issue };
}
