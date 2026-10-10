import { parseArgs } from "node:util";
import type { Io } from "./command.js";
import { YodelError } from "./project.js";

/** The arguments `yodel <verb> <env>` takes: the environment, `--json`, `--dir`, and any extra string options. */
export interface EnvArgs {
  env: string;
  json: boolean;
  /** The project directory, or a directory inside it. Default: the working directory. */
  dir: string;
  options: Record<string, string | undefined>;
}

/** True when the arguments ask for the verb's help. */
export const wantsHelp = (args: readonly string[]) => args.includes("--help") || args.includes("-h");

export function parseEnvArgs(verb: string, args: string[], extra: readonly string[] = []): EnvArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: "boolean" },
        dir: { type: "string", short: "C" },
        ...Object.fromEntries(extra.map((name) => [name, { type: "string" as const }])),
      },
    });
  } catch (e) {
    throw new YodelError(`${e instanceof Error ? e.message : String(e)}\n${usage(verb, extra)}`);
  }
  const { values, positionals } = parsed;
  const [env, ...rest] = positionals;
  if (env === undefined || rest.length > 0) throw new YodelError(usage(verb, extra));
  const options: Record<string, string | undefined> = {};
  for (const name of extra) {
    const v = values[name];
    options[name] = typeof v === "string" ? v : undefined;
  }
  return {
    env,
    json: values.json === true,
    dir: typeof values.dir === "string" ? values.dir : process.cwd(),
    options,
  };
}

export function usage(verb: string, extra: readonly string[] = []): string {
  return `usage: yodel ${verb} <env> [--json] [--dir <project>]${extra.map((e) => ` [--${e} <${e}>]`).join("")}`;
}

/**
 * Runs a verb: prints `help` for `--help`, else runs `body`, turning a
 * {@link YodelError} (or any error) into a message on stderr and its exit code.
 */
export async function guarded(verb: string, io: Io, args: readonly string[], help: string, body: () => Promise<number>): Promise<number> {
  if (wantsHelp(args)) {
    io.out(formatHelp(help));
    return 0;
  }
  try {
    return await body();
  } catch (e) {
    if (e instanceof YodelError) {
      io.err(`yodel ${verb}: ${e.message}\n`);
      return e.exitCode;
    }
    io.err(`yodel ${verb}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    return 1;
  }
}

/**
 * Wraps each line of a help text longer than `width` columns, continuing
 * where its text starts: after `usage: yodel <verb> `, in an option's or an
 * exit code's description column, else at the line's own indent.
 */
export function formatHelp(text: string, width = 80): string {
  return text
    .split("\n")
    .map((line) => {
      if (line.length <= width) return line;
      const usage = /^usage: yodel \S+ /.exec(line);
      const column = /^(\s*(?:-\S.*?|\d)\s{2,})(?=\S)/.exec(line);
      const indent = " ".repeat(usage ? usage[0].length : column ? (column[1] ?? "").length : (/^\s*/.exec(line)?.[0].length ?? 0));
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
    })
    .join("\n");
}
