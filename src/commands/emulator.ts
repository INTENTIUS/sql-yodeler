import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Command, Io } from "../command.js";
import { guarded } from "../env-args.js";
import { loadProject, YodelError } from "../project.js";
import { runChant, type ChantResult, type RunChantOptions } from "../chant/process.js";

const SUBCOMMANDS = ["up", "down", "status"] as const;

const usage = "usage: yodel emulator <up|down|status> [--port <container>=<host>]... [--json] [--dir <project>]";

const help = `${usage}

The local database: a ClickHouse and a Postgres in Docker, the servers the
template's dev environment reaches. chant runs them underneath (chant
emulator <up|down|status> --lexicon sql, in the project), and what it prints
is printed here: where each server listens and how to sign in.

  up      start each server, or reuse a running one, and wait until it is
          ready; refuses when another process holds the host port
  down    stop and remove the containers
  status  whether each server runs, and whether its address reaches it

The servers are shared by every project on the machine: down stops them for
all of them.

Options:
  --port <c>=<h>   up: publish container port <c> on host port <h>; repeatable
  --json           print chant's report as JSON
  -C, --dir <dir>  the project directory (default: the working directory)

Exit codes: chant's. 0 done; 1 Docker could not be asked, a port is held,
or (status) an address reaches another server; also 1 outside a project.
`;

export interface EmulatorArgs {
  sub: (typeof SUBCOMMANDS)[number];
  ports: string[];
  json: boolean;
  dir: string;
}

export function parseEmulatorArgs(args: string[]): EmulatorArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        port: { type: "string", multiple: true },
        json: { type: "boolean" },
        dir: { type: "string", short: "C" },
      },
    });
  } catch (e) {
    throw new YodelError(`${e instanceof Error ? e.message : String(e)}\n${usage}`);
  }
  const { values, positionals } = parsed;
  const [sub, ...rest] = positionals;
  if (sub === undefined || rest.length > 0 || !(SUBCOMMANDS as readonly string[]).includes(sub)) {
    throw new YodelError(`${sub === undefined ? "name what to do" : rest.length > 0 ? `one of up, down or status, got ${positionals.join(" ")}` : `unknown ${sub}: up, down or status`}\n${usage}`);
  }
  const ports = (values.port ?? []) as string[];
  if (ports.length > 0 && sub !== "up") throw new YodelError(`--port is for yodel emulator up\n${usage}`);
  return { sub: sub as EmulatorArgs["sub"], ports, json: values.json === true, dir: resolve(typeof values.dir === "string" ? values.dir : process.cwd()) };
}

/** The chant arguments for `a`. */
export function chantEmulatorArgs(a: EmulatorArgs): string[] {
  return ["emulator", a.sub, "--lexicon", "sql", ...a.ports.flatMap((p) => ["--port", p]), ...(a.json ? ["--json"] : [])];
}

type Runner = (args: readonly string[], options: RunChantOptions) => Promise<ChantResult>;

/** `yodel emulator`, running chant with `run` (tests pass their own). */
export function emulatorCommand(run: Runner = runChant): Command {
  return {
    name: "emulator",
    summary: "start, stop or check the local ClickHouse and Postgres (Docker)",
    implemented: true,
    run: (args, io: Io) =>
      guarded("emulator", io, args, help, async () => {
        const a = parseEmulatorArgs(args);
        // chant reads the project's lexicons from its chant.config.ts, so the project is found first, from a directory inside it too.
        const project = await loadProject(a.dir);
        const ran = await run(chantEmulatorArgs(a), { cwd: project.dir, onStdout: io.out, onStderr: io.err });
        return ran.code;
      }),
  };
}

export const emulator = emulatorCommand();
