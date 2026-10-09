/**
 * Finding, loading and checking `yodel.config.ts`. The file is optional; a
 * project without one gets `undefined` and every setting's default.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseTopology } from "@intentius/chant-lexicon-sql/clickhouse/topology";
import { YodelError } from "../project.js";
import type { EnvironmentConfig, YodelConfig } from "./define.js";

export const CONFIG_FILE = "yodel.config.ts";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const TOPOLOGY_KINDS = ["single", "cluster", "replicated", "cloud"];

function checkTopology(value: unknown, where: string): void {
  if (typeof value === "string") {
    try {
      parseTopology(value);
    } catch (e) {
      throw new YodelError(`${where}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }
  if (!isRecord(value) || typeof value.kind !== "string" || !TOPOLOGY_KINDS.includes(value.kind)) {
    throw new YodelError(`${where}: expected single, cluster:<name>, replicated, replicated:<cluster>, cloud, or { kind: ... }`);
  }
  const allowed: Record<string, string[]> = { single: [], cloud: [], replicated: ["cluster"], cluster: ["cluster", "replicaPath", "replicaName"] };
  for (const [k, v] of Object.entries(value)) {
    if (k === "kind") continue;
    if (!(allowed[value.kind] ?? []).includes(k)) throw new YodelError(`${where}.${k}: a ${value.kind} topology takes no ${k}`);
    if (typeof v !== "string" || v === "") throw new YodelError(`${where}.${k}: expected a non-empty string`);
  }
  if (value.kind === "cluster" && typeof value.cluster !== "string") throw new YodelError(`${where}.cluster: a cluster topology needs the cluster's name`);
}

function checkEnvironment(value: unknown, where: string): EnvironmentConfig {
  if (!isRecord(value)) throw new YodelError(`${where}: expected an object`);
  for (const k of Object.keys(value)) {
    if (!["topology", "history", "lockTtl"].includes(k)) throw new YodelError(`${where}.${k}: unknown setting (expected topology, history, lockTtl)`);
  }
  if (value.topology !== undefined) checkTopology(value.topology, `${where}.topology`);
  if (value.history !== undefined) {
    if (!isRecord(value.history)) throw new YodelError(`${where}.history: expected an object`);
    for (const k of Object.keys(value.history)) if (k !== "database") throw new YodelError(`${where}.history.${k}: unknown setting (expected database)`);
    const db = value.history.database;
    if (db !== undefined && (typeof db !== "string" || db === "")) throw new YodelError(`${where}.history.database: expected a database name`);
  }
  if (value.lockTtl !== undefined && !(typeof value.lockTtl === "number" && Number.isFinite(value.lockTtl) && value.lockTtl > 0)) {
    throw new YodelError(`${where}.lockTtl: expected a number of seconds greater than 0`);
  }
  return value;
}

/**
 * Checks a loaded config's shape. `environments` names each environment by
 * its `sql.profiles` name; one that chant.config.ts does not declare is an
 * error, so a typo does not silently leave an environment on the defaults.
 */
export function checkYodelConfig(value: unknown, path: string, profiles?: readonly string[]): YodelConfig {
  if (!isRecord(value)) throw new YodelError(`${path}: the default export must be a config object (export default defineConfig({ ... }))`);
  for (const k of Object.keys(value)) {
    if (k !== "environments" && k !== "lint") throw new YodelError(`${path}: unknown setting ${k} (expected environments, lint)`);
  }
  if (value.lint !== undefined && !isRecord(value.lint)) throw new YodelError(`${path}: lint: expected an object`);
  if (value.environments !== undefined) {
    if (!isRecord(value.environments)) throw new YodelError(`${path}: environments: expected an object keyed by environment`);
    for (const [name, env] of Object.entries(value.environments)) {
      checkEnvironment(env, `${path}: environments.${name}`);
      if (profiles && !profiles.includes(name)) {
        throw new YodelError(
          `${path}: environments.${name} is not an environment chant.config.ts declares` + (profiles.length > 0 ? ` (sql.profiles: ${profiles.join(", ")})` : " (it declares no sql.profiles)"),
        );
      }
    }
  }
  return value;
}

/** Loads `<dir>/yodel.config.ts`, or `undefined` when there is none. */
export async function loadYodelConfig(dir: string, profiles?: readonly string[]): Promise<{ path: string; config: YodelConfig } | undefined> {
  const path = join(dir, CONFIG_FILE);
  if (!existsSync(path)) return undefined;
  let mod: { default?: unknown };
  try {
    mod = (await import(pathToFileURL(path).href)) as { default?: unknown };
  } catch (e) {
    throw new YodelError(`${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { path, config: checkYodelConfig(mod.default, path, profiles) };
}
