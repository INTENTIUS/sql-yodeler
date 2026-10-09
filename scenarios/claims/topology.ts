import { clickhouseQuery, type ClickHouseEndpoint } from "@intentius/chant-lexicon-sql/clickhouse/http";
import { startKeeperCluster, CLUSTER, type KeeperCluster } from "../../test/e2e/keeper-cluster.js";
import { hold, type Claim, type Ctx } from "../lib/claim.js";
import { endpoints } from "../lib/db.js";
import { Project } from "../lib/project.js";

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
async function body(ctx: Ctx): Promise<void> {
  let cluster: KeeperCluster | undefined;
  try {
    cluster = await startKeeperCluster();
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

    const apply = async (env: string) => {
      const first = await p.yodel(["apply", env, "--json"], { timeoutMs: 600_000 });
      if (first.code !== 3) throw new Error(`yodel apply ${env} did not stop at the gate (exit ${String(first.code)})`);
      await p.approve((JSON.parse(first.out.slice(first.out.indexOf("{"))) as { approve?: string }).approve);
      const ran = await p.yodel(["apply", env, "--json"], { timeoutMs: 600_000 });
      hold(ran.code === 0, `yodel apply ${env} exited ${String(ran.code)}`);
    };

    await apply(single);
    const n = ctx.db.name;
    hold((await ctx.db.scalar(`SELECT engine FROM system.databases WHERE name = '${n}'`)) === "Atomic", "the single node's database is not Atomic");
    hold((await ctx.db.scalar(`SELECT engine FROM system.tables WHERE database = '${n}' AND name = 'events'`)) === "MergeTree", "the single node's events is not MergeTree");
    hold((await ctx.db.scalar(`SELECT sorting_key FROM system.tables WHERE database = '${n}' AND name = 'events'`)) === "country, kind, ts", "the single node's events was not rekeyed");
    hold((await ctx.db.scalar(`SELECT engine FROM system.tables WHERE database = '${ctx.db.history}' AND name = 'history'`)) === "MergeTree", "the single node's history is not MergeTree");

    await apply(replicated);
    const q = async (at: ClickHouseEndpoint, sql: string) => (await clickhouseQuery(at, sql)).map((r) => Object.values(r).map(String).join(" "));
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
  } finally {
    await cluster?.stop();
  }
}

export const topology: Claim = {
  name: "topology",
  says: "ClickHouse: one migrations directory applies to a single node and to a Replicated database, each rendered for its topology",
  dialects: { ch: body },
  shares: ["docker-cluster"],
  stallMinutes: 10,
};
