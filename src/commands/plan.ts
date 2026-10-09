import type { Command } from "../command.js";
import { guarded, parseEnvArgs, usage } from "../env-args.js";
import { loadProject, resolveEnvironment } from "../project.js";
import { buildSchema } from "../chant/build.js";
import { planEnvironment, planExitCode, planJson, renderPlan } from "../chant/plan.js";

const help = `${usage("plan")}

Shows the classified change from the environment's live database
(sql.profiles.<env>) to the declared schema, as chant sql plan reports it.

Options:
  --json           print chant's diff as JSON, with environment and dialect
  -C, --dir <dir>  the project directory (default: the working directory)

Exit codes:
  0  every change can be made in place, or there is none
  2  a change needs its own Op: a ClickHouse rebuild, a Postgres expand and contract
  1  no plan could be made: a bad config, an unknown environment, a declaration
     chant cannot build (an unsupported object), a server it cannot read
`;

/** `yodel plan <env>`; the exit codes are in `help`. */
export const plan: Command = {
  name: "plan",
  summary: "show what apply would change in an environment",
  implemented: true,
  run: (args, io) =>
    guarded("plan", io, args, help, async () => {
      const { env: name, json, dir } = parseEnvArgs("plan", args);
      const project = await loadProject(dir);
      const env = resolveEnvironment(project, name);
      const build = await buildSchema(project);
      try {
        const result = await planEnvironment(project, env, build);
        if (json) io.out(`${JSON.stringify(planJson(result), null, 2)}\n`);
        else io.out(`${await renderPlan(result, `Plan for ${env.name} (${project.dialect}, sql.profiles.${env.name})`)}\n`);
        return planExitCode(result);
      } finally {
        build.dispose();
      }
    }),
};
