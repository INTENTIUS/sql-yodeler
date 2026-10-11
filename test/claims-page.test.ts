/**
 * docs/claims.md is what scenarios/status-page.ts renders from the committed
 * claims record, and the record covers the claims scenarios/claims/index.ts
 * lists.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { claims } from "../scenarios/claims/index.js";
import type { Dialect } from "../scenarios/lib/claim.js";
import { readRecord } from "../scenarios/record.js";
import { pageCommand, pagePath, recordPath, renderPage } from "../scenarios/status-page.js";

const record = readRecord(recordPath);
const page = readFileSync(pagePath, "utf8");

describe("docs/claims.md", () => {
  it("is what the committed record renders to", () => {
    expect(record, `${recordPath} is missing`).toBeDefined();
    expect(page, `docs/claims.md does not match scenarios/claims-record.json; run \`${pageCommand}\` and commit the page`).toBe(renderPage(record));
  });

  it("has a row for every claim and dialect, recorded or shown as not recorded", () => {
    const recorded = new Set((record?.rows ?? []).map((r) => `${r.claim}:${r.dialect}`));
    const missing: string[] = [];
    for (const c of claims) {
      for (const d of Object.keys(c.dialects) as Dialect[]) {
        if (recorded.has(`${c.name}:${d}`)) continue;
        const line = page.split("\n").find((l) => l.startsWith(`| ${c.name} | ${d === "ch" ? "ClickHouse" : "Postgres"} |`));
        if (!line?.includes("not recorded")) missing.push(`${c.name}:${d}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("lists no record row for a claim or dialect that is gone", () => {
    const known = new Set(claims.flatMap((c) => Object.keys(c.dialects).map((d) => `${c.name}:${d}`)));
    expect((record?.rows ?? []).map((r) => `${r.claim}:${r.dialect}`).filter((k) => !known.has(k))).toEqual([]);
  });

  it("shows a claim the record lacks as not recorded", () => {
    const one = claims.find((c) => c.name === "forgejo");
    expect(one).toBeDefined();
    if (!one) return;
    expect(renderPage(undefined, [one])).toMatch(/\| forgejo \| \w+ \| .* \| not recorded \| not recorded \| \| \|/);
  });
});
