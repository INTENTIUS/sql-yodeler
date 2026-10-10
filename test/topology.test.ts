import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Topology } from "@intentius/chant-lexicon-sql/clickhouse/topology";
import { checkYodelConfig, declarativeTopologyRefusal, defineConfig, environmentSettings, type YodelConfig } from "../src/config/index.js";
import * as root from "../src/index.js";
import { loadProject, projectFromConfig, type Project } from "../src/project.js";
import { createMigration } from "../src/migrations/index.js";
import type { BuildOutput } from "../src/chant/build.js";
import { historyDdl, statementSha } from "../src/history/index.js";
import { renderForEnvironment, topologyNote } from "../src/topology/render.js";
import { currentDigest, digestSubject, executeApply, inspect, openVersioned, planDigest, selectToApply, statusReport, type VersionedEnv } from "../src/versioned/index.js";
import { FakeClickHouse, migration } from "./helpers/fake-clickhouse.js";
import { projectFrom, repoRoot, yodel } from "./helpers/run.js";

const PROFILES = { dev: { url: "http://dev:8123" }, prod: { url: "http://prod:8123" } };

function project(yodelConfig?: YodelConfig, profiles: Record<string, unknown> = PROFILES): Project {
  return projectFromConfig(
    "/p",
    "/p/chant.config.ts",
    { lexicons: ["sql"], sql: { dialect: "clickhouse", profiles } } as never,
    yodelConfig ? { path: "/p/yodel.config.ts", config: checkYodelConfig(yodelConfig, "/p/yodel.config.ts", Object.keys(profiles)) } : undefined,
  );
}

describe("yodel.config.ts", () => {
  it("is exported from the package root as defineConfig, an identity", () => {
    const c = { environments: { prod: { topology: "cluster:main" } } };
    expect(root.defineConfig(c)).toBe(c);
    expect(defineConfig).toBe(root.defineConfig);
  });

  it("loads with the project, and a project without one has none", async () => {
    const p = projectFrom("clickhouse-versioned");
    try {
      expect((await loadProject(p.dir)).yodel).toBeUndefined();
      writeFileSync(
        join(p.dir, "yodel.config.ts"),
        `import { defineConfig } from ${JSON.stringify(join(import.meta.dirname, "../src/index.js"))};\n` +
          `export default defineConfig({ environments: { e2e: { topology: "replicated", history: { database: "h9" }, lockTtl: 60 } } });\n`,
      );
      const loaded = await loadProject(p.dir);
      expect(loaded.yodel?.path).toBe(join(p.dir, "yodel.config.ts"));
      expect(environmentSettings(loaded, "e2e", {})).toMatchObject({ topology: { kind: "replicated" }, topologySource: "yodel.config.ts", historyDatabase: "h9", lockTtlMs: 60_000 });
    } finally {
      p.dispose();
    }
  });

  it("refuses a config naming an environment chant.config.ts does not declare, a bad topology, or an unknown setting", async () => {
    expect(() => project({ environments: { prdo: { topology: "single" } } })).toThrow(/environments.prdo is not an environment chant.config.ts declares \(sql.profiles: dev, prod\)/);
    expect(() => project({ environments: { prod: { topology: "cluster" } } })).toThrow(/environments.prod.topology: topology cluster needs the cluster's name/);
    expect(() => project({ environments: { prod: { topology: { kind: "single", cluster: "x" } as never } } })).toThrow(/a single topology takes no cluster/);
    expect(() => project({ environments: { prod: { lockTtl: -1 } } })).toThrow(/lockTtl: expected a number of seconds/);
    expect(() => project({ environments: { prod: { topolgy: "single" } as never } })).toThrow(/prod.topolgy: unknown setting/);
    expect(() => checkYodelConfig(undefined, "/p/yodel.config.ts")).toThrow(/default export must be a config object/);

    const p = projectFrom("clickhouse-versioned");
    try {
      writeFileSync(join(p.dir, "yodel.config.ts"), `export default { environments: { prod: { topology: "single" } } };\n`);
      await expect(loadProject(p.dir)).rejects.toThrow(/environments.prod is not an environment/);
      const ran = await yodel(["status", "e2e", "--dir", p.dir]);
      expect(ran.code).toBe(1);
      expect(ran.err).toMatch(/yodel.config.ts: environments.prod is not an environment/);
    } finally {
      p.dispose();
    }
  });
});

describe("environmentSettings", () => {
  it("takes the topology from yodel.config.ts, then sql.profiles.<env>.topology, then YODEL_TOPOLOGY, then single", () => {
    const env = { YODEL_TOPOLOGY: "cloud" };
    const withProfile = { ...PROFILES, prod: { url: "http://prod:8123", topology: "replicated" } };
    expect(environmentSettings(project({ environments: { prod: { topology: "cluster:main" } } }, withProfile), "prod", env)).toMatchObject({
      topology: { kind: "cluster", cluster: "main" },
      topologySource: "yodel.config.ts",
    });
    expect(environmentSettings(project(undefined, withProfile), "prod", env)).toMatchObject({ topology: { kind: "replicated" }, topologySource: "sql.profiles.prod.topology" });
    expect(environmentSettings(project(), "prod", env)).toMatchObject({ topology: { kind: "cloud" }, topologySource: "YODEL_TOPOLOGY" });
    expect(environmentSettings(project(), "prod", {})).toMatchObject({ topology: { kind: "single" }, topologySource: "default" });
    // Another environment's setting does not leak.
    expect(environmentSettings(project({ environments: { prod: { topology: "cluster:main" } } }), "dev", {})).toMatchObject({ topology: { kind: "single" } });
  });

  it("takes the history database and lock TTL from yodel.config.ts, then the env vars, then the defaults", () => {
    const env = { YODEL_HISTORY_DATABASE: "from_env", YODEL_LOCK_TTL: "30" };
    expect(environmentSettings(project({ environments: { prod: { history: { database: "own" }, lockTtl: 120 } } }), "prod", env)).toMatchObject({ historyDatabase: "own", lockTtlMs: 120_000 });
    expect(environmentSettings(project(), "prod", env)).toMatchObject({ historyDatabase: "from_env", lockTtlMs: 30_000 });
    expect(environmentSettings(project(), "prod", {})).toMatchObject({ historyDatabase: "yodeler", lockTtlMs: 900_000 });
    expect(() => environmentSettings(project(), "prod", { YODEL_LOCK_TTL: "soon" })).toThrow(/YODEL_LOCK_TTL must be a number/);
  });

  it("keeps a cluster's replica path for the migrations' tables but not for the history", () => {
    const s = environmentSettings(project({ environments: { prod: { topology: { kind: "cluster", cluster: "main", replicaPath: "/t/{uuid}", replicaName: "{replica}" } } } }), "prod", {});
    expect(s.topology).toEqual({ kind: "cluster", cluster: "main", replicaPath: "/t/{uuid}", replicaName: "{replica}" });
    expect(s.historyTopology).toEqual({ kind: "cluster", cluster: "main" });
  });

  it("gives the history table the engine the configured topology needs", () => {
    const ddl = (topology: string) => {
      const s = environmentSettings(project({ environments: { prod: { topology, history: { database: "h" } } } }), "prod", {});
      return historyDdl({ database: s.historyDatabase, topology: s.historyTopology }).join("\n");
    };
    expect(ddl("single")).toMatch(/ENGINE = MergeTree\n/);
    expect(ddl("single")).not.toMatch(/ON CLUSTER|Replicated/);
    expect(ddl("cluster:main")).toContain("CREATE DATABASE IF NOT EXISTS `h` ON CLUSTER `main`");
    expect(ddl("cluster:main")).toContain("ENGINE = ReplicatedMergeTree('/clickhouse/yodeler/h/history', '{shard}-{replica}')");
    expect(ddl("replicated")).toContain("ENGINE = Replicated('/clickhouse/databases/h', '{shard}', '{replica}')");
    expect(ddl("replicated")).toMatch(/ENGINE = ReplicatedMergeTree\n/);
    expect(ddl("cloud")).toMatch(/ENGINE = MergeTree\n/);
    expect(ddl("cloud")).not.toMatch(/ON CLUSTER/);
  });

  it("refuses the declarative path when only yodel.config.ts names the topology, since chant does not read it", () => {
    expect(declarativeTopologyRefusal(project(), "prod")).toBeUndefined();
    expect(declarativeTopologyRefusal(project({ environments: { prod: { topology: "cluster:main" } } }), "prod")?.message).toMatch(/Set sql.profiles.prod.topology to the same/);
    const same = { ...PROFILES, prod: { url: "http://prod:8123", topology: { cluster: "main", kind: "cluster" } } };
    expect(declarativeTopologyRefusal(project({ environments: { prod: { topology: "cluster:main" } } }, same), "prod")).toBeUndefined();
  });
});

// A fixture migration as `yodel new` writes it: topology-neutral, for a single node.
const build: BuildOutput = {
  dialect: "clickhouse",
  objects: [
    { export: "db", type: "ClickHouse::Database", ddl: "CREATE DATABASE yodel_9 ENGINE = Atomic", dependsOn: [] },
    { export: "events", type: "ClickHouse::Table", ddl: "CREATE TABLE yodel_9.events (id UInt64, at DateTime) ENGINE = MergeTree ORDER BY id", dependsOn: ["db"] },
  ],
};

describe("one migration source, rendered per topology", () => {
  const made = createMigration({ name: "events", build, now: new Date("2026-10-09T12:00:00Z") });
  if (!made.id) throw new Error("no migration");
  const statements = made.document.steps.flatMap((s) => (s.kind === "statement" ? [s.sql] : []));

  it("is written for a single node, recording no topology", () => {
    expect(made.document.topology).toBeUndefined();
    expect(made.files.json).not.toMatch(/"topology"/);
    expect(statements.join("\n")).not.toMatch(/ON CLUSTER|Replicated/);
    expect(statements.some((s) => /ENGINE = MergeTree/.test(s))).toBe(true);
  });

  const render = (t: Topology) => statements.map((s) => renderForEnvironment(s, t)).join("\n");

  it("renders unchanged for a single node and for Cloud", () => {
    expect(render({ kind: "single" })).toBe(statements.join("\n"));
    expect(render({ kind: "cloud" })).not.toMatch(/ON CLUSTER|Replicated/);
  });

  it("renders ON CLUSTER and a ReplicatedMergeTree with a Keeper path for a cluster", () => {
    const sql = render({ kind: "cluster", cluster: "main" });
    expect(sql).toMatch(/CREATE DATABASE (IF NOT EXISTS )?`?yodel_9`? ON CLUSTER `?main`?/);
    expect(sql).toMatch(/events`? ON CLUSTER `?main`?/);
    expect(sql).toContain("ReplicatedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')");
  });

  it("renders a ReplicatedMergeTree with no arguments and no ON CLUSTER for a Replicated database", () => {
    const sql = render({ kind: "replicated" });
    expect(sql).not.toMatch(/ON CLUSTER/);
    expect(sql).toMatch(/ENGINE = ReplicatedMergeTree(\(\))?\s+ORDER BY/);
  });
});

/** A fake server that also takes the KeeperMap lock, so a replicated topology can apply. */
class KeeperFake extends FakeClickHouse {
  private owner = "";
  override query<Row = Record<string, unknown>>(sql: string, options?: unknown): Promise<Row[]> {
    if (/^CREATE TABLE IF NOT EXISTS \S+\.lock\b/.test(sql) || /^SYSTEM SYNC REPLICA/.test(sql) || /^ALTER TABLE \S+\.lock\b/.test(sql)) return Promise.resolve([]);
    if (/^INSERT INTO \S+\.lock\b/.test(sql)) {
      this.owner = /SELECT 'apply', '([^']*)'/.exec(sql)?.[1] ?? "";
      return Promise.resolve([]);
    }
    if (/^SELECT owner, .* FROM \S+\.lock\b/.test(sql)) return Promise.resolve([{ owner: this.owner, until: "2099-01-01", expired: 0 }] as Row[]);
    return (super.query as (s: string, o?: unknown) => Promise<Row[]>)(sql, options);
  }
}

const m1 = migration("20261009T1000-one", null, ["CREATE DATABASE yodel_9", "CREATE TABLE yodel_9.a (x UInt8) ENGINE = MergeTree ORDER BY x"]);

async function setup(yodelConfig: YodelConfig | undefined, ch = new KeeperFake()): Promise<{ ch: KeeperFake; venv: VersionedEnv }> {
  const url = `http://fake-${randomUUID()}:8123`;
  const p = project(yodelConfig, { e2e: { url, databases: ["yodel_9"] } });
  const venv = await openVersioned(p, { name: "e2e", profile: { url } }, { YODEL_HISTORY_DATABASE: "yodel_9_history" }, ch);
  return { ch, venv };
}

async function apply(venv: VersionedEnv) {
  const { status } = await inspect(venv, [m1]);
  const digest = await currentDigest(venv, status, selectToApply(status, false));
  return executeApply(venv, [m1], { approvedDigest: digest, allowOutOfOrder: false, approve: () => Promise.resolve(), log: () => undefined, processEnv: { USER: "t" } });
}

describe("versioned apply per topology", () => {
  it("sends each statement rendered for the configured topology, recording the neutral statement's sha and the topology", async () => {
    const { ch, venv } = await setup({ environments: { e2e: { topology: "cluster:main" } } });
    await apply(venv);
    expect(ch.sent).toEqual([
      renderForEnvironment("CREATE DATABASE yodel_9", { kind: "cluster", cluster: "main" }),
      renderForEnvironment("CREATE TABLE yodel_9.a (x UInt8) ENGINE = MergeTree ORDER BY x", { kind: "cluster", cluster: "main" }),
    ]);
    expect(ch.sent[0]).toMatch(/ON CLUSTER/);
    const row = ch.rows.find((r) => r.kind === "statement" && r.statement_index === 1 && r.status === "succeeded");
    expect(row).toMatchObject({ statement_sha: statementSha("CREATE TABLE yodel_9.a (x UInt8) ENGINE = MergeTree ORDER BY x"), note: topologyNote({ kind: "cluster", cluster: "main" }) });
    expect(row?.note).toBe("topology=cluster:main");

    // A second apply sends nothing.
    ch.sent = [];
    expect((await apply(venv)).applied).toEqual([]);
    expect(ch.sent).toEqual([]);
  });

  it("sends the statements as written on a single node, and its status names the topology and where it came from", async () => {
    const { ch, venv } = await setup(undefined);
    await apply(venv);
    expect(ch.sent).toEqual(["CREATE DATABASE yodel_9", "CREATE TABLE yodel_9.a (x UInt8) ENGINE = MergeTree ORDER BY x"]);
    expect((await statusReport(venv, [m1])).topology).toBe("single (default)");
    const replicated = await setup({ environments: { e2e: { topology: "replicated" } } });
    expect((await statusReport(replicated.venv, [m1])).topology).toBe("replicated (yodel.config.ts)");
  });
});

describe("the plan digest", () => {
  const subject = (topology?: Topology) =>
    digestSubject({ environment: "prod", historyDatabase: "yodeler", ...(topology ? { topology } : {}), applied: [], toApply: [], live: "sha256:0" });

  it("covers the topology: an approval for a single node does not apply on a cluster", async () => {
    const single = await planDigest(subject({ kind: "single" }));
    expect(await planDigest(subject())).toBe(single);
    const digests = new Set([
      single,
      await planDigest(subject({ kind: "cluster", cluster: "main" })),
      await planDigest(subject({ kind: "cluster", cluster: "other" })),
      await planDigest(subject({ kind: "cluster", cluster: "main", replicaPath: "/x/{uuid}" })),
      await planDigest(subject({ kind: "replicated" })),
      await planDigest(subject({ kind: "cloud" })),
    ]);
    expect(digests.size).toBe(6);
  });

  it("moves when the environment's configured topology changes", async () => {
    const a = await setup(undefined);
    const b = await setup({ environments: { e2e: { topology: "replicated" } } });
    const { status } = await inspect(a.venv, [m1]);
    expect(await currentDigest(a.venv, status, status.pending)).not.toBe(await currentDigest(b.venv, status, status.pending));
  });
});

describe("what moved", () => {
  it("names a topology change between two subjects", async () => {
    const { diffSubjects } = await import("../src/versioned/explain.js");
    const a = digestSubject({ environment: "prod", historyDatabase: "h", topology: { kind: "single" }, applied: [], toApply: [], live: "L" });
    const b = digestSubject({ environment: "prod", historyDatabase: "h", topology: { kind: "cluster", cluster: "main" }, applied: [], toApply: [], live: "L" });
    expect(diffSubjects(a, b)).toEqual([{ part: "environment", message: "the topology changed: single -> cluster:main" }]);
    expect(diffSubjects(a, a)).toEqual([]);
  });
});

describe("the ClickHouse template's own config pair (#25)", () => {
  it("is not refused: topology single in yodel.config.ts agrees with chant's unset profile topology", async () => {
    const project = await loadProject(join(repoRoot, "templates", "clickhouse"));
    for (const env of ["dev", "prod"]) {
      expect(project.yodel?.config.environments?.[env]?.topology).toBe("single");
      expect((project.config.sql?.profiles?.[env] as { topology?: unknown } | undefined)?.topology).toBeUndefined();
      expect(declarativeTopologyRefusal(project, env)).toBeUndefined();
    }
    // A cluster in yodel.config.ts still disagrees with an unset (single-node) profile.
    const cluster = { ...project, yodel: { path: "yodel.config.ts", config: { environments: { dev: { topology: "cluster:main" } } } } } as typeof project;
    expect(declarativeTopologyRefusal(cluster, "dev")?.message).toContain("(unset, so a single node)");
  });
});
