/**
 * `yodel chant <args>` (#287): one chant command line, run with yodel's
 * words (../ci-words.ts). The jobs chant's product pipeline generates for
 * yodel run this line where chant's own jobs run `chant` (chant#4550 ruling
 * C), so every status, note and approve line those jobs write says yodel.
 *
 * With a chant that has `@intentius/chant/ci-product`, the line runs in this
 * process through its `runChantInProcess(argv, words)`. With an older chant
 * it runs as `chant <args>` in a child, in chant's own words, as the jobs
 * did before.
 *
 * It is not in `yodel --help`'s list: people type yodel's own verbs, and
 * this line is for the generated jobs (docs with #298).
 */

import type { Io } from "../command.js";
import { EXIT_FAILED } from "../exit.js";
import { chantProduct, YODEL_WORDS, type ChantProduct } from "../ci-words.js";
import { runChant } from "../chant/process.js";

export const CHANT_VERB = "chant";

const usage = `usage: yodel chant <chant command> [args...]

Runs one chant command in yodel's words: statuses read yodel/plan and
yodel/apply, and approve lines read yodel approve <env>. The CI jobs yodel ci
renders run it in place of chant.
`;

/** What {@link runChantVerb} reaches, so a test can stand in for chant. */
export interface ChantVerbDeps {
  product?: () => Promise<ChantProduct | undefined>;
  child?: typeof runChant;
  cwd?: string;
}

/** Runs `yodel chant <argv>`; resolves to chant's exit code. */
export async function runChantVerb(argv: string[], io: Io, deps: ChantVerbDeps = {}): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    (argv.length === 0 ? io.err : io.out)(usage);
    return argv.length === 0 ? EXIT_FAILED : 0;
  }
  const product = await (deps.product ?? chantProduct)();
  if (product) return product.runChantInProcess(argv, YODEL_WORDS);
  const ran = await (deps.child ?? runChant)(argv, { cwd: deps.cwd ?? process.cwd(), onStdout: io.out, onStderr: io.err });
  return ran.code;
}
