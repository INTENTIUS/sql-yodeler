/**
 * A scratch two-replica ClickHouse cluster with Keeper, for the Keeper lock
 * and the replicated history: the pinned server image, Keeper embedded in
 * the first replica, `keeper_map_path_prefix` set (KeeperMap needs it), and
 * a cluster `yodel` of one shard with both replicas in `remote_servers`, so
 * `ON CLUSTER` works. The pattern is chant's `startScratchCluster`
 * (lexicons/sql/src/clickhouse/container.ts), with the two settings it does
 * not set. Removed by `stop()`.
 */

import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { clickhousePing, clickhouseQuery, type ClickHouseEndpoint } from "@intentius/chant-lexicon-sql/clickhouse/http";
import { publishedPort, uniqueContainerName } from "@intentius/chant-lexicon-sql/core/container";
import { clickhouseImage } from "@intentius/chant-lexicon-sql/spec/pin";

const exec = promisify(execFile);

export const CLUSTER = "yodel";

export interface KeeperCluster {
  replicas: [ClickHouseEndpoint, ClickHouseEndpoint];
  stop(): Promise<void>;
}

/** Starts the cluster. Its containers are named `<containers>-<pid>-<random>-r1` and `-r2`; underscores in `containers` become dashes. */
export async function startKeeperCluster(containers = "yodel-keeper"): Promise<KeeperCluster> {
  const name = uniqueContainerName(containers.replaceAll("_", "-"));
  const network = `${name}-net`;
  const nodes = [`${name}-r1`, `${name}-r2`] as const;
  const dir = mkdtempSync(join(tmpdir(), "yodel-keeper-"));
  let removed = false;
  const stop = async () => {
    if (removed) return;
    removed = true;
    await exec("docker", ["rm", "-f", ...nodes]).catch(() => undefined);
    await exec("docker", ["network", "rm", network]).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  };
  const keeper = nodes[0];
  const config = (node: string, i: number) => `<clickhouse>
${
  i === 0
    ? `  <keeper_server>
    <tcp_port>9181</tcp_port>
    <server_id>1</server_id>
    <log_storage_path>/var/lib/clickhouse/coordination/log</log_storage_path>
    <snapshot_storage_path>/var/lib/clickhouse/coordination/snapshots</snapshot_storage_path>
    <raft_configuration><server><id>1</id><hostname>${keeper}</hostname><port>9234</port></server></raft_configuration>
  </keeper_server>
`
    : ""
}  <zookeeper><node><host>${keeper}</host><port>9181</port></node></zookeeper>
  <keeper_map_path_prefix>/keeper_map_tables</keeper_map_path_prefix>
  <distributed_ddl><path>/clickhouse/task_queue/ddl</path></distributed_ddl>
  <remote_servers><${CLUSTER}><shard><internal_replication>true</internal_replication>${nodes.map((n) => `<replica><host>${n}</host><port>9000</port></replica>`).join("")}</shard></${CLUSTER}></remote_servers>
  <macros><shard>s1</shard><replica>r${String(i + 1)}</replica></macros>
  <interserver_http_host>${node}</interserver_http_host>
</clickhouse>
`;
  try {
    await exec("docker", ["network", "create", network]);
    const endpoints = await Promise.all(
      nodes.map(async (node, i) => {
        await exec("docker", ["create", "--name", node, "--hostname", node, "--network", network, "-p", "127.0.0.1::8123", "-e", "CLICKHOUSE_SKIP_USER_SETUP=1", clickhouseImage()], { timeout: 600_000 });
        const file = join(dir, `${node}.xml`);
        writeFileSync(file, config(node, i));
        chmodSync(file, 0o644);
        await exec("docker", ["cp", file, `${node}:/etc/clickhouse-server/config.d/yodel-cluster.xml`]);
        await exec("docker", ["start", node]);
        return { url: `http://127.0.0.1:${await publishedPort(node, 8123)}` } satisfies ClickHouseEndpoint;
      }),
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
    return { replicas: endpoints as [ClickHouseEndpoint, ClickHouseEndpoint], stop };
  } catch (e) {
    await stop();
    throw e;
  }
}
