/**
 * One environment's settings, from `yodel.config.ts`, chant's profile and
 * the process environment, first one set wins:
 *
 * | setting          | 1. yodel.config.ts                     | 2. chant.config.ts                | 3. env var              | default  |
 * |------------------|----------------------------------------|-----------------------------------|-------------------------|----------|
 * | topology         | `environments.<env>.topology`          | `sql.profiles.<env>.topology`     | `YODEL_TOPOLOGY`        | `single` |
 * | history database | `environments.<env>.history.database`  |                                   | `YODEL_HISTORY_DATABASE`| `yodeler`|
 * | lock TTL         | `environments.<env>.lockTtl` (seconds) |                                   | `YODEL_LOCK_TTL`        | 900      |
 */

import { toTopology, topologyLabel, type Topology } from "@intentius/chant-lexicon-sql/clickhouse/topology";
import { DEFAULT_HISTORY_DATABASE } from "../history/ddl.js";
import { DEFAULT_LOCK_TTL_MS } from "../history/lock.js";
import type { HistoryTopology } from "../history/topology.js";
import { YodelError, type Project } from "../project.js";
import { CONFIG_FILE } from "./load.js";

export interface EnvironmentSettings {
  /** What every statement is rendered for when it is sent. */
  topology: Topology;
  /** Where {@link topology} came from, for messages: `yodel.config.ts`, `sql.profiles.<env>.topology`, `YODEL_TOPOLOGY` or `default`. */
  topologySource: string;
  /**
   * The history's topology: {@link topology} without a cluster's Keeper
   * path and replica name, which are for the migrations' tables. The
   * history keeps its own path, one copy for the whole cluster.
   */
  historyTopology: HistoryTopology;
  historyDatabase: string;
  lockTtlMs: number;
}

function parse(value: string | Topology, where: string): Topology {
  try {
    return toTopology(value);
  } catch (e) {
    throw new YodelError(`${where}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The topology the history's DDL is written for. */
export function historyTopologyOf(t: Topology): HistoryTopology {
  return t.kind === "cluster" ? { kind: "cluster", cluster: t.cluster } : t;
}

/** The settings of environment `name`; see the module comment for the order. */
export function environmentSettings(project: Pick<Project, "config" | "yodel">, name: string, env: NodeJS.ProcessEnv = process.env): EnvironmentSettings {
  const own = project.yodel?.config.environments?.[name];
  const profile = project.config.sql?.profiles?.[name] as { topology?: string | Topology } | undefined;

  let topology: Topology;
  let topologySource: string;
  if (own?.topology !== undefined) {
    topology = parse(own.topology, `${CONFIG_FILE}: environments.${name}.topology`);
    topologySource = CONFIG_FILE;
  } else if (profile?.topology !== undefined) {
    topology = parse(profile.topology, `sql.profiles.${name}.topology`);
    topologySource = `sql.profiles.${name}.topology`;
  } else if (env.YODEL_TOPOLOGY) {
    topology = parse(env.YODEL_TOPOLOGY, "YODEL_TOPOLOGY");
    topologySource = "YODEL_TOPOLOGY";
  } else {
    topology = { kind: "single" };
    topologySource = "default";
  }

  let lockTtlMs = DEFAULT_LOCK_TTL_MS;
  if (own?.lockTtl !== undefined) lockTtlMs = own.lockTtl * 1000;
  else if (env.YODEL_LOCK_TTL) {
    const ttl = Number(env.YODEL_LOCK_TTL);
    if (!(Number.isFinite(ttl) && ttl > 0)) throw new YodelError(`YODEL_LOCK_TTL must be a number of seconds, got ${JSON.stringify(env.YODEL_LOCK_TTL)}`);
    lockTtlMs = ttl * 1000;
  }

  return {
    topology,
    topologySource,
    historyTopology: historyTopologyOf(topology),
    historyDatabase: own?.history?.database ?? (env.YODEL_HISTORY_DATABASE || DEFAULT_HISTORY_DATABASE),
    lockTtlMs,
  };
}

/** `cluster:main (yodel.config.ts)`, for a report's header. */
export const describeSettingsTopology = (s: Pick<EnvironmentSettings, "topology" | "topologySource">): string => `${topologyLabel(s.topology)} (${s.topologySource})`;

/**
 * The declarative path (`yodel plan`, `yodel apply` without migrations) runs
 * chant's planner and applier, which render for `sql.profiles.<env>.topology`
 * and do not read `yodel.config.ts`. A topology set only in yodel.config.ts
 * would be ignored there, so it is refused unless chant's profile says the same
 * (an unset profile topology is a single node, as chant renders it).
 */
export function declarativeTopologyRefusal(project: Pick<Project, "config" | "yodel">, name: string): YodelError | undefined {
  const own = project.yodel?.config.environments?.[name]?.topology;
  if (own === undefined) return undefined;
  const profile = (project.config.sql?.profiles?.[name] as { topology?: string | Topology } | undefined)?.topology;
  const ours = parse(own, `${CONFIG_FILE}: environments.${name}.topology`);
  // An unset profile topology is a single node to chant, so "single" in yodel.config.ts agrees with it (#25).
  const chants = parse(profile ?? "single", `sql.profiles.${name}.topology`);
  if (JSON.stringify(sorted(chants)) === JSON.stringify(sorted(ours))) return undefined;
  return new YodelError(
    `${CONFIG_FILE} sets environments.${name}.topology to ${topologyLabel(ours)}, but the declarative path plans and applies through chant, which reads sql.profiles.${name}.topology ` +
      `(${profile === undefined ? "unset, so a single node" : topologyLabel(chants)}). Set sql.profiles.${name}.topology to the same in chant.config.ts, or leave the topology to chant.config.ts.`,
  );
}

const sorted = (t: Topology): [string, unknown][] => Object.entries(t).sort(([a], [b]) => a.localeCompare(b));
