/**
 * `yodel upgrade` (#298): a project rendered by 0.10.1 moves onto chant's
 * product pipeline in one commit, and the docs name 0.12's chant floor in
 * one place.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { installedVersion } from "../src/chant-floor.js";
import { declarationAbove, newDeclaration, TEMPLATE_DECLARATION_NAME, upgradeFiles, workspaceName } from "../src/commands/upgrade.js";
import { copyTemplate, repoRoot, yodel } from "./helpers/run.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

const scratch = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `yodel-upgrade-${name}-`));
  temps.push(dir);
  return dir;
};

/** yodel-waves.json as 0.10.1 rendered it: yodel's plan and apply callbacks, no capability step, no gate pattern, no stand-down. */
const WAVES_0_10_1 = {
  name: "yodel-apply",
  op: "migrate-dev",
  plan: ["yodel", "apply", "{target}", "--wave-plan", "{plan}", "--spec", "yodel-waves.json"],
  apply: ["yodel", "apply", "{target}", "--wave-apply", "{plan}", "--spec", "yodel-waves.json"],
  branches: ["main"],
  waves: [
    { name: "dev", runs: [{ target: "dev", op: "migrate-dev" }], gate: "always" },
    { name: "prod", runs: [{ target: "prod", op: "migrate-prod" }], gate: "always" },
  ],
};

/**
 * A project as 0.10.1's template made it, as far as the upgrade reads it:
 * the template's files with no workspace declaration, the waves spec on
 * yodel's callbacks and the wave jobs running bare `chant run wave` with
 * YODEL_LOCK_WAIT and YODEL_STAND_DOWN, chant and the lexicons from this
 * checkout, in a repository. yodel's own generator, which rendered these,
 * left in 0.12 (#303).
 */
function project(dialect: "clickhouse" | "postgres"): string {
  const dir = scratch(dialect);
  copyTemplate(dialect, dir);
  symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"));
  writeFileSync(join(dir, "yodel-waves.json"), `${JSON.stringify(WAVES_0_10_1, null, 2)}\n`);
  const apply = join(dir, ".github/workflows/yodel-apply.yml");
  writeFileSync(apply, readFileSync(apply, "utf8").replace(/yodel chant run wave/g, "chant run wave").replace(/^( +)YODEL_CREDENTIALS: (.*)$/gm, "$1YODEL_CREDENTIALS: $2\n$1YODEL_LOCK_WAIT: '10m'\n$1YODEL_STAND_DOWN: '1'"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  return dir;
}

const page = (name: string) => readFileSync(join(repoRoot, "docs", name), "utf8");

/** The chant release yodel 0.12 took as its floor (#303), which the upgrade docs name. */
const CHANT_CI_FLOOR = "0.124.67";
const installLine = `npm install -E @intentius/chant@${CHANT_CI_FLOOR} @intentius/chant-lexicon-sql@${CHANT_CI_FLOOR}`;

describe("the chant floor", () => {
  it("the docs name the same floor, and workflows.md the same install line", () => {
    const text = page("chant-ci.md");
    expect(text).toContain(`## From chant ${CHANT_CI_FLOOR}`);
    expect(text).toContain("https://intentius.io/chant/concepts/ci-products/");
    const workflows = page("workflows.md");
    expect(workflows).toContain(`### Upgrading the pipelines to chant ${CHANT_CI_FLOOR}`);
    expect(workflows).toContain(installLine);
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

  it("declares the project as the workspace, with no members", () => {
    const dir = scratch("declaration");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "shop" }));
    const d = newDeclaration(dir);
    expect(d.path).toBe("chant.workspace.json");
    expect(JSON.parse(d.content)).toMatchObject({ name: "shop", schema: 1, members: [] });
    expect((JSON.parse(newDeclaration(dir, TEMPLATE_DECLARATION_NAME).content) as { name: string }).name).toBe("{{chant:name}}");
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

describe.each(["clickhouse", "postgres"] as const)("yodel upgrade of a project made from the %s template", (dialect) => {
  it("writes the declaration and the pipelines in one go, then yodel ci --check and yodel upgrade --check pass", async () => {
    const dir = project(dialect);
    const check = await yodel(["upgrade", "--check", "--dir", dir]);
    expect(check.code).toBe(1);
    expect(check.err).toContain("chant.workspace.json");
    expect(check.err).toContain("yodel-waves.json");
    expect(check.err).toContain(".github/workflows/yodel-apply.yml");

    const ran = await yodel(["upgrade", "--dir", dir]);
    expect(ran.code, ran.err).toBe(0);
    expect(ran.out).toContain("wrote chant.workspace.json (new)");
    const declaration = JSON.parse(readFileSync(join(dir, "chant.workspace.json"), "utf8")) as { name: string; ci?: { hooks?: { check?: Array<{ name?: string }> } } };
    expect(declaration.name).toBe(workspaceName(dir));
    expect(declaration.ci?.hooks?.check?.map((h) => h.name)).toContain("yodel-lint");
    const spec = JSON.parse(readFileSync(join(dir, "yodel-waves.json"), "utf8")) as { gateName?: string };
    expect(spec.gateName).toBe("yodel-apply-wave-{k}");
    expect(readFileSync(join(dir, ".github/workflows/yodel-apply.yml"), "utf8")).toContain("yodel chant run wave");
    expect(readFileSync(join(dir, ".github/workflows/yodel-apply.yml"), "utf8")).not.toMatch(/YODEL_LOCK_WAIT|YODEL_STAND_DOWN/);

    expect((await yodel(["ci", "--check", "--dir", dir])).code).toBe(0);
    expect((await yodel(["upgrade", "--check", "--dir", dir])).code).toBe(0);
    const again = await yodel(["upgrade", "--dir", dir]);
    expect(again.out).toContain("nothing to write");
  });

  it("gives the templates' declaration the name parameter, for templates:render", async () => {
    const dir = project(dialect);
    const { files } = await upgradeFiles(dir, { declarationName: TEMPLATE_DECLARATION_NAME });
    const declaration = files.find((f) => f.path === "chant.workspace.json");
    expect((JSON.parse(declaration?.content ?? "{}") as { name?: string }).name).toBe("{{chant:name}}");
  });
});
