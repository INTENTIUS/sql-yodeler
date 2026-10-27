import { EXIT_FAILED } from "./exit.js";
/** Where a command writes. Tests pass their own; the bin passes process.stdout and stderr. */
export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
  /**
   * Asks the person at the terminal and resolves to their answer. Present
   * only when stdin and stderr are a terminal: a script, CI or an agent has
   * no one to ask, and a command that needs a person's consent refuses.
   */
  ask?: (question: string) => Promise<string>;
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
      return Promise.resolve(EXIT_FAILED);
    },
  };
}
