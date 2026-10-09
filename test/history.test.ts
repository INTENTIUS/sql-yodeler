import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireLock,
  databaseDdl,
  deriveState,
  historyDdl,
  historyTableDdl,
  isApplied,
  LockHeldError,
  LOCKED,
  localLockPath,
  lockTableDdl,
  parseHistoryTopology,
  statementDone,
  type HistoryRow,
  type HistoryTopology,
} from "../src/history/index.js";
import { FakeClickHouse } from "./helpers/fake-clickhouse.js";

const at = (topology: HistoryTopology) => ({ database: "yodeler", topology });

describe("the history table's DDL per topology", () => {
  it("is a MergeTree on a single node", () => {
    const [db, table] = historyDdl(at({ kind: "single" }));
    expect(db).toBe("CREATE DATABASE IF NOT EXISTS `yodeler`");
    expect(table).toMatch(/^CREATE TABLE IF NOT EXISTS `yodeler`\.history\n\(/);
    expect(table).toContain("\nENGINE = MergeTree\nORDER BY (migration_id, statement_index, seq)");
    expect(table).not.toContain("ON CLUSTER");
  });

  it("is a ReplicatedMergeTree ON CLUSTER on a cluster, one copy for the whole cluster", () => {
    const t = at({ kind: "cluster", cluster: "main" });
    expect(databaseDdl(t)).toBe("CREATE DATABASE IF NOT EXISTS `yodeler` ON CLUSTER `main`");
    const table = historyTableDdl(t);
    expect(table).toMatch(/^CREATE TABLE IF NOT EXISTS `yodeler`\.history ON CLUSTER `main`\n/);
    expect(table).toContain("ENGINE = ReplicatedMergeTree('/clickhouse/yodeler/yodeler/history', '{shard}-{replica}')");
    const custom = historyTableDdl(at({ kind: "cluster", cluster: "main", replicaPath: "/x/{shard}", replicaName: "{replica}" }));
    expect(custom).toContain("ENGINE = ReplicatedMergeTree('/x/{shard}', '{replica}')");
  });

  it("is a ReplicatedMergeTree with no arguments, and no ON CLUSTER, in a Replicated database", () => {
    const t = at({ kind: "replicated" });
    expect(databaseDdl(t)).toBe("CREATE DATABASE IF NOT EXISTS `yodeler` ENGINE = Replicated('/clickhouse/databases/yodeler', '{shard}', '{replica}')");
    expect(databaseDdl(at({ kind: "replicated", cluster: "main" }))).toBe(
      "CREATE DATABASE IF NOT EXISTS `yodeler` ON CLUSTER `main` ENGINE = Replicated('/clickhouse/databases/yodeler', '{shard}', '{replica}')",
    );
    const table = historyTableDdl(t);
    expect(table).toContain("\nENGINE = ReplicatedMergeTree\nORDER BY");
    expect(table).not.toContain("ON CLUSTER");
    expect(historyTableDdl(at({ kind: "replicated", cluster: "main" }))).not.toContain("ON CLUSTER");
  });

  it("is plain MergeTree DDL on Cloud, which makes it SharedMergeTree itself", () => {
    const [db, table] = historyDdl(at({ kind: "cloud" }));
    expect(db).toBe("CREATE DATABASE IF NOT EXISTS `yodeler`");
    expect(table).toContain("\nENGINE = MergeTree\nORDER BY");
    expect(table).not.toMatch(/Replicated|Shared|ON CLUSTER/);
  });

  it("has a column for everything a row records, append-only", () => {
    const table = historyTableDdl(at({ kind: "single" }));
    for (const column of ["seq UInt64", "migration_id String", "parent String", "checksum String", "statement_index Int32", "statement_sha String", "status LowCardinality(String)", "error String", "applied_by String", "plan_digest String", "silences String DEFAULT '[]'", "recorded_at DateTime64(6, 'UTC') DEFAULT now64(6)"]) {
      expect(table).toContain(`  ${column}`);
    }
  });

  it("puts the lock in a KeeperMap, ON CLUSTER on a cluster", () => {
    expect(lockTableDdl(at({ kind: "single" }))).toContain("ENGINE = KeeperMap('/yodeler/yodeler/lock')\nPRIMARY KEY name");
    expect(lockTableDdl(at({ kind: "cluster", cluster: "c" }))).toMatch(/^CREATE TABLE IF NOT EXISTS `yodeler`\.lock ON CLUSTER `c`\n/);
    expect(lockTableDdl(at({ kind: "replicated" }))).not.toContain("ON CLUSTER");
  });

  it("reads a topology from its string form", () => {
    expect(parseHistoryTopology("single")).toEqual({ kind: "single" });
    expect(parseHistoryTopology("cluster:main")).toEqual({ kind: "cluster", cluster: "main" });
    expect(parseHistoryTopology("replicated")).toEqual({ kind: "replicated" });
    expect(parseHistoryTopology("replicated:main")).toEqual({ kind: "replicated", cluster: "main" });
    expect(parseHistoryTopology("cloud")).toEqual({ kind: "cloud" });
    expect(() => parseHistoryTopology("cluster")).toThrow(/cluster's name/);
    expect(() => parseHistoryTopology("mesh")).toThrow(/unknown topology/);
  });
});

let seq = 0;
const row = (r: Partial<HistoryRow> & Pick<HistoryRow, "migration_id" | "status">): HistoryRow => ({
  seq: ++seq,
  run_id: "r",
  kind: "migration",
  parent: "",
  checksum: "sha256:a",
  statement_index: -1,
  statement_sha: "",
  error: "",
  applied_by: "me@host",
  plan_digest: "jcs1-sha256:x",
  silences: "[]",
  note: "",
  ...r,
});

describe("the state the rows add up to", () => {
  it("is the latest row per migration and per statement, whatever order the rows come in", () => {
    seq = 0;
    const rows = [
      row({ migration_id: "m1", status: "started" }),
      row({ migration_id: "m1", kind: "statement", statement_index: 0, status: "started" }),
      row({ migration_id: "m1", kind: "statement", statement_index: 0, status: "succeeded" }),
      row({ migration_id: "m1", status: "succeeded" }),
      row({ migration_id: "m2", parent: "m1", status: "started" }),
      row({ migration_id: "m2", kind: "statement", statement_index: 0, status: "succeeded" }),
      row({ migration_id: "m2", kind: "statement", statement_index: 1, status: "started" }),
      row({ migration_id: "m2", kind: "statement", statement_index: 1, status: "failed", error: "boom" }),
      row({ migration_id: "m2", parent: "m1", status: "failed", error: "statement 1: boom" }),
    ];
    const state = deriveState([...rows].reverse());
    expect(state.maxSeq).toBe(9);
    expect(state.migrations.map((m) => m.id)).toEqual(["m1", "m2"]);
    const m1 = state.byId.get("m1");
    const m2 = state.byId.get("m2");
    expect(isApplied(m1)).toBe(true);
    expect(m1?.appliedSeq).toBe(4);
    expect(isApplied(m2)).toBe(false);
    expect(m2?.status).toBe("failed");
    expect(m2?.parent).toBe("m1");
    expect(statementDone(m2, 0)).toBe(true);
    expect(statementDone(m2, 1)).toBe(false);
    expect(m2?.statements.get(1)?.error).toBe("boom");
  });

  it("takes a later succeeded row over an earlier failed one, and a later checksum over an earlier", () => {
    seq = 0;
    const state = deriveState([
      row({ migration_id: "m1", status: "failed" }),
      row({ migration_id: "m1", kind: "statement", statement_index: 0, status: "failed" }),
      row({ migration_id: "m1", kind: "statement", statement_index: 0, status: "succeeded" }),
      row({ migration_id: "m1", status: "succeeded", checksum: "sha256:b" }),
    ]);
    expect(isApplied(state.byId.get("m1"))).toBe(true);
    expect(state.byId.get("m1")?.checksum).toBe("sha256:b");
  });
});

describe("the apply lock without Keeper", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const options = (localDir: string, holder: string, ttlMs = 60_000) => ({ database: "yodeler", topology: { kind: "single" } as const, holder, ttlMs, serverKey: "http://x:8123", localDir });

  it("falls back to a local lock file on a single node, says so, and refuses a second holder until released", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yodel-lock-"));
    dirs.push(dir);
    const ch = new FakeClickHouse();
    const lock = await acquireLock(ch, options(dir, "a@host"));
    expect(lock.kind).toBe("local");
    expect(lock.notice).toMatch(/cross-runner locking needs Keeper/);
    const file = localLockPath(options(dir, "a@host"));
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ owner: lock.owner });

    const second = acquireLock(ch, options(dir, "b@host"));
    await expect(second).rejects.toBeInstanceOf(LockHeldError);
    await expect(second).rejects.toMatchObject({ exitCode: LOCKED, message: expect.stringContaining(`rm ${file}`) as unknown });

    await lock.release();
    const third = await acquireLock(ch, options(dir, "b@host"));
    expect(third.owner).toMatch(/^b@host#/);
    await third.release();
  });

  it("takes over an expired lock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yodel-lock-"));
    dirs.push(dir);
    const ch = new FakeClickHouse();
    await acquireLock(ch, options(dir, "dead@host", 1));
    await new Promise((r) => setTimeout(r, 10));
    const lock = await acquireLock(ch, options(dir, "b@host"));
    expect(lock.owner).toMatch(/^b@host#/);
    await lock.release();
  });

  it("never falls back on a cluster, a Replicated database or Cloud", async () => {
    for (const topology of [{ kind: "cluster", cluster: "c" }, { kind: "replicated" }, { kind: "cloud" }] as const) {
      await expect(acquireLock(new FakeClickHouse(), { ...options("/nonexistent", "a"), topology })).rejects.toThrow(/needs the Keeper lock/);
    }
  });
});
