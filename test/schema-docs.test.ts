/**
 * `yodel docs` (#62): the HTML reference and the Mermaid ERD, offline. The
 * fixtures docs-clickhouse and docs-postgres hold the relations the examples
 * do not (a foreign key, a materialized view, views); the examples' output
 * is committed under examples/<dialect>/schema-docs/ and must be what a
 * fresh run writes, as docs/schema-docs.md quotes it.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HAT_ICON, HAT_IMG } from "../src/brand.js";
import { loadProject } from "../src/project.js";
import { docsInput } from "../src/commands/docs.js";
import { erdMermaid, relations, schemaHtml } from "../src/schema-docs/render.js";
import { projectFrom, repoRoot, yodel } from "./helpers/run.js";

async function input(name: string) {
  const p = projectFrom(name);
  try {
    return await docsInput(await loadProject(p.dir));
  } finally {
    p.dispose();
  }
}

/** The body of the first ```mermaid block in `text`. */
const mermaidBlock = (text: string): string => {
  const m = /```mermaid\n([\s\S]*?)```/.exec(text);
  if (!m?.[1]) throw new Error("no mermaid block");
  return m[1];
};

describe("yodel docs", () => {
  it("draws a Postgres foreign key as many-to-one, a view as reading its table, and marks the keys", async () => {
    const { output } = await input("docs-postgres");
    expect(relations(output)).toEqual([
      { from: "orders", to: "customers", kind: "foreign key", label: "orders_customer_fk: customer_id to id", optional: false },
      { from: "bigOrders", to: "orders", kind: "reads", label: "reads" },
    ]);
    expect(erdMermaid(output)).toBe(`erDiagram
  shop_customers["shop.customers"] {
    bigint id PK
    text email UK "Lower-cased"
  }
  shop_orders["shop.orders"] {
    bigint id PK
    bigint customer_id FK
    numeric(12_2) amount
  }
  shop_big_orders["shop.big_orders"]
  shop_orders }o--|| shop_customers : "orders_customer_fk: customer_id to id"
  shop_big_orders }o..|| shop_orders : "reads"
`);
  });

  it("draws a materialized view's source and target, and marks ClickHouse's primary key columns", async () => {
    const { output } = await input("docs-clickhouse");
    expect(relations(output).map((r) => `${r.from} ${r.label} ${r.to}`)).toEqual([
      "dailyTotalsMv writes to dailyTotals",
      "dailyTotalsMv reads events",
      "recent reads events",
    ]);
    const erd = erdMermaid(output);
    // PRIMARY KEY (kind) on events; daily_totals has no PRIMARY KEY, so its ORDER BY (day, kind).
    expect(erd).toContain('  shop_events["shop.events"] {\n    UInt64 id "The event id"\n    LowCardinality(String) kind PK\n');
    expect(erd).toContain("    Date day PK\n    LowCardinality(String) kind PK\n    Decimal(18_2) total\n");
  });

  it("the HTML has each table's engine, sort key, columns and relations, inline and with no script", async () => {
    const html = schemaHtml(await input("docs-clickhouse"));
    // The hat beside the title and as the icon is inline as data: URIs; nothing else loads.
    expect(html).toContain(HAT_IMG);
    expect(html.replace(HAT_ICON, "").replace(HAT_IMG, "")).not.toMatch(/<script|<link|https?:\/\/(?!www\.w3)/);
    expect(html).toContain("<dt>Engine</dt><dd><code>ReplacingMergeTree(at)</code></dd>");
    expect(html).toContain("<dt>ORDER BY</dt><dd><code>(kind, id)</code></dd>");
    expect(html).toContain("<dt>TTL</dt><dd><code>at + INTERVAL 1 YEAR</code></dd>");
    expect(html).toContain('<li>written by <a href="#o-dailyTotalsMv">shop.daily_totals_mv</a></li>');
    expect(html).toContain("<td>The event id</td>");
  });

  it("lists the migrations that changed an object, and --migration documents a recorded schema", async () => {
    const dir = join(repoRoot, "examples", "postgres");
    const html = schemaHtml(await docsInput(await loadProject(dir)));
    expect(html).toContain("<td><code>20261010T1724-rename-email</code></td><td><code>PostgresMigrationOp step (SQLPG205 columns.email)</code></td>");
    const first = await docsInput(await loadProject(dir), "20261010T1723-baseline");
    expect(first.source).toBe("the schema migration 20261010T1723-baseline recorded");
    expect(first.migrations?.map((m) => m.id)).toEqual(["20261010T1723-baseline"]);
    expect(erdMermaid(first.output)).toContain("text customer_email\n");
    const unknown = await yodel(["docs", "--dir", dir, "--migration", "nope", "--out", join(tmpdir(), "yodel-docs-unused")]);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain("no migration nope");
  });

  it.each(["clickhouse", "postgres"])("examples/%s/schema-docs/ is what yodel docs writes, and docs/schema-docs.md shows its ERD", async (name) => {
    const out = mkdtempSync(join(tmpdir(), `yodel-docs-${name}-`));
    try {
      const ran = await yodel(["docs", "--dir", join(repoRoot, "examples", name), "--out", out]);
      expect(ran.code, ran.err).toBe(0);
      for (const file of ["index.html", "erd.md"]) {
        expect(readFileSync(join(out, file), "utf8"), `examples/${name}/schema-docs/${file} is stale: run yodel docs in examples/${name}`).toBe(
          readFileSync(join(repoRoot, "examples", name, "schema-docs", file), "utf8"),
        );
      }
      const page = readFileSync(join(repoRoot, "docs", "schema-docs.md"), "utf8");
      const shown = new RegExp(`<!-- erd: ${name} -->\\n<pre class="mermaid">\\n([\\s\\S]*?)</pre>`).exec(page)?.[1];
      expect(shown, `docs/schema-docs.md shows no ERD for ${name}`).toBeDefined();
      expect(shown).toBe(mermaidBlock(readFileSync(join(out, "erd.md"), "utf8")));
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
