/**
 * Every docs page names the claims that prove it, and a page that is not a
 * draft names only claims that pass plain and are caught broken in the
 * committed claims record (scenarios/docs-claims.ts).
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claims } from "../scenarios/claims/index.js";
import { docsClaimProblems, docsPages, frontMatter } from "../scenarios/docs-claims.js";
import type { Claim } from "../scenarios/lib/claim.js";
import { readRecord, type ClaimsRecord } from "../scenarios/record.js";
import { recordPath } from "../scenarios/status-page.js";
import { repoRoot } from "./helpers/run.js";

describe("the claims behind each docs page", () => {
  it("every page names claims that hold in the committed record", () => {
    expect(docsClaimProblems(docsPages(join(repoRoot, "docs")), readRecord(recordPath), claims)).toEqual([]);
  });

  it("every page names at least one claim, except the ones that describe no behaviour", () => {
    const none = docsPages(join(repoRoot, "docs")).filter((p) => frontMatter(p.text).claims?.length === 0).map((p) => p.file);
    expect(none.sort()).toEqual(["README.md", "agents.md", "claims.md", "glossary.md"]);
  });

  describe("the check, on a fixture record", () => {
    const body = () => Promise.resolve();
    const fixture: Claim[] = [
      { name: "good", says: "holds", dialects: { ch: body, pg: body } },
      { name: "broken", says: "fails broken", dialects: { ch: body } },
      { name: "waiting", says: "pending", dialects: { pg: body } },
      { name: "half", says: "recorded on one dialect", dialects: { ch: body, pg: body } },
    ];
    const row = (claim: string, dialect: "ch" | "pg", plain: string, brk: string) => ({
      claim,
      dialect,
      says: "",
      needs: null,
      plain,
      break: brk,
      seconds: { plain: 1, break: 1 },
      recorded: "2026-10-10T00:00:00.000Z",
      commit: "abc1234",
      dirty: false,
    });
    const record = {
      format: 1,
      recorded: "2026-10-10T00:00:00.000Z",
      commit: "abc1234",
      dirty: false,
      rows: [
        row("good", "ch", "pass", "caught"),
        row("good", "pg", "pass", "caught"),
        row("broken", "ch", "pass", "fail"),
        row("waiting", "pg", "pending", "pending"),
        row("half", "ch", "pass", "caught"),
      ],
    } as unknown as ClaimsRecord;
    const page = (front: string) => [{ file: "page.md", text: `${front}# Page\n` }];
    const check = (front: string) => docsClaimProblems(page(front), record, fixture);

    it("passes a page whose claims hold, and a page with an empty list", () => {
      expect(check("---\nclaims: [good]\n---\n\n")).toEqual([]);
      expect(check("---\nclaims: []\n---\n\n")).toEqual([]);
    });

    it("refuses a page with no claims line", () => {
      expect(check("")).toEqual(["docs/page.md: no claims line in its front matter (claims: [] when no claim proves it)"]);
    });

    it("refuses a claim the list of claims does not have", () => {
      expect(check("---\nclaims: [gone]\n---\n")).toEqual(["docs/page.md: names claim gone, which scenarios/claims/index.ts does not list"]);
    });

    it("refuses a claim that fails, is pending, or is not recorded on one of its dialects", () => {
      expect(check("---\nclaims: [good, broken, waiting, half]\n---\n")).toEqual([
        "docs/page.md: claim broken (ch) is failing in the record; fix it, or mark the page draft: true",
        "docs/page.md: claim waiting (pg) is pending in the record; fix it, or mark the page draft: true",
        "docs/page.md: claim half (pg) is not recorded in the record; fix it, or mark the page draft: true",
      ]);
    });

    it("lets a draft name claims that do not hold yet", () => {
      expect(check("---\nclaims: [broken, waiting, half]\ndraft: true\n---\n")).toEqual([]);
    });
  });
});
