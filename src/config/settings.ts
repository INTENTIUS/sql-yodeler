/**
 * One environment's settings, from `yodel.config.ts`, chant's profile and
 * the process environment, first one set wins:
 *
 * | setting          | 1. yodel.config.ts                     | 2. chant.config.ts                | 3. env var              | default  |
 * |------------------|----------------------------------------|-----------------------------------|-------------------------|----------|
 * | topology         | `environments.<env>.topology`          | `sql.profiles.<env>.topology`     | `YODEL_TOPOLOGY`        | `single` |
 * | history database | `environments.<env>.history.database`  |                                   | `YODEL_HISTORY_DATABASE`| `yodeler`|
 * | lock TTL         | `environments.<env>.lockTtl` (seconds) |                                   | `YODEL_LOCK_TTL`        | 900      |
 * | lock wait        | `environments.<env>.lockWait` (seconds)|                                   | `YODEL_LOCK_WAIT`       | 0        |
 * | access (Postgres)| `environments.<env>.access`            | `sql.profiles.<env>.access`       |                         | off      |
 *
 * `yodel apply --lock-wait <duration>` sets the lock wait over all three.
 *
 * A tenant (`<env>/<tenant>`, #56) has its environment's settings, its
 * history database suffixed with `_<tenant>`.
 */

import { toTopology, topologyLabel, type Topology } from "@intentius/chant-lexicon-sql/clickhouse/topology";
import { DEFAULT_HISTORY_DATABASE } from "../history/ddl.js";
import { DEFAULT_LOCK_TTL_MS } from "../history/lock.js";
import type { HistoryTopology } from "../history/topology.js";
import { YodelError, type Project } from "../project.js";
import { CONFIG_FILE } from "./load.js";
import { splitTarget } from "../tenants/target.js";

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
  /** How long an apply waits for a lock another apply holds; 0 gives up at once (exit 5). */
  lockWaitMs: number;
}

/** The variable that sets the lock wait (a duration, as {@link parseDuration} reads it). */
export const LOCK_WAIT_ENV = "YODEL_LOCK_WAIT";

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/**
 * A duration in milliseconds: `90` (seconds), `500ms`, `30s`, `10m`, `1h`,
 * or a sum of them (`1m30s`). `what` names it in the error.
 */
export function parseDuration(text: string, what: string): number {
  const t = text.trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t) * 1000);
  const parts = [...t.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)];
  if (t === "" || parts.map((m) => m[0]).join("") !== t) {
    throw new YodelError(`${what} must be a duration such as 90 (seconds), 30s, 10m or 1h, got ${JSON.stringify(text)}`);
  }
  return Math.round(parts.reduce((sum, m) => sum + Number(m[1]) * (UNITS[m[2] ?? "s"] ?? 1000), 0));
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
export function environmentSettings(project: Pick<Project, "config" | "yodel">, target: string, env: NodeJS.ProcessEnv = process.env): EnvironmentSettings {
  // A tenant, <env>/<tenant>, has its environment's settings, and a history of its own (#56).
  const { env: name, tenant } = splitTarget(target);
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

  let lockWaitMs = 0;
  if (own?.lockWait !== undefined) lockWaitMs = own.lockWait * 1000;
  else if (env[LOCK_WAIT_ENV]) lockWaitMs = parseDuration(env[LOCK_WAIT_ENV], LOCK_WAIT_ENV);

  return {
    topology,
    topologySource,
    historyTopology: historyTopologyOf(topology),
    historyDatabase: `${own?.history?.database ?? (env.YODEL_HISTORY_DATABASE || DEFAULT_HISTORY_DATABASE)}${tenant !== undefined ? `_${tenant}` : ""}`,
    lockTtlMs,
    lockWaitMs,
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

/** Whether yodel manages access control in environment `name`, and where that came from (`yodel.config.ts`, `sql.profiles.<env>.access` or `default`). */
export function environmentAccess(own: { access?: boolean } | undefined, profile: { access?: unknown } | undefined, name: string): { access: boolean; source: string } {
  if (own?.access !== undefined) return { access: own.access, source: CONFIG_FILE };
  if (typeof profile?.access === "boolean") return { access: profile.access, source: `sql.profiles.${name}.access` };
  return { access: false, source: "default" };
}

/**
 * The declarative apply (the project's ApplyOp, run by `chant run`) and
 * `chant lifecycle diff` read chant.config.ts themselves, so an `access`
 * set in yodel.config.ts that chant.config.ts does not say would be
 * ignored there. It is refused unless the profile says the same; yodel's own
 * plan, `yodel new`, lint and `yodel init --from` use yodel.config.ts's.
 */
export function declarativeAccessRefusal(project: Pick<Project, "configPath" | "yodel" | "profileAccess">, name: string): YodelError | undefined {
  const own = project.yodel?.config.environments?.[name]?.access;
  if (own === undefined) return undefined;
  const chants = project.profileAccess?.[name] === true;
  if (own === chants) return undefined;
  return new YodelError(
    `${CONFIG_FILE} sets environments.${name}.access to ${String(own)}, but the declarative path applies through chant, which reads sql.profiles.${name}.access in ${project.configPath} ` +
      `(${project.profileAccess?.[name] === undefined ? "unset, so off" : String(chants)}). Set sql.profiles.${name}.access to ${String(own)} as well, or leave access to chant.config.ts.`,
  );
}

const sorted = (t: Topology): [string, unknown][] => Object.entries(t).sort(([a], [b]) => a.localeCompare(b));
