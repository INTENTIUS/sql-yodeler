import { parseArgs } from "node:util";
import { resolve } from "node:path";
import type { Command } from "../command.js";
import { guarded } from "../env-args.js";
import { loadProject, YodelError } from "../project.js";
import { serveOnChant } from "../mcp/chant-hook.js";

const usage = "usage: yodel mcp [--dir <project>]";

const help = `${usage}

Serves read-only tools for a coding agent over the Model Context Protocol, on
stdin and stdout, on chant's own read-only server (chant serve mcp
--read-only): yodel:status, yodel:plan, yodel:lint, yodel:drift,
yodel:history and yodel:explain, beside chant's reads of the ledger and the
workspace graph. Each runs
the yodel command of the same name with --json, in the project, and returns
its exit code and output in an envelope (schemas/mcp.schema.json). There is
no tool that applies, approves, repairs, rebases or writes a migration, and
the server refuses to start with one. A plan carries the commands that are a
person's to run: the approve command, and an override for a denied policy rule.

Start it with the reader's credentials in the environment, the ones
yodel plan uses; the tools read the servers chant.config.ts names.

yodel's own server, with the unprefixed names, is gone from 0.12, and
YODEL_OWN_MCP=1, which served it, is refused.

Options:
  -C, --dir <dir>  the project directory (default: the working directory)

Exit codes:
  0  stdin closed
  1  the server could not start: no project in the directory, or
     YODEL_OWN_MCP is set
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
      // yodel's own server left in 0.12 (#303): the variable that chose it is refused by name, not ignored.
      if (process.env.YODEL_OWN_MCP !== undefined && process.env.YODEL_OWN_MCP !== "") {
        throw new YodelError("refused: YODEL_OWN_MCP is set, and yodel's own MCP server is gone from 0.12; the tools are served on chant serve mcp --read-only, named yodel:status, yodel:plan and so on. Unset YODEL_OWN_MCP in the agent's registration.");
      }
      // Refuse to start outside a project, rather than answer every call with the same error.
      dir = (await loadProject(dir)).dir;
      // On chant's read-only server through the product tool hook (#297, chant#4555).
      io.err(`yodel mcp: serving yodel's tools on chant serve mcp --read-only for ${dir} on stdio\n`);
      return serveOnChant(dir);
    }),
};
