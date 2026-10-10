/**
 * Finding, loading and checking `yodel.config.ts`. The file is optional; a
 * project without one gets `undefined` and every setting's default.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseTopology } from "@intentius/chant-lexicon-sql/clickhouse/topology";
import { YodelError } from "../project.js";
import { CI_FORGES, WAVE_GATES, type EnvironmentConfig, type YodelConfig } from "./define.js";
import { notifyConfigProblem } from "../notify/index.js";
import { checkSources } from "../sources/index.js";

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
    if (!["topology", "history", "lockTtl", "lockWait"].includes(k)) throw new YodelError(`${where}.${k}: unknown setting (expected topology, history, lockTtl, lockWait)`);
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
  if (value.lockWait !== undefined && !(typeof value.lockWait === "number" && Number.isFinite(value.lockWait) && value.lockWait >= 0)) {
    throw new YodelError(`${where}.lockWait: expected a number of seconds, 0 or more`);
  }
  return value;
}

const RULE_ID = /^[a-z0-9][a-z0-9_-]*$/;

function checkPolicy(value: unknown, where: string, profiles?: readonly string[]): void {
  if (!isRecord(value)) throw new YodelError(`${where}: expected { rules: [...], overriders?: [...] }`);
  for (const k of Object.keys(value)) if (k !== "rules" && k !== "overriders") throw new YodelError(`${where}.${k}: unknown setting (expected rules, overriders)`);
  if (value.overriders !== undefined && !(Array.isArray(value.overriders) && value.overriders.every((o) => typeof o === "string" && o !== ""))) {
    throw new YodelError(`${where}.overriders: expected a list of names`);
  }
  if (!Array.isArray(value.rules)) throw new YodelError(`${where}.rules: expected a list of rules`);
  const seen = new Set<string>();
  for (const [i, rule] of value.rules.entries()) {
    const at = `${where}.rules[${String(i)}]`;
    if (!isRecord(rule)) throw new YodelError(`${at}: expected an object`);
    for (const k of Object.keys(rule)) {
      if (!["id", "description", "environments", "refuse", "silences", "check"].includes(k)) throw new YodelError(`${at}.${k}: unknown setting (expected id, description, environments, refuse, silences, check)`);
    }
    if (typeof rule.id !== "string" || !RULE_ID.test(rule.id)) throw new YodelError(`${at}.id: lowercase letters, digits, - and _, got ${JSON.stringify(rule.id)}`);
    if (seen.has(rule.id)) throw new YodelError(`${at}.id: two rules are named ${rule.id}`);
    seen.add(rule.id);
    if (rule.environments !== undefined) {
      if (!Array.isArray(rule.environments) || !rule.environments.every((e) => typeof e === "string")) throw new YodelError(`${at}.environments: expected a list of environment names`);
      const unknown = profiles ? rule.environments.filter((e) => !profiles.includes(e)) : [];
      if (unknown.length > 0) throw new YodelError(`${at}.environments: ${unknown.join(", ")} ${unknown.length === 1 ? "is not an environment" : "are not environments"} chant.config.ts declares`);
    }
    if (rule.refuse === undefined && rule.silences === undefined && rule.check === undefined) throw new YodelError(`${at}: a rule needs refuse, silences or check`);
    if (rule.refuse !== undefined) {
      const r = rule.refuse;
      if (!isRecord(r) || Object.keys(r).some((k) => k !== "classes" && k !== "destructive")) throw new YodelError(`${at}.refuse: expected { classes?: [...], destructive?: true }`);
      if (r.classes !== undefined && !(Array.isArray(r.classes) && r.classes.every((c) => typeof c === "string"))) throw new YodelError(`${at}.refuse.classes: expected a list of classes`);
      if (r.destructive !== undefined && typeof r.destructive !== "boolean") throw new YodelError(`${at}.refuse.destructive: expected true or false`);
    }
    if (rule.silences !== undefined) {
      const s = rule.silences;
      if (!isRecord(s) || !(s.reason instanceof RegExp) || Object.keys(s).some((k) => k !== "rules" && k !== "reason")) throw new YodelError(`${at}.silences: expected { reason: /pattern/, rules?: [...] }`);
      if (s.rules !== undefined && !(Array.isArray(s.rules) && s.rules.every((x) => typeof x === "string"))) throw new YodelError(`${at}.silences.rules: expected a list of lint rules`);
    }
    if (rule.check !== undefined && typeof rule.check !== "function") throw new YodelError(`${at}.check: expected a function of the plan`);
  }
}

const notDeclared = (profiles: readonly string[]) => (profiles.length > 0 ? ` (sql.profiles: ${profiles.join(", ")})` : " (it declares no sql.profiles)");

function checkWaves(value: unknown, where: string, profiles?: readonly string[]): void {
  if (!Array.isArray(value)) throw new YodelError(`${where}: expected a list of { env, gate }, in the order they apply`);
  const seen = new Set<string>();
  value.forEach((wave: unknown, i) => {
    const at = `${where}[${String(i)}]`;
    if (!isRecord(wave)) throw new YodelError(`${at}: expected { env, gate }`);
    for (const k of Object.keys(wave)) if (!["env", "gate", "requires"].includes(k)) throw new YodelError(`${at}.${k}: unknown setting (expected env, gate, requires)`);
    const env = wave.env;
    if (typeof env !== "string" || env === "") throw new YodelError(`${at}.env: expected an environment's name`);
    if (profiles && !profiles.includes(env)) throw new YodelError(`${at}.env: ${env} is not an environment chant.config.ts declares${notDeclared(profiles)}`);
    if (seen.has(env)) throw new YodelError(`${at}.env: ${env} has a wave already; an environment is one wave`);
    seen.add(env);
    if (wave.gate !== undefined && !WAVE_GATES.includes(wave.gate as never)) {
      throw new YodelError(`${at}.gate: ${JSON.stringify(wave.gate)} is not a gate policy (expected ${WAVE_GATES.join(", ")})`);
    }
    const req = wave.requires;
    if (req !== undefined && req !== false) {
      if (typeof req !== "string" || req === "") throw new YodelError(`${at}.requires: expected an environment's name, or false`);
      if (req === env) throw new YodelError(`${at}.requires: ${env} cannot require itself`);
      if (profiles && !profiles.includes(req)) throw new YodelError(`${at}.requires: ${req} is not an environment chant.config.ts declares${notDeclared(profiles)}`);
    }
  });
}

function checkCi(value: unknown, where: string): void {
  if (!isRecord(value)) throw new YodelError(`${where}: expected { forges?, jobs? }`);
  for (const k of Object.keys(value)) if (k !== "forges" && k !== "jobs") throw new YodelError(`${where}.${k}: unknown setting (expected forges, jobs)`);
  const forges = value.forges;
  if (forges !== undefined && !(Array.isArray(forges) && forges.length > 0 && forges.every((f) => (CI_FORGES as readonly unknown[]).includes(f)))) {
    throw new YodelError(`${where}.forges: a list of ${CI_FORGES.join(", ")}`);
  }
  if (value.jobs !== undefined && (typeof value.jobs !== "string" || value.jobs === "")) throw new YodelError(`${where}.jobs: the path of the module that declares the project's own jobs, such as "ci/jobs.ts"`);
}

/**
 * Checks a loaded config's shape. `environments` names each environment by
 * its `sql.profiles` name; one that chant.config.ts does not declare is an
 * error, so a typo does not silently leave an environment on the defaults.
 */
export function checkYodelConfig(value: unknown, path: string, profiles?: readonly string[]): YodelConfig {
  if (!isRecord(value)) throw new YodelError(`${path}: the default export must be a config object (export default defineConfig({ ... }))`);
  for (const k of Object.keys(value)) {
    if (!["environments", "lint", "policy", "notify", "sources", "waves", "ci"].includes(k)) throw new YodelError(`${path}: unknown setting ${k} (expected environments, lint, policy, notify, sources, waves, ci)`);
  }
  if (value.ci !== undefined) checkCi(value.ci, `${path}: ci`);
  if (value.sources !== undefined) checkSources(value.sources, `${path}: sources`);
  if (value.notify !== undefined) {
    const problem = notifyConfigProblem(value.notify);
    if (problem) throw new YodelError(`${path}: ${problem}`);
  }
  if (value.policy !== undefined) checkPolicy(value.policy, `${path}: policy`, profiles);
  if (value.waves !== undefined) checkWaves(value.waves, `${path}: waves`, profiles);
  if (value.lint !== undefined && !isRecord(value.lint)) throw new YodelError(`${path}: lint: expected an object`);
  if (value.environments !== undefined) {
    if (!isRecord(value.environments)) throw new YodelError(`${path}: environments: expected an object keyed by environment`);
    for (const [name, env] of Object.entries(value.environments)) {
      checkEnvironment(env, `${path}: environments.${name}`);
      if (profiles && !profiles.includes(name)) {
        throw new YodelError(
          `${path}: environments.${name} is not an environment chant.config.ts declares${notDeclared(profiles)}`,
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
