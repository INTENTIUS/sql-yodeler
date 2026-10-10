import { clickhouseQuery, type ClickHouseEndpoint } from "@intentius/chant-lexicon-sql/clickhouse/http";
import { startKeeperCluster, CLUSTER, SHARDED_CLUSTER, type KeeperCluster } from "../../test/e2e/keeper-cluster.js";
import { hold, Violation, type Claim, type Ctx } from "../lib/claim.js";
import { endpoints } from "../lib/db.js";
import { parse, Project } from "../lib/project.js";

const op = (env: string) => `import { Op, phase, gate, shell, stepOutput } from "@intentius/chant/op";

const plan = shell("yodel apply ${env} --digest", { id: "plan" });
const digest = stepOutput(plan, "stdout");

export const op = Op({
  name: "migrate-${env}",
  overview: "Apply the pending migrations to ${env}",
  phases: [
    phase("Plan", [plan]),
    phase("Approve", [gate("approve-migrate-${env}", { plan: digest })]),
    phase("Apply", [shell("yodel apply ${env} --execute", { env: { YODEL_APPROVED_PLAN: digest }, timeout: "2h" })]),
  ],
});
`;

/** `yodel apply <env>`, stopped at the gate, approved with the command it printed, and applied. */
async function approvedApply(p: Project, env: string): Promise<void> {
  const first = await p.yodel(["apply", env, "--json"], { timeoutMs: 600_000 });
  if (first.code !== 3) throw new Error(`yodel apply ${env} did not stop at the gate (exit ${String(first.code)})`);
  await p.approve((JSON.parse(first.out.slice(first.out.indexOf("{"))) as { approve?: string }).approve);
  const ran = await p.yodel(["apply", env, "--json"], { timeoutMs: 600_000 });
  hold(ran.code === 0, `yodel apply ${env} exited ${String(ran.code)}`);
}

/** Each row of a query's answer, its columns joined by a space. */
const q = async (at: ClickHouseEndpoint, sql: string) => (await clickhouseQuery(at, sql)).map((r) => Object.values(r).map(String).join(" "));

/**
 * One migrations directory, written once by yodel new, applied to two
 * environments whose topology yodel.config.ts sets: a single node (the
 * emulator) and a Replicated database on a scratch two-replica cluster with
 * Keeper. On the single node the tables are MergeTree in an Atomic
 * database; on the cluster every replica has a Replicated database of
 * ReplicatedMergeTree tables, the rebuild step's new table included, and
 * the history is replicated too. The directory is unchanged by either.
 * BREAK: yodel.config.ts gives the replicated environment the single-node
 * topology, so the cluster gets plain MergeTree tables on one replica.
 */
async function replicatedPart(ctx: Ctx, cluster: KeeperCluster): Promise<void> {
  {
    const [r1, r2] = cluster.replicas;
    const single = `${ctx.env}-single`;
    const replicated = `${ctx.env}-replicated`;
    const p = await Project.create(ctx, { ops: "none" });
    p.write(
      "chant.config.ts",
      `import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-sql";

export default {
  lexicons: ["sql"],
  sql: {
    dialect: "clickhouse",
    profiles: {
      "${single}": { url: "${endpoints.clickhouse}", databases: ["${ctx.db.name}"] },
      "${replicated}": { url: "${r1.url}", databases: ["${ctx.db.name}"] },
    },
  },
} satisfies ChantConfig;
`,
    );
    p.write(
      "yodel.config.ts",
      `import { defineConfig } from "@intentius/sql-yodeler";

export default defineConfig({
  environments: {
    "${single}": { topology: "single", history: { database: "${ctx.db.history}" } },
    "${replicated}": { topology: "${ctx.broken ? "single" : `replicated:${CLUSTER}`}", history: { database: "${ctx.db.history}" } },
  },
});
`,
    );
    p.write(`ops/migrate-${single}.op.ts`, op(single));
    p.write(`ops/migrate-${replicated}.op.ts`, op(replicated));
    await p.newMigration("create");
    p.edit("src/schema.ts", "    ts   DateTime\n", "    ts   DateTime,\n    country LowCardinality(String) DEFAULT ''\n");
    await p.newMigration("add-country");
    p.edit("src/schema.ts", "ORDER BY (kind, ts)", "ORDER BY (country, kind, ts)");
    await p.newMigration("rekey");
    await p.commit("three migrations");
    const written = p.migrationIds().map((id) => p.migration(id).checksum);
    hold(written.length === 3, `yodel new wrote ${String(written.length)} migrations, not 3`);

    const apply = (env: string) => approvedApply(p, env);

    await apply(single);
    const n = ctx.db.name;
    hold((await ctx.db.scalar(`SELECT engine FROM system.databases WHERE name = '${n}'`)) === "Atomic", "the single node's database is not Atomic");
    hold((await ctx.db.scalar(`SELECT engine FROM system.tables WHERE database = '${n}' AND name = 'events'`)) === "MergeTree", "the single node's events is not MergeTree");
    hold((await ctx.db.scalar(`SELECT sorting_key FROM system.tables WHERE database = '${n}' AND name = 'events'`)) === "country, kind, ts", "the single node's events was not rekeyed");
    hold((await ctx.db.scalar(`SELECT engine FROM system.tables WHERE database = '${ctx.db.history}' AND name = 'history'`)) === "MergeTree", "the single node's history is not MergeTree");

    await apply(replicated);
    for (const [i, r] of [r1, r2].entries()) {
      const which = `replica ${String(i + 1)}`;
      const dbs = await q(r, `SELECT name, engine FROM system.databases WHERE name IN ('${n}', '${ctx.db.history}') ORDER BY name`);
      hold(JSON.stringify(dbs) === JSON.stringify([`${n} Replicated`, `${ctx.db.history} Replicated`]), `${which}'s databases: ${JSON.stringify(dbs)}, not two Replicated ones`);
      await q(r, `SYSTEM SYNC DATABASE REPLICA ${n}`);
      const events = await q(r, `SELECT engine, sorting_key FROM system.tables WHERE database = '${n}' AND name = 'events'`);
      hold(JSON.stringify(events) === JSON.stringify(["ReplicatedMergeTree country, kind, ts"]), `${which}'s events: ${JSON.stringify(events)}`);
      const history = await q(r, `SELECT engine FROM system.tables WHERE database = '${ctx.db.history}' AND name = 'history'`);
      hold(JSON.stringify(history) === JSON.stringify(["ReplicatedMergeTree"]), `${which}'s history: ${JSON.stringify(history)}`);
    }
    hold(JSON.stringify(p.migrationIds().map((id) => p.migration(id).checksum)) === JSON.stringify(written), "an apply changed the migrations directory");
  }
}

/**
 * The same three kinds of change on a sharded cluster (#60): the scratch
 * cluster's `yodel_sharded`, shard s1 two replicas and shard s2 one server,
 * with a Distributed table over the shards' local events. Its own project
 * and database (`<db>_sharded`), as the Replicated database above lives on
 * the same servers. yodel new writes the create and an added column, yodel
 * apply sends them `ON CLUSTER` with ReplicatedMergeTree; rows go in through
 * the Distributed table, one half to each shard. The history is one
 * ReplicatedMergeTree for the whole cluster, read from the second shard.
 * A sort-key change is a ClickHouseRebuildOp step that copies and verifies
 * every shard (each server has its own `{shard}` macro), each shard keeping
 * its own rows. yodel drift finds nothing after the applies, names the TTL
 * changed on shard s2 alone (seen on s2's server), and then the TTL changed
 * and the Distributed table dropped out of band, both `ON CLUSTER`.
 * BREAK: yodel.config.ts gives the environment the single-node topology,
 * so the tables are made on the first server only.
 */
async function shardedPart(ctx: Ctx, cluster: KeeperCluster): Promise<void> {
  const [r1, r2] = cluster.replicas;
  const r3 = cluster.shard2;
  if (!r3) throw new Error("the scratch cluster has no second shard");
  const env = `${ctx.env}-sharded`;
  const n = `${ctx.db.name}_sharded`;
  const history = `${n}_history`;
  // In chant.config.ts as well as yodel.config.ts: yodel drift reads through chant, which renders for the profile's topology.
  const topology = ctx.broken ? "single" : `cluster:${SHARDED_CLUSTER}`;
  const p = await Project.create(ctx, { ops: "none", name: "sharded" });
  p.write(
    "chant.config.ts",
    `import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-sql";

export default {
  lexicons: ["sql"],
  sql: { dialect: "clickhouse", profiles: { "${env}": { url: "${r1.url}", databases: ["${n}"], topology: "${topology}" } } },
} satisfies ChantConfig;
`,
  );
  p.write(
    "yodel.config.ts",
    `import { defineConfig } from "@intentius/sql-yodeler";

export default defineConfig({
  environments: {
    "${env}": { topology: "${topology}", history: { database: "${history}" } },
  },
});
`,
  );
  p.write(
    "src/schema.ts",
    `import { database, table } from "@intentius/chant-lexicon-sql/clickhouse";

export const db = database\`
  CREATE DATABASE ${n}
  ENGINE = Atomic\`;

export const events = table\`
  CREATE TABLE \${db}.events (
    id   UInt64,
    kind LowCardinality(String),
    ts   DateTime
  )
  ENGINE = MergeTree
  PARTITION BY toYYYYMM(ts)
  ORDER BY (kind, ts)
  TTL ts + INTERVAL 365 DAY\`;

export const eventsAll = table\`
  CREATE TABLE \${db}.events_all (
    id   UInt64,
    kind LowCardinality(String),
    ts   DateTime
  )
  ENGINE = Distributed('${SHARDED_CLUSTER}', '${n}', 'events', id)\`;
`,
  );
  p.write(`ops/migrate-${env}.op.ts`, op(env));
  await p.newMigration("create");
  p.edit("src/schema.ts", / {4}ts {3}DateTime\n/g, "    ts   DateTime,\n    country LowCardinality(String) DEFAULT ''\n");
  await p.newMigration("add-country");
  await p.commit("two migrations");
  hold(p.migrationIds().length === 2, `yodel new wrote ${String(p.migrationIds().length)} migrations, not 2`);
  await approvedApply(p, env);

  const servers: Array<[string, ClickHouseEndpoint]> = [["s1 replica 1", r1], ["s1 replica 2", r2], ["s2", r3]];
  for (const [which, at] of servers) {
    const tables = await q(at, `SELECT name, engine FROM system.tables WHERE database = '${n}' ORDER BY name`);
    hold(JSON.stringify(tables) === JSON.stringify(["events ReplicatedMergeTree", "events_all Distributed"]), `${which}'s tables: ${JSON.stringify(tables)}, not a ReplicatedMergeTree events and a Distributed events_all`);
    const columns = await q(at, `SELECT table, groupArray(name) FROM (SELECT table, name FROM system.columns WHERE database = '${n}' ORDER BY table, position) GROUP BY table ORDER BY table`);
    hold(columns.every((c) => c.endsWith(" id,kind,ts,country")) && columns.length === 2, `${which}'s columns: ${JSON.stringify(columns)}`);
  }

  // Forty rows through the Distributed table: even ids to s1, odd ones to s2.
  await q(r1, `INSERT INTO ${n}.events_all (id, kind, ts, country) SETTINGS distributed_foreground_insert = 1 SELECT number + 1, ['a', 'b', 'c'][number % 3 + 1], now() - number * 43200, ['fr', 'jp'][number % 2 + 1] FROM numbers(40)`);
  await q(r2, `SYSTEM SYNC REPLICA ${n}.events`);
  const local = async (at: ClickHouseEndpoint) => (await q(at, `SELECT count(), sum(id) FROM ${n}.events`))[0] ?? "";
  const before = await Promise.all(servers.map(([, at]) => local(at)));
  hold(JSON.stringify(before) === JSON.stringify(["20 420", "20 420", "20 400"]), `the shards' rows (count, sum of ids) on s1, s1 again and s2: ${JSON.stringify(before)}, not half each`);

  // The rebuild step copies and verifies every shard: each keeps its own rows.
  {
    p.edit("src/schema.ts", "ORDER BY (kind, ts)", "ORDER BY (country, kind, ts)");
    const rekey = await p.newMigration("rekey");
    await p.commit("rekey");
    const steps = rekey === undefined ? [] : p.migration(rekey).steps;
    hold(steps.length === 1 && steps[0]?.op === "ClickHouseRebuildOp", `the sort-key change is not one ClickHouseRebuildOp step: ${JSON.stringify(steps.map((s) => s.op ?? s.sql))}`);
    await approvedApply(p, env);
    await q(r2, `SYSTEM SYNC REPLICA ${n}.events`);
    for (const [which, at] of servers) {
      const events = await q(at, `SELECT engine, sorting_key FROM system.tables WHERE database = '${n}' AND name = 'events'`);
      hold(JSON.stringify(events) === JSON.stringify(["ReplicatedMergeTree country, kind, ts"]), `${which}'s events after the rebuild: ${JSON.stringify(events)}`);
    }
    const after = await Promise.all(servers.map(([, at]) => local(at)));
    hold(JSON.stringify(after) === JSON.stringify(before), `the shards' rows after the rebuild: ${JSON.stringify(after)}, were ${JSON.stringify(before)}`);
    hold((await q(r3, `SELECT count() FROM ${n}.events_all`))[0] === "40", "the Distributed table does not read 40 rows after the rebuild");
  }
  await q(r3, `SYSTEM SYNC REPLICA ${history}.history`);
  const migrations = "3";
  const historyRows = await q(r3, `SELECT engine FROM system.tables WHERE database = '${history}' AND name = 'history' UNION ALL SELECT toString(count()) FROM ${history}.history WHERE kind = 'migration' AND status = 'succeeded'`);
  hold(historyRows.includes("ReplicatedMergeTree") && historyRows.includes(migrations), `the history on s2: ${JSON.stringify(historyRows)}, not a ReplicatedMergeTree with ${migrations} migrations`);

  const clean = await p.yodel(["drift", env, "--json"]);
  hold(clean.code === 0, `yodel drift ${env} exited ${String(clean.code)} with nothing changed: ${clean.out.slice(0, 600)}`);
  // A change on shard s2 alone, not ON CLUSTER: drift reads every server and names where it saw it.
  await q(r3, `ALTER TABLE ${n}.events MODIFY TTL ts + INTERVAL 30 DAY`);
  const s2Host = (await q(r3, "SELECT hostName()"))[0] ?? "";
  const oneShard = await p.yodel(["drift", env, "--json"]);
  const oneDoc = parse<{ drifted: boolean; changed: Array<{ name: string; changes: Array<{ path: string; seenOn?: string }> }> }>(oneShard);
  hold(oneShard.code === 2 && oneDoc.drifted, `yodel drift ${env} exited ${String(oneShard.code)} after a TTL changed on shard s2 alone`);
  const ttl = oneDoc.changed.find((c) => c.name === "events")?.changes.find((x) => x.path === "ttl");
  hold(ttl !== undefined, `yodel drift does not name events' ttl changed on shard s2 alone: ${JSON.stringify(oneDoc.changed)}`);
  hold(ttl.seenOn === s2Host, `yodel drift says the ttl change was seen on ${String(ttl.seenOn)}, not on s2 (${s2Host})`);
  await q(r1, `ALTER TABLE ${n}.events ON CLUSTER ${SHARDED_CLUSTER} MODIFY TTL ts + INTERVAL 30 DAY`);
  await q(r1, `DROP TABLE ${n}.events_all ON CLUSTER ${SHARDED_CLUSTER} SYNC`);
  const drifted = await p.yodel(["drift", env, "--json"]);
  const doc = parse<{ drifted: boolean; changed: Array<{ name: string; changes: Array<{ path: string }> }>; missing: string[] }>(drifted);
  hold(drifted.code === 2 && doc.drifted, `yodel drift ${env} exited ${String(drifted.code)} after the cluster changed`);
  hold(doc.changed.some((c) => c.name === "events" && c.changes.some((x) => x.path === "ttl")), `yodel drift does not name events' ttl: ${JSON.stringify(doc.changed)}`);
  hold(doc.missing.includes("eventsAll"), `yodel drift does not report eventsAll gone: ${JSON.stringify(doc.missing)}`);
}

/**
 * Both parts on one scratch cluster of three servers. Under BREAK each part
 * breaks its own topology, and the run is caught only when both catch it.
 */
async function body(ctx: Ctx): Promise<void> {
  const cluster = await startKeeperCluster("yodel-topology", { shards: 2 });
  try {
    const caught: string[] = [];
    for (const part of [replicatedPart, shardedPart]) {
      try {
        await part(ctx, cluster);
      } catch (e) {
        if (!(ctx.broken && e instanceof Violation)) throw e;
        ctx.log(`${part.name} caught: ${e.message}`);
        caught.push(e.message);
      }
    }
    if (ctx.broken && caught.length === 2) throw new Violation(caught.join("; "));
    if (ctx.broken) ctx.log(`only ${String(caught.length)} of the two parts caught the broken topology`);
  } finally {
    await cluster.stop();
  }
}

export const topology: Claim = {
  name: "topology",
  says: "ClickHouse: one migrations directory applies to a single node and to a Replicated database, and one to a sharded cluster with drift read there, each rendered for its topology",
  dialects: { ch: body },
  shares: ["docker-cluster"],
  stallMinutes: 10,
};
