/**
 * The scratch Keeper cluster as a Compose project, declared with chant's
 * docker lexicon: one network, a ClickHouse server per replica on it, and
 * each server's cluster config as an inline Compose config mounted into
 * `config.d`.
 *
 * Services `r1` and `r2` are shard s1's replicas, and Keeper is embedded in
 * `r1`. With two shards, `r3` is shard s2. The service keys are also the
 * hosts the servers reach each other by on the network.
 *
 * The cluster config is YAML, which ClickHouse reads from `config.d` as it
 * does XML: the document is the `<clickhouse>` element's content, a mapping
 * is an element, and a list repeats its element.
 */

import { emitYAML } from "@intentius/chant/yaml";
import type { Declarable } from "@intentius/chant/declarable";
import { DockerConfig, Network, Service } from "@intentius/chant-lexicon-docker";
import { clickhouseImage } from "@intentius/chant-lexicon-sql/spec/pin";

export const CLUSTER = "yodel";
/** The two-shard cluster `{ shards: 2 }` declares. */
export const SHARDED_CLUSTER = "yodel_sharded";

const KEEPER = "r1";
const NETWORK = "cluster";

/** The ClickHouse config one server gets: `node` is its service key, `i` its index. */
function serverConfig(nodes: string[], node: string, i: number): Record<string, unknown> {
  const shard = (hosts: string[]) => ({ internal_replication: true, replica: hosts.map((host) => ({ host, port: 9000 })) });
  const [s1, s2] = [nodes.slice(0, 2), nodes.slice(2)];
  return {
    ...(i === 0
      ? {
          keeper_server: {
            tcp_port: 9181,
            server_id: 1,
            log_storage_path: "/var/lib/clickhouse/coordination/log",
            snapshot_storage_path: "/var/lib/clickhouse/coordination/snapshots",
            raft_configuration: { server: { id: 1, hostname: KEEPER, port: 9234 } },
          },
        }
      : {}),
    zookeeper: { node: { host: KEEPER, port: 9181 } },
    keeper_map_path_prefix: "/keeper_map_tables",
    distributed_ddl: { path: "/clickhouse/task_queue/ddl" },
    remote_servers: {
      [CLUSTER]: { shard: [shard(s1)] },
      ...(s2.length > 0 ? { [SHARDED_CLUSTER]: { shard: [shard(s1), shard(s2)] } } : {}),
    },
    macros: { shard: i < 2 ? "s1" : "s2", replica: `r${String(i + 1)}` },
    interserver_http_host: node,
  };
}

/**
 * The cluster's entities, keyed by their Compose names, for the docker
 * lexicon's serializer. `nodes` lists the service keys, in shard order.
 */
export function keeperClusterEntities(shards: 1 | 2): { nodes: string[]; entities: Map<string, Declarable> } {
  const nodes = shards === 2 ? ["r1", "r2", "r3"] : ["r1", "r2"];
  const entities = new Map<string, Declarable>([[NETWORK, new Network({ driver: "bridge" })]]);
  nodes.forEach((node, i) => {
    const config = new DockerConfig({ content: `${emitYAML(serverConfig(nodes, node, i), 0).trimStart()}\n` });
    entities.set(`${node}-config`, config);
    entities.set(
      node,
      new Service({
        image: clickhouseImage(),
        environment: { CLICKHOUSE_SKIP_USER_SETUP: "1" },
        ports: ["127.0.0.1::8123"],
        networks: [NETWORK],
        configs: [{ source: config, target: "/etc/clickhouse-server/config.d/yodel-cluster.yaml" }],
      }),
    );
  });
  return { nodes, entities };
}
