/**
 * The release on chant's release block (#319): chant.config.ts declares it,
 * `chant release workflow` writes .github/workflows/publish.yml from it, and
 * `chant ci workflow` writes the tick that tags green commits for its gate.
 * Neither file is edited by hand: each is what chant writes from the
 * committed config, and CHANGELOG.md has the section the GitHub release takes
 * its notes from.
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseNotesSection } from "@intentius/chant/lifecycle/publish-forge";
import { afterAll, describe, expect, it } from "vitest";
import config from "../chant.config.js";
import * as compiled from "../.github/chant/workflows.js";
import { repoRoot } from "./helpers/run.js";

const chant = join(repoRoot, "node_modules", ".bin", "chant");
const read = (f: string) => readFileSync(join(repoRoot, f), "utf8");

/** A copy of what the release files are rendered from, in a repository of its own. */
const scratch = mkdtempSync(join(tmpdir(), "yodel-release-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});
for (const f of ["chant.config.ts", "chant.workspace.json", "package.json"]) cpSync(join(repoRoot, f), join(scratch, f));
mkdirSync(join(scratch, ".github"), { recursive: true });
cpSync(join(repoRoot, ".github", "workflows"), join(scratch, ".github", "workflows"), { recursive: true });
symlinkSync(join(repoRoot, "node_modules"), join(scratch, "node_modules"));
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: scratch });

describe("the release (#319)", () => {
  it("is one dispatched run of chant's release workflow, from the newest green commit, to npm, GHCR and the GitHub release", () => {
    const release = config.release;
    expect(release.workflow).toMatchObject({ trigger: "dispatch", gate: "last-green", file: ".github/workflows/publish.yml" });
    expect(release.publish.map((t) => t.type)).toEqual(["oci", "npm", "forge"]);
    expect(release.images.map((i) => i.archive)).toEqual(["dist/images/sql-yodeler.tar"]);
    // The cut compiles this repository's own workflows and nothing else.
    expect(config.sourceDir).toBe(".github/chant");
    expect(Object.keys(compiled).sort()).toEqual(["ci", "claims", "claimsWeekly", "pages", "templates"]);
  });

  it("publish.yml is what chant release workflow writes from chant.config.ts, at the file npm's trusted publisher names", () => {
    execFileSync(chant, ["release", "workflow"], { cwd: scratch, stdio: "pipe" });
    expect(read(".github/workflows/publish.yml")).toBe(readFileSync(join(scratch, ".github", "workflows", "publish.yml"), "utf8"));
  }, 60_000);

  it("chant-ci-green.yml is what chant ci workflow writes from chant.workspace.json's ci.green", () => {
    execFileSync(chant, ["ci", "workflow", "--token-secret", "CI_GREEN_TOKEN"], { cwd: scratch, stdio: "pipe" });
    expect(read(".github/workflows/chant-ci-green.yml")).toBe(readFileSync(join(scratch, ".github", "workflows", "chant-ci-green.yml"), "utf8"));
  }, 60_000);

  it("the GitHub release's notes are CHANGELOG.md's section for the package's version", () => {
    const forge = config.release.publish.find((t) => t.type === "forge");
    if (forge?.type !== "forge") throw new Error("no forge target");
    const version = (JSON.parse(read("package.json")) as { version: string }).version;
    const section = releaseNotesSection(read(forge.notes.file), forge.notes.heading.replace("{version}", version));
    expect(section.trim().length).toBeGreaterThan(0);
  });
});
