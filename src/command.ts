/** Where a command writes. Tests pass their own; the bin passes process.stdout and stderr. */
export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

/** One `yodel` verb. Each lives in its own module under src/commands/. */
export interface Command {
  name: string;
  /** One line for `yodel --help`. */
  summary: string;
  /** False until a later issue builds the verb; `yodel --help` marks it. */
  implemented: boolean;
  /** Runs the verb with the arguments after its name; resolves to the exit code. */
  run: (args: string[], io: Io) => Promise<number>;
}

/** A verb that is listed but not built yet. Later issues replace these one by one. */
export function notImplemented(name: string, summary: string): Command {
  return {
    name,
    summary,
    implemented: false,
    run: (_args, io) => {
      io.err(`yodel ${name}: not implemented yet\n`);
      return Promise.resolve(2);
    },
  };
}
