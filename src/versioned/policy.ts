/**
 * Policy over the plan (#53): the rules `yodel.config.ts` `policy` declares
 * (`../config/define.ts`), evaluated over the plan `yodel apply` would run,
 * and the overrides recorded against them.
 *
 * `yodel plan` reports each rule's outcome; `yodel apply` refuses (exit 7)
 * before the gate, and its Apply step again under the lock, a plan a rule
 * denies. An override is a person's decision to run that plan anyway, and
 * chant's override gate (`@intentius/chant/override-gate`) records and
 * decides it: `yodel override <env> --rule <id> --reason <text>` records the
 * denial and then the override on `_gates/policy-override.jsonl` (the
 * `chant/lifecycle` branch), under the migrations Op's name
 * ({@link overrideSubject}). It counts only for the same plan digest and the
 * same denying rules, only when `policy.overriders` at base lists who
 * recorded it, under `sealed` only sealed, and once: the Apply step spends it
 * before it applies, and writes the overrides it relied on into the history
 * (the `note` of each migration's `started` row).
 */

import type { GateSigners, OverrideDecision, StandingOverride } from "@intentius/chant/override-gate";
import type { OverrideLedger } from "@intentius/chant/lifecycle/override-ledger";
import type { EnvironmentApprovalMode, PolicyConfig, PolicyPlan, PolicyRule, PolicyStep } from "../config/define.js";
import type { SqlDialect } from "../project.js";
import { YodelError, yodelRefusal } from "../project.js";
import { EXIT_DENIED } from "../exit.js";
import { silencesOf } from "../lint/index.js";
import type { PendingMigration } from "./state.js";
import type { RevertPlan } from "./revert.js";

/** The subject chant's override gate records an override of `op`'s plan under: the Op's name, or for the revert of a migration (#97) `<op>/revert-<id>`. */
export const overrideSubject = (op: string, revert?: string): string => (revert === undefined ? op : `${op}/revert-${revert}`);

/** Where `policy.overriders` comes from, for chant's refusals. */
const OVERRIDERS_PATH = "yodel.config.ts policy.overriders";

/** The override ledger for one subject, and how an override of it counts. */
export interface OverrideSource {
  subject: string;
  ledger: OverrideLedger;
  mode?: EnvironmentApprovalMode | undefined;
  /** The signers at base, under `sealed`; without them nothing counts. */
  signers?: GateSigners | undefined;
}

/** {@link OverrideSource} from the checkout at `cwd`, judged as `approval` (the migrations Op's mode at base) has it. */
export async function overrideSourceAt(cwd: string, subject: string, approval?: { mode: EnvironmentApprovalMode; base?: string | undefined }): Promise<OverrideSource> {
  const { readOverrideLedger } = await import("@intentius/chant/lifecycle/override-ledger");
  const ledger = await readOverrideLedger({ cwd });
  if (approval?.mode !== "sealed") return { subject, ledger };
  const { gateSignersAt } = await import("@intentius/chant/gate-decision");
  return { subject, ledger, mode: "sealed", ...(approval.base !== undefined ? { signers: gateSignersAt(cwd, approval.base) } : {}) };
}

/** chant's decision for the plan `digest` that `rules` deny. */
export async function decidePolicyOverride(source: OverrideSource, digest: string, rules: readonly string[], overriders: readonly string[] | undefined): Promise<OverrideDecision> {
  const { decideOverride } = await import("@intentius/chant/override-gate");
  return decideOverride({
    ledger: source.ledger,
    applied: source.ledger.applied,
    subject: source.subject,
    planDigest: digest,
    rules,
    overriders: overriders ?? [],
    overridersPath: OVERRIDERS_PATH,
    mode: source.mode ?? "ledger",
    ...(source.signers ? { signers: source.signers } : {}),
  });
}

/**
 * Spends `override` before the run applies under it: chant's applied record
 * on `chant/lifecycle`, pushed. A write that fails stops the run; a push
 * that does not land is logged.
 */
export async function spendOverride(cwd: string, override: StandingOverride, log: (line: string) => void): Promise<void> {
  const { appliedOverride } = await import("@intentius/chant/override-gate");
  const { recordOverridesApplied } = await import("@intentius/chant/lifecycle/override-ledger");
  const { pushLifecycleReport } = await import("@intentius/chant/lifecycle/git");
  const { isLifecycleLocalNote } = await import("@intentius/chant/lifecycle/local-note");
  await recordOverridesApplied([appliedOverride(override, { timestamp: new Date().toISOString() })], { cwd });
  const { pushed, pushWarning } = await pushLifecycleReport({ cwd });
  if (!pushed && !isLifecycleLocalNote(pushWarning)) log(`the override by ${override.by} is spent here, but the push to chant/lifecycle did not land: ${pushWarning ?? "no reason given"}`);
}

/** An override that counts: who recorded it, when, why, and the digest it is for. */
export interface PolicyOverride {
  rule: string;
  by: string;
  at: string;
  reason: string;
  digest: string;
}

export interface RuleResult {
  id: string;
  description?: string | undefined;
  /** `denied` stands; `overridden` was denied, and an override counts. */
  outcome: "allowed" | "denied" | "overridden";
  /** Why it denies the plan, one line each. */
  reasons: string[];
  override?: PolicyOverride | undefined;
}

/** The plan a rule sees. */
export function policyPlan(environment: string, dialect: SqlDialect, toApply: readonly PendingMigration[], now: Date = new Date()): PolicyPlan {
  return {
    environment,
    dialect,
    now: now.toISOString(),
    pending: toApply.map((p) => ({
      id: p.id,
      checksum: p.checksum,
      outOfOrder: p.outOfOrder,
      steps: p.migration.document.steps.map((s, index): PolicyStep => {
        if (s.kind === "statement") {
          return { index, kind: "statement", object: s.object, name: s.name, classes: [s.class], destructive: s.destructive === true, rules: [s.rule], sql: s.sql };
        }
        return {
          index,
          kind: s.kind,
          object: s.object,
          name: s.name,
          classes: [...new Set(s.changes.map((c) => c.class))],
          destructive: s.changes.some((c) => c.destructive === true),
          rules: [...new Set(s.changes.map((c) => c.rule))],
          ...(s.kind === "op" ? { op: s.op } : {}),
        };
      }),
      silences: silencesOf(p.migration).map(({ step, rule, reason }) => ({ step, rule, reason })),
    })),
  };
}

/**
 * The plan a rule sees for a revert (#97): the migration reverted is the one
 * entry of `pending`, its steps the revert's statements in the order they
 * run (a hand-written revert step's first), and `revert` says it is one. A
 * rule that refuses drops refuses a revert that drops what the migration
 * added.
 */
export function policyRevertPlan(environment: string, dialect: SqlDialect, plan: RevertPlan, now: Date = new Date()): PolicyPlan {
  return {
    environment,
    dialect,
    now: now.toISOString(),
    revert: { id: plan.migration.id, to: plan.to },
    pending: [
      {
        id: plan.migration.id,
        checksum: plan.checksum,
        outOfOrder: false,
        steps: plan.statements.map(({ source, step }, index): PolicyStep => ({
          index,
          kind: "statement",
          object: step.object,
          name: source === "step" ? `${step.name} (${plan.step?.file ?? "the revert step"})` : step.name,
          classes: [step.class],
          destructive: step.destructive === true,
          rules: [step.rule],
          sql: step.sql,
        })),
        silences: [],
      },
    ],
  };
}

const applies = (rule: PolicyRule, environment: string) => rule.environments === undefined || rule.environments.includes(environment);

function denials(rule: PolicyRule, plan: PolicyPlan): string[] {
  const out: string[] = [];
  if (rule.refuse) {
    const { classes = [], destructive = false } = rule.refuse;
    for (const m of plan.pending) {
      for (const s of m.steps) {
        const cls = s.classes.filter((c) => classes.includes(c));
        if (cls.length > 0) out.push(`${m.id} step ${String(s.index)} (${s.name}) is ${cls.join(", ")}`);
        else if (destructive && s.destructive) out.push(`${m.id} step ${String(s.index)} (${s.name}) is destructive`);
      }
    }
  }
  if (rule.silences) {
    const { rules, reason } = rule.silences;
    for (const m of plan.pending) {
      for (const s of m.silences) {
        if (rules && !rules.includes(s.rule)) continue;
        reason.lastIndex = 0;
        if (!reason.test(s.reason)) out.push(`${m.id} step ${String(s.step)} silences ${s.rule} with a reason that does not match ${String(reason)}: ${JSON.stringify(s.reason)}`);
      }
    }
  }
  if (rule.check) {
    let said: ReturnType<NonNullable<PolicyRule["check"]>>;
    try {
      said = rule.check(plan);
    } catch (e) {
      said = `its check threw: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (said === false) out.push(rule.description ?? "its check denies the plan");
    else if (typeof said === "string") out.push(said);
    else if (Array.isArray(said)) out.push(...said);
  }
  return out;
}

/** Each rule that applies to the plan's environment, allowed or denied. No overrides yet. */
export function evaluatePolicy(policy: PolicyConfig | undefined, plan: PolicyPlan): RuleResult[] {
  return (policy?.rules ?? [])
    .filter((r) => applies(r, plan.environment))
    .map((r) => {
      const reasons = denials(r, plan);
      return { id: r.id, ...(r.description ? { description: r.description } : {}), outcome: reasons.length > 0 ? "denied" : "allowed", reasons };
    });
}

/** The results with each denied rule an override counts for marked overridden. */
export function withOverrides(results: readonly RuleResult[], overrides: readonly PolicyOverride[]): RuleResult[] {
  return results.map((r) => {
    const o = r.outcome === "denied" ? overrides.find((x) => x.rule === r.id) : undefined;
    return o ? { ...r, outcome: "overridden", override: o } : r;
  });
}

/** The refusal for the rules that deny the plan with no override, or `undefined`. `revert`: the plan is the revert of that migration (with that hand-written step, as given). */
export function policyRefusal(results: readonly RuleResult[], environment: string, digest: string | undefined, when: string, revert?: { id: string; step?: string | undefined }): YodelError | undefined {
  const denied = results.filter((r) => r.outcome === "denied");
  if (denied.length === 0) return undefined;
  const lines = denied.flatMap((r) => [`  ${r.id}${r.description ? ` (${r.description})` : ""}:`, ...r.reasons.map((x) => `    ${x}`)]);
  const ids = denied.map((r) => r.id).join(", ");
  const what = revert ? `the revert of ${revert.id}` : "this plan";
  const target = revert ? ` --revert ${revert.id}${revert.step !== undefined ? ` --step ${revert.step}` : ""}` : "";
  return yodelRefusal(
    `refused by policy ${when}: ${denied.length === 1 ? "rule" : "rules"} ${ids} ${denied.length === 1 ? "denies" : "deny"} ${what}${digest ? ` (${digest})` : ""}. Nothing was ${revert ? "reverted" : "applied"}:\n${lines.join("\n")}\n` +
      `To run it anyway, someone policy.overriders lists records why, for exactly this plan: ${overrideCommand(environment, denied.map((r) => r.id), target)}`,
    EXIT_DENIED,
  );
}

/** The command that overrides the denial by `rules`: one override names every rule that denies the plan. */
export const overrideCommand = (environment: string, rules: readonly string[], target = ""): string => `yodel override ${environment}${target} ${rules.map((r) => `--rule ${r}`).join(" ")} --reason "<why>"`;

/** The whole evaluation: the rules over the plan, with the overrides on the ledger for `digest`. Empty when the config declares no policy. */
export async function judgePlan(input: {
  policy: PolicyConfig | undefined;
  environment: string;
  dialect: SqlDialect;
  toApply: readonly PendingMigration[];
  digest: string | undefined;
  ledger: () => Promise<OverrideSource | undefined>;
  /** Under the lock: spends the override the run applies under ({@link spendOverride}). */
  spend?: (override: StandingOverride) => Promise<void>;
  now?: Date;
}): Promise<RuleResult[]> {
  if (!input.policy || input.toApply.length === 0) return [];
  return judgePolicyPlan(input.policy, policyPlan(input.environment, input.dialect, input.toApply, input.now), input.digest, input.ledger, input.spend);
}

/** The rules over `plan` (a migration plan's, a revert's, a declarative plan's), with the override that counts for `digest` (chant's decision) marking the denials it answers. */
export async function judgePolicyPlan(
  policy: PolicyConfig,
  plan: PolicyPlan,
  digest: string | undefined,
  ledger: () => Promise<OverrideSource | undefined>,
  spend?: (override: StandingOverride) => Promise<void>,
): Promise<RuleResult[]> {
  const results = evaluatePolicy(policy, plan);
  const denied = results.filter((r) => r.outcome === "denied").map((r) => r.id);
  if (!digest || denied.length === 0) return results;
  const source = await ledger();
  if (!source) return results;
  const decision = await decidePolicyOverride(source, digest, denied, policy.overriders);
  if (decision.status !== "overridden") return results;
  await spend?.(decision.override);
  const { by, at, reason } = decision.override;
  return withOverrides(results, denied.map((rule) => ({ rule, by, at, reason, digest })));
}

/**
 * The policy over a revert (#97), as `yodel revert` judges it before the
 * gate and its Apply step again under the lock: the rules over
 * {@link policyRevertPlan}, and the overrides recorded for the revert's own
 * digest (`yodel override <env> --revert <id>`). Empty when the config
 * declares no policy, or the revert has no statement.
 */
export async function judgeRevert(input: {
  policy: PolicyConfig | undefined;
  environment: string;
  dialect: SqlDialect;
  plan: RevertPlan;
  digest: string | undefined;
  ledger: () => Promise<OverrideSource | undefined>;
  /** Under the lock: spends the override the revert runs under. */
  spend?: (override: StandingOverride) => Promise<void>;
  now?: Date;
}): Promise<RuleResult[]> {
  if (!input.policy || input.plan.statements.length === 0) return [];
  return judgePolicyPlan(input.policy, policyRevertPlan(input.environment, input.dialect, input.plan, input.now), input.digest, input.ledger, input.spend);
}

/** One line per rule, for text output. */
export function describeResults(results: readonly RuleResult[]): string[] {
  return results.map((r) => {
    if (r.outcome === "allowed") return `policy ${r.id}: allowed`;
    if (r.outcome === "overridden" && r.override) return `policy ${r.id}: denied, overridden by ${r.override.by} at ${r.override.at}: ${r.override.reason}`;
    return `policy ${r.id}: denied: ${r.reasons.join("; ")}`;
  });
}
