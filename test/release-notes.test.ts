import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { workflow } from "../.github/src/publish.js";
import { changelogSection } from "../scripts/changelog-section.js";

/**
 * publish.yml's release job: the GitHub release for the tag, with
 * CHANGELOG.md's `## <version>` section as its notes.
 */

const changelog = `# Changelog

## 0.12.1

- A fix.

### Breaking

- Something.

## 0.12.0

- Older.
`;

describe("changelogSection", () => {
  it("takes the section from its heading to the next ## heading, keeping ### headings", () => {
    expect(changelogSection(changelog, "0.12.1")).toBe("- A fix.\n\n### Breaking\n\n- Something.");
    expect(changelogSection(changelog, "0.12.0")).toBe("- Older.");
  });

  it("finds nothing for a version with no section, or with an empty one", () => {
    expect(changelogSection(changelog, "0.13.0")).toBeUndefined();
    expect(changelogSection("## 0.1.10\n\n- x\n", "0.1.1")).toBeUndefined();
    expect(changelogSection("## 0.2.0\n\n## 0.1.0\n- x\n", "0.2.0")).toBeUndefined();
  });

  it("reads a version written with a v", () => {
    expect(changelogSection("## v0.3.0\n- x\n", "0.3.0")).toBe("- x");
  });
});

interface Props {
  props: Record<string, unknown>;
}
const jobs = (workflow as unknown as Props).props.jobs as Record<string, Props>;
const release = jobs.release;
if (!release) throw new Error("publish.ts declares no release job");

describe("the release job", () => {
  it("runs after publish and smoke, with contents: write and nothing else", () => {
    expect(release.props.needs).toEqual(["publish", "smoke"]);
    expect(release.props.permissions).toEqual({ contents: "write" });
  });

  it("is the only job that can write contents", () => {
    for (const [name, job] of Object.entries(jobs)) {
      if (name === "release") continue;
      expect((job.props.permissions as Record<string, string> | undefined)?.contents ?? "read", name).toBe("read");
    }
  });

  describe("its script, with gh stubbed", () => {
    const steps = release.props.steps as Props[];
    const script = steps.map((s) => s.props.run).find((r): r is string => typeof r === "string");
    if (!script) throw new Error("the release job has no run step");

    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "yodel-release-notes-"));
      mkdirSync(join(dir, "scripts"));
      mkdirSync(join(dir, "bin"));
      mkdirSync(join(dir, "tmp"));
      copyFileSync(resolve(__dirname, "../scripts/changelog-section.ts"), join(dir, "scripts", "changelog-section.ts"));
      writeFileSync(join(dir, "CHANGELOG.md"), changelog);
      // gh: `release view` succeeds only when $dir/exists is there; `release create` records its arguments and the notes.
      writeFileSync(
        join(dir, "bin", "gh"),
        `#!/usr/bin/env bash
if [ "$2" = view ]; then [ -f "${dir}/exists" ]; exit $?; fi
if [ "$2" = create ]; then echo "$@" > "${dir}/created"; while [ $# -gt 0 ]; do if [ "$1" = --notes-file ]; then cp "$2" "${dir}/notes"; fi; shift; done; exit 0; fi
exit 2
`,
      );
      // The job's Node 24 strips the types itself; the test's Node may need the flag.
      writeFileSync(join(dir, "bin", "node"), `#!/usr/bin/env bash\nexec "${process.execPath}" --experimental-strip-types --no-warnings "$@"\n`);
      chmodSync(join(dir, "bin", "gh"), 0o755);
      chmodSync(join(dir, "bin", "node"), 0o755);
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    const run = (version: string) =>
      spawnSync("bash", ["-eo", "pipefail", "-c", script], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`, VERSION: version, RUNNER_TEMP: join(dir, "tmp") },
      });

    it("makes the release with the version's section as its notes", () => {
      const r = run("0.12.1");
      expect(r.status, r.stderr).toBe(0);
      expect(readFileSync(join(dir, "created"), "utf8")).toContain("release create v0.12.1 --title 0.12.1 --notes-file");
      expect(readFileSync(join(dir, "created"), "utf8")).toContain("--verify-tag");
      expect(readFileSync(join(dir, "notes"), "utf8")).toBe("- A fix.\n\n### Breaking\n\n- Something.\n");
    });

    it("fails naming the section when CHANGELOG.md has none, and makes no release", () => {
      const r = run("0.13.0");
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('::error::CHANGELOG.md has no "## 0.13.0" section');
      expect(existsSync(join(dir, "created"))).toBe(false);
    });

    it("makes nothing when the release already exists", () => {
      writeFileSync(join(dir, "exists"), "");
      const r = run("0.13.0");
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("release v0.13.0 already exists");
      expect(existsSync(join(dir, "created"))).toBe(false);
    });
  });
});
