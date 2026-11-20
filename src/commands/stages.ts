/**
 * The stage commands (#384), in chant's release words: `yodel promote`,
 * `yodel reject`, `yodel pause` and `yodel resume`. Each is one chant
 * command run in yodel's words (`yodel chant`), so the lines chant prints
 * name yodel's commands. They act on the stages `.chant/pipeline.ts`
 * declares, which `yodel ci` writes from yodel.config.ts `ci.promotion`.
 */

import type { Command, Io } from "../command.js";
import { runChantVerb } from "./chant.js";

interface StageVerb {
  name: string;
  summary: string;
  /** The chant command the verb runs, before the arguments it was given. */
  chant: string[];
  help: string;
}

const VERBS: readonly StageVerb[] = [
  {
    name: "promote",
    summary: "take a release into a pipeline stage, behind its gate",
    chant: ["components", "promote"],
    help: `usage: yodel promote --to <env> [--release <label>] [--from <env>]
                     [--allow-skip] [--dry-run]
       yodel promote --to <env> --release <label> --urgent --reason <text>

Takes the release the merge cut into the stage --to names (chant components
promote), behind that stage's gate as .chant/pipeline.ts on the default
branch has it: its approval rules, its change risk, the soak of the stage
before it, its hold, freeze windows and pause. A gate that waits exits 3
with the approve line. --urgent passes the gate on the stage's urgent rule,
one sealed approval from its role.
`,
  },
  {
    name: "reject",
    summary: "turn down the release a stage's gate waits on",
    chant: ["reject"],
    help: `usage: yodel reject <pipeline> <env> --reason <text> [--plan <digest>]
                    [--sign [<key file>]]

Rejects the release the stage's gate waits on (chant reject): a promote of
it into that stage exits 8, naming who rejected it and why. The pipeline is
yodel-apply. --sign seals the rejection, which a sealed stage needs.
`,
  },
  {
    name: "pause",
    summary: "stop releases entering a stage",
    chant: ["stage", "pause"],
    help: `usage: yodel pause <env> --reason <text>

Pauses the stage (chant stage pause): a promote into it exits 3 and its
release waits. A promote that is applying finishes.
`,
  },
  {
    name: "resume",
    summary: "let releases into a paused stage again",
    chant: ["stage", "resume"],
    help: `usage: yodel resume <env> --reason <text>

Resumes the stage (chant stage resume). The newest release that waited is
the one that enters.
`,
  },
];

function stageCommand(verb: StageVerb): Command {
  return {
    name: verb.name,
    summary: verb.summary,
    implemented: true,
    run: async (args: string[], io: Io) => {
      if (args[0] === "--help" || args[0] === "-h") {
        io.out(verb.help);
        return 0;
      }
      return runChantVerb([...verb.chant, ...args], io);
    },
  };
}

export const [promote, reject, pause, resume] = VERBS.map(stageCommand) as [Command, Command, Command, Command];
