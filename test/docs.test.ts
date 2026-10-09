/**
 * The output docs/ quotes from scripts that need no server is what those
 * scripts print today. (The examples' transcripts are checked against the
 * emulator by test/e2e/examples.test.ts.)
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { render } from "../examples/walkthrough/topology.js";
import { repoRoot, yodel } from "./helpers/run.js";

/** The console block in `page` that starts with `$ <command>`, without the command line. */
function block(page: string, command: string): string {
  const text = readFileSync(join(repoRoot, "docs", page), "utf8");
  const start = text.indexOf(`$ ${command}\n`);
  if (start === -1) throw new Error(`docs/${page} has no "$ ${command}" block`);
  const body = text.slice(start + command.length + 3);
  return body.slice(0, body.indexOf("\n```"));
}

describe("docs", () => {
  it("topology.md shows what examples/walkthrough/topology.ts prints", () => {
    expect(block("topology.md", "npx tsx examples/walkthrough/topology.ts")).toBe(render().trimEnd());
  });

  it("lint.md shows what yodel lint --rules prints in examples/clickhouse", async () => {
    const ran = await yodel(["lint", "--rules", "--dir", join(repoRoot, "examples", "clickhouse")]);
    expect(ran.code, ran.err).toBe(0);
    expect(block("lint.md", "npx yodel lint --rules")).toBe(ran.out.trimEnd());
  });
});
