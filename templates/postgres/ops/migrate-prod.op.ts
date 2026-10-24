import { Op, phase, gate, shell, stepOutput } from "@intentius/chant/op";

// yodel apply prod runs this Op when migrations are pending. The gate is bound
// to the plan digest (the pending migrations' checksums, the history and the
// live schema), so an approval given for one state never applies another.
// The pull request comment prints the yodel approve command for it.
const plan = shell("yodel apply prod --digest", { id: "plan" });
const digest = stepOutput(plan, "stdout");

export const migrateProd = Op({
  name: "migrate-prod",
  overview: "Apply the pending migrations to prod, behind an approval bound to their plan digest",
  phases: [
    phase("Plan", [plan]),
    phase("Approve", [gate("approve-migrate-prod", { plan: digest, resume: true })]),
    phase("Apply", [shell("yodel apply prod --execute", { env: { YODEL_APPROVED_PLAN: digest }, timeout: "2h" })]),
  ],
});
