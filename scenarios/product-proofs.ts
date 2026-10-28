/**
 * The product-scenario proof kind (INTENTIUS/chant#4586, ruling C).
 *
 * A claim in scenarios/claims/ keeps its own runs. It can also cite one row
 * of a product's scenario on the shared e2e harness (the sy-forge rows
 * behind forge, waves and the CI half of approval are the first). The
 * citations are listed in scenarios/product-proofs.json:
 *
 *   {
 *     "format": 1,
 *     "proofs": [
 *       {
 *         "kind": "product-scenario",
 *         "repo": "INTENTIUS/sql-yodeler",   the product that ran the scenario
 *         "scenario": "sy-forge",            the scenario's id
 *         "claim": "forge",                  the claim id the row records (a claim in scenarios/claims/index.ts)
 *         "commit": "0123abc",               the product commit the row ran at
 *         "date": "2026-11-02",              YYYY-MM-DD
 *         "engine_version": "0.11.0"         the yodel version the row ran
 *       }
 *     ]
 *   }
 *
 * The six fields are the ones choudoufu's live/smoke/claims.json and
 * plunge's claims source use for the same kind. A row counts toward its
 * claim only when its engine_version is the version the claim is about,
 * which is package.json's version. A row at another version is shown, marked
 * as not counted. A product row never replaces the claim's own run.
 */

import { existsSync, readFileSync } from "node:fs";

export const proofKind = "product-scenario";
export const proofsFormat = 1;

/** The six fields every proof of the kind carries, in the order the page shows them. */
export const proofFields = ["repo", "scenario", "claim", "commit", "date", "engine_version"] as const;

export interface ProductScenarioProof {
  kind: typeof proofKind;
  repo: string;
  scenario: string;
  claim: string;
  commit: string;
  date: string;
  engine_version: string;
}

export interface ProductProofs {
  format: typeof proofsFormat;
  proofs: ProductScenarioProof[];
}

const patterns: Record<(typeof proofFields)[number], { re: RegExp; shape: string }> = {
  repo: { re: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, shape: "owner/name" },
  scenario: { re: /^[a-z0-9][a-z0-9-]*$/, shape: "a scenario id such as sy-forge" },
  claim: { re: /^[a-z0-9][a-z0-9-]*$/, shape: "a claim id" },
  commit: { re: /^[0-9a-f]{7,40}$/, shape: "a git sha of 7 to 40 hex digits" },
  date: { re: /^\d{4}-\d{2}-\d{2}$/, shape: "YYYY-MM-DD" },
  engine_version: { re: /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, shape: "a version such as 0.11.0" },
};

/**
 * What is wrong with one proof: a field that is missing, not a string or
 * not in its shape. `claims` is the claim ids scenarios/claims/index.ts
 * lists; a proof naming another is wrong too.
 */
export function proofProblems(proof: unknown, claims: readonly string[]): string[] {
  if (proof === null || typeof proof !== "object" || Array.isArray(proof)) return ["a proof must be an object"];
  const p = proof as Record<string, unknown>;
  const problems: string[] = [];
  if (p.kind !== proofKind) problems.push(`kind must be "${proofKind}"`);
  for (const f of proofFields) {
    const v = p[f];
    if (v === undefined) problems.push(`${f} is missing`);
    else if (typeof v !== "string" || v === "") problems.push(`${f} must be a non-empty string`);
    else if (!patterns[f].re.test(v)) problems.push(`${f} ${JSON.stringify(v)} is not ${patterns[f].shape}`);
  }
  if (typeof p.claim === "string" && patterns.claim.re.test(p.claim) && !claims.includes(p.claim)) {
    problems.push(`claim ${p.claim} is not in scenarios/claims/index.ts`);
  }
  return problems;
}

/** The proofs in a parsed file, or the problems with it, each naming the proof by position. */
export function parseProductProofs(doc: unknown, claims: readonly string[]): { proofs: ProductScenarioProof[]; problems: string[] } {
  const d = doc as { format?: unknown; proofs?: unknown } | null;
  if (d === null || typeof d !== "object" || d.format !== proofsFormat || !Array.isArray(d.proofs)) {
    return { proofs: [], problems: [`not a product proofs file of format ${String(proofsFormat)}: expected { "format": ${String(proofsFormat)}, "proofs": [...] }`] };
  }
  const problems: string[] = [];
  (d.proofs as unknown[]).forEach((p, i) => {
    for (const why of proofProblems(p, claims)) problems.push(`proofs[${String(i)}]: ${why}`);
  });
  return { proofs: problems.length ? [] : (d.proofs as ProductScenarioProof[]), problems };
}

/** The proofs in `file` (none when it does not exist); throws with every problem when the file is wrong. */
export function readProductProofs(file: string, claims: readonly string[]): ProductScenarioProof[] {
  if (!existsSync(file)) return [];
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file} is not JSON (${e instanceof Error ? e.message : String(e)})`, { cause: e });
  }
  const { proofs, problems } = parseProductProofs(doc, claims);
  if (problems.length) throw new Error(`${file}:\n  ${problems.join("\n  ")}`);
  return proofs;
}

/** A proof counts when the row ran the version the claim is about. */
export function counts(proof: ProductScenarioProof, claimedVersion: string): boolean {
  return proof.engine_version === claimedVersion;
}

/** The proofs that cite `claim`, each with whether it counts at `claimedVersion`. */
export function proofsFor(proofs: readonly ProductScenarioProof[], claim: string, claimedVersion: string): Array<{ proof: ProductScenarioProof; counted: boolean }> {
  return proofs.filter((p) => p.claim === claim).map((proof) => ({ proof, counted: counts(proof, claimedVersion) }));
}

/** Where a row can be read: the product commit it ran at. */
export function rowLink(p: ProductScenarioProof): string {
  return `https://github.com/${p.repo}/commit/${p.commit}`;
}

/** The version the claims are about: package.json's. */
export function claimedVersion(packageJson: string): string {
  const v = (JSON.parse(readFileSync(packageJson, "utf8")) as { version?: unknown }).version;
  if (typeof v !== "string") throw new Error(`${packageJson} has no version`);
  return v;
}
