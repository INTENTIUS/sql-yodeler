/**
 * The product-scenario proof kind (scenarios/product-proofs.ts): the six
 * fields, the version a row counts at, and how the claims page and the docs
 * pages show it.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { claims } from "../scenarios/claims/index.js";
import {
  claimedVersion,
  counts,
  parsePending,
  parseProductProofs,
  proofFields,
  proofsFor,
  readPendingCitations,
  readProductProofs,
  rowLink,
  type ProductScenarioProof,
} from "../scenarios/product-proofs.js";
import { packagePath, proofsPath, renderPage } from "../scenarios/status-page.js";
// @ts-expect-error docs-site/pages.mjs is plain JavaScript, with no types
import { productRowsMarkdown as untyped } from "../docs-site/pages.mjs";

const productRowsMarkdown = untyped as (names: string[], p: { proofs: ProductScenarioProof[]; version: string }) => string;
const names = claims.map((c) => c.name);

/** A row of the sy-forge scenario for the forge claim, as the harness will record it. */
const row: ProductScenarioProof = {
  kind: "product-scenario",
  repo: "INTENTIUS/sql-yodeler",
  scenario: "sy-forge",
  claim: "forge",
  commit: "0123abcd4567",
  date: "2026-11-02",
  engine_version: "0.11.0",
};

const file = (...proofs: unknown[]) => ({ format: 1, proofs });

describe("the product-scenario proof kind", () => {
  it("accepts a proof with the six fields", () => {
    expect(parseProductProofs(file(row), names)).toEqual({ proofs: [row], problems: [] });
  });

  it.each(proofFields)("rejects a proof missing %s", (field) => {
    const rest = Object.fromEntries(Object.entries(row).filter(([k]) => k !== field));
    const { proofs, problems } = parseProductProofs(file(rest), names);
    expect(proofs).toEqual([]);
    expect(problems).toEqual([`proofs[0]: ${field} is missing`]);
  });

  it("rejects an empty field, a field of the wrong shape and a kind that is not product-scenario", () => {
    expect(parseProductProofs(file({ ...row, scenario: "" }), names).problems).toEqual(["proofs[0]: scenario must be a non-empty string"]);
    expect(parseProductProofs(file({ ...row, date: "2/11/2026" }), names).problems[0]).toMatch(/date "2\/11\/2026" is not YYYY-MM-DD/);
    expect(parseProductProofs(file({ ...row, engine_version: "v0.11" }), names).problems[0]).toMatch(/engine_version/);
    expect(parseProductProofs(file({ ...row, kind: "go_test" }), names).problems).toEqual(['proofs[0]: kind must be "product-scenario"']);
  });

  it("rejects a claim scenarios/claims/index.ts does not list", () => {
    expect(parseProductProofs(file({ ...row, claim: "teleport" }), names).problems).toEqual(["proofs[0]: claim teleport is not in scenarios/claims/index.ts"]);
  });

  it("rejects a file of another format", () => {
    expect(parseProductProofs({ proofs: [] }, names).problems).toHaveLength(1);
  });

  it("counts a row only at the version the claims are about", () => {
    const other = { ...row, engine_version: "0.10.0" };
    expect(counts(row, "0.11.0")).toBe(true);
    expect(counts(other, "0.11.0")).toBe(false);
    expect(proofsFor([row, other, { ...row, claim: "waves" }], "forge", "0.11.0").map((r) => r.counted)).toEqual([true, false]);
  });

  it("links a row to the product commit", () => {
    expect(rowLink(row)).toBe("https://github.com/INTENTIUS/sql-yodeler/commit/0123abcd4567");
  });

  it("is valid in the committed scenarios/product-proofs.json", () => {
    expect(() => readProductProofs(proofsPath, names)).not.toThrow();
    expect(claimedVersion(packagePath)).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("docs/claims.md", () => {
  const forge = claims.filter((c) => c.name === "forge");
  const other = { ...row, engine_version: "0.10.0", scenario: "sy-forge-old" };

  it("lists a row with a link, and says a row at another version does not count", () => {
    const page = renderPage(undefined, forge, new Map(), [row, other], "0.11.0");
    expect(page).toContain("## Product scenario rows");
    expect(page).toContain("| forge | INTENTIUS/sql-yodeler | [sy-forge](https://github.com/INTENTIUS/sql-yodeler/commit/0123abcd4567) | `0123abcd4567` | 2026-11-02 | 0.11.0 | yes |");
    expect(page).toContain("| 0.10.0 | no, the claims are about 0.11.0 |");
  });

  it("says so when no row is cited", () => {
    expect(renderPage(undefined, forge, new Map(), [], "0.11.0", [])).toContain("No product scenario row is cited yet.");
  });

  it("lists a pending citation as pending, never as a row", () => {
    const page = renderPage(undefined, forge, new Map(), [], "0.11.0", [{ repo: "INTENTIUS/sql-yodeler", scenario: "sy-forge-postgres", claim: "forge", note: "the forge loop" }]);
    expect(page).toContain("No product scenario row is cited yet.");
    expect(page).toContain("| forge | INTENTIUS/sql-yodeler | `sy-forge-postgres` | the forge loop |");
  });
});

describe("pending citations", () => {
  const pending = { repo: "INTENTIUS/sql-yodeler", scenario: "sy-waves-clickhouse", claim: "waves", note: "two waves" };

  it("takes none when the file has no pending list", () => {
    expect(parsePending({ format: 1, proofs: [] }, names)).toEqual({ pending: [], problems: [] });
  });

  it("takes a citation with the repo, the scenario, the claim and a note", () => {
    expect(parsePending({ ...file(), pending: [pending] }, names)).toEqual({ pending: [pending], problems: [] });
  });

  it("refuses a citation missing its note, of an unknown claim or a bad scenario id", () => {
    const { pending: got, problems } = parsePending({ ...file(), pending: [{ ...pending, note: "" }, { ...pending, claim: "nope" }, { ...pending, scenario: "Sy Waves" }] }, names);
    expect(got).toEqual([]);
    expect(problems).toEqual(["pending[0]: note must be a non-empty string", "pending[1]: claim nope is not in scenarios/claims/index.ts", 'pending[2]: scenario "Sy Waves" is not a scenario id such as sy-forge']);
  });

  it("reads the committed file's citations", () => {
    expect(readPendingCitations(proofsPath, names).length).toBeGreaterThan(0);
  });
});

describe("a docs page's Proven by", () => {
  const other = { ...row, engine_version: "0.10.0" };

  it("shows the rows that cite the page's claims, with a link and whether each counts", () => {
    const md = productRowsMarkdown(["forge", "waves"], { proofs: [row, other, { ...row, claim: "resume" }], version: "0.11.0" });
    expect(md).toContain("[sy-forge](https://github.com/INTENTIUS/sql-yodeler/commit/0123abcd4567)");
    expect(md).toContain("| yes |");
    expect(md).toContain("no, the claims are about 0.11.0");
    expect(md).not.toContain("resume");
  });

  it("shows nothing for a page none cites", () => {
    expect(productRowsMarkdown(["migrations"], { proofs: [row], version: "0.11.0" })).toBe("");
    expect(readFileSync(proofsPath, "utf8")).toContain('"proofs"');
  });
});
