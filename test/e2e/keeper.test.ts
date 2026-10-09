/**
 * The Keeper lock and the replicated history on a scratch two-replica
 * cluster with Keeper (./keeper-cluster.ts), since the emulator has no
 * Keeper. Needs Docker and YODEL_E2E_KEEPER=1; the containers are removed
 * after.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clickhouseQuery, type ClickHouseEndpoint } from "@intentius/chant-lexicon-sql/clickhouse/http";
import { dockerAvailable } from "@intentius/chant-lexicon-sql/core/container";
import { projectFromConfig } from "../../src/project.js";
import { acquireLock, HistoryStore, httpPort, LockHeldError, LockLostError, LOCKED, type HistoryLocation, type HistoryRow } from "../../src/history/index.js";
import { memoryGateLedgerPort } from "@intentius/chant/op/gate";
import { currentDigest, executeApply, inspect, openVersioned, verifyApproval } from "../../src/versioned/index.js";
import { migration } from "../helpers/fake-clickhouse.js";
import { CLUSTER, startKeeperCluster, type KeeperCluster } from "./keeper-cluster.js";


const enabled = process.env.YODEL_E2E_KEEPER === "1" && (await dockerAvailable());
let cluster: KeeperCluster | undefined;

const replicas = (): KeeperCluster["replicas"] => {
  if (!cluster) throw new Error("the scratch cluster did not start");
  return cluster.replicas;
};

const q = <T = Record<string, unknown>>(at: ClickHouseEndpoint, sql: string) => clickhouseQuery<T>(at, sql);

const row = (seq: number, id: string): HistoryRow => ({
  seq,
  run_id: "e2e",
  kind: "migration",
  migration_id: id,
  parent: "",
  checksum: "sha256:x",
  statement_index: -1,
  statement_sha: "",
  status: "succeeded",
  error: "",
  applied_by: "e2e",
  plan_digest: "",
  silences: "[]",
  note: "",
});

describe.skipIf(!enabled)("the Keeper lock and the replicated history (scratch cluster with Keeper)", () => {
  beforeAll(async () => {
    cluster = await startKeeperCluster();
  }, 600_000);
  afterAll(async () => {
    await cluster?.stop();
  });

  it("on a cluster, the history is a ReplicatedMergeTree ON CLUSTER, and a row written on one replica is read on the other", async () => {
    const [r1, r2] = replicas();
    const location: HistoryLocation = { database: "yodel_8_history", topology: { kind: "cluster", cluster: CLUSTER } };
    const s1 = new HistoryStore(await httpPort(r1), location);
    const s2 = new HistoryStore(await httpPort(r2), location);
    await s1.ensure();
    for (const r of [r1, r2]) {
      const [t] = await q<{ engine: string; engine_full: string }>(r, "SELECT engine, engine_full FROM system.tables WHERE database = 'yodel_8_history' AND name = 'history'");
      expect(t?.engine).toBe("ReplicatedMergeTree");
      expect(t?.engine_full).toContain("ReplicatedMergeTree('/clickhouse/yodeler/yodel_8_history/history', '{shard}-{replica}')");
    }
    await s1.append([row(1, "m1")]);
    const state = await s2.state();
    expect(state.byId.get("m1")?.status).toBe("succeeded");
  }, 120_000);

  it("in a Replicated database, the history is a ReplicatedMergeTree with no arguments, on every replica", async () => {
    const [r1, r2] = replicas();
    const location: HistoryLocation = { database: "yodel_8_hrepl", topology: { kind: "replicated", cluster: CLUSTER } };
    const s1 = new HistoryStore(await httpPort(r1), location);
    await s1.ensure();
    await q(r2, "SYSTEM SYNC DATABASE REPLICA yodel_8_hrepl");
    const [db] = await q<{ engine: string }>(r2, "SELECT engine FROM system.databases WHERE name = 'yodel_8_hrepl'");
    expect(db?.engine).toBe("Replicated");
    const [t] = await q<{ engine: string; create_table_query: string }>(r2, "SELECT engine, create_table_query FROM system.tables WHERE database = 'yodel_8_hrepl' AND name = 'history'");
    expect(t?.engine).toBe("ReplicatedMergeTree");
    await s1.append([row(1, "m1")]);
    expect((await new HistoryStore(await httpPort(r2), location).state()).byId.get("m1")?.status).toBe("succeeded");
  }, 120_000);

  it("holds one apply at a time across runners on different replicas, by a KeeperMap row with an owner and an expiry", async () => {
    const [r1, r2] = replicas();
    const options = (holder: string, ttlMs = 60_000) => ({ database: "yodel_8_history", topology: { kind: "cluster", cluster: CLUSTER } as const, holder, ttlMs, serverKey: "scratch" });
    const p1 = await httpPort(r1);
    const p2 = await httpPort(r2);

    const first = await acquireLock(p1, options("runner-1"));
    expect(first.kind).toBe("keeper");
    expect(first.notice).toBeUndefined();
    const second = acquireLock(p2, options("runner-2"));
    await expect(second).rejects.toBeInstanceOf(LockHeldError);
    await expect(second).rejects.toMatchObject({ exitCode: LOCKED, holder: first.owner });
    await first.heartbeat();
    await first.release();

    const third = await acquireLock(p2, options("runner-2"));
    expect(third.owner).toMatch(/^runner-2#/);
    await third.release();

    // A dead runner's lock expires, and the next runner takes it over; the dead one, waking, finds it lost.
    const dead = await acquireLock(p1, options("dead", 200));
    await new Promise((r) => setTimeout(r, 400));
    const taker = await acquireLock(p2, options("runner-3"));
    expect(taker.owner).toMatch(/^runner-3#/);
    await expect(dead.heartbeat()).rejects.toBeInstanceOf(LockLostError);
    await taker.release();
  }, 120_000);

  it("applies under the Keeper lock, and refuses (exit 5) while another runner holds it", async () => {
    const [r1, r2] = replicas();
    const project = projectFromConfig("/nowhere", "/nowhere/chant.config.ts", { lexicons: ["sql"], sql: { dialect: "clickhouse", profiles: { e2e: { url: r1.url, databases: ["yodel_8"] } } } });
    const env = { YODEL_HISTORY_DATABASE: "yodel_8_hist2", YODEL_TOPOLOGY: `cluster:${CLUSTER}` };
    const venv = await openVersioned(project, { name: "e2e", profile: { url: r1.url } }, env);
    const m = migration("20261009T1000-one", null, [
      `CREATE DATABASE IF NOT EXISTS yodel_8 ON CLUSTER ${CLUSTER}`,
      `CREATE TABLE yodel_8.t ON CLUSTER ${CLUSTER} (x UInt8) ENGINE = ReplicatedMergeTree ORDER BY x`,
    ]);
    const { status } = await inspect(venv, [m]);
    const digest = await currentDigest(venv, status, status.pending);
    const op = { name: "migrate-e2e", filePath: "", gate: "approve-migrate-e2e", quorum: false };
    const ledger = memoryGateLedgerPort({ resolutions: [{ version: 1, op: op.name, gate: op.gate, resolvedBy: "e2e", timestamp: new Date().toISOString(), planDigest: digest }] });

    const other = await acquireLock(await httpPort(r2), { database: "yodel_8_hist2", topology: { kind: "cluster", cluster: CLUSTER }, holder: "other-runner", serverKey: "scratch" });
    const blocked = executeApply(venv, [m], { approvedDigest: digest, allowOutOfOrder: false, approve: (d) => verifyApproval(ledger, op, d), log: () => undefined });
    await expect(blocked).rejects.toMatchObject({ exitCode: LOCKED, holder: other.owner });
    await other.release();

    const result = await executeApply(venv, [m], { approvedDigest: digest, allowOutOfOrder: false, approve: (d) => verifyApproval(ledger, op, d), log: () => undefined });
    expect(result.applied).toEqual([m.id]);
    expect(result.lock.kind).toBe("keeper");
    expect(Number((await q<{ n: string | number }>(r2, "SELECT count() AS n FROM system.tables WHERE database = 'yodel_8' AND name = 't'"))[0]?.n)).toBe(1);
    // The lock was released: nothing is left in it.
    expect(Number((await q<{ n: string | number }>(r2, "SELECT count() AS n FROM yodel_8_hist2.lock"))[0]?.n)).toBe(0);
  }, 180_000);
});
