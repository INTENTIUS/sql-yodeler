/**
 * Where the history table lives, as far as its DDL cares: a single node, a
 * cluster (`ON CLUSTER`), a `Replicated` database, or ClickHouse Cloud.
 *
 * The same four kinds as chant's ClickHouse topology, with the same string
 * form (`single`, `cluster:<name>`, `replicated`, `replicated:<cluster>`,
 * `cloud`). Choosing one per environment is #9's (`yodel.config.ts`); until
 * then `YODEL_TOPOLOGY` sets it and the default is a single node.
 */

import { YodelError } from "../project.js";

export type HistoryTopology =
  | { kind: "single" }
  | {
      kind: "cluster";
      /** The cluster's name in `remote_servers`, or a macro such as `{cluster}`. */
      cluster: string;
      /** The history table's Keeper path. Default {@link defaultReplicaPath}. */
      replicaPath?: string;
      /** Its replica name. Default {@link DEFAULT_HISTORY_REPLICA_NAME}. */
      replicaName?: string;
    }
  | {
      kind: "replicated";
      /** A cluster to create the history's `Replicated` database on, when yodel creates it. */
      cluster?: string;
    }
  | { kind: "cloud" };

export const SINGLE: HistoryTopology = { kind: "single" };

/**
 * A cluster's history table is one copy for the whole cluster, not one per
 * shard: every runner, on any host, must read the same rows. So the Keeper
 * path names no `{shard}`, and the replica name carries the shard as well as
 * the replica, so replicas of different shards do not collide.
 */
export const defaultReplicaPath = (database: string, table: string): string => `/clickhouse/yodeler/${database}/${table}`;
export const DEFAULT_HISTORY_REPLICA_NAME = "{shard}-{replica}";

/** A topology from its string form. */
export function parseHistoryTopology(value: string): HistoryTopology {
  const at = value.indexOf(":");
  const kind = (at < 0 ? value : value.slice(0, at)).trim();
  const arg = at < 0 ? undefined : value.slice(at + 1).trim();
  switch (kind) {
    case "single":
    case "cloud":
      if (arg !== undefined) throw new YodelError(`topology ${kind} takes no argument: ${JSON.stringify(value)}`);
      return { kind };
    case "cluster":
      if (!arg) throw new YodelError(`topology cluster needs the cluster's name: cluster:<name>, got ${JSON.stringify(value)}`);
      return { kind, cluster: arg };
    case "replicated":
      return arg ? { kind, cluster: arg } : { kind };
    default:
      throw new YodelError(`unknown topology ${JSON.stringify(value)}: expected single, cluster:<name>, replicated or cloud`);
  }
}

/** The string form of a topology, for messages. */
export function describeTopology(t: HistoryTopology): string {
  switch (t.kind) {
    case "cluster":
      return `cluster:${t.cluster}`;
    case "replicated":
      return t.cluster ? `replicated:${t.cluster}` : "replicated";
    default:
      return t.kind;
  }
}

/** Whether the history's tables replicate through Keeper, so a read on one host must first catch up with the others. */
export const replicates = (t: HistoryTopology): boolean => t.kind === "cluster" || t.kind === "replicated";
