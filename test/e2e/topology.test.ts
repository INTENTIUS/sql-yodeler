/**
 * One migrations directory, applied to a single node and to a Replicated
 * database (#9): each environment's topology comes from yodel.config.ts
 * (test/fixtures/clickhouse-topology), every statement is rendered for it as
 * it is sent, and the history's engine follows it. A second apply sends
 * nothing.
 *
 *   single      the emulator: YODEL_E2E_CLICKHOUSE_URL=http://$(ipconfig getifaddr en0):8123
 *   replicated  a scratch two-replica cluster with Keeper (./keeper-cluster.ts): YODEL_E2E_KEEPER=1 and Docker
 *
 * Either half runs on its own; with both set, the same directory applies to
 * both. Run after `npm run build` (the migrations Op runs the yodel bin):
 *
 *   npm run build && YODEL_E2E_CLICKHOUSE_URL=... YODEL_E2E_KEEPER=1 npx vitest run test/e2e/topology.test.ts
 *
 * Objects live in yodel_9, the history in yodel_9_history. Both are dropped
 * on the emulator before and after; the scratch cluster is removed after.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { clickhouseQuery, type ClickHouseEndpoint } from "@intentius/chant-lexicon-sql/clickhouse/http";
import { dockerAvailable } from "@intentius/chant-lexicon-sql/core/container";
import { runChant } from "../../src/chant/process.js";
import type { BuildOutput } from "../../src/chant/build.js";
import { createMigration, readMigrations, writeMigration, type Migration } from "../../src/migrations/index.js";
import { json, projectFrom, yodel } from "../helpers/run.js";
import { clickhouse, clickhouseReachable } from "./emulator.js";
import { startKeeperCluster, type KeeperCluster } from "./keeper-cluster.js";

const DB = "yodel_9";
const HISTORY = "yodel_9_history";

const keeperEnabled = process.env.YODEL_E2E_KEEPER === "1" && (await dockerAvailable());

const build = (columns: string): BuildOutput => ({
  dialect: "clickhouse",
  objects: [
    { export: "db", type: "ClickHouse::Database", ddl: `CREATE DATABASE ${DB} ENGINE = Atomic`, dependsOn: [] },
    { export: "events", type: "ClickHouse::Table", ddl: `CREATE TABLE ${DB}.events (${columns}) ENGINE = MergeTree ORDER BY id`, dependsOn: ["db"] },
  ],
});

interface StatusDoc {
  topology: string;
  history: { database: string; topology: string };
  applied: Array<{ id: string; checksum: string }>;
  pending: Array<{ id: string }>;
  planDigest?: string;
  status?: string;
  approve?: string;
}

// The project and its migrations: written once, offline, topology-neutral.
let dir = "";
let dispose = (): void => undefined;
let written: Migration[] = [];
const at = (...args: string[]) => [...args, "--dir", dir];

function writeMigrations(): void {
  ({ dir, dispose } = projectFrom("clickhouse-topology"));
  const migrations = join(dir, "migrations");
  let previous: Migration | undefined;
  for (const [i, [name, columns]] of [["events", "id UInt64"], ["add-country", "id UInt64, country LowCardinality(String) DEFAULT ''"]].entries()) {
    const made = createMigration({ name: name ?? "", build: build(columns ?? ""), previous, now: new Date(Date.UTC(2026, 9, 9, 9, i)) });
    if (made.id === undefined) throw new Error(`no change for ${name ?? ""}`);
    writeMigration(migrations, made);
    previous = readMigrations(migrations).at(-1);
  }
  written = readMigrations(migrations);
}

/** The directory is the same one, unchanged, after every apply. */
const unchanged = () => { expect(readMigrations(join(dir, "migrations")).map((m) => [m.id, m.checksum])).toEqual(written.map((m) => [m.id, m.checksum])); };

async function approvedApply(env: string) {
  const gated = await yodel(at("apply", env, "--json"));
  expect(gated.code, gated.err).toBe(3);
  const doc = json(gated) as StatusDoc;
  expect(doc.approve).toMatch(new RegExp(`^chant approve migrate-${env} approve-migrate-${env} --plan jcs1-sha256:`));
  const ran = await runChant((doc.approve ?? "").split(" ").slice(1), { cwd: dir });
  expect(ran.code, ran.stderr).toBe(0);
  const applied = await yodel(at("apply", env, "--json"));
  expect(applied.code, applied.err).toBe(0);
  expect((json(applied) as StatusDoc).status).toBe("applied");
  return doc;
}

async function secondApplySendsNothing(env: string, count: () => Promise<number>) {
  const rows = await count();
  const again = await yodel(at("apply", env, "--json"));
  expect(again.code, again.err).toBe(0);
  expect((json(again) as StatusDoc).status).toBe("unchanged");
  expect(await count()).toBe(rows);
}

let cluster: KeeperCluster | undefined;

// The cluster starts before anything loads chant.config.ts, which reads YODEL_9_REPLICATED_URL.
beforeAll(async () => {
  if (keeperEnabled) {
    cluster = await startKeeperCluster();
    process.env.YODEL_9_REPLICATED_URL = cluster.replicas[0].url;
  }
  if (clickhouseReachable || keeperEnabled) writeMigrations();
}, 600_000);
afterAll(async () => {
  dispose();
  delete process.env.YODEL_9_REPLICATED_URL;
  await cluster?.stop();
});

describe.skipIf(!clickhouseReachable)("one migrations directory on a single node (the emulator)", () => {
  const n = async (sql: string) => Number((await clickhouse(sql)).trim());

  beforeAll(async () => {
    await clickhouse(`DROP DATABASE IF EXISTS ${DB}`);
    await clickhouse(`DROP DATABASE IF EXISTS ${HISTORY}`);
  });
  afterAll(async () => {
    await clickhouse(`DROP DATABASE IF EXISTS ${DB}`);
    await clickhouse(`DROP DATABASE IF EXISTS ${HISTORY}`);
  });

  it("applies as written, with a MergeTree history, and a second apply sends nothing", async () => {
    const status = await yodel(at("status", "single"));
    expect(status.out).toContain(`Migrations in single (history ${HISTORY}.history, topology single (yodel.config.ts))`);
    const doc = await approvedApply("single");
    expect(doc.topology).toBe("single (yodel.config.ts)");

    expect((await clickhouse(`SELECT engine FROM system.databases WHERE name = '${DB}'`)).trim()).toBe("Atomic");
    expect((await clickhouse(`SELECT engine FROM system.tables WHERE database = '${DB}' AND name = 'events'`)).trim()).toBe("MergeTree");
    expect((await clickhouse(`SELECT engine FROM system.tables WHERE database = '${HISTORY}' AND name = 'history'`)).trim()).toBe("MergeTree");
    expect(await n(`SELECT count() FROM system.columns WHERE database = '${DB}' AND table = 'events' AND name = 'country'`)).toBe(1);
    expect((await clickhouse(`SELECT DISTINCT note FROM ${HISTORY}.history WHERE kind = 'statement'`)).trim()).toBe("topology=single");

    await secondApplySendsNothing("single", () => n(`SELECT count() FROM ${HISTORY}.history`));
    unchanged();
  }, 300_000);
});

describe.skipIf(!keeperEnabled)("the same migrations directory on a Replicated database (scratch cluster with Keeper)", () => {
  const replicas = (): [ClickHouseEndpoint, ClickHouseEndpoint] => {
    if (!cluster) throw new Error("the scratch cluster did not start");
    return cluster.replicas;
  };
  const q = async (at: ClickHouseEndpoint, sql: string) => (await clickhouseQuery(at, sql)).map((r) => Object.values(r).map(String).join(" "));

  it("renders every statement for the Replicated database, gives the history a ReplicatedMergeTree there, and a second apply sends nothing", async () => {
    const status = await yodel(at("status", "replicated"));
    expect(status.out, status.err).toContain(`topology replicated:yodel (yodel.config.ts)`);
    await approvedApply("replicated");

    const [r1, r2] = replicas();
    for (const r of [r1, r2]) {
      await q(r, `SYSTEM SYNC DATABASE REPLICA ${DB}`);
      expect(await q(r, `SELECT engine FROM system.databases WHERE name IN ('${DB}', '${HISTORY}') ORDER BY name`)).toEqual(["Replicated", "Replicated"]);
      expect(await q(r, `SELECT engine FROM system.tables WHERE database = '${DB}' AND name = 'events'`)).toEqual(["ReplicatedMergeTree"]);
      expect(await q(r, `SELECT engine FROM system.tables WHERE database = '${HISTORY}' AND name = 'history'`)).toEqual(["ReplicatedMergeTree"]);
      expect(await q(r, `SELECT name FROM system.columns WHERE database = '${DB}' AND table = 'events' ORDER BY name`)).toEqual(["country", "id"]);
    }
    expect(await q(r1, `SELECT DISTINCT note FROM ${HISTORY}.history WHERE kind = 'statement'`)).toEqual(["topology=replicated:yodel"]);
    // The rows are the history's on every replica.
    await q(r2, `SYSTEM SYNC REPLICA ${HISTORY}.history`);
    expect(await q(r2, `SELECT count() FROM ${HISTORY}.history WHERE kind = 'migration' AND status = 'succeeded'`)).toEqual(["2"]);

    await secondApplySendsNothing("replicated", async () => Number((await q(r1, `SELECT count() FROM ${HISTORY}.history`))[0]));
    unchanged();
  }, 600_000);
});
