/**
 * Every transcript docs/ quotes is checked. A block from a walkthrough
 * (examples/walkthrough/) follows a `<!-- quote: <walkthrough>#<id> -->` line
 * naming the step it shows: from an example's run it must be what the
 * example's README shows for the same steps (the examples' transcripts are
 * checked against the emulator by test/e2e/examples.test.ts), and from a
 * walkthrough that needs no server it must be what a fresh run prints. The
 * few blocks from commands that need no server are run here.
 */

import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { excerpt, findMarked, load, marker, quoteGroups, quotes, runWalkthrough } from "../examples/walkthrough/run.js";
import { render } from "../examples/walkthrough/topology.js";
import { repoRoot, yodel } from "./helpers/run.js";
// @ts-expect-error docs-site/prompts.mjs is plain JavaScript, with no types
import { neverLine, pagePrompts, pageUrl, setupPrompt } from "../docs-site/prompts.mjs";

const page = (name: string) => readFileSync(join(repoRoot, "docs", name), "utf8");

/** The console block in `text` that starts with `$ <command>`, without the command line. */
function block(text: string, command: string, where: string): string {
  const start = text.indexOf(`$ ${command}\n`);
  if (start === -1) throw new Error(`${where} has no "$ ${command}" block`);
  const body = text.slice(start + command.length + 3);
  return body.slice(0, body.indexOf("\n```"));
}

/** The body of the block after `mark` in `text`. */
function marked(text: string, mark: string, where: string, from = 0): { body: string; end: number } {
  const b = findMarked(text, mark, from);
  if (!b) throw new Error(`${where} has no block after ${mark}`);
  return { body: text.slice(b.start, b.end), end: b.end };
}

/** The blocks run here, by their first command, and the page each is on. */
const RUN_HERE: Record<string, string> = {
  "npx tsx examples/walkthrough/topology.ts": "topology.md",
  "npx yodel lint --rules": "lint.md",
  "yodel --help": "README.md",
  "yodel plan dev": "configuration.md",
};

describe("docs", () => {
  it("topology.md shows what examples/walkthrough/topology.ts prints", () => {
    expect(block(page("topology.md"), "npx tsx examples/walkthrough/topology.ts", "docs/topology.md")).toBe(render().trimEnd());
  });

  it("lint.md shows what yodel lint --rules prints in examples/clickhouse", async () => {
    const ran = await yodel(["lint", "--rules", "--dir", join(repoRoot, "examples", "clickhouse")]);
    expect(ran.code, ran.err).toBe(0);
    expect(block(page("lint.md"), "npx yodel lint --rules", "docs/lint.md")).toBe(ran.out.trimEnd());
  });

  it("README.md shows what yodel --help prints", async () => {
    const ran = await yodel(["--help"]);
    expect(block(page("README.md"), "yodel --help", "docs/README.md")).toBe(ran.out.trimEnd());
  });

  it("configuration.md shows the refusal of a topology set only in yodel.config.ts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yodel-docs-topology-"));
    try {
      for (const f of ["chant.config.ts", "package.json", "src"]) cpSync(join(repoRoot, "examples", "clickhouse", f), join(dir, f), { recursive: true });
      symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"), "dir");
      writeFileSync(join(dir, "yodel.config.ts"), 'export default { environments: { dev: { topology: "cluster:main" } } };\n');
      const ran = await yodel(["plan", "dev", "--dir", dir]);
      expect(ran.code).toBe(1);
      expect(block(page("configuration.md"), "yodel plan dev", "docs/configuration.md")).toBe(ran.err.trimEnd());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(["clickhouse", "postgres"])("what docs/ quotes from the %s example's run is what its README shows", async (name) => {
    const w = await load(name);
    const readme = readFileSync(join(repoRoot, "examples", name, "README.md"), "utf8");
    const groups = quoteGroups(w.steps);
    expect(groups.length).toBeGreaterThan(0);
    for (const g of groups) {
      const mark = marker(name, g.id);
      let from = 0;
      const shown = g.members.map((m) => {
        const b = marked(readme, mark, `examples/${name}/README.md`, from);
        from = b.end;
        return excerpt(b.body, m.excerpt, "run" in m.step);
      });
      expect(marked(page(g.page), mark, `docs/${g.page}`).body, `docs/${g.page}: ${mark}`).toBe(shown.join("\n"));
    }
  });

  it("every console block in docs/ follows a quote line naming a walkthrough step, or is run here", async () => {
    const known = new Set<string>();
    for (const name of ["clickhouse", "postgres", "template", "getting-started"]) for (const g of quoteGroups((await load(name)).steps)) known.add(`${g.page} ${marker(name, g.id)}`);
    const problems: string[] = [];
    for (const file of readdirSync(join(repoRoot, "docs")).filter((f) => f.endsWith(".md"))) {
      const lines = page(file).split("\n");
      lines.forEach((line, i) => {
        const mark = /^<!-- quote: .* -->$/.exec(line)?.[0];
        if (mark && !known.has(`${file} ${mark}`)) problems.push(`docs/${file}:${String(i + 1)}: ${mark} names no quoted step of that page`);
        if (!/^`{3,}console$/.test(line)) return;
        const first = (lines[i + 1] ?? "").replace(/^\$ /, "");
        if (RUN_HERE[first] === file) return;
        if (!/^<!-- quote: [\w-]+#[a-z0-9-]+ -->$/.test(lines[i - 1] ?? "")) problems.push(`docs/${file}:${String(i + 1)}: a console block with no quote line above it`);
      });
    }
    expect(problems).toEqual([]);
  });

  it("getting-started.md has each quoted step of examples/walkthrough/getting-started.ts, with its exit code", async () => {
    // Its steps need a server of their own, so this checks the commands and exit codes; run.ts getting-started --write refreshes the output.
    for (const g of quoteGroups((await load("getting-started")).steps)) {
      const text = marked(page(g.page), marker("getting-started", g.id), `docs/${g.page}`).body;
      const parts = `\n${text}`.split("\n$ ").slice(1);
      expect(parts.map((p) => p.split("\n")[0])).toEqual(g.members.map((m) => ("run" in m.step ? m.step.run : "")));
      expect(parts.map((p) => /\n\[exit (\d+)\]$/.exec(p.trimEnd())?.[1] ?? "0")).toEqual(g.members.map((m) => ("run" in m.step ? String(m.step.code) : "")));
    }
  });

  it("adoption.md shows what examples/walkthrough/template.ts prints", async () => {
    if (!existsSync(join(repoRoot, "dist", "bin.js"))) throw new Error("run npm run build first: the walkthrough runs dist/bin.js");
    const { ran, dispose } = await runWalkthrough(await load("template"));
    try {
      const id = (text: string) => text.replace(/\b\d{8}T\d{4}-/g, "<id>-");
      const made = quotes(ran);
      expect(made.length).toBeGreaterThan(0);
      for (const q of made) expect(id(marked(page(q.page), marker("template", q.id), `docs/${q.page}`).body)).toBe(id(q.text));
    } finally {
      dispose();
    }
  }, 120_000);

  describe("the prompts for coding agents (docs-site/prompts.mjs)", () => {
    const prompts = Object.entries(pagePrompts as Record<string, string>);
    const flat = (text: string) => text.replace(/\s+/g, " ");

    it.each(prompts)("%s's prompt carries the never-line word for word and names its page", (slug, prompt) => {
      expect(flat(prompt), "end it with the never-line from docs-site/prompts.mjs").toContain(neverLine as string);
      expect(prompt).toContain((pageUrl as (s: string) => string)(slug));
    });

    it.each(prompts)("%s is a page in docs/", (slug) => {
      expect(existsSync(join(repoRoot, "docs", `${slug}.md`))).toBe(true);
    });

    it("agents.md and its prompt are there, and agents.md quotes the setup prompt word for word", () => {
      expect(pagePrompts).toHaveProperty("agents", setupPrompt);
      const page = readFileSync(join(repoRoot, "docs", "agents.md"), "utf8");
      expect(page).toContain("```text\n" + (setupPrompt as string) + "\n```");
    });
  });
});
