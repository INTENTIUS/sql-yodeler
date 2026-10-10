/**
 * Policy over the plan (#53): the rules `yodel.config.ts` `policy` declares
 * (`../config/define.ts`), evaluated over the plan `yodel apply` would run,
 * and the overrides recorded against them.
 *
 * `yodel plan` reports each rule's outcome; `yodel apply` refuses (exit 4)
 * before the gate, and its Apply step again under the lock, a plan a rule
 * denies. An override is a person's decision to run that plan anyway:
 * `yodel override <env> --rule <id> --reason <text>` records it on chant's
 * gate ledger (the `chant/lifecycle` branch) as an approval of the gate
 * `override-<id>` of the migrations Op, for exactly the current plan digest,
 * with the reason as its note. It counts only when the plan digest is the
 * same, so it is refused once the plan moves, and only when
 * `policy.overriders` lists who recorded it. The Apply step writes the
 * overrides it relied on into the history (the `note` of each migration's
 * `started` row).
 */

import type { GateLedgerPort } from "@intentius/chant/op/gate";
import type { PolicyConfig, PolicyPlan, PolicyRule, PolicyStep } from "../config/define.js";
import type { SqlDialect } from "../project.js";
import { YodelError } from "../project.js";
import { EXIT_REFUSED } from "../exit.js";
import { silencesOf } from "../lint/index.js";
import type { MigrateOpRef } from "./op.js";
import type { PendingMigration } from "./state.js";
import { sameDigest } from "./digest.js";

/** The gate an override of `rule` is recorded as an approval of. */
export const overrideGate = (rule: string): string => `override-${rule}`;

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

/** The overrides on the ledger that count for `digest`: of a rule's override gate, for that digest, with a reason, by someone `overriders` lists. The newest per rule. */
export async function readOverrides(port: GateLedgerPort, op: MigrateOpRef, digest: string, overriders: readonly string[] | undefined): Promise<PolicyOverride[]> {
  const { resolutions } = await port.read(op.name);
  const byRule = new Map<string, PolicyOverride>();
  for (const r of resolutions) {
    if (!r.gate.startsWith("override-") || !r.note || !(overriders ?? []).includes(r.resolvedBy)) continue;
    if (!(await sameDigest(r.planDigest, digest))) continue;
    const rule = r.gate.slice("override-".length);
    const prior = byRule.get(rule);
    if (!prior || prior.at < r.timestamp) byRule.set(rule, { rule, by: r.resolvedBy, at: r.timestamp, reason: r.note, digest });
  }
  return [...byRule.values()];
}

/** The results with each denied rule an override counts for marked overridden. */
export function withOverrides(results: readonly RuleResult[], overrides: readonly PolicyOverride[]): RuleResult[] {
  return results.map((r) => {
    const o = r.outcome === "denied" ? overrides.find((x) => x.rule === r.id) : undefined;
    return o ? { ...r, outcome: "overridden", override: o } : r;
  });
}

/** The refusal for the rules that deny the plan with no override, or `undefined`. */
export function policyRefusal(results: readonly RuleResult[], environment: string, digest: string | undefined, when: string): YodelError | undefined {
  const denied = results.filter((r) => r.outcome === "denied");
  if (denied.length === 0) return undefined;
  const lines = denied.flatMap((r) => [`  ${r.id}${r.description ? ` (${r.description})` : ""}:`, ...r.reasons.map((x) => `    ${x}`)]);
  const ids = denied.map((r) => r.id).join(", ");
  return new YodelError(
    `refused by policy ${when}: ${denied.length === 1 ? "rule" : "rules"} ${ids} ${denied.length === 1 ? "denies" : "deny"} this plan${digest ? ` (${digest})` : ""}. Nothing was applied:\n${lines.join("\n")}\n` +
      `To run it anyway, someone policy.overriders lists records why, for exactly this plan: ${denied.map((r) => `yodel override ${environment} --rule ${r.id} --reason "<why>"`).join("; ")}`,
    EXIT_REFUSED,
  );
}

/** The whole evaluation: the rules over the plan, with the overrides on the ledger for `digest`. Empty when the config declares no policy. */
export async function judgePlan(input: {
  policy: PolicyConfig | undefined;
  environment: string;
  dialect: SqlDialect;
  toApply: readonly PendingMigration[];
  digest: string | undefined;
  ledger: () => Promise<{ port: GateLedgerPort; op: MigrateOpRef } | undefined>;
  now?: Date;
}): Promise<RuleResult[]> {
  if (!input.policy || input.toApply.length === 0) return [];
  const results = evaluatePolicy(input.policy, policyPlan(input.environment, input.dialect, input.toApply, input.now));
  if (!input.digest || !results.some((r) => r.outcome === "denied")) return results;
  const at = await input.ledger();
  if (!at) return results;
  return withOverrides(results, await readOverrides(at.port, at.op, input.digest, input.policy.overriders));
}

/** One line per rule, for text output. */
export function describeResults(results: readonly RuleResult[]): string[] {
  return results.map((r) => {
    if (r.outcome === "allowed") return `policy ${r.id}: allowed`;
    if (r.outcome === "overridden" && r.override) return `policy ${r.id}: denied, overridden by ${r.override.by} at ${r.override.at}: ${r.override.reason}`;
    return `policy ${r.id}: denied: ${r.reasons.join("; ")}`;
  });
}
