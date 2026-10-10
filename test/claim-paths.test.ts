/**
 * scenarios/claim-paths.txt, the map `npm run claims -- --affected` reads,
 * and the picking in scenarios/affected.ts.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { affected, changedSince, entryFor, globToRegExp, parseClaimPaths, readClaimPaths, reasons, unknownClaims } from "../scenarios/affected.js";
import { claims } from "../scenarios/claims/index.js";
import type { Claim } from "../scenarios/lib/claim.js";
import { repoRoot } from "./helpers/run.js";

const names = claims.map((c) => c.name);
const entries = readClaimPaths();

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [relative(repoRoot, join(dir, e.name))]));
}

describe("scenarios/claim-paths.txt", () => {
  it("names only claims that exist", () => {
    expect(unknownClaims(entries, names)).toEqual([]);
  });

  it("reaches every claim from a line of its own, not only through ALL", () => {
    const named = new Set(entries.flatMap((e) => (e.claims === "ALL" ? [] : e.claims)));
    expect(names.filter((n) => !named.has(n))).toEqual([]);
  });

  it("has a line for every file under src/", () => {
    const missing = walk(join(repoRoot, "src")).filter((p) => !entryFor(p, entries));
    expect(missing).toEqual([]);
  });

  it("maps each file in scenarios/claims/ to the claims it defines", async () => {
    const dir = join(repoRoot, "scenarios", "claims");
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "index.ts")) {
      const mod = (await import(join(dir, f))) as Record<string, unknown>;
      const defined = Object.values(mod)
        .filter((v): v is Claim => typeof v === "object" && v !== null && "name" in v && "dialects" in v)
        .map((c) => c.name);
      const e = entryFor(`scenarios/claims/${f}`, entries);
      const mapped = e?.claims;
      if (mapped === undefined || mapped === "ALL") throw new Error(`scenarios/claims/${f} has no line of its own in claim-paths.txt`);
      expect([...mapped].sort(), f).toEqual(defined.sort());
    }
  });

  it("has no line that matches no file", () => {
    const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: repoRoot, encoding: "utf8" }).split("\n").filter(Boolean);
    expect(entries.filter((e) => !tracked.some((p) => e.re.test(p))).map((e) => `${String(e.line)}: ${e.glob}`)).toEqual([]);
  });

  it("picks no claim for docs and tests, and every claim for the runner", () => {
    expect(affected(["docs/lint.md", "README.md", "test/lint.test.ts"], entries, names).claims).toEqual([]);
    expect(affected(["scenarios/lib/db.ts"], entries, names).claims).toEqual(names);
    expect(affected(["src/replay/postgres.ts"], entries, names).claims).toEqual(["lint", "template", "template-github", "template-gitlab"]);
    expect(affected(["src/lint/silences.ts"], entries, names).claims).toEqual(names);
  });
});

describe("globToRegExp", () => {
  it.each([
    ["src/lint/", "src/lint/rules.ts", true],
    ["src/lint/", "src/lint", false],
    ["src/lint/", "src/linter/x.ts", false],
    ["src/*.ts", "src/cli.ts", true],
    ["src/*.ts", "src/commands/new.ts", false],
    ["*.md", "README.md", true],
    ["*.md", "docs/lint.md", false],
    ["**/*.md", "docs/lint.md", true],
    ["**/*.md", "README.md", true],
    ["src/**/kinds.ts", "src/steps/kinds.ts", true],
    ["src/?.ts", "src/a.ts", true],
    ["tsconfig.json", "tsconfigXjson", false],
  ])("%s matches %s: %s", (glob, path, want) => {
    expect(globToRegExp(glob).test(path)).toBe(want);
  });
});

describe("affected", () => {
  const map = parseClaimPaths(`
# a comment
docs/          -
src/a.ts       one      # the file before its directory
src/           two three
pkg.json       ALL
`);
  const all = ["one", "two", "three", "four"];

  it("takes the first line that matches", () => {
    expect(affected(["src/a.ts"], map, all).claims).toEqual(["one"]);
    expect(affected(["src/b.ts"], map, all).claims).toEqual(["two", "three"]);
  });

  it("runs every claim for ALL and for a path no line names", () => {
    expect(affected(["pkg.json"], map, all).claims).toEqual(all);
    const a = affected(["new/thing.ts"], map, all);
    expect(a.claims).toEqual(all);
    expect(a.why.get("four")).toEqual(["new/thing.ts (no entry: every claim)"]);
  });

  it("runs nothing for an inert path, and says so", () => {
    const a = affected(["docs/x.md"], map, all);
    expect(a.claims).toEqual([]);
    expect(a.inert).toEqual(["docs/x.md (docs/)"]);
  });

  it("says why, one line per claim picked, in claim order", () => {
    const a = affected(["src/b.ts", "src/a.ts", "src/c.ts", "src/d.ts", "src/e.ts"], map, all);
    expect(reasons(a)).toEqual([
      "one: src/a.ts (src/a.ts)",
      "two: src/b.ts (src/), src/c.ts (src/), src/d.ts (src/), and 1 more",
      "three: src/b.ts (src/), src/c.ts (src/), src/d.ts (src/), and 1 more",
    ]);
  });

  it("refuses a line with no claims, and names unknown claims", () => {
    expect(() => parseClaimPaths("src/  \n")).toThrow(/claim-paths.txt:1/);
    expect(() => parseClaimPaths("src/ one ALL\n")).toThrow(/stand alone/);
    expect(unknownClaims(parseClaimPaths("src/ one five\n"), all)).toEqual(["five (claim-paths.txt:1)"]);
  });
});

describe("changedSince", () => {
  const dir = mkdtempSync(join(tmpdir(), "yodel-affected-"));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, encoding: "utf8" });

  it("lists committed, uncommitted and untracked changes since the merge base, renames both ways", () => {
    git("init", "-q", "-b", "main");
    for (const f of ["a.ts", "b.ts", "c.ts"]) writeFileSync(join(dir, f), `${f}\n`);
    git("add", "-A");
    git("commit", "-qm", "base");
    git("checkout", "-qb", "work");
    writeFileSync(join(dir, "a.ts"), "changed\n");
    git("commit", "-qam", "a");
    git("checkout", "-q", "main");
    writeFileSync(join(dir, "main-only.ts"), "x\n");
    git("add", "-A");
    git("commit", "-qm", "main moved on");
    git("checkout", "-q", "work");
    writeFileSync(join(dir, "b.ts"), "dirty\n");
    renameSync(join(dir, "c.ts"), join(dir, "d.ts"));
    git("add", "-A", "c.ts", "d.ts");
    writeFileSync(join(dir, "new.ts"), "untracked\n");
    const c = changedSince("main", dir);
    expect(c.paths).toEqual(["a.ts", "b.ts", "c.ts", "d.ts", "new.ts"]);
    expect(c.mergeBase).toMatch(/^[0-9a-f]{7,}$/);
  });
});
