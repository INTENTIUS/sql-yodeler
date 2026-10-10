/**
 * The claims behind each docs page. Every page under docs/ starts with front
 * matter naming the scenario claims that prove what it describes:
 *
 *   ---
 *   claims: [approval, pr-comment]
 *   ---
 *
 * (an empty list is allowed, and says the page makes no claim a scenario
 * proves), and optionally `draft: true`. A page that is not a draft may only
 * name claims whose newest recorded row, for every dialect the claim runs on
 * (scenarios/claims/index.ts), passed plain and was caught broken in
 * scenarios/claims-record.json. A draft may name pending ones; the site says
 * so on the page and leaves it out of llms.txt. test/docs-claims.test.ts runs
 * the check, so `npm run check` fails on a page whose claims do not hold.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Claim, Dialect } from "./lib/claim.js";
import type { ClaimsRecord } from "./record.js";

export interface PageFront {
  /** The claims the page names; undefined when it has no `claims:` line. */
  claims: string[] | undefined;
  draft: boolean;
}

/** The page's front matter (`---` lines at the very top). */
export function frontMatter(text: string): PageFront {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const lines = m?.[1]?.split("\n") ?? [];
  const value = (key: string) => lines.find((l) => l.startsWith(`${key}:`))?.slice(key.length + 1).trim();
  const list = value("claims");
  let claims: string[] | undefined;
  if (list !== undefined) {
    const inner = /^\[(.*)\]$/.exec(list)?.[1];
    if (inner === undefined) throw new Error(`claims: ${list}: write a list, claims: [a, b]`);
    claims = inner.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return { claims, draft: value("draft") === "true" };
}

export type ClaimState = "holds" | "failing" | "pending" | "not recorded";

/** Where each dialect of `claim` stands in the record. */
export function claimStates(claim: Claim, record: ClaimsRecord | undefined): Array<{ dialect: Dialect; state: ClaimState }> {
  return (Object.keys(claim.dialects) as Dialect[]).map((dialect) => {
    const row = record?.rows.find((r) => r.claim === claim.name && r.dialect === dialect);
    if (!row) return { dialect, state: "not recorded" };
    if (row.plain === "pass" && row.break === "caught") return { dialect, state: "holds" };
    if (row.plain === "pending" || row.break === "pending") return { dialect, state: "pending" };
    return { dialect, state: "failing" };
  });
}

/** The pages under docs/, by file name, with their text. */
export function docsPages(docsDir: string): Array<{ file: string; text: string }> {
  return readdirSync(docsDir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((file) => ({ file, text: readFileSync(join(docsDir, file), "utf8") }));
}

/** What is wrong with the pages' claims: an empty list when every page is right. */
export function docsClaimProblems(pages: Array<{ file: string; text: string }>, record: ClaimsRecord | undefined, claims: readonly Claim[]): string[] {
  const byName = new Map(claims.map((c) => [c.name, c]));
  const problems: string[] = [];
  for (const { file, text } of pages) {
    let front: PageFront;
    try {
      front = frontMatter(text);
    } catch (e) {
      problems.push(`docs/${file}: ${(e as Error).message}`);
      continue;
    }
    if (!front.claims) {
      problems.push(`docs/${file}: no claims line in its front matter (claims: [] when no claim proves it)`);
      continue;
    }
    for (const name of front.claims) {
      const claim = byName.get(name);
      if (!claim) {
        problems.push(`docs/${file}: names claim ${name}, which scenarios/claims/index.ts does not list`);
        continue;
      }
      if (front.draft) continue;
      for (const { dialect, state } of claimStates(claim, record)) {
        if (state !== "holds") problems.push(`docs/${file}: claim ${name} (${dialect}) is ${state} in the record; fix it, or mark the page draft: true`);
      }
    }
  }
  return problems;
}

/** The pages that name each claim, by claim name, for the status page. */
export function pagesByClaim(pages: Array<{ file: string; text: string }>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const { file, text } of pages) {
    let claims: string[] | undefined;
    try {
      claims = frontMatter(text).claims;
    } catch {
      continue;
    }
    for (const c of claims ?? []) out.set(c, [...(out.get(c) ?? []), file]);
  }
  return out;
}
