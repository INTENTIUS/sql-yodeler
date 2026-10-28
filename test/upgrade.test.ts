/**
 * `yodel upgrade` (#298): a project rendered by 0.10.1 moves onto chant's
 * product pipeline in one commit once its chant is at the floor, and the
 * docs name the same floor the command does.
 *
 * The cases that need chant's product pipeline skip on a chant without it;
 * the refusal skips on a chant with it.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CHANT_CI_FLOOR, chantParts, installedVersion, installLine } from "../src/chant-floor.js";
import { declarationAbove, newDeclaration, TEMPLATE_DECLARATION_NAME, upgradeFiles, workspaceName } from "../src/commands/upgrade.js";
import { PRODUCT } from "./helpers/chant-bin.js";
import { copyTemplate, repoRoot, yodel } from "./helpers/run.js";
import { render } from "../src/ci/render.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

const scratch = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `yodel-upgrade-${name}-`));
  temps.push(dir);
  return dir;
};

/**
 * A project as 0.10.1's template made it: the template's files with no
 * workspace declaration and the pipelines from yodel's own generator, chant
 * and the lexicons from this checkout, in a repository.
 */
async function project(dialect: "clickhouse" | "postgres"): Promise<string> {
  const dir = scratch(dialect);
  copyTemplate(dialect, dir);
  symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"));
  for (const f of await render(dir, { product: false })) {
    mkdirSync(dirname(join(dir, f.path)), { recursive: true });
    writeFileSync(join(dir, f.path), f.content);
  }
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  return dir;
}

const page = (name: string) => readFileSync(join(repoRoot, "docs", name), "utf8");

describe("the chant floor", () => {
  it("is a version, and the install line pins chant and the sql lexicon at it", () => {
    expect(CHANT_CI_FLOOR).toMatch(/^\d+\.\d+\.\d+$/);
    expect(installLine()).toBe(`npm install -E @intentius/chant@${CHANT_CI_FLOOR} @intentius/chant-lexicon-sql@${CHANT_CI_FLOOR}`);
  });

  it("the docs name the same floor, and workflows.md the same install line", () => {
    const text = page("chant-ci.md");
    expect(text).toContain(`## From chant ${CHANT_CI_FLOOR}`);
    expect(text).toContain("https://intentius.io/chant/concepts/ci-products/");
    const workflows = page("workflows.md");
    expect(workflows).toContain(`### Upgrading the pipelines to chant ${CHANT_CI_FLOOR}`);
    expect(workflows).toContain(installLine());
    // Every version the upgrade's text names is the floor: chant-ci.md, workflows.md's upgrade section, and cli.md's rows for yodel upgrade and yodel chant.
    const upgrade = workflows.slice(workflows.indexOf("### Upgrading the pipelines"), workflows.indexOf("## ClickHouse objects"));
    const rows = page("cli.md").split("\n").filter((l) => l.startsWith("| `yodel upgrade`") || l.startsWith("| `yodel chant"));
    expect(rows).toHaveLength(2);
    for (const [where, t] of [["docs/chant-ci.md", text], ["docs/workflows.md", upgrade], ["docs/cli.md", rows.join("\n")]] as const) {
      for (const m of t.matchAll(/\b\d+\.\d+\.\d+\b/g)) expect(m[0], where).toBe(CHANT_CI_FLOOR);
    }
  });

  it("no other docs page says which chant release brings a part of chant CI: that is docs/chant-ci.md's upgrade section", () => {
    const status = /the release after 0\.\d+\.\d+|a published chant without|with a published chant they keep/;
    const found = readdirSync(join(repoRoot, "docs"))
      .filter((f) => f.endsWith(".md") && f !== "chant-ci.md")
      .flatMap((f) => page(f).split("\n").flatMap((line, i) => (status.test(line) ? [`docs/${f}:${String(i + 1)}`] : [])));
    expect(found).toEqual([]);
  });

  it("finds the installed chant's version", () => {
    const v = installedVersion("@intentius/chant");
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
    expect(installedVersion("@intentius/no-such-package")).toBeUndefined();
  });

  it("lists every part of chant CI, the product pipeline first", async () => {
    const parts = await chantParts();
    expect(parts[0]?.name).toMatch(/^product pipeline/);
    expect(parts[0]?.has).toBe(PRODUCT);
    expect(new Set(parts.map((p) => p.section)).size).toBe(parts.length);
    // Each part's section is a heading of docs/chant-ci.md.
    const anchors = new Set([...page("chant-ci.md").matchAll(/^#{2,4} (.+)$/gm)].map((m) => (m[1] ?? "").toLowerCase().replace(/[^a-z0-9 -]/g, "").replace(/ /g, "-")));
    for (const p of parts) expect(anchors, p.section).toContain(p.section);
  });
});

describe("the workspace declaration yodel upgrade adds", () => {
  it("is named for the package, in chant's rule for a name", () => {
    const dir = scratch("name");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@acme/Shop.Schema_v2" }));
    expect(workspaceName(dir)).toBe("shop-schema-v2");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x".repeat(60) }));
    expect(workspaceName(dir)).toBe("x".repeat(40));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "_workspace" }));
    expect(workspaceName(dir)).toBe("workspace");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "---" }));
    expect(workspaceName(dir)).toBe("yodel");
  });

  it("declares the project as the workspace, with no members", async () => {
    const dir = scratch("declaration");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "shop" }));
    const d = await newDeclaration(dir);
    expect(d.path).toBe("chant.workspace.json");
    expect(JSON.parse(d.content)).toMatchObject({ name: "shop", schema: 1, members: [] });
    expect((JSON.parse((await newDeclaration(dir, TEMPLATE_DECLARATION_NAME)).content) as { name: string }).name).toBe("{{chant:name}}");
  });

  it("is not added under a repository whose declaration is above the project", () => {
    const repo = scratch("monorepo");
    mkdirSync(join(repo, ".git"));
    writeFileSync(join(repo, "chant.workspace.json"), "{}\n");
    mkdirSync(join(repo, "db"));
    expect(declarationAbove(join(repo, "db"))).toBe(join(repo, "chant.workspace.json"));
    const alone = scratch("alone");
    mkdirSync(join(alone, ".git"));
    expect(declarationAbove(alone)).toBeUndefined();
  });
});

describe.skipIf(PRODUCT)("yodel upgrade on a chant without the product pipeline", () => {
  it("writes nothing, exits 1 and names the floor's install line", async () => {
    const dir = await project("postgres");
    const before = readFileSync(join(dir, ".github/workflows/yodel-apply.yml"), "utf8");
    const ran = await yodel(["upgrade", "--dir", dir]);
    expect(ran.code).toBe(1);
    expect(ran.out).toMatch(/^chant \d+\.\d+\.\d+/);
    expect(ran.out).toContain("no   product pipeline");
    expect(ran.err).toContain(installLine());
    expect(existsSync(join(dir, "chant.workspace.json"))).toBe(false);
    expect(readFileSync(join(dir, ".github/workflows/yodel-apply.yml"), "utf8")).toBe(before);
  });
});

describe.skipIf(!PRODUCT).each(["clickhouse", "postgres"] as const)("yodel upgrade of a project made from the %s template", (dialect) => {
  it("writes the declaration and the pipelines in one go, then yodel ci --check and yodel upgrade --check pass", async () => {
    const dir = await project(dialect);
    const check = await yodel(["upgrade", "--check", "--dir", dir]);
    expect(check.code).toBe(1);
    expect(check.err).toContain("chant.workspace.json");
    expect(check.err).toContain("yodel-waves.json");

    const ran = await yodel(["upgrade", "--dir", dir]);
    expect(ran.code, ran.err).toBe(0);
    expect(ran.out).toContain("wrote chant.workspace.json (new)");
    const declaration = JSON.parse(readFileSync(join(dir, "chant.workspace.json"), "utf8")) as { name: string; ci?: { hooks?: { check?: Array<{ name?: string }> } } };
    expect(declaration.name).toBe(workspaceName(dir));
    expect(declaration.ci?.hooks?.check?.map((h) => h.name)).toContain("yodel-lint");
    const spec = JSON.parse(readFileSync(join(dir, "yodel-waves.json"), "utf8")) as { gateName?: string };
    expect(spec.gateName).toBe("yodel-apply-wave-{k}");
    expect(readFileSync(join(dir, ".github/workflows/yodel-apply.yml"), "utf8")).toContain("yodel chant run wave");

    expect((await yodel(["ci", "--check", "--dir", dir])).code).toBe(0);
    expect((await yodel(["upgrade", "--check", "--dir", dir])).code).toBe(0);
    const again = await yodel(["upgrade", "--dir", dir]);
    expect(again.out).toContain("nothing to write");
  });

  it("gives the templates' declaration the name parameter, for templates:render", async () => {
    const dir = await project(dialect);
    const { files } = await upgradeFiles(dir, { declarationName: TEMPLATE_DECLARATION_NAME });
    const declaration = files.find((f) => f.path === "chant.workspace.json");
    expect((JSON.parse(declaration?.content ?? "{}") as { name?: string }).name).toBe("{{chant:name}}");
  });
});
