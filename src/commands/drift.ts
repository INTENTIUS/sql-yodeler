import type { Command } from "../command.js";
import { guarded, parseEnvArgs, usage } from "../env-args.js";
import { loadProject, resolveEnvironment } from "../project.js";
import { declarativeTopologyRefusal } from "../config/settings.js";
import { driftExitCode, readDrift, renderDrift } from "../chant/drift.js";

const help = `${usage("drift")}

Reports the declared objects changed out of band or gone from the
environment, from chant lifecycle diff <env> --live. Objects the project does
not declare are never reported.

Options:
  --json           print the drift as JSON
  -C, --dir <dir>  the project directory (default: the working directory)

Exit codes:
  0  no drift
  2  a declared object changed out of band, or is gone
  1  the drift could not be read, or there is none but a declared object
     could not be read (its state is unknown, not clean)
`;

/** `yodel drift <env>`; the exit codes are in `help`. */
export const drift: Command = {
  name: "drift",
  summary: "report declared objects changed out of band or gone from an environment",
  implemented: true,
  run: (args, io) =>
    guarded("drift", io, args, help, async () => {
      const { env: name, json, dir } = parseEnvArgs("drift", args);
      const project = await loadProject(dir);
      const env = resolveEnvironment(project, name);
      // chant renders the declaration for sql.profiles.<env>.topology alone; a different one in yodel.config.ts would show every replicated engine as drift.
      const refusal = project.dialect === "clickhouse" ? declarativeTopologyRefusal(project, env.name) : undefined;
      if (refusal) throw refusal;
      const result = await readDrift(project, env);
      const code = driftExitCode(result);
      if (json) io.out(`${JSON.stringify({ ...result, dialect: project.dialect, drifted: code === 2 }, null, 2)}\n`);
      else io.out(renderDrift(result));
      return code;
    }),
};
