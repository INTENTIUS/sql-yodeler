import { describe, expect, it } from "vitest";
import { projectFromConfig } from "../src/project.js";
import { refuseShared, serverKey, sharedProfiles } from "../src/replay/index.js";
import { unreachable } from "../src/history/client.js";

const clickhouse = (profiles: Record<string, unknown>) =>
  projectFromConfig("/p", "/p/chant.config.ts", { lexicons: ["sql"], sql: { dialect: "clickhouse", profiles } } as never);

describe("a replay that would empty another profile's database (#12)", () => {
  it("folds loopback names and default ports into one server", () => {
    expect(serverKey("clickhouse", "http://localhost:8123")).toBe(serverKey("clickhouse", "http://127.0.0.1"));
    expect(serverKey("clickhouse", "http://localhost:8124")).not.toBe(serverKey("clickhouse", "http://127.0.0.1:8123"));
    expect(serverKey("postgres", "postgres://u@localhost/postgres")).toBe("127.0.0.1:5432/postgres");
    expect(serverKey("postgres", "postgres://127.0.0.1:5432/other")).not.toBe("127.0.0.1:5432/postgres");
  });

  it("names the profile on the same server that names one of the replayed databases, and refuses even with --reset", async () => {
    const project = clickhouse({
      dev: { url: "http://127.0.0.1:8123", databases: ["shop"] },
      prod: { url: "https://ch.example.com:8443", databases: ["shop"] },
      other: { url: "http://localhost:8123", databases: ["elsewhere"] },
      replay: { url: "http://localhost:8123", databases: ["shop"] },
    });
    const replay = { name: "replay", profile: {} } as never;
    const shared = await sharedProfiles(project, replay, ["shop"], {});
    expect(shared).toEqual([{ profile: "dev", server: "127.0.0.1:8123", names: ["shop"] }]);
    expect(() => { refuseShared(replay, shared, [], "clickhouse"); }).toThrow(
      "refused: replay and dev are the same server (127.0.0.1:8123) and both name shop; the replay would drop dev's database, with or without --reset. " +
        "Point replay at a throwaway server of its own (a second emulator on another port), or, to empty dev too, add --reset-shared dev. Nothing was run.",
    );
    try {
      refuseShared(replay, shared, [], "clickhouse");
    } catch (e) {
      expect((e as { exitCode: number }).exitCode).toBe(4);
    }
    expect(() => { refuseShared(replay, shared, ["dev"], "clickhouse"); }).not.toThrow();
  });

  it("leaves out a profile whose credentials are not set here (a CI job holding only the replay server's)", async () => {
    const project = clickhouse({
      dev: { url: "http://127.0.0.1:8123", user: { env: "DEV_USER" }, databases: ["shop"] },
      replay: { url: "http://localhost:8123", databases: ["shop"] },
    });
    const replay = { name: "replay", profile: {} } as never;
    expect(await sharedProfiles(project, replay, ["shop"], {})).toEqual([]);
    expect(await sharedProfiles(project, replay, ["shop"], { DEV_USER: "me" })).toHaveLength(1);
  });
});

describe("a ClickHouse server that does not answer", () => {
  it("is one line naming the URL, without credentials", () => {
    const e = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    expect(unreachable({ url: "http://u:secret@127.0.0.1:8124" }, e)?.message).toBe("the ClickHouse server at http://127.0.0.1:8124 did not answer (ECONNREFUSED); is it running, and is that the right URL?");
    expect(unreachable({ url: "http://x" }, new Error("Code: 60. Table missing"))).toBeUndefined();
  });
});
