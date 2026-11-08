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
    const out = (() => {
      try {
        return execFileSync("git", ["grep", "-n", "-E", "chant/lifecycle:|branch -f chant/lifecycle|refs/remotes/[^ ]*chant/lifecycle", "--", "src"], { cwd: repoRoot, encoding: "utf8" });
      } catch {
        return "";
      }
    })();
    expect(out.split("\n").filter((l) => l.trim() !== "")).toEqual([]);
  });
});
