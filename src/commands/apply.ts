import type { Command } from "../command.js";
import { guarded, parseEnvArgs, usage } from "../env-args.js";
import { loadProject, resolveEnvironment } from "../project.js";
import { buildSchema } from "../chant/build.js";
import { declaredChanges, planEnvironment, planExitCode, planJson, renderPlan, PLAN_NEEDS_OP } from "../chant/plan.js";
import { findApplyOp, GATED, runApplyOp } from "../chant/apply.js";

const help = `${usage("apply", ["op"])}

Plans, then runs the project's ApplyOp for the environment (chant run <op>),
behind the Op's approval gate, which is bound to the plan. A run that stops
at the gate prints the chant approve command; approve, then run yodel apply
again. An approval binds to the plan digest the Op's Plan phase printed: if
that changes, the gate asks again.

Options:
  --json           print the outcome as JSON
  --op <name>      the ApplyOp to run, when more than one applies <env>
  -C, --dir <dir>  the project directory (default: the working directory)

Exit codes:
  0  the environment matches the declared schema (applied, or already did)
  2  a change needs its own Op; nothing was applied
  3  stopped at the gate, waiting for approval of this plan
  1  anything else failed, including changes to declared objects still
     planned after the Op completed
`;

/** `yodel apply <env>`; the exit codes are in `help`. */
export const apply: Command = {
  name: "apply",
  summary: "bring an environment to the declared schema or the pending migrations",
  implemented: true,
  run: (args, io) =>
    guarded("apply", io, args, help, async () => {
      const { env: name, json, dir, options } = parseEnvArgs("apply", args, ["op"]);
      const project = await loadProject(dir);
      const env = resolveEnvironment(project, name);
      const op = await findApplyOp(project, env, options.op);
      const report = (doc: Record<string, unknown>, code: number) => {
        if (json) io.out(`${JSON.stringify({ environment: env.name, dialect: project.dialect, op: op.name, ...doc }, null, 2)}\n`);
        return code;
      };

      const build = await buildSchema(project);
      try {
        const before = await planEnvironment(project, env, build);
        if (!json) io.out(`${await renderPlan(before, `Plan for ${env.name} (${project.dialect}, sql.profiles.${env.name})`)}\n`);
        if (planExitCode(before) === PLAN_NEEDS_OP) {
          if (!json) io.err(`yodel apply: refused: ${String(before.refused.length)} change(s) need their own Op; nothing was applied\n`);
          return report({ status: "refused", plan: planJson(before) }, PLAN_NEEDS_OP);
        }
        if (declaredChanges(before, build).length === 0) {
          if (!json) io.out(`${env.name} already matches the declared schema; nothing to apply.\n`);
          return report({ status: "unchanged", plan: planJson(before) }, 0);
        }

        if (!json) io.out(`\nRunning ${op.name} (${op.filePath})\n`);
        const run = await runApplyOp(project, op, { onOutput: (t) => { io.err(t); } });
        if (run.status === "gated") {
          if (!json) {
            io.out(`\n${op.name} is waiting at gate "${op.gate}" for approval of this plan.\n`);
            if (run.approve) io.out(`Approve it with:\n  ${run.approve}\nthen run yodel apply ${env.name} again.\n`);
          }
          return report({ status: "gated", gate: op.gate, ...(run.approve ? { approve: run.approve } : {}), ...(run.planDigest ? { planDigest: run.planDigest } : {}), plan: planJson(before) }, GATED);
        }
        if (run.status === "failed") {
          if (!json) io.err(`yodel apply: chant run ${op.name} failed (exit ${String(run.code)})\n`);
          return report({ status: "failed", exitCode: run.code, plan: planJson(before) }, 1);
        }

        // The Op completed: check the server now matches, so a change the applier did not attempt is not reported as applied.
        const after = await planEnvironment(project, env, build);
        const remaining = declaredChanges(after, build);
        if (remaining.length > 0) {
          if (!json) io.err(`yodel apply: ${op.name} completed but ${String(remaining.length)} change(s) to declared objects are still planned (a drop the Op's delete mode withholds, or a change it did not attempt):\n${await renderPlan(after, `Plan for ${env.name} after apply`)}\n`);
          return report({ status: "incomplete", plan: planJson(before), remaining: planJson(after) }, 1);
        }
        if (!json) io.out(`\nApplied: ${env.name} matches the declared schema.\n`);
        return report({ status: "applied", plan: planJson(before) }, 0);
      } finally {
        build.dispose();
      }
    }),
};
