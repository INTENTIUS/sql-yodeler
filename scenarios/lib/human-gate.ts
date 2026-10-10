/**
 * The claims and the bench run only when a person starts them. They are not
 * part of developing a change: nothing merges or releases on them, and a
 * coding agent never runs them. Between development cycles a person runs
 * them from a real terminal and types `run`. GitHub's own runs (the manual
 * and weekly claims workflows) pass through.
 */

import { createInterface } from "node:readline/promises";

const STOP = (what: string) => `
STOP. \`npm run ${what}\` is not part of developing a change.

If you are a coding agent: do not run this, do not work around this check,
and do not wait on its result. Nothing merges or releases on it. Merge on
\`npm run check\` (and \`npm run templates:check\` for template or release
pull requests) and go on with the work.

A person runs ${what} between development cycles, from a real terminal,
and types "run" when asked.
`;

export async function humanGate(what: "claims" | "bench"): Promise<void> {
  if (process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_RUN_ID) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(STOP(what));
    process.exit(3);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\`npm run ${what}\` takes a long time and holds nothing up. Type "run" to start it: `);
  rl.close();
  if (answer.trim() !== "run") {
    process.stderr.write(`Not started (you typed ${JSON.stringify(answer.trim())}, not "run").\n`);
    process.exit(3);
  }
}
