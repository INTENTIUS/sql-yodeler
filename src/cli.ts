import { parseArgs } from "node:util";
import type { Command, Io } from "./command.js";
import { commands } from "./commands/index.js";
import { version } from "./version.js";
import { EXIT_CODES, PLAN_PENDING_NOTE } from "./exit.js";

export function help(list: readonly Command[] = commands): string {
  const width = Math.max(...list.map((c) => c.name.length));
  const lines = list.map((c) => {
    const mark = c.implemented ? "" : " (not implemented yet)";
    return `  ${c.name.padEnd(width)}  ${c.summary}${mark}`;
  });
  return [
    "Usage: yodel <command> [options]",
    "",
    "Schema management and migrations for ClickHouse and Postgres.",
    "",
    "Commands:",
    ...lines,
    "",
    "Options:",
    "  -h, --help     show this help",
    "  -v, --version  print the version",
    "",
    "Exit codes (yodel <command> --help lists a command's own):",
    ...EXIT_CODES.map(([code, meaning]) => wrap(`  ${String(code)}  ${meaning}`, "     ")),
    wrap(`  ${PLAN_PENDING_NOTE}`, "  "),
    "",
  ].join("\n");
}

/** Wraps `line` at 80 columns, continuing with `indent`. */
export function wrap(line: string, indent: string, width = 80): string {
  const out: string[] = [];
  let current = "";
  for (const word of line.split(/(?<=\S) (?=\S)/)) {
    if (current && current.length + 1 + word.length > width) {
      out.push(current);
      current = indent + word.trimStart();
    } else current = current ? `${current} ${word}` : word;
  }
  if (current) out.push(current);
  return out.join("\n");
}

/** Parses argv (without the node and script paths) and runs a verb; resolves to the exit code. */
export async function main(
  argv: string[],
  io: Io,
  list: readonly Command[] = commands,
): Promise<number> {
  const verbAt = argv.findIndex((a) => !a.startsWith("-"));
  const globals = verbAt === -1 ? argv : argv.slice(0, verbAt);

  let values: { help?: boolean; version?: boolean };
  try {
    ({ values } = parseArgs({
      args: globals,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
      strict: true,
    }));
  } catch (e) {
    io.err(`yodel: ${e instanceof Error ? e.message : String(e)}\n\n${help(list)}`);
    return 1;
  }

  if (values.version) {
    io.out(`${version()}\n`);
    return 0;
  }
  if (values.help || verbAt === -1) {
    (values.help ? io.out : io.err)(help(list));
    return values.help ? 0 : 1;
  }

  const name = argv[verbAt];
  const command = list.find((c) => c.name === name);
  if (!command) {
    io.err(`yodel: unknown command "${String(name)}"\n\n${help(list)}`);
    return 1;
  }
  return command.run(argv.slice(verbAt + 1), io);
}
