/**
 * The jobs' fetch of chant/lifecycle (#326): `yodel ci --fetch-ledger` goes
 * through chant's reader, and nothing under src/ writes the ledger branch or
 * the remote-tracking ref chant's push leases against.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ledgerFetchLine } from "../src/chant/ledger-fetch.js";
import { repoRoot, yodel } from "./helpers/run.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

/** A remote with main and, when `ledger`, a chant/lifecycle branch; and a clone of main alone, as a CI checkout is. */
function remoteAndCheckout(ledger: boolean): { remote: string; checkout: string } {
  const root = mkdtempSync(join(tmpdir(), "yodel-ledger-fetch-"));
  temps.push(root);
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  execFileSync("git", ["init", "-q", "-b", "main", seed]);
  writeFileSync(join(seed, "README.md"), "project\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "base");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-q", "origin", "main");
  if (ledger) {
    git(seed, "checkout", "-q", "--orphan", "chant/lifecycle");
    git(seed, "rm", "-q", "-rf", ".");
    writeFileSync(join(seed, "approved.jsonl"), "{}\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-qm", "ledger");
    git(seed, "push", "-q", "origin", "chant/lifecycle");
  }
  const checkout = join(root, "checkout");
  execFileSync("git", ["clone", "-q", "--single-branch", "-b", "main", remote, checkout]);
  return { remote, checkout };
}

describe("yodel ci --fetch-ledger (#326)", () => {
  it("fetches chant/lifecycle through chant's reader, as the remote has it", async () => {
    const { remote, checkout } = remoteAndCheckout(true);
    const r = await yodel(["ci", "--fetch-ledger", "--dir", checkout]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("chant/lifecycle: fetched");
    expect(git(checkout, "rev-parse", "refs/heads/chant/lifecycle")).toBe(execFileSync("git", ["rev-parse", "chant/lifecycle"], { cwd: remote, encoding: "utf8" }).trim());
  }, 60_000);

  it("says nothing is approved when the remote has no ledger yet, and exits 0", async () => {
    const { checkout } = remoteAndCheckout(false);
    const r = await yodel(["ci", "--fetch-ledger", "--dir", checkout]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("origin has no chant/lifecycle branch yet, so nothing is approved");
  }, 60_000);

  it("fails only on a branch that has diverged from the remote's", () => {
    expect(ledgerFetchLine({ status: "diverged", remote: "origin", stderr: "" }).code).toBe(1);
    expect(ledgerFetchLine({ status: "unreachable", remote: "origin", stderr: "fatal: could not read\nmore" })).toEqual({
      line: "chant/lifecycle: could not fetch from origin (fatal: could not read); an approval there is not read",
      code: 0,
      stream: "err",
    });
    expect(ledgerFetchLine({ status: "no-remote" }).code).toBe(0);
  });

  it("is the only fetch of the ledger yodel renders: nothing under src/ writes chant/lifecycle or its remote-tracking ref", () => {
    /** The files under `paths` in `cwd`'s repository with a line that writes the ledger branch or its remote-tracking ref. */
    const scan = (cwd: string, ...paths: string[]): string[] => {
      try {
        const out = execFileSync("git", ["grep", "-l", "-E", "chant/lifecycle:|branch -f chant/lifecycle|refs/remotes/[^ ]*chant/lifecycle", "--", ...paths], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        return out.split("\n").filter((l) => l.trim() !== "");
      } catch (e) {
        // git grep exits 1 when nothing matches; anything else is a scan that did not run, and fails.
        if ((e as { status?: unknown }).status === 1) return [];
        throw e;
      }
    };
    // The scan finds the lines it is for (sql-yodeler issue 333): the git line yodel rendered before #326, and the fetch's own words.
    const { checkout } = remoteAndCheckout(false);
    writeFileSync(join(checkout, "old.ts"), "const line = \"git fetch --no-tags origin '+refs/heads/chant/lifecycle:refs/remotes/origin/chant/lifecycle' && git branch -f chant/lifecycle origin/chant/lifecycle\";\n");
    git(checkout, "add", "old.ts");
    expect(scan(checkout, ".")).toEqual(["old.ts"]);
    expect(scan(repoRoot, "src")).toEqual(["src/chant/ledger-fetch.ts"]);
    // A scan that cannot run fails, so it never passes by checking nothing.
    const plain = mkdtempSync(join(tmpdir(), "yodel-ledger-scan-"));
    temps.push(plain);
    expect(() => scan(plain, ".")).toThrow();
    // src/chant/ledger-fetch.ts is the fetch itself, and its messages and doc comment name the ref.
    expect(scan(repoRoot, "src", ":(exclude)src/chant/ledger-fetch.ts")).toEqual([]);
  }, 60_000);
});
