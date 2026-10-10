import { parseArgs } from "node:util";
import { resolve } from "node:path";
import type { Command } from "../command.js";
import { guarded } from "../env-args.js";
import { loadProject, YodelError } from "../project.js";
import { YodelMcpServer } from "../mcp/server.js";
import { yodelTools } from "../mcp/tools.js";

const usage = "usage: yodel mcp [--dir <project>]";

const help = `${usage}

Serves read-only tools for a coding agent over the Model Context Protocol, on
stdin and stdout: status, plan, lint, drift, history and explain. Each runs
the yodel command of the same name with --json, in the project, and returns
its exit code and output in an envelope (schemas/mcp.schema.json). There is
no tool that applies, approves, repairs, rebases or writes a migration, and
the server refuses to start with one. A plan waiting for approval carries
the approve command for a person to run.

Start it with the reader's credentials in the environment, the ones
yodel plan uses; the tools read the servers chant.config.ts names.

Options:
  -C, --dir <dir>  the project directory (default: the working directory)

Exit codes:
  0  stdin closed
  1  the server could not start: no project in the directory
`;

/** `yodel mcp`; the exit codes are in `help`. */
export const mcp: Command = {
  name: "mcp",
  summary: "serve read-only tools to a coding agent (MCP, stdio)",
  implemented: true,
  run: (args, io) =>
    guarded("mcp", io, args, help, async () => {
      let dir: string;
      try {
        const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: { dir: { type: "string", short: "C" } } });
        dir = resolve(values.dir ?? process.cwd());
      } catch (e) {
        throw new YodelError(`${e instanceof Error ? e.message : String(e)}\n${usage}`);
      }
      // Refuse to start outside a project, rather than answer every call with the same error.
      dir = (await loadProject(dir)).dir;
      const server = new YodelMcpServer(yodelTools(dir));
      io.err(`yodel mcp: serving ${server.list().map((t) => t.name).join(", ")} for ${dir} on stdio\n`);
      await server.serve();
      return 0;
    }),
};
