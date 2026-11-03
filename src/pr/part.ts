/**
 * A versioned plan as a chant change-set part (#237), for a chant Op that
 * gates a SQL change together with another member's: `yodel plan <env>
 * --part <file>` writes it, and the Op reads it with `readChangeSetPart({
 * member, planner: "sql", file })` and joins it to the others with
 * `composeChangeSet`. The sql lexicon's `sqlVersionedPlanPart` makes it:
 * one entry per object the pending steps touch, the action and disruption
 * from their change classes, and yodel's plan digest as the member's, so
 * chant's gate and yodel's approval bind the same value. Statements are
 * redacted as in `--json`.
 */

import { SQL_CHANGE_SET_LEXICON, sqlVersionedPlanPart } from "@intentius/chant-lexicon-sql/change-set";
import { computePlanDigest } from "@intentius/chant/lifecycle/plan-digest";
import type { ChangeSetPart } from "@intentius/chant/change-set";
import type { VersionedPlan } from "./model.js";
import { redact } from "./render.js";

/** `plan` as `member`'s part. A plan apply would refuse is a `failed` member, with no digest. */
export function planPart(plan: VersionedPlan, member: string): ChangeSetPart {
  return sqlVersionedPlanPart({
    member,
    plan: {
      dialect: plan.dialect,
      environment: plan.environment,
      migrations: plan.pending.map((p) => ({
        id: p.id,
        steps: p.steps.map(({ step, done }) => ({ step: step.kind === "statement" ? { ...step, sql: redact(step.sql) } : step, done })),
      })),
      ...(plan.digest !== undefined ? { digest: plan.digest } : {}),
      ...(plan.refusal ? { refusal: plan.refusal.message } : {}),
    },
  });
}

/**
 * A slot of a tenant set's wave as one part (#56): `yodel plan
 * <env>/@<i>of<n> --part <file>`, which chant's `sql-migrate` capability
 * runs for each run of a set read by a query before `--wave-plan`. Every
 * tenant of the slot is planned against its own history; the part has each
 * tenant's entries, scoped to the tenant, and a digest over the tenants'
 * plan digests. A tenant apply would refuse makes the slot a failed member,
 * naming it, with no digest, as one environment's refusal does. A slot with
 * no tenant now is a planned member with no entries.
 */
export function slotPart(slot: string, tenants: readonly VersionedPlan[], member: string): ChangeSetPart {
  const parts = tenants.map((t) => ({ target: t.environment, part: planPart(t, member) }));
  const failed = parts.filter((p) => p.part.member.status === "failed");
  const planDigest =
    failed.length > 0
      ? null
      : computePlanDigest("yodel-plan-slot", {
          environment: slot,
          tenants: parts.map((p) => ({ target: p.target, planDigest: p.part.member.planDigest })).sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0)),
        });
  return {
    member: {
      member,
      lexicon: SQL_CHANGE_SET_LEXICON,
      planner: "sql",
      scope: slot,
      status: failed.length > 0 ? "failed" : "planned",
      ...(failed.length > 0 ? { error: failed.map((p) => `${p.target}: ${p.part.member.error ?? "yodel apply would refuse it"}`).join("; ") } : {}),
      planDigest,
      holes: parts.flatMap((p) => p.part.member.holes),
    },
    entries: parts.flatMap((p) => p.part.entries),
  };
}
