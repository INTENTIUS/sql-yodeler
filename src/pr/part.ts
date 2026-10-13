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

import { sqlVersionedPlanPart } from "@intentius/chant-lexicon-sql/change-set";
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
