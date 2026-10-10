import { describe, expect, it } from "vitest";
import { describeServer, serverAddress, versionWord } from "../src/server.js";
import { describeHolders, isLockTimeout, lockTimeoutOptions, readUnderLockTimeout } from "../src/versioned/postgres/waits.js";
import { renderDrift } from "../src/chant/drift.js";

describe("the server in a header (#11)", () => {
  it("names the address without credentials, and the version's first word", () => {
    expect(serverAddress("postgres", "postgres://u:secret@127.0.0.1:5432/postgres")).toBe("127.0.0.1:5432/postgres");
    expect(serverAddress("postgres", "postgres://db.example")).toBe("db.example:5432/postgres");
    expect(serverAddress("clickhouse", "http://user:pw@192.168.14.189:8123")).toBe("192.168.14.189:8123");
    expect(serverAddress("clickhouse", "https://ch.example")).toBe("ch.example:8443");
    expect(versionWord("16.14 (Homebrew)")).toBe("16.14");
    expect(describeServer({ dialect: "postgres", address: "127.0.0.1:5432/postgres", version: "16.14" })).toBe("postgres 16.14 at 127.0.0.1:5432/postgres");
    expect(describeServer({ dialect: "clickhouse", address: "ch:8123" })).toBe("clickhouse at ch:8123");
  });

  it("drift's header names it", () => {
    const text = renderDrift({ environment: "dev", changed: [], missing: [], unobserved: [] }, { dialect: "postgres", address: "h:5432/p", version: "18.6" });
    expect(text.split("\n")[0]).toBe("Drift in dev (postgres 18.6 at h:5432/p)");
  });
});

class LockedClient {
  queries: string[] = [];
  constructor(private blockedFor: number) {}
  query<T>(sql: string): Promise<T[]> {
    this.queries.push(sql);
    if (sql.includes("current_setting('lock_timeout')")) return Promise.resolve([{ lock_timeout: "0" }] as T[]);
    if (sql.includes("pg_locks")) return Promise.resolve([{ schema: "shop", name: "orders", pid: "4242", granted: true, application: "psql" }] as T[]);
    return Promise.resolve([] as T[]);
  }
  read = (): Promise<string> => {
    if (this.blockedFor-- > 0) return Promise.reject(Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" }));
    return Promise.resolve("catalog");
  };
}

describe("reads under the lock timeout (#18)", () => {
  const opts = (log: string[]) => ({ lockTimeoutMs: 5000, retries: 2, schemas: ["shop"], what: "the live schema", log: (l: string) => log.push(l), sleep: () => Promise.resolve() });

  it("says which lock it waits on, tries again, and restores the setting", async () => {
    const c = new LockedClient(1);
    const log: string[] = [];
    await expect(readUnderLockTimeout(c, c.read, opts(log))).resolves.toBe("catalog");
    expect(log).toEqual(["reading the live schema waited 5s for a lock on shop.orders (held by pid 4242, psql); trying again in 250ms (1 of 2)"]);
    expect(c.queries.filter((q) => q.includes("set_config('lock_timeout'"))).toHaveLength(2);
  });

  it("fails after the last try, naming the holder", async () => {
    const c = new LockedClient(10);
    const log: string[] = [];
    await expect(readUnderLockTimeout(c, c.read, opts(log))).rejects.toThrow(/waited 5s for a lock on shop\.orders \(held by pid 4242, psql\), 3 time\(s\); nothing was changed.*pg_terminate_backend\(4242\)/);
    expect(log).toHaveLength(2);
  });

  it("passes other errors through at once", async () => {
    const c = new LockedClient(0);
    const read = () => Promise.reject(Object.assign(new Error("boom"), { code: "42P01" }));
    await expect(readUnderLockTimeout(c, read, opts([]))).rejects.toThrow("boom");
  });

  it("hands chant's read the timeout through PGOPTIONS", () => {
    expect(lockTimeoutOptions(5000, undefined)).toBe("-c lock_timeout=5000");
    expect(lockTimeoutOptions(2500, "-c search_path=x")).toBe("-c search_path=x -c lock_timeout=2500");
    expect(isLockTimeout("canceling statement due to lock timeout")).toBe(true);
    expect(describeHolders([])).toMatch(/another session/);
  });

  it("drift says what the read waited on", () => {
    const text = renderDrift({ environment: "dev", changed: [], missing: [], unobserved: [{ name: "orders", reason: "read-failed", detail: "canceling statement due to lock timeout" }] as never, lockWait: "waited 5s (lockTimeoutMs) for a lock on shop.orders (held by pid 1)" });
    expect(text).toContain("No drift in the declared objects that could be read.");
    expect(text).toContain("The read waited 5s (lockTimeoutMs) for a lock on shop.orders (held by pid 1).");
  });
});
