/**
 * Every docs page names the claims that prove it, and names only claims the
 * list of claims has (scenarios/docs-claims.ts). The check does not read the
 * claims record: claims run between development cycles, never as a gate.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claims } from "../scenarios/claims/index.js";
import { docsClaimProblems, docsPages, frontMatter } from "../scenarios/docs-claims.js";
import type { Claim } from "../scenarios/lib/claim.js";
import { repoRoot } from "./helpers/run.js";

describe("the claims behind each docs page", () => {
  it("every page names claims the list of claims has", () => {
    expect(docsClaimProblems(docsPages(join(repoRoot, "docs")), claims)).toEqual([]);
  });

  it("every page names at least one claim, except the ones that describe no behaviour", () => {
    const none = docsPages(join(repoRoot, "docs")).filter((p) => frontMatter(p.text).claims?.length === 0).map((p) => p.file);
    expect(none.sort()).toEqual(["README.md", "agents.md", "claims.md", "glossary.md", "schema-docs.md"]);
  });

  describe("the check, on fixture pages", () => {
    const body = () => Promise.resolve();
    const fixture: Claim[] = [{ name: "good", says: "holds", dialects: { ch: body, pg: body } }];
    const page = (front: string) => [{ file: "page.md", text: `${front}# Page\n` }];
    const check = (front: string) => docsClaimProblems(page(front), fixture);

    it("passes a page that names a listed claim, and a page with an empty list", () => {
      expect(check("---\nclaims: [good]\n---\n\n")).toEqual([]);
      expect(check("---\nclaims: []\n---\n\n")).toEqual([]);
    });

    it("refuses a page with no claims line", () => {
      expect(check("")).toEqual(["docs/page.md: no claims line in its front matter (claims: [] when no claim proves it)"]);
    });

    it("refuses a claim the list of claims does not have", () => {
      expect(check("---\nclaims: [gone]\n---\n")).toEqual(["docs/page.md: names claim gone, which scenarios/claims/index.ts does not list"]);
    });
  });
});
