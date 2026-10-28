/**
 * Ledger records through chant (#292, chant#4551): a request that is not a
 * migration apply asks, spends and finishes through chant's gated request;
 * yodel approve shows the plan a wave's pending fact cites; yodel report
 * lists the wave jobs' run records and the applies under an approval, takes
 * a wave from the run record first and from the history note after, and
 * finds no gap on a 0.10.1 ledger; and nothing under src/ writes the
 * chant/lifecycle branch with git of its own.
 */

import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { GateLedgerPort } from "@intentius/chant/op/gate";
import { askGatedRequest, gatedRequests, requester, spendAndAct, type GatedRequest, type GatedRequestApi, type RequestGateResult } from "../src/chant/gated-request.js";
import { citedChangeSet } from "../src/chant/stored-plan.js";
import type { HistoryRow } from "../src/history/index.js";
import { baselineGate, BASELINE_REQUEST } from "../src/init/index.js";
import { CLEANUP_REQUEST } from "../src/commands/cleanup.js";
import { deriveAudit, type AppliesInput, type WaveRunInput, type WaveRunRecord } from "../src/report/audit.js";
import { waveRunOf } from "../src/report/model.js";
import { repoRoot } from "./helpers/run.js";

/** A gated-request API over memory, in the shape chant's `lifecycle/gated-request` has. */
function memoryApi(approvedBy?: string) {
  const asked: GatedRequest[] = [];
  const lines: Array<{ kind: string; gate: string; digest: string; result?: string; detail?: unknown }> = [];
  const digestOf = (op: string, r: GatedRequest) => `sha256:${op}:${r.kind}:${r.subject}:${r.by}:${r.at}:${JSON.stringify(r.fields)}`;
  const api: GatedRequestApi = {
    gatedRequestDigest: digestOf,
    requestGate(input): Promise<RequestGateResult> {
      const digest = digestOf(input.op, input.request);
      if (!asked.some((r) => digestOf(input.op, r) === digest)) asked.push(input.request);
      if (lines.some((l) => l.kind === "applied" && l.digest === digest)) return Promise.resolve({ status: "spent", digest, request: input.request });
      if (approvedBy === undefined) return Promise.resolve({ status: "waiting", digest, request: input.request, command: `chant approve ${input.op} ${input.request.subject} --plan ${digest}` });
      if (approvedBy === input.request.by) return Promise.resolve({ status: "refused", digest, request: input.request, by: approvedBy, reason: "a requester's own approval does not count", command: "" });
      return Promise.resolve({ status: "approved", digest, request: input.request, approval: { resolvedBy: approvedBy, timestamp: "2026-10-27T10:00:00.000Z" } });
    },
    spendGatedRequest(input) {
      lines.push({ kind: "applied", gate: input.gate, digest: input.digest });
      return Promise.resolve({ timestamp: "2026-10-27T10:01:00.000Z" });
    },
    finishGatedRequest(input) {
      lines.push({ kind: "finished", gate: input.gate, digest: input.digest, result: input.result, detail: input.detail });
      return Promise.resolve({ pushed: true });
    },
    readGatedRequests(op) {
      return Promise.resolve(asked.map((request) => {
        const digest = digestOf(op, request);
        return { op, gate: request.subject, digest, request, ...(lines.some((l) => l.kind === "applied" && l.digest === digest) ? { applied: {} } : {}) };
      }));
    },
  };
  return { api, asked, lines };
}

const ask = (api: GatedRequestApi, now: string) =>
  askGatedRequest(api, {
    op: "migrate-prod",
    kind: CLEANUP_REQUEST,
    subject: "approve-migrate-prod-cleanup",
    fields: { environment: "prod", plan: "jcs1-sha256:cleanup" },
    description: "yodel cleanup prod",
    rules: { mode: "ledger" },
    cwd: "/nowhere",
    by: "alice",
    now,
  });

describe("gated requests (#292, chant#4551)", () => {
  it("names the kinds and gates yodel asks under", () => {
    expect(CLEANUP_REQUEST).toBe("sql-cleanup");
    expect(BASELINE_REQUEST).toBe("sql-baseline");
    expect(baselineGate("approve-migrate-prod")).toBe("approve-migrate-prod-baseline");
  });

  it("names the requester as chant names an approver", () => {
    expect(requester({ GITHUB_ACTOR: "gh", GITLAB_USER_LOGIN: "gl", USER: "u" })).toBe("gh");
    expect(requester({ GITLAB_USER_LOGIN: "gl", USER: "u" })).toBe("gl");
    expect(requester({ USER: "u" })).toBe("u");
  });

  it("is off with YODEL_GATED_REQUESTS=0", async () => {
    expect(await gatedRequests({ YODEL_GATED_REQUESTS: "0" })).toBeUndefined();
  });

  it("asks once and keeps the first request's time, so asking again digests the same", async () => {
    const { api, asked } = memoryApi();
    const first = await ask(api, "2026-10-27T09:00:00.000Z");
    const again = await ask(api, "2026-10-27T09:30:00.000Z");
    expect(first.status).toBe("waiting");
    expect(again.digest).toBe(first.digest);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.at).toBe("2026-10-27T09:00:00.000Z");
  });

  it("does not count the requester's own approval", async () => {
    const { api } = memoryApi("alice");
    expect((await ask(api, "2026-10-27T09:00:00.000Z")).status).toBe("refused");
  });

  it("spends the approval before acting and records how it ended", async () => {
    const { api, lines } = memoryApi("bob");
    const asked = await ask(api, "2026-10-27T09:00:00.000Z");
    if (asked.status !== "approved") throw new Error(asked.status);
    const order: string[] = [];
    const { result } = await spendAndAct(api, asked, { op: "migrate-prod", cwd: "/nowhere" }, () => {
      order.push(`act after ${String(lines.length)} line(s)`);
      return Promise.resolve({ result: ["shop.events__chant_old"], detail: { dropped: 1 } });
    });
    expect(result).toEqual(["shop.events__chant_old"]);
    expect(order).toEqual(["act after 1 line(s)"]);
    expect(lines.map((l) => [l.kind, l.result ?? ""])).toEqual([["applied", ""], ["finished", "applied"]]);
    // Spent: asking with the same time again answers spent; a new ask gets a new time and waits.
    expect((await api.requestGate({ op: "migrate-prod", request: asked.request, rules: { mode: "ledger" } })).status).toBe("spent");
  });

  it("finishes a failed act as failed and throws again", async () => {
    const { api, lines } = memoryApi("bob");
    const asked = await ask(api, "2026-10-27T09:00:00.000Z");
    if (asked.status !== "approved") throw new Error(asked.status);
    await expect(spendAndAct(api, asked, { op: "migrate-prod", cwd: "/nowhere" }, () => Promise.reject(new Error("the server went away")))).rejects.toThrow("the server went away");
    expect(lines.at(-1)).toMatchObject({ kind: "finished", result: "failed", detail: { error: "the server went away" } });
  });
});

describe("the change set a wave's pending fact cites (#292)", () => {
  const port = (pending: Array<Record<string, unknown>>): GateLedgerPort => ({ read: () => Promise.resolve({ pending, resolutions: [] }) }) as unknown as GateLedgerPort;

  it("is the newest pending fact's for the gate and digest", async () => {
    const ledger = port([
      { gate: "yodel-apply-wave-2", planDigest: "jcs1-sha256:w2", changeSet: "sha256:old", timestamp: "1" },
      { gate: "yodel-apply-wave-2", planDigest: "jcs1-sha256:w2", changeSet: "sha256:new", timestamp: "2" },
      { gate: "yodel-apply-wave-1", planDigest: "jcs1-sha256:w2", changeSet: "sha256:other", timestamp: "3" },
    ]);
    expect(await citedChangeSet(ledger, "yodel-apply", "yodel-apply-wave-2", "jcs1-sha256:w2")).toBe("sha256:new");
  });

  it("is none on a pending fact written before chant#4551", async () => {
    expect(await citedChangeSet(port([{ gate: "yodel-apply-wave-2", planDigest: "jcs1-sha256:w2", timestamp: "1" }]), "yodel-apply", "yodel-apply-wave-2", "jcs1-sha256:w2")).toBeUndefined();
  });
});

let seq = 0;
function row(r: Partial<HistoryRow> & Pick<HistoryRow, "migration_id" | "status">): HistoryRow {
  seq += 1;
  return {
    seq,
    run_id: "run-1",
    kind: "migration",
    parent: "",
    checksum: "sha256:c",
    statement_index: -1,
    statement_sha: "",
    error: "",
    applied_by: "ci@host",
    plan_digest: "jcs1-sha256:m",
    silences: "[]",
    note: "",
    recorded_at: `2026-10-27 10:00:${String(seq).padStart(2, "0")}.000000`,
    ...r,
  };
}

const run = (over: Partial<WaveRunRecord["wave"]> = {}): WaveRunRecord => ({
  id: "r-1",
  started: "2026-10-27T09:59:00.000Z",
  ended: "2026-10-27T10:01:00.000Z",
  status: "ok",
  wave: { spec: "yodel-apply", number: 2, name: "prod", job: "wave", digest: "sha256:wave2", exitCode: 0, applied: ["prod"], failed: [], moved: [], ...over },
});
const runs = (records: WaveRunRecord[]): WaveRunInput => ({ path: "local/runs__yodel-apply.jsonl", gateOf: (k) => `yodel-apply-wave-${String(k)}`, records });

describe("yodel report's run records and applies (#292, ruling B on #300)", () => {
  const waveNote = JSON.stringify({ wave: { wave: 2, op: "yodel-apply", gate: "yodel-apply-wave-2", digest: "sha256:wave2", status: "approved" } });
  const history = () => {
    seq = 0;
    return [row({ migration_id: "m1", status: "started", note: waveNote }), row({ migration_id: "m1", status: "succeeded" })];
  };

  it("lists the wave job that ran the environment and the approval it spent", () => {
    const applies: AppliesInput[] = [{ op: "yodel-apply", path: "_gates/yodel-apply/applied.jsonl", gates: new Set(["yodel-apply-wave-2"]), lines: [{ gate: "yodel-apply-wave-2", planDigest: "sha256:wave2", timestamp: "2026-10-27T10:00:00.000Z", approvedBy: "bob", finished: { timestamp: "2026-10-27T10:00:30.000Z", result: "applied" } }] }];
    const { entries, gaps } = deriveAudit({ environment: "prod", history: "shop.history", rows: history(), runs: runs([run()]), applies });
    expect(entries.filter((e) => e.kind === "wave-run").map((e) => e.detail)).toEqual(["wave 2 (prod), wave job, exit 0: prod applied; run r-1"]);
    expect(entries.find((e) => e.kind === "spent")).toMatchObject({ by: "bob", digest: "sha256:wave2", source: { ledger: "_gates/yodel-apply/applied.jsonl", op: "yodel-apply", gate: "yodel-apply-wave-2" } });
    expect(entries.find((e) => e.kind === "applied")?.wave).toEqual({ gate: "yodel-apply-wave-2", digest: "sha256:wave2", status: "approved" });
    expect(gaps).toEqual([]);
  });

  it("takes the wave from the run record first, and from the history note when no record matches", () => {
    seq = 0;
    const rows = [row({ migration_id: "m1", status: "started" }), row({ migration_id: "m1", status: "succeeded" })];
    const fromRun = deriveAudit({ environment: "prod", history: "shop.history", rows, runs: runs([run()]) });
    expect(fromRun.entries.find((e) => e.kind === "applied")?.wave).toEqual({ gate: "yodel-apply-wave-2", digest: "sha256:wave2", status: "approved" });
    const later = run();
    later.started = "2026-10-28T00:00:00.000Z";
    later.ended = "2026-10-28T00:01:00.000Z";
    const fromNote = deriveAudit({ environment: "prod", history: "shop.history", rows: history(), runs: runs([later]) });
    expect(fromNote.entries.find((e) => e.kind === "applied")?.wave).toEqual({ gate: "yodel-apply-wave-2", digest: "sha256:wave2", status: "approved" });
  });

  it("keeps the ids and finds no gap on a 0.10.1 ledger, which has no run records and no applies", () => {
    const before = deriveAudit({ environment: "prod", history: "shop.history", rows: history() });
    const after = deriveAudit({ environment: "prod", history: "shop.history", rows: history(), runs: runs([]), applies: [] });
    expect(after.entries.map((e) => e.id)).toEqual(before.entries.map((e) => e.id));
    expect(after.gaps).toEqual(before.gaps);
  });

  it("reads a run record's wave structurally, and skips a record without one", () => {
    expect(waveRunOf({ id: "r", started: "a", ended: "b", status: "ok" })).toBeUndefined();
    expect(waveRunOf({ id: "r", started: "a", ended: "b", status: "ok", wave: run().wave })?.wave.digest).toBe("sha256:wave2");
  });
});

describe("chant/lifecycle writes (#292)", () => {
  it("go through chant's API: no module under src/ runs a git command that writes a ref or pushes", () => {
    const out = (() => {
      try {
        return execFileSync("git", ["grep", "-n", "-E", "\"(push|update-ref|commit-tree|hash-object|mktree|fast-import)\"|git (push|update-ref|commit-tree|hash-object)", "--", "src"], { cwd: repoRoot, encoding: "utf8" });
      } catch {
        return "";
      }
    })();
    // The two hints that tell a person to commit their own project are not writes to chant/lifecycle.
    const writes = out.split("\n").filter((l) => l.trim() !== "" && !/git add -A && git commit -m init/.test(l));
    expect(writes).toEqual([]);
  });
});
