/**
 * Finding, loading and checking `yodel.config.ts`. The file is optional; a
 * project without one gets `undefined` and every setting's default.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseTopology } from "@intentius/chant-lexicon-sql/clickhouse/topology";
import { YodelError } from "../project.js";
import { APPROVAL_MODES, CI_FORGES, ENVIRONMENT_APPROVAL_MODES, WAVE_GATES, type EnvironmentConfig, type YodelConfig } from "./define.js";
import { notifyConfigProblem } from "../notify/index.js";
import { checkSources } from "../sources/index.js";
import { TENANT_NAME } from "../tenants/target.js";
import { checksProblem } from "../migrations/checks.js";

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
    if (!["topology", "history", "lockTtl", "lockWait", "tenants", "steps", "access", "approval"].includes(k)) throw new YodelError(`${where}.${k}: unknown setting (expected topology, history, lockTtl, lockWait, tenants, steps, access, approval)`);
  }
  if (value.approval !== undefined && !ENVIRONMENT_APPROVAL_MODES.includes(value.approval as never)) {
    throw new YodelError(
      value.approval === "pr-review"
        ? `${where}.approval: pr-review is a wave's (waves[].approval): the pull request's pipeline records the plans a review approves for the apply pipeline's waves, not for the migrations Op; expected ${ENVIRONMENT_APPROVAL_MODES.join(" or ")}`
        : `${where}.approval: ${JSON.stringify(value.approval)} is not an approval mode (expected ${ENVIRONMENT_APPROVAL_MODES.join(" or ")})`,
    );
  }
  if (value.tenants !== undefined) checkTenants(value.tenants, `${where}.tenants`);
  if (value.steps !== undefined) checkApplySteps(value.steps, `${where}.steps`);
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
  if (value.access !== undefined && typeof value.access !== "boolean") throw new YodelError(`${where}.access: expected true or false`);
  return value;
}


function checkTenants(value: unknown, where: string): void {
  if (Array.isArray(value)) {
    const bad = value.filter((t) => typeof t !== "string" || !TENANT_NAME.test(t));
    if (bad.length > 0) throw new YodelError(`${where}: ${bad.map((b) => JSON.stringify(b)).join(", ")} ${bad.length === 1 ? "is not a tenant name" : "are not tenant names"} (letters, digits and _, not starting with a digit)`);
    if (new Set(value).size !== value.length) throw new YodelError(`${where}: a tenant is listed twice`);
    return;
  }
  const keys = isRecord(value) ? Object.keys(value) : [];
  if (!isRecord(value) || keys.length !== 1 || !["file", "query"].includes(keys[0] ?? "") || typeof value[keys[0] ?? ""] !== "string" || value[keys[0] ?? ""] === "") {
    throw new YodelError(`${where}: expected a list of tenant names, { file: "<path>" } or { query: "<SQL>" }`);
  }
}

const STEP_NAME = /^[a-z0-9][a-z0-9_-]*$/;

function checkApplySteps(value: unknown, where: string): void {
  if (!isRecord(value)) throw new YodelError(`${where}: expected { before?: [...], after?: [...] }`);
  for (const k of Object.keys(value)) if (k !== "before" && k !== "after") throw new YodelError(`${where}.${k}: unknown setting (expected before, after)`);
  const seen = new Set<string>();
  for (const when of ["before", "after"] as const) {
    const list = value[when];
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw new YodelError(`${where}.${when}: expected a list of steps`);
    list.forEach((step: unknown, i) => {
      const at = `${where}.${when}[${String(i)}]`;
      if (!isRecord(step)) throw new YodelError(`${at}: expected { name, sql } or { name, command }`);
      for (const k of Object.keys(step)) if (!["name", "sql", "expect", "command", "onFailure"].includes(k)) throw new YodelError(`${at}.${k}: unknown setting (expected name, sql, expect, command, onFailure)`);
      if (typeof step.name !== "string" || !STEP_NAME.test(step.name)) throw new YodelError(`${at}.name: lowercase letters, digits, - and _, got ${JSON.stringify(step.name)}`);
      if (seen.has(step.name)) throw new YodelError(`${at}.name: two steps are named ${step.name}`);
      seen.add(step.name);
      const sql = typeof step.sql === "string" && step.sql.trim() !== "";
      const command = typeof step.command === "string" && step.command.trim() !== "";
      if (sql === command) throw new YodelError(`${at} (${step.name}): give sql or command, one of them`);
      if (step.expect !== undefined) {
        if (!sql) throw new YodelError(`${at}.expect: only a sql step has an expect`);
        const problem = checksProblem([{ name: step.name, sql: step.sql, expect: step.expect }]);
        if (problem) throw new YodelError(`${at}.expect: ${problem.replace(/^checks\[0\] \([^)]*\): /, "")}`);
      }
      if (step.onFailure !== undefined && step.onFailure !== "fail" && step.onFailure !== "approve") throw new YodelError(`${at}.onFailure: "fail" or "approve", got ${JSON.stringify(step.onFailure)}`);
      if (step.onFailure === "approve" && when === "after") throw new YodelError(`${at}.onFailure: an after step runs once the migrations are applied, so there is nothing left to hold for approval; use "fail"`);
    });
  }
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
    for (const k of Object.keys(wave)) if (!["env", "gate", "requires", "shares", "approval"].includes(k)) throw new YodelError(`${at}.${k}: unknown setting (expected env, gate, requires, shares, approval)`);
    if (wave.approval !== undefined && !APPROVAL_MODES.includes(wave.approval as never)) {
      throw new YodelError(`${at}.approval: ${JSON.stringify(wave.approval)} is not an approval mode (expected ${APPROVAL_MODES.join(", ")})`);
    }
    if (wave.shares !== undefined && !(typeof wave.shares === "number" && Number.isInteger(wave.shares) && wave.shares >= 1)) throw new YodelError(`${at}.shares: expected a whole number from 1`);
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

/** An image reference pinned by digest. */
const CI_IMAGE = /^[^\s@]+@sha256:[0-9a-f]{64}$/;

function checkCi(value: unknown, where: string): void {
  if (!isRecord(value)) throw new YodelError(`${where}: expected { forges?, jobs?, image?, resume? }`);
  for (const k of Object.keys(value)) if (!["forges", "jobs", "image", "resume"].includes(k)) throw new YodelError(`${where}.${k}: unknown setting (expected forges, jobs, image, resume)`);
  const resume = value.resume;
  if (resume !== undefined && !(isRecord(resume) && Object.keys(resume).every((k) => k === "schedule") && typeof resume.schedule === "string" && resume.schedule.trim().split(/\s+/).length === 5)) {
    throw new YodelError(`${where}.resume: { schedule } with a five-field cron, such as { schedule: "*/10 * * * *" }`);
  }
  if (value.image !== undefined && (typeof value.image !== "string" || !CI_IMAGE.test(value.image))) {
    throw new YodelError(`${where}.image: the CI image pinned by its digest, ghcr.io/intentius/sql-yodeler:<version>@sha256:<digest> (the release's image job writes the digest to its summary)`);
  }
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
    // The file's hash in the URL: a process that loads it again after an edit (the MCP server, a claim) reads the edit, not the first import.
    const version = createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);
    mod = (await import(`${pathToFileURL(path).href}?yodel=${version}`)) as { default?: unknown };
  } catch (e) {
    throw new YodelError(`${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { path, config: checkYodelConfig(mod.default, path, profiles) };
}
