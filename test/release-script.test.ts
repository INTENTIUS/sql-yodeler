import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * scripts/release.sh's tag step against a scratch origin, with `gh` and
 * `npm` stubbed on PATH: every ci and claims run on main concluded failure,
 * and nothing is on npm yet.
 */
const script = resolve(__dirname, "../scripts/release.sh");

let dir: string;
let work: string;
let origin: string;

function sh(cwd: string, cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function release(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync("bash", [script, ...args], {
    cwd: work,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
      YODEL_RELEASE_SKIP_CI: "",
      ...env,
    },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const tags = () => sh(work, "git", ["ls-remote", "--tags", "origin"]);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yodel-release-test-"));
  origin = join(dir, "origin.git");
  work = join(dir, "work");
  sh(dir, "git", ["init", "-q", "--bare", "-b", "main", origin]);
  sh(dir, "git", ["clone", "-q", origin, work]);
  for (const [k, v] of [
    ["user.name", "t"],
    ["user.email", "t@example.invalid"],
    ["commit.gpgsign", "false"],
    ["tag.gpgsign", "false"],
  ] as const)
    sh(work, "git", ["config", k, v]);
  writeFileSync(
    join(work, "package.json"),
    `${JSON.stringify({ name: "@intentius/sql-yodeler", version: "9.9.9" }, null, 2)}\n`,
  );
  sh(work, "git", ["add", "-A"]);
  sh(work, "git", ["commit", "-q", "-m", "chore: release 9.9.9"]);
  sh(work, "git", ["push", "-q", "origin", "main"]);
  const bin = join(dir, "bin");
  sh(dir, "mkdir", [bin]);
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub("gh", 'echo "completed failure https://example.invalid/run"');
  stub("npm", "exit 1");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("scripts/release.sh, the tag step", () => {
  it("refuses a commit whose ci and claims runs are not green", () => {
    const r = release(["9.9.9"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/concluded failure/);
    expect(r.out).toMatch(
      /no commit on main at 9\.9\.9 has both ci and claims green/,
    );
    expect(tags()).toBe("");
  });

  it("with --skip-ci, tags origin/main without looking at the runs", () => {
    const head = sh(work, "git", ["rev-parse", "HEAD"]);
    const dry = release(["9.9.9", "--skip-ci", "--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.out).toMatch(/not checked \(--skip-ci\)/);
    expect(dry.out).not.toMatch(/concluded failure/);
    expect(dry.out).toMatch(/Dry run: no tag made or pushed/);
    expect(tags()).toBe("");

    const r = release(["9.9.9", "--skip-ci"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Pushed v9\.9\.9/);
    expect(tags()).toMatch(new RegExp(`^\\w+\\s+refs/tags/v9\\.9\\.9`));
    expect(sh(work, "git", ["rev-parse", "v9.9.9^{commit}"])).toBe(head);
  });

  it("takes YODEL_RELEASE_SKIP_CI=1 and --commit, and still checks that the commit is on main", () => {
    const old = sh(work, "git", ["rev-parse", "HEAD"]);
    writeFileSync(join(work, "README.md"), "after\n");
    sh(work, "git", ["add", "-A"]);
    sh(work, "git", ["commit", "-q", "-m", "docs: after"]);
    sh(work, "git", ["push", "-q", "origin", "main"]);
    const r = release(["9.9.9", "--commit", old, "--dry-run"], {
      YODEL_RELEASE_SKIP_CI: "1",
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Tag v9.9.9 on ${old.slice(0, 7)}`);

    // A commit that is not on origin/main is refused, CI or not.
    sh(work, "git", ["commit", "-q", "--allow-empty", "-m", "local only"]);
    const wrong = release([
      "9.9.9",
      "--skip-ci",
      "--commit",
      "HEAD",
      "--dry-run",
    ]);
    expect(wrong.code).toBe(1);
    expect(wrong.out).toMatch(/is not on origin\/main/);
  });
});
