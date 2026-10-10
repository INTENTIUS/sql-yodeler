/**
 * The claims status page: docs/claims.md, rendered from the committed
 * claims record (scenarios/claims-record.json, written by
 * `npm run claims -- --record FILE`).
 *
 *   npm run claims:page    rewrite docs/claims.md from the record
 *
 * One table row per claim and dialect in scenarios/claims/index.ts, in that
 * order. A claim and dialect the record has no row for shows as "not
 * recorded". test/claims-page.test.ts fails when the committed page is not
 * what this renders from the committed record.
 */

import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { claims as allClaims } from "./claims/index.js";
import type { Claim, Dialect } from "./lib/claim.js";
import { docsPages, pagesByClaim } from "./docs-claims.js";
import { readRecord, type ClaimsRecord, type Stamp } from "./record.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const recordPath = join(root, "scenarios", "claims-record.json");
export const pagePath = join(root, "docs", "claims.md");
export const pageCommand = "npm run claims:page";

const dialectName: Record<Dialect, string> = { ch: "ClickHouse", pg: "Postgres" };

/** "2026-10-09 12:00 UTC" from an ISO time. */
function when(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function commitOf(s: Stamp): string {
  if (s.commit === null) return "unknown";
  return s.dirty ? `\`${s.commit}\` (with uncommitted changes)` : `\`${s.commit}\``;
}

/** A table cell: no pipes or line breaks. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
}

function verdict(v: string | null, needs: string | null): string {
  if (v === null) return "not run";
  if (v === "pending" && needs) return `pending (${needs})`;
  return v;
}

/** The docs pages that name each claim (their front matter), this page aside. */
export function citedBy(): Map<string, string[]> {
  return pagesByClaim(docsPages(join(root, "docs")).filter((p) => p.file !== "claims.md"));
}

/**
 * The page for `record` (undefined: no record yet), one row per claim and
 * dialect in `claims`, each with the docs pages that name the claim.
 */
export function renderPage(record: ClaimsRecord | undefined, claims: readonly Claim[] = allClaims, pages: Map<string, string[]> = citedBy()): string {
  const byKey = new Map((record?.rows ?? []).map((r) => [`${r.claim}:${r.dialect}`, r]));
  const cited = (name: string) => (pages.get(name) ?? []).map((f) => `[${f.replace(/\.md$/, "")}](${f})`).join(", ");
  const out: string[] = [
    "---",
    "claims: []",
    "---",
    "",
    "# Claims status",
    "",
    "<!-- Written by `npm run claims:page` from scenarios/claims-record.json. Do not edit by hand. -->",
    "",
    "Each scenario claim (`scenarios/claims/`) is a promise the docs make, run against chant's emulator. A claim runs twice: plain, where it should pass, and broken (`BREAK=1`), where the claim's own check should catch the fault it plants; a claim of several parts is caught only when each part catches the fault planted in it. `npm run claims` runs them; see the comment at the top of `scenarios/run.ts`.",
    "",
    record
      ? `The record was last written at ${when(record.recorded)}, at commit ${commitOf(record)}. A row run in an earlier run keeps that run's commit and date.`
      : "There is no record yet.",
    "",
    "A row marked \"not recorded\" has not been run into the record. CI does not run the template claim, which needs a Forgejo with a runner.",
    "",
    "Each docs page names the claims that prove it, and `npm run check` fails when a page that is not a draft names one that does not pass plain and get caught broken here. The last column lists those pages.",
    "",
    "| Claim | Dialect | What it says | Plain | Broken | Commit | Date | Pages |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const c of claims) {
    for (const d of Object.keys(c.dialects) as Dialect[]) {
      const r = byKey.get(`${c.name}:${d}`);
      const head = `| ${c.name} | ${dialectName[d]} | ${cell(r?.says ?? c.says)} |`;
      out.push(r ? `${head} ${verdict(r.plain, r.needs)} | ${verdict(r.break, r.needs)} | ${commitOf(r)} | ${when(r.recorded)} | ${cited(c.name)} |` : `${head} not recorded | not recorded | | | ${cited(c.name)} |`);
    }
  }
  return `${out.join("\n")}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(pagePath, renderPage(readRecord(recordPath)));
  process.stderr.write(`[claims] wrote ${pagePath}\n`);
}
