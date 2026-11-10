/**
 * The type-the-name confirmation of `yodel approve` (#295), in chant core
 * (ruling F on #285, chant#4575). yodel approve asks through chant's
 * `confirmApproval`: chant shows the gate, its pending fact and the stored
 * plan the fact cites, and asks for the target's name, the environment (or
 * tenant set) yodel names. A wrong answer, or the end of input, records
 * nothing and exits 8, as chant approve does for every product. yodel asks
 * its own question only with YODEL_OWN_CONFIRM=1, or when chant has nothing
 * to show (no ledger to read yet).
 *
 * yodel still refuses with no terminal before anything is read, and still
 * reads its plan again after the answer, so what is approved is what the
 * person saw. chant's `approve` child then records with no terminal of its
 * own, so the person is asked once.
 */
import { confirmApproval as chantConfirmApproval } from "@intentius/chant/cli/handlers/approve-confirm";
import { EXIT_DECLINED } from "../exit.js";
import type { Io } from "../command.js";

/** The parts of chant's `cli/handlers/approve-confirm` yodel calls. */
export interface ChantConfirm {
  confirmApproval: typeof chantConfirmApproval;
}

/** True when chant asks the question; false with YODEL_OWN_CONFIRM=1, when yodel asks its own. */
export function chantConfirms(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.YODEL_OWN_CONFIRM !== "1";
}

/** What one confirmation asks about. */
export interface Confirmation {
  io: Io;
  ask: (question: string) => Promise<string>;
  /** The project's directory: chant reads the ledger from the working directory. */
  dir: string;
  op: string;
  gate: string;
  digest: string;
  /** The name the person types: the environment, the tenant set. */
  target: string;
  /** yodel's own question, for YODEL_OWN_CONFIRM=1 and when chant has nothing to show. */
  question: string;
}

/**
 * Ask the person to confirm. Undefined when they typed the target's name;
 * else the exit code: 8 for a wrong answer or the end of input, or chant's
 * code for a plan that moved while they were asked.
 */
export async function confirmApproval(c: Confirmation, chant: ChantConfirm = { confirmApproval: chantConfirmApproval }): Promise<number | undefined> {
  if (!chantConfirms()) return ownPrompt(c);
  const before = process.cwd();
  process.chdir(c.dir);
  let answered: Awaited<ReturnType<ChantConfirm["confirmApproval"]>>;
  try {
    answered = await chant.confirmApproval(c.op, c.gate, {
      plan: c.digest,
      environment: c.target,
      cwd: c.dir,
      ask: (q) => c.ask(q).catch(() => null),
      out: (t) => {
        c.io.out(t);
      },
      err: (t) => {
        c.io.err(t);
      },
    });
  } finally {
    process.chdir(before);
  }
  if (answered.status === "refused") return answered.code;
  if (answered.status === "confirmed") return answered.target === c.target ? undefined : EXIT_DECLINED;
  // chant had nothing to show (no ledger to read yet): yodel's question, as before.
  return ownPrompt(c);
}

/** yodel's own question. */
async function ownPrompt(c: Confirmation): Promise<number | undefined> {
  const answer = (await c.ask(c.question)).trim();
  if (answer === c.target) return undefined;
  c.io.err(`Not approved: the answer was not ${c.target}.\n`);
  return EXIT_DECLINED;
}
