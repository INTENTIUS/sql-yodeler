/**
 * The output docs/ quotes from scripts that need no server is what those
 * scripts print today, and what docs/ quotes from the examples' runs is what
 * their READMEs show. (The examples' transcripts are checked against the
 * emulator by test/e2e/examples.test.ts.)
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findBlock, load, quotes, runWalkthrough } from "../examples/walkthrough/run.js";
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

  it.each(["clickhouse", "postgres"])("what docs/ quotes from the %s example's run is what its README shows", async (dialect) => {
    const w = await load(dialect);
    const readme = readFileSync(join(repoRoot, "examples", dialect, "README.md"), "utf8");
    // Consecutive quoted steps are one block in docs/ and one block each in the README.
    const groups: Array<{ page: string; commands: string[] }> = [];
    let open: { page: string; commands: string[] } | undefined;
    for (const step of w.steps) {
      if ("run" in step && step.quote) {
        if (/\{[a-z]/.test(step.run)) throw new Error(`a quoted step's command must be literal: ${step.run}`);
        if (open?.page !== step.quote) groups.push((open = { page: step.quote, commands: [] }));
        open.commands.push(step.run);
      } else open = undefined;
    }
    const body = (text: string, command: string, where: string) => {
      const b = findBlock(text, command);
      if (!b) throw new Error(`${where} has no console block starting with "$ ${command}"`);
      return text.slice(b.start, b.end);
    };
    for (const g of groups) {
      const page = readFileSync(join(repoRoot, "docs", g.page), "utf8");
      const fromReadme = g.commands.map((c) => body(readme, c, `examples/${dialect}/README.md`)).join("\n");
      expect(body(page, g.commands[0] ?? "", `docs/${g.page}`), `docs/${g.page}`).toBe(fromReadme);
    }
  });

  it("adoption.md shows what examples/walkthrough/template.ts prints", async () => {
    if (!existsSync(join(repoRoot, "dist", "bin.js"))) throw new Error("run npm run build first: the walkthrough runs dist/bin.js");
    const { ran, dispose } = await runWalkthrough(await load("template"));
    try {
      const id = (text: string) => text.replace(/\b\d{8}T\d{4}-/g, "<id>-");
      const made = quotes(ran);
      expect(made.length).toBeGreaterThan(0);
      for (const q of made) {
        const page = readFileSync(join(repoRoot, "docs", q.page), "utf8");
        const b = findBlock(page, q.command);
        expect(b, `docs/${q.page}: "$ ${q.command}"`).toBeDefined();
        if (b) expect(id(page.slice(b.start, b.end))).toBe(id(q.text));
      }
    } finally {
      dispose();
    }
  }, 120_000);
});
