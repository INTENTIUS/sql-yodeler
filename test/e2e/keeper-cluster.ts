/**
 * A scratch two-replica ClickHouse cluster with Keeper, for the Keeper lock
 * and the replicated history: the pinned server image, Keeper embedded in
 * the first replica, `keeper_map_path_prefix` set (KeeperMap needs it), and
 * a cluster `yodel` of one shard with both replicas in `remote_servers`, so
 * `ON CLUSTER` works. Removed by `stop()`.
 *
 * With `{ shards: 2 }` a third server joins as the second shard, and every
 * server also declares the cluster `yodel_sharded`: shard s1 is the two
 * replicas, shard s2 the third server. `yodel` stays the one-shard cluster
 * of the first two, so a Replicated database and a sharded cluster can run
 * side by side, in different databases.
 *
 * The cluster is declared with chant's docker lexicon
 * (./keeper-cluster.compose.ts), serialized to a Compose file, and run as a
 * Compose project of its own.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { dockerSerializer } from "@intentius/chant-lexicon-docker";
import { clickhousePing, clickhouseQuery, type ClickHouseEndpoint } from "@intentius/chant-lexicon-sql/clickhouse/http";
import { publishedPort, uniqueContainerName } from "@intentius/chant-lexicon-sql/core/container";
import { CLUSTER, SHARDED_CLUSTER, keeperClusterEntities } from "./keeper-cluster.compose.js";

const exec = promisify(execFile);

export { CLUSTER, SHARDED_CLUSTER };

export interface KeeperCluster {
  /** Shard s1's two replicas. */
  replicas: [ClickHouseEndpoint, ClickHouseEndpoint];
  /** With `{ shards: 2 }`, the server of shard s2. */
  shard2?: ClickHouseEndpoint;
  stop(): Promise<void>;
}

/**
 * Starts the cluster as the Compose project `<containers>-<pid>-<random>`
 * (lowercased, underscores become dashes), whose containers are
 * `<project>-r1-1` and `-r2-1` (and `-r3-1` with two shards).
 */
export async function startKeeperCluster(containers = "yodel-keeper", options: { shards?: 1 | 2 } = {}): Promise<KeeperCluster> {
  const project = uniqueContainerName(containers.replaceAll("_", "-").toLowerCase());
  const { nodes, entities } = keeperClusterEntities(options.shards === 2 ? 2 : 1);
  const compose = dockerSerializer.serialize(entities);
  if (typeof compose !== "string") throw new Error("the cluster's declaration serialized to more than a Compose file");
  const dir = mkdtempSync(join(tmpdir(), "yodel-keeper-"));
  const file = join(dir, "compose.yaml");
  writeFileSync(file, compose);
  const composeArgs = ["compose", "--project-name", project, "--file", file];
  let removed = false;
  const stop = async () => {
    if (removed) return;
    removed = true;
    await exec("docker", [...composeArgs, "down", "--volumes", "--timeout", "0"]).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    await exec("docker", [...composeArgs, "up", "--detach", "--quiet-pull"], { timeout: 600_000 });
    const endpoints = await Promise.all(
      nodes.map(async (node) => ({ url: `http://127.0.0.1:${await publishedPort(`${project}-${node}-1`, 8123)}` }) satisfies ClickHouseEndpoint),
    );
    const deadline = Date.now() + 120_000;
    for (const endpoint of endpoints) {
      for (;;) {
        const ready = (await clickhousePing(endpoint)) && (await clickhouseQuery(endpoint, "SELECT count() FROM system.zookeeper WHERE path = '/'").then(() => true, () => false));
        if (ready) break;
        if (Date.now() > deadline) throw new Error(`${endpoint.url} did not answer and reach Keeper in time`);
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    const [r1, r2, r3] = endpoints;
    if (!r1 || !r2) throw new Error("the cluster's replicas did not start");
    return { replicas: [r1, r2], ...(r3 ? { shard2: r3 } : {}), stop };
  } catch (e) {
    await stop();
    throw e;
  }
}
