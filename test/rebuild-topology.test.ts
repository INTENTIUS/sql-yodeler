import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BuildOutput } from "../src/chant/build.js";
import { rebuildChantConfig, runRebuild, withProfileTopology } from "../src/steps/index.js";
import { projectFrom } from "./helpers/run.js";

// A rebuild step renders through chant's rebuild activities, which bind the
// topology from sql.profiles.<env>.topology. A topology set only in
// yodel.config.ts (#9) reaches them through the config yodel hands them.

const DB = "yodel_12";
const schema: BuildOutput = {
  dialect: "clickhouse",
  objects: [
    { export: "db", type: "ClickHouse::Database", ddl: `CREATE DATABASE ${DB} ENGINE = Atomic`, dependsOn: [] },
    { export: "events", type: "ClickHouse::Table", ddl: `CREATE TABLE ${DB}.events (id UInt64, ts DateTime, k String) ENGINE = MergeTree PARTITION BY toYYYYMM(ts) ORDER BY (id, k)`, dependsOn: ["db"] },
  ],
};
const options = { name: "rebuild-yodel-12-events", table: `${DB}.events`, dualWrite: { mode: "materialized-view" as const, cutoverColumn: "ts" } };

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const d of disposers.splice(0)) d();
});

/** Runs the step with chant's own rebuildRun in place of the Create activity, and returns the new table's DDL and topology it bound. */
async function rebuildAs(dir: string) {
  const { rebuildRun } = await import("@intentius/chant-lexicon-sql/op/activities/clickhouse-rebuild");
  const seen: { ddl?: string; topology?: unknown } = {};
  const ok = () => Promise.resolve({});
  const activities = {
    clickhouseRebuildPlan: () => Promise.resolve({ state: "rebuild" }),
    clickhouseRebuildCreate: async (args: Record<string, unknown>, signal?: AbortSignal, deps?: unknown) => {
      const run = await rebuildRun(args as never, signal, (deps ?? {}));
      seen.ddl = run.declared.ddl;
      seen.topology = run.target.topology;
      return {};
    },
    clickhouseRebuildDualWrite: ok,
    clickhouseRebuildBackfill: ok,
    clickhouseRebuildVerify: ok,
    clickhouseRebuildSwap: ok,
    clickhouseRebuildRetain: ok,
  };
  const config = await rebuildChantConfig(dir, "e2e", {});
  await runRebuild(options, { environment: "e2e", projectDir: dir, schema, activities: activities, base: new Map(), config });
  return { config, ...seen };
}

describe("a rebuild step's topology", () => {
  it("follows a cluster topology set only in yodel.config.ts: the new table is created ON CLUSTER with a ReplicatedMergeTree", async () => {
    const p = projectFrom("clickhouse-steps");
    disposers.push(p.dispose);
    writeFileSync(join(p.dir, "yodel.config.ts"), `export default { environments: { e2e: { topology: "cluster:main" } } };\n`);
    const { config, ddl, topology } = await rebuildAs(p.dir);
    expect(config?.sql?.profiles?.e2e).toMatchObject({ topology: { kind: "cluster", cluster: "main" } });
    expect(topology).toEqual({ kind: "cluster", cluster: "main" });
    expect(ddl).toMatch(/events`? ON CLUSTER `?main`?/);
    expect(ddl).toContain("ReplicatedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')");
  });

  it("is left to chant when nothing but chant's profile (or nothing at all) names one", async () => {
    const p = projectFrom("clickhouse-steps");
    disposers.push(p.dispose);
    const { config, ddl, topology } = await rebuildAs(p.dir);
    expect(config).toBeUndefined();
    expect(topology).toBeUndefined();
    expect(ddl).not.toMatch(/ON CLUSTER|Replicated/);
  });

  it("sets the topology on a copy of the profile, leaving the config as it was", () => {
    const config = { lexicons: ["sql"], sql: { dialect: "clickhouse" as const, profiles: { e2e: { url: "http://x:8123" } } } };
    const out = withProfileTopology(config, "e2e", { kind: "replicated" });
    expect(out.sql?.profiles?.e2e).toEqual({ url: "http://x:8123", topology: { kind: "replicated" } });
    expect(config.sql.profiles.e2e).toEqual({ url: "http://x:8123" });
    expect(withProfileTopology(config, "nope", { kind: "replicated" })).toBe(config);
  });
});
