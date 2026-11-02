/**
 * Spending a gated request's approval with chant's own ledger in a scratch
 * git repository: with no remote the local chant/lifecycle branch is the
 * whole ledger, so the spend chant records there lets the request act; a
 * remote that refuses the push still stops it.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gatedRequests, ledgerRemoteOf, spendAndAct, type GatedRequest, type GatedRequestApi, type RequestGateResult } from "../src/chant/gated-request.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function scratch(name: string): string {
  const d = mkdtempSync(join(tmpdir(), `yodel-spend-${name}-`));
  dirs.push(d);
  return d;
}

function project(): string {
  const dir = scratch("project");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "alice@example.com");
  git(dir, "config", "user.name", "alice");
  writeFileSync(join(dir, "README"), "x\n");
  git(dir, "add", "README");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

/** A bare remote whose pre-receive hook refuses every push. */
function refusingRemote(): string {
  const bare = scratch("remote");
  git(bare, "init", "-q", "--bare");
  const hook = join(bare, "hooks", "pre-receive");
  writeFileSync(hook, "#!/bin/sh\necho 'refused by the test hook' >&2\nexit 1\n");
  chmodSync(hook, 0o755);
  return bare;
}

const OP = "migrate-prod";

/** Ask through chant (which records the pending fact), then take it as approved by bob. */
async function approved(api: GatedRequestApi, cwd: string): Promise<Extract<RequestGateResult, { status: "approved" }>> {
  const request: GatedRequest = { kind: "sql-cleanup", subject: "approve-migrate-prod-cleanup", by: "alice", at: "2026-11-02T09:00:00.000Z", fields: { environment: "prod" } };
  const asked = await api.requestGate({ op: OP, request, rules: { mode: "ledger" }, description: "yodel cleanup prod", cwd });
  expect(asked.status).toBe("waiting");
  return { status: "approved", digest: asked.digest, request, approval: { resolvedBy: "bob", timestamp: "2026-11-02T09:05:00.000Z" } };
}

describe("spending a gated request on chant's ledger", () => {
  it("names no remote for a repository without one, and the remote chant would push to otherwise", async () => {
    const dir = project();
    expect(await ledgerRemoteOf(dir, {})).toBeNull();
    git(dir, "remote", "add", "backup", refusingRemote());
    expect(await ledgerRemoteOf(dir, {})).toEqual({ remote: "backup" });
    expect(await ledgerRemoteOf(dir, { CHANT_LIFECYCLE_REMOTE: "elsewhere" })).toBe("unknown");
    expect(await ledgerRemoteOf(join(dir, "missing"), {})).toBe("unknown");
  });

  it("acts with no remote: the spend recorded on the local branch is the whole ledger", async () => {
    const api = await gatedRequests({});
    if (!api) throw new Error("the installed chant has no gated requests");
    const dir = project();
    const ok = await approved(api, dir);
    let acted = 0;
    const { result } = await spendAndAct(api, ok, { op: OP, cwd: dir }, () => {
      acted++;
      return Promise.resolve({ result: "dropped", detail: { dropped: 1 } });
    });
    expect(result).toBe("dropped");
    expect(acted).toBe(1);
    const read = (await api.readGatedRequests(OP, { cwd: dir })).find((r) => r.digest === ok.digest) as { applied?: { approvedBy?: string }; finished?: { result?: string } } | undefined;
    expect(read?.applied?.approvedBy).toBe("bob");
    expect(read?.finished?.result).toBe("applied");
    // Spent: the same request asked again does not act a second time.
    expect((await api.requestGate({ op: OP, request: ok.request, rules: { mode: "ledger" }, cwd: dir })).status).toBe("spent");
  });

  it("refuses when the ledger has a remote and the push of the spend did not land", async () => {
    const api = await gatedRequests({});
    if (!api) throw new Error("the installed chant has no gated requests");
    const dir = project();
    git(dir, "remote", "add", "origin", refusingRemote());
    const ok = await approved(api, dir);
    let acted = 0;
    await expect(
      spendAndAct(api, ok, { op: OP, cwd: dir }, () => {
        acted++;
        return Promise.resolve({ result: "dropped", detail: {} });
      }),
    ).rejects.toThrow(/recorded as spent and not pushed/);
    expect(acted).toBe(0);
  });

  it("refuses with no remote when the local ledger holds no spend of this approval", async () => {
    const dir = project();
    const request: GatedRequest = { kind: "sql-cleanup", subject: "g", by: "alice", at: "t", fields: {} };
    const api: GatedRequestApi = {
      gatedRequestDigest: () => "sha256:x",
      requestGate: () => Promise.reject(new Error("unused")),
      spendGatedRequest: () => Promise.reject(new Error("recording is off")),
      finishGatedRequest: () => Promise.resolve({ pushed: false }),
      readGatedRequests: (op) => Promise.resolve([{ op, gate: "g", digest: "sha256:x", request, applied: { approvedBy: "carol", approvedAt: "earlier", timestamp: "t0" } }]),
    };
    const ok: Extract<RequestGateResult, { status: "approved" }> = { status: "approved", digest: "sha256:x", request, approval: { resolvedBy: "bob", timestamp: "now" } };
    let acted = 0;
    await expect(
      spendAndAct(api, ok, { op: OP, cwd: dir }, () => {
        acted++;
        return Promise.resolve({ result: 1, detail: {} });
      }),
    ).rejects.toThrow("recording is off");
    expect(acted).toBe(0);
  });
});
