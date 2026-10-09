import { Op, phase, gate, shell, stepOutput } from "@intentius/chant/op";

// The migrations Op `yodel apply CLAIMENV` prints when there is none.
const plan = shell("yodel apply CLAIMENV --digest", { id: "plan" });
const digest = stepOutput(plan, "stdout");

export const op = Op({
  name: "migrate-CLAIMENV",
  overview: "Apply the pending migrations to CLAIMENV, behind an approval bound to their plan digest",
  phases: [
    phase("Plan", [plan]),
    phase("Approve", [gate("approve-migrate-CLAIMENV", { plan: digest })]),
    phase("Apply", [shell("yodel apply CLAIMENV --execute", { env: { YODEL_APPROVED_PLAN: digest }, timeout: "2h" })]),
  ],
});
