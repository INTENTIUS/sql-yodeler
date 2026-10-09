import { Op, phase, gate, shell, stepOutput } from "@intentius/chant/op";

const plan = shell("yodel apply single --digest", { id: "plan" });
const digest = stepOutput(plan, "stdout");

export const op = Op({
  name: "migrate-single",
  overview: "Apply the pending migrations to single, behind an approval bound to their plan digest",
  phases: [
    phase("Plan", [plan]),
    phase("Approve", [gate("approve-migrate-single", { plan: digest })]),
    phase("Apply", [shell("yodel apply single --execute", { env: { YODEL_APPROVED_PLAN: digest }, timeout: "2h" })]),
  ],
});
