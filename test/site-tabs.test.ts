/**
 * The docs' tabs convention (docs-site/pages.mjs tabsToMdx): a block between
 * `<!-- tabs: <key> -->` and `<!-- /tabs -->` becomes a Starlight tab group,
 * the rest of the page valid MDX, and a malformed block fails the site build
 * naming the docs file and line.
 */

import { describe, expect, it } from "vitest";
// @ts-expect-error docs-site/pages.mjs is plain JavaScript, with no types
import { tabsToMdx as untyped } from "../docs-site/pages.mjs";

const tabsToMdx = untyped as (md: string, where: (i: number) => string) => { count: number; mdx: string };
const convert = (md: string) => tabsToMdx(md, (i) => `docs/page.md:${String(i + 1)}`);

describe("tabs blocks in docs pages", () => {
  it("leaves a page without one alone", () => {
    expect(convert("# Page\n\nText.\n").count).toBe(0);
  });

  it("turns a block into Tabs and TabItems, and makes the rest valid MDX", () => {
    const md = [
      "Use `<ENV>` and {x} <here>. <!-- dropped -->",
      "<!-- tabs: dialect -->",
      "#### ClickHouse",
      "",
      "```sh",
      "# not a heading {}",
      "```",
      "",
      "#### Postgres",
      "",
      "Text.",
      "",
      "<!-- /tabs -->",
    ].join("\n");
    const { count, mdx } = convert(md);
    expect(count).toBe(1);
    expect(mdx).toContain("Use `<ENV>` and \\{x\\} \\<here>. ");
    expect(mdx).not.toContain("dropped");
    expect(mdx).toContain('<Tabs syncKey="dialect">\n\n<TabItem label="ClickHouse">\n\n```sh\n# not a heading {}\n```\n\n</TabItem>\n\n<TabItem label="Postgres">\n\nText.\n\n</TabItem>\n\n</Tabs>');
  });

  it("refuses a malformed block, naming the file and line", () => {
    expect(() => convert("<!-- tabs: colour -->\n#### Red\n<!-- /tabs -->")).toThrow("docs/page.md:1: tabs: colour is not a tab group");
    expect(() => convert("<!-- tabs: dialect -->\n#### MySQL\n<!-- /tabs -->")).toThrow("docs/page.md:2: #### MySQL is not a tab of dialect; use one of ClickHouse, Postgres");
    expect(() => convert("<!-- tabs: forge -->\n#### GitHub\n\n### Steps\n<!-- /tabs -->")).toThrow("docs/page.md:4: a ### heading inside the tabs block opened at line 1");
    expect(() => convert("<!-- tabs: forge -->\nText first.\n#### GitHub\n<!-- /tabs -->")).toThrow("docs/page.md:2: text before the first #### heading");
    expect(() => convert("\n<!-- tabs: forge -->\n#### GitHub\nText.\n")).toThrow("docs/page.md:2: the tabs block opened here has no <!-- /tabs --> to close it");
  });
});
