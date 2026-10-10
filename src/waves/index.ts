/**
 * Environment waves (#42): the apply pipeline as chant's Op waves, one wave
 * per environment, each behind a gate policy of its own.
 *
 * The project's CI script renders `yodel.config.ts` `waves` as a chant Op
 * waves spec, {@link WAVES_SPEC_FILE}, and the pipeline from it (`chant run
 * --generate <forge> --spec`, or `generateOpWavesPipeline`). Every wave's
 * job runs `chant run wave`, which calls back into yodel twice per
 * environment:
 *
 * - `yodel apply <env> --wave-plan <file>` ({@link writeWavePlan}): the
 *   plan file chant binds the wave's gate to. Its `planDigest` covers the
 *   migrations' plan digest (what `--digest` prints), the environment's gate
 *   policy as the base commit's `yodel.config.ts` has it, and whether a
 *   pending step is destructive, which is what `on-destructive` waits on.
 * - `yodel apply <env> --wave-apply <file>` ({@link applyWave}): applies
 *   that plan, under the lock, only when chant's decision for the wave lets
 *   it through: an approval of the wave's set digest in the gate ledger, or
 *   a policy at the base commit that needs none. The plan is computed again
 *   under the lock and must be the one the decision was made on.
 *
 * chant reads the policy from the spec file at the first parent, so a pull
 * request that loosens its own environment's gate merges under the old one.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { MigrationStep } from "@intentius/chant-lexicon-sql/migration-statements";
import { baseRef, loadYodelConfigAtBase, type ConfigAtBase } from "../config/base.js";
import type { WaveGate, YodelConfig } from "../config/define.js";
import { createdObjects, stepFindings } from "../lint/statements.js";
import type { Migration } from "../migrations/index.js";
import { YodelError, type Project } from "../project.js";
import { describeStep } from "../steps/kinds.js";
import { EXIT_REFUSED } from "../exit.js";
import { currentDigest, inspect, selectToApply, type VersionedEnv } from "../versioned/engine.js";
import { gitLedger, NOT_APPROVED, verifyApproval } from "../versioned/approval.js";
import type { PendingMigration } from "../versioned/state.js";
import { WAVES_PIPELINE, type WaveRecord } from "./record.js";
import { enforcePromotion, promotionEvidence, readPromotions, type Promotion } from "./promotion.js";
import { baseEnvironment, splitTarget } from "../tenants/target.js";
import { heldSteps, runApplySteps, stepsAtBase, stepsRefusal, type StepOutcome } from "../apply-steps/index.js";

export * from "./promotion.js";
export * from "./record.js";

/** The waves spec the CI script writes and every wave job reads. */
export const WAVES_SPEC_FILE = "yodel-waves.json";
export const WAVE_PLAN_KIND = "yodel-wave";

/** The gate policy an environment no wave names gets. */
export const DEFAULT_WAVE_GATE: WaveGate = "always";

/** `env`'s wave gate in `config`; a tenant's is its environment's. */
export function waveGate(config: YodelConfig | undefined, env: string): { gate: WaveGate; declared: boolean } {
  const wave = config?.waves?.find((w) => w.env === baseEnvironment(env));
  return wave ? { gate: wave.gate ?? DEFAULT_WAVE_GATE, declared: true } : { gate: DEFAULT_WAVE_GATE, declared: false };
}

/** A pending step `on-destructive` waits on, and why. */
export interface DestructiveStep {
  migration: string;
  step: number;
  what: string;
  /** The lint rule that classes it, or `op-step` / `manual-step`. */
  why: string;
}

const GATED_RULES = new Set(["destructive", "pg-rewrite", "pg-lock", "pg-access", "ch-mutation", "ch-rebuild", "ch-access"]);

/**
 * The steps of `pending` that `on-destructive` waits on: a destructive
 * statement or Op step, a Postgres rewrite or lock-heavy statement, one
 * that takes access away (a revoke, a policy dropped, row-level security
 * turned off; on ClickHouse a revoke), a
 * ClickHouse mutation or rebuild (lint's statement rules, whatever their
 * level or silences), and any Op or manual step.
 */
export function destructiveSteps(dialect: "clickhouse" | "postgres", pending: ReadonlyArray<Pick<PendingMigration, "id"> & { migration: Pick<Migration, "document"> }>): DestructiveStep[] {
  const out: DestructiveStep[] = [];
  for (const p of pending) {
    const created = dialect === "postgres" ? createdObjects(p.migration.document.steps) : undefined;
    p.migration.document.steps.forEach((step: MigrationStep, i: number) => {
      const rules = stepFindings(dialect, step, created ? { created } : {}).map((f) => f.rule).filter((r) => GATED_RULES.has(r));
      const why = rules[0] ?? (step.kind === "op" ? "op-step" : step.kind === "manual" ? "manual-step" : undefined);
      if (why) out.push({ migration: p.id, step: i, what: describeStep(step), why: [...new Set([why, ...rules])].join(", ") });
    });
  }
  return out;
}

/** What `--wave-plan` writes: chant's plan file, and what yodel needs to apply exactly it. */
export interface WavePlanFile {
  /** chant's: what the wave's set digest is taken over. */
  planDigest: string;
  destructive: boolean;
  empty: boolean;
  environment: string;
  /** The migrations' plan digest, as `yodel apply --digest` prints it; the history records it. */
  migrations: string;
  /** The gate policy at the base commit, and that commit. */
  gate: WaveGate;
  base: string;
  pending: string[];
  destructiveSteps: DestructiveStep[];
  /** Each environment this one requires, and the pending migrations its history records applied. */
  requires: Array<{ env: string; applied: Array<{ id: string; checksum: string }> }>;
  /** The `before` steps' outcomes (#64), when the environment has steps and something is pending. */
  steps?: StepOutcome[];
  /** The `before` steps that failed with `onFailure: "approve"`: the wave waits for a person whatever its gate, and the digest covers them. */
  held?: string[];
}

/** The wave plan's digest: over what the run would do and the policy it is gated under. */
export async function wavePlanDigest(subject: {
  environment: string;
  migrations: string;
  gate: WaveGate;
  destructive: boolean;
  requires?: ReadonlyArray<{ env: string; applied: ReadonlyArray<{ id: string; checksum: string }> }>;
  held?: readonly string[];
}): Promise<string> {
  const { computePlanDigest } = await import("@intentius/chant/lifecycle/plan-digest");
  return computePlanDigest(WAVE_PLAN_KIND, subject);
}

/** The gate policy for `env` at the base commit. */
export async function gateAtBase(project: Project, env: string): Promise<{ gate: WaveGate; at: ConfigAtBase; declared: boolean }> {
  const at = await loadYodelConfigAtBase(project.dir);
  return { ...waveGate(at.config, env), at };
}

/** The wave plan for one environment, now. A refusal (out of order, a checksum) throws, as `--digest` does. */
export async function planWave(project: Project, venv: VersionedEnv, ordered: readonly Migration[], options: { allowOutOfOrder: boolean }): Promise<WavePlanFile> {
  const { status } = await inspect(venv, ordered);
  const toApply = selectToApply(status, options.allowOutOfOrder);
  // Before the gate: a pending migration the required environment has not applied refuses here (exit 4).
  const requires = promotionEvidence(await enforcePromotion(project, venv.environment, ordered, toApply));
  const migrations = await currentDigest(venv, status, toApply);
  const { gate, at } = await gateAtBase(project, venv.environment);
  const steps = destructiveSteps(project.dialect === "postgres" ? "postgres" : "clickhouse", toApply);
  // The before steps (#64), as the base commit declares them: one that fails refuses; one that fails with onFailure approve holds the wave for a person.
  // A command is not run here (#107): it may have side effects, so it runs once, under the lock (yodel apply --wave-apply), and the plan shows that it will.
  const before = toApply.length > 0 ? ((await stepsAtBase(project, venv.environment)).steps?.before ?? []) : [];
  const outcomes = before.length > 0 ? await runApplySteps(venv.driver, before, "before", { dir: project.dir, env: venv.environment, commands: "plan" }) : [];
  const refusal = stepsRefusal(venv.environment, outcomes, "as the wave was planned");
  if (refusal) throw refusal;
  const held = heldSteps(outcomes);
  // A held step is what on-destructive waits on too; the gate never is held by --wave-apply (verifyWaveDecision).
  const destructive = steps.length > 0 || held.length > 0;
  return {
    planDigest: await wavePlanDigest({ environment: venv.environment, migrations, gate, destructive, requires, ...(held.length > 0 ? { held } : {}) }),
    destructive,
    empty: toApply.length === 0,
    environment: venv.environment,
    migrations,
    gate,
    base: at.sha,
    pending: toApply.map((p) => p.id),
    destructiveSteps: steps,
    requires,
    ...(outcomes.length > 0 ? { steps: outcomes } : {}),
    ...(held.length > 0 ? { held } : {}),
  };
}

/**
 * The wave plan digest `--wave-plan` would write for `venv` now, without
 * running the `before` steps: what `yodel plan` and `yodel approve` show of
 * a tenant set's wave (#56), where each tenant is a run. A plan with nothing
 * pending requires nothing, as {@link planWave} has it; a pending migration
 * the required environment has not applied makes it `blocked`, where
 * `planWave` would refuse.
 */
export async function viewWavePlan(project: Project, venv: VersionedEnv, ordered: readonly Migration[], options: { allowOutOfOrder?: boolean } = {}): Promise<{
  planDigest: string;
  destructive: boolean;
  empty: boolean;
  pending: string[];
  destructiveSteps: DestructiveStep[];
  promotions: Promotion[];
  blocked: boolean;
}> {
  const { status } = await inspect(venv, ordered, { sync: false });
  const toApply = selectToApply(status, options.allowOutOfOrder === true);
  const promotions = toApply.length > 0 ? await readPromotions(project, venv.environment, ordered, toApply) : [];
  const blocked = promotions.some((p) => p.migrations.some((m) => m.ran !== "applied"));
  const migrations = await currentDigest(venv, status, toApply);
  const { gate } = await gateAtBase(project, venv.environment);
  const steps = destructiveSteps(project.dialect === "postgres" ? "postgres" : "clickhouse", toApply);
  const destructive = steps.length > 0;
  return {
    planDigest: await wavePlanDigest({ environment: venv.environment, migrations, gate, destructive, requires: promotionEvidence(promotions) }),
    destructive,
    empty: toApply.length === 0,
    pending: toApply.map((p) => p.id),
    destructiveSteps: steps,
    promotions,
    blocked,
  };
}

/** `--wave-apply` found the wave plan moved since the wave was decided: nothing was applied. */
export class WavePlanMoved extends YodelError {
  constructor(message: string) {
    super(message, 1);
    this.name = "WavePlanMoved";
  }
}

/** `--wave-plan <file>`: writes the plan file. */
export async function writeWavePlan(project: Project, venv: VersionedEnv, ordered: readonly Migration[], file: string, options: { allowOutOfOrder: boolean }): Promise<WavePlanFile> {
  const plan = await planWave(project, venv, ordered, options);
  const path = resolve(file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(plan, null, 2)}\n`);
  return plan;
}

/** chant's spec, the parts read here. */
interface WavesSpec {
  name: string;
  waves: Array<{ name: string; runs: Array<{ target: string }> }>;
}

/** chant's decision record for a wave, the parts read here. */
interface WaveDecision {
  wave: number;
  op: string;
  gate: string;
  digest: string;
  status: "approved" | "not-required" | "waiting";
  members: Array<{ member: string; planDigest: string; destructive?: boolean; empty?: boolean }>;
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names the document's shape
function readJson<T>(path: string, what: string): T {
  if (!existsSync(path)) throw new YodelError(`refused: ${what} is not at ${path}. --wave-apply runs inside chant run wave, after it decided the wave; nothing was applied`, NOT_APPROVED);
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (e) {
    throw new YodelError(`${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The wave `env` is in, by the spec. */
function waveOf(spec: WavesSpec, env: string, specFile: string): { k: number; name: string } {
  const i = spec.waves.findIndex((w) => w.runs.some((r) => r.target === env));
  const wave = spec.waves[i];
  if (!wave) throw new YodelError(`refused: ${specFile} has no wave for ${env}; nothing was applied`, EXIT_REFUSED);
  return { k: i + 1, name: wave.name };
}

/**
 * Throws unless chant's decision for `env`'s wave lets `planDigest` apply:
 * the decision names this plan for `env`, and either the gate ledger holds
 * an approval of the wave's set digest, or the wave's policy at the base
 * commit needs no approval for these plans. A plan with `held` steps (#64)
 * needs that approval whatever the policy.
 */
export async function verifyWaveDecision(cwd: string, specFile: string, env: string, planDigest: string, held: readonly string[] = []): Promise<{ line: string; wave: WaveRecord }> {
  const specPath = resolve(cwd, specFile);
  const spec = readJson<WavesSpec>(specPath, "the waves spec");
  const { k, name } = waveOf(spec, env, specFile);
  const decision = readJson<WaveDecision>(join(cwd, ".chant", "op-waves", spec.name, `wave-${String(k)}.json`), `chant's decision for wave ${String(k)} (${name})`);
  const member = decision.members.find((m) => m.member === env);
  if (decision.wave !== k || !member || member.planDigest !== planDigest) {
    throw new YodelError(
      `refused: chant decided wave ${String(k)} (${name}) on ${member ? `plan ${member.planDigest}` : `no plan for ${env}`}, and ${env}'s plan is now ${planDigest}. Nothing was applied; run the wave again.`,
      NOT_APPROVED,
    );
  }
  const { waveSetDigest } = await import("@intentius/chant/gated-waves");
  if (waveSetDigest(decision.members) !== decision.digest) throw new YodelError(`refused: chant's decision for wave ${String(k)} does not hold the digest of its own members; nothing was applied`, NOT_APPROVED);
  if (decision.status === "approved") {
    const by = await verifyApproval(await gitLedger(cwd), { name: spec.name, filePath: specFile, gate: decision.gate, quorum: false }, decision.digest);
    return {
      line: `wave ${String(k)} (${name}): approved by ${by.resolvedBy} at ${by.timestamp}`,
      wave: { wave: k, op: spec.name, gate: decision.gate, digest: decision.digest, status: "approved" },
    };
  }
  // Not required: ask chant's rule again rather than trust the record, at yodel's base
  // (../config/base.ts), never at a base the spec in the change names.
  const { opWaveNeedsApproval, readOpWavePolicy } = await import("@intentius/chant/op");
  const policy = readOpWavePolicy(specFile, name, baseRef(cwd).ref, cwd);
  if (held.length > 0) {
    // A before step failed with onFailure approve: a person approves this plan, whatever the gate.
    try {
      const by = await verifyApproval(await gitLedger(cwd), { name: spec.name, filePath: specFile, gate: decision.gate, quorum: false }, decision.digest);
      return {
        line: `wave ${String(k)} (${name}): held by ${held.join(", ")}, approved by ${by.resolvedBy} at ${by.timestamp}`,
        wave: { wave: k, op: spec.name, gate: decision.gate, digest: decision.digest, status: "approved" },
      };
    } catch {
      throw new YodelError(
        `refused: ${env}'s before step${held.length === 1 ? "" : "s"} ${held.join(", ")} failed with onFailure approve, so wave ${String(k)} (${name}) waits for a person under any gate. Nothing was applied. ` +
          `Approve it with: chant approve ${spec.name} ${decision.gate} --plan ${decision.digest}`,
        NOT_APPROVED,
      );
    }
  }
  if (decision.status !== "not-required" || opWaveNeedsApproval(policy.policy, decision.members as never)) {
    throw new YodelError(
      `refused: wave ${String(k)} (${name}) needs an approval of ${decision.digest} under gate ${policy.policy} (read at ${policy.base.slice(0, 12)}), and chant's gate ledger has none. Nothing was applied.`,
      NOT_APPROVED,
    );
  }
  return {
    line: `wave ${String(k)} (${name}): gate ${policy.policy} at ${policy.base.slice(0, 12)} needs no approval for this plan`,
    wave: { wave: k, op: spec.name, gate: decision.gate, digest: decision.digest, status: "not-required", policy: policy.policy, base: policy.base },
  };
}

/** chant's decision for a wave, as `chant run wave` will make it once this plan is written. */
export interface WaveForecast {
  wave: number;
  name: string;
  gate: string;
  digest: string;
  policy: string;
  base: string;
  /** No approval of `digest` stands and the policy asks for one: chant exits 3. */
  waits: boolean;
  /** `chant approve <op> <gate> --plan <digest>`. */
  approve: string;
}

/** Where chant run wave writes a run's plan file (chant's opWavePlanPath). */
export const wavePlanPath = (op: string, wave: number, target: string): string => `.chant/op-waves/${op}/wave-${String(wave)}/${target.replace(/[^A-Za-z0-9._-]/g, "_")}.plan.json`;

/**
 * The decision chant makes for `plan`'s wave right after `--wave-plan`,
 * made the same way and from the same sources: the policy from the spec at
 * yodel's base, chant's own rule, and the gate ledger for an approval of
 * the wave's set digest. A tenant set's wave (#56) has a run per tenant,
 * which chant plans in order: the forecast is made at the last run, from
 * the plan files the runs before it wrote; at any other run it is
 * undefined.
 */
export async function forecastWave(cwd: string, specFile: string, plan: Pick<WavePlanFile, "planDigest" | "destructive" | "empty" | "environment" | "held">): Promise<WaveForecast | undefined> {
  const spec = readJson<WavesSpec & { gate?: string }>(resolve(cwd, specFile), "the waves spec");
  const { k, name } = waveOf(spec, plan.environment, specFile);
  const { waveSetDigest, waveGateName } = await import("@intentius/chant/gated-waves");
  const { opWaveNeedsApproval, readOpWavePolicy } = await import("@intentius/chant/op");
  const member = (target: string, p: Pick<WavePlanFile, "planDigest" | "destructive" | "empty">) => ({ member: target, planDigest: p.planDigest, op: "", ...(p.destructive ? { destructive: true } : {}), ...(p.empty ? { empty: true } : {}) });
  const runs = spec.waves[k - 1]?.runs ?? [];
  if (runs.at(-1)?.target !== plan.environment) return undefined;
  const members = [];
  for (const run of runs) {
    if (run.target === plan.environment) {
      members.push(member(run.target, plan));
      continue;
    }
    const path = join(cwd, wavePlanPath(spec.name, k, run.target));
    if (!existsSync(path)) return undefined;
    members.push(member(run.target, JSON.parse(readFileSync(path, "utf8")) as WavePlanFile));
  }
  const digest = waveSetDigest(members);
  const gate = waveGateName(spec.gate ?? spec.name, k);
  const policy = readOpWavePolicy(specFile, name, baseRef(cwd).ref, cwd);
  let waits = opWaveNeedsApproval(policy.policy, members) || (plan.held?.length ?? 0) > 0;
  if (waits) {
    try {
      await verifyApproval(await gitLedger(cwd), { name: spec.name, filePath: specFile, gate, quorum: false }, digest);
      waits = false;
    } catch {
      // No approval of this digest: chant waits.
    }
  }
  return { wave: k, name, gate, digest, policy: policy.policy, base: policy.base, waits, approve: `chant approve ${spec.name} ${gate} --plan ${digest}` };
}

/** Reads a plan file `--wave-plan` wrote. */
export function readWavePlan(file: string): WavePlanFile {
  const plan = readJson<WavePlanFile>(resolve(file), "the wave's plan file");
  if (typeof plan.planDigest !== "string" || typeof plan.migrations !== "string") throw new YodelError(`${file} is not a plan yodel apply --wave-plan wrote`);
  return plan;
}

/** What `yodel plan` and the pull request comment show of an environment's wave. */
export interface WaveView {
  /** 1-based, in yodel.config.ts `waves`. */
  wave: number;
  gate: WaveGate;
  /** The base commit the gate was read at, and how it was chosen. */
  base: string;
  baseSource: string;
  destructiveSteps: DestructiveStep[];
  /** Under the gate at the base, the wave waits for an approval of this plan. */
  waits: boolean;
  /** The wave plan digest and the set digest the wave's gate binds. */
  planDigest: string;
  digest: string;
  /** `chant approve yodel-apply yodel-apply-wave-<k> --plan <digest>`. */
  approve: string;
  /** What each required environment's history records of the pending migrations. */
  promotions: Promotion[];
  /** A pending migration has not run where it must first: the wave refuses until it has, so there is nothing to approve yet. */
  blocked: boolean;
}

/**
 * `env`'s wave, as the apply pipeline will plan it after the merge, when
 * yodel.config.ts declares waves and names `env`; undefined otherwise. The
 * gate is the base commit's: on a pull request, the merge base with the
 * target branch.
 */
export async function waveView(project: Project, env: string, ordered: readonly Migration[], pending: readonly PendingMigration[], migrations: string): Promise<WaveView | undefined> {
  // A tenant's wave is its whole set's, which one tenant's plan does not make (#56).
  if (splitTarget(env).tenant !== undefined) return undefined;
  const k = (project.yodel?.config.waves ?? []).findIndex((w) => w.env === env) + 1;
  if (k === 0) return undefined;
  const { gate, at } = await gateAtBase(project, env);
  const steps = destructiveSteps(project.dialect === "postgres" ? "postgres" : "clickhouse", pending);
  const destructive = steps.length > 0;
  const promotions = await readPromotions(project, env, ordered, pending);
  const blocked = promotions.some((p) => p.migrations.some((m) => m.ran !== "applied"));
  const planDigest = await wavePlanDigest({ environment: env, migrations, gate, destructive, requires: promotionEvidence(promotions) });
  const { waveSetDigest, waveGateName } = await import("@intentius/chant/gated-waves");
  const digest = waveSetDigest([{ member: env, planDigest }]);
  const waits = !blocked && pending.length > 0 && (gate === "always" || (gate === "on-destructive" && destructive));
  return {
    wave: k,
    gate,
    base: at.sha,
    baseSource: at.base.source,
    destructiveSteps: steps,
    waits,
    planDigest,
    digest,
    approve: `chant approve ${WAVES_PIPELINE} ${waveGateName(WAVES_PIPELINE, k)} --plan ${digest}`,
    promotions,
    blocked,
  };
}

/** One line on the wave, for text and markdown. */
export function describeWave(w: WaveView, code: (s: string) => string = (s) => s): string {
  const at = `gate ${code(w.gate)} at ${code(w.base.slice(0, 12))}`;
  if (w.blocked) {
    const envs = [...new Set(w.promotions.filter((p) => p.migrations.some((m) => m.ran !== "applied")).map((p) => code(p.env)))];
    return `The apply pipeline refuses this in wave ${String(w.wave)} until ${envs.join(" and ")} ${envs.length === 1 ? "has" : "have"} applied it; approve it then (${at}).`;
  }
  if (!w.waits) {
    const why = w.gate === "never" ? "" : `: nothing pending is destructive`;
    return `The apply pipeline applies this in wave ${String(w.wave)} with no approval (${at}${why}).`;
  }
  const why = w.gate === "on-destructive" ? `: ${w.destructiveSteps.map((d) => `${d.migration} step ${String(d.step)} (${d.why})`).join(", ")}` : "";
  return `The apply pipeline waits in wave ${String(w.wave)} for an approval of ${code(w.digest)} (${at}${why}).`;
}
