/**
 * The stage commands (#384), in chant's release words: `yodel promote`,
 * `yodel reject`, `yodel pause` and `yodel resume`. Each is one chant
 * command run in yodel's words (`yodel chant`), so the lines chant prints
 * name yodel's commands. They act on the stages `.chant/pipeline.ts`
 * declares, which `yodel ci` writes from yodel.config.ts `ci.promotion`.
 */

import type { Command, Io } from "../command.js";
import { EXIT_FAILED } from "../exit.js";
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
    help: `usage: yodel promote --to <env> --release <label> [--from <env>]
                     [--allow-skip] [--dry-run]
       yodel promote --to <env> --release <label> --urgent --reason <text>

Takes the release the merge cut into the stage --to names (chant components
promote), behind that stage's gate as .chant/pipeline.ts on the default
branch has it: its approval rules, its change risk, the soak of the stage
before it, its hold, freeze windows and pause. Run it in a checkout of the
default branch with its full history, which holds the release's commit.

A later stage takes two approvals. The stage's gate binds the release
digest: a gate that waits exits 3 with its line, chant approve <pipeline>
<env> --env <env> --plan <release digest>. Once it passes, the promote runs
the stage's waves, and each wave's gate binds its plan, under the op
<pipeline>-<env>: a wave that waits exits 3 with its own chant approve
line. Approve it and run the same yodel promote again.

--urgent passes the stage's gate on its urgent rule, one sealed approval
from its role.
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
      // A stage's op waves apply one release, which the stage's gate binds (#384): a promote names it.
      if (verb.name === "promote" && !args.some((a) => a === "--release" || a.startsWith("--release="))) {
        io.err(`yodel promote takes the release the merge cut: add --release <label>\n\n${verb.help}`);
        return EXIT_FAILED;
      }
      return runChantVerb([...verb.chant, ...args], io);
    },
  };
}

export const [promote, reject, pause, resume] = VERBS.map(stageCommand) as [Command, Command, Command, Command];
