import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { projectFromConfig } from "../src/project.js";
import { parseDuration, environmentSettings } from "../src/config/settings.js";
import { LockHeldError, type Lock } from "../src/history/index.js";
import { acquireWaiting, currentDigest, executeApply, inspect, openVersioned, selectToApply, type VersionedEnv } from "../src/versioned/index.js";
import { FakeClickHouse, migration } from "./helpers/fake-clickhouse.js";

const m1 = migration("20261009T1000-one", null, ["CREATE DATABASE yodel_60", "CREATE TABLE yodel_60.a (x UInt8) ENGINE = MergeTree ORDER BY x"]);

async function setup(): Promise<{ ch: FakeClickHouse; venv: VersionedEnv }> {
  const ch = new FakeClickHouse();
  const url = `http://fake-${randomUUID()}:8123`;
  const project = projectFromConfig("/nowhere", "/nowhere/chant.config.ts", { lexicons: ["sql"], sql: { dialect: "clickhouse", profiles: { e2e: { url, databases: ["yodel_60"] } } } });
  const venv = await openVersioned(project, { name: "e2e", profile: { url } }, { YODEL_HISTORY_DATABASE: "yodel_60_history" }, ch);
  return { ch, venv };
}

const fakeLock: Lock = { kind: "local", owner: "me", where: "here", heartbeat: () => Promise.resolve(), release: () => Promise.resolve() };
const held = (holder: string) => new LockHeldError(holder, "2026-10-09 12:00:00", "KeeperMap h.lock", "ALTER TABLE h.lock DELETE WHERE name = 'apply'");

/** A driver whose lock is held for the first `busy` tries. */
function driver(busy: number, holders = ["ci@runner-1#1-a"]) {
  let tries = 0;
  return {
    tries: () => tries,
    venv: {
      driver: {
        acquireLock: () => {
          tries += 1;
          return tries <= busy ? Promise.reject(held(holders[Math.min(tries - 1, holders.length - 1)] ?? "")) : Promise.resolve(fakeLock);
        },
      },
    } as unknown as Pick<VersionedEnv, "driver">,
  };
}

describe("parseDuration", () => {
  it("reads seconds, units and sums, and refuses anything else", () => {
    expect(parseDuration("90", "x")).toBe(90_000);
    expect(parseDuration("500ms", "x")).toBe(500);
    expect(parseDuration("30s", "x")).toBe(30_000);
    expect(parseDuration("10m", "x")).toBe(600_000);
    expect(parseDuration("1h", "x")).toBe(3_600_000);
    expect(parseDuration("1m30s", "x")).toBe(90_000);
    expect(() => parseDuration("soon", "--lock-wait")).toThrow(/--lock-wait must be a duration/);
    expect(() => parseDuration("10 m", "x")).toThrow();
  });

  it("takes the lock wait from yodel.config.ts, else YODEL_LOCK_WAIT, else 0", () => {
    const project = (lockWait?: number) => ({ config: { lexicons: ["sql"] }, yodel: { path: "y", config: { environments: { dev: lockWait === undefined ? {} : { lockWait } } } } }) as never;
    expect(environmentSettings(project(), "dev", {}).lockWaitMs).toBe(0);
    expect(environmentSettings(project(), "dev", { YODEL_LOCK_WAIT: "2m" }).lockWaitMs).toBe(120_000);
    expect(environmentSettings(project(45), "dev", { YODEL_LOCK_WAIT: "2m" }).lockWaitMs).toBe(45_000);
  });
});

describe("acquireWaiting", () => {
  it("gives up at once without a wait: the lock's own refusal, exit 5", async () => {
    const d = driver(1);
    await expect(acquireWaiting(d.venv, "me", { waitMs: 0, log: () => undefined })).rejects.toMatchObject({ exitCode: 5, holder: "ci@runner-1#1-a" });
    expect(d.tries()).toBe(1);
  });

  it("waits while it is held, naming the holder once per holder, and reports the wait", async () => {
    const d = driver(3, ["ci@runner-1#1-a", "ci@runner-1#1-a", "ci@runner-2#2-b"]);
    const lines: string[] = [];
    const got = await acquireWaiting(d.venv, "me", { waitMs: 10_000, pollMs: 5, log: (l) => lines.push(l) });
    expect("lock" in got && got.lock).toBe(fakeLock);
    expect("waited" in got && got.waited).toMatchObject({ heldBy: "ci@runner-1#1-a", where: "KeeperMap h.lock" });
    expect(lines.filter((l) => l.includes("held by"))).toEqual([
      expect.stringContaining("lock: held by ci@runner-1#1-a (KeeperMap h.lock"),
      expect.stringContaining("lock: held by ci@runner-2#2-b"),
    ]);
    expect(lines.at(-1)).toMatch(/^lock: taken after waiting/);
  });

  it("gives up when the wait runs out, saying it waited", async () => {
    const d = driver(1000);
    const e = await acquireWaiting(d.venv, "me", { waitMs: 50, pollMs: 10, log: () => undefined }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(LockHeldError);
    expect((e as LockHeldError).exitCode).toBe(5);
    expect((e as LockHeldError).message).toMatch(/This run waited \S+ \(--lock-wait\), and it is still held/);
  });

  it("stands down while waiting when a newer commit will apply the environment", async () => {
    const d = driver(1000);
    let asked = 0;
    const got = await acquireWaiting(d.venv, "me", { waitMs: 10_000, pollMs: 5, log: () => undefined, standDown: () => Promise.resolve(++asked >= 2 ? "standing down: newer" : undefined) });
    expect(got).toEqual({ stoodDown: "standing down: newer" });
  });
});

describe("executeApply under a held lock", () => {
  it("a second apply waits for the first, then finds nothing pending and sends nothing", async () => {
    const { ch, venv } = await setup();
    const { status } = await inspect(venv, [m1]);
    const digest = await currentDigest(venv, status, selectToApply(status, false));
    const approve = () => Promise.resolve();
    const options = { approvedDigest: digest, allowOutOfOrder: false, approve, log: () => undefined, processEnv: { USER: "tester" }, lockWaitMs: 10_000, lockPollMs: 10 };
    const first = await venv.driver.acquireLock("first");
    const waiting = executeApply(venv, [m1], options);
    await new Promise((r) => setTimeout(r, 50));
    expect(ch.sent).toEqual([]);
    // The first applies (as its own run would), then lets go.
    const applied = await executeApply({ ...venv, driver: { ...venv.driver, acquireLock: () => Promise.resolve(fakeLock) } }, [m1], options);
    expect(applied.applied).toEqual([m1.id]);
    await first.release();
    const second = await waiting;
    expect(second.applied).toEqual([]);
    expect(second.lock.waited?.heldBy).toMatch(/^first#/);
    // Each statement sent once, and started once in the history.
    expect(ch.sent).toHaveLength(2);
    expect(ch.rows.filter((r) => r.kind === "statement" && r.status === "started")).toHaveLength(2);
  });

  it("stands down before taking the lock when a newer commit will apply the environment", async () => {
    const { ch, venv } = await setup();
    const result = await executeApply(venv, [m1], { approvedDigest: "x", allowOutOfOrder: false, approve: () => Promise.reject(new Error("approve() called")), log: () => undefined, standDown: () => Promise.resolve("standing down: newer") });
    expect(result).toMatchObject({ applied: [], stoodDown: "standing down: newer" });
    expect(ch.sent).toEqual([]);
  });
});
