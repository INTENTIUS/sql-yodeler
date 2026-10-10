/**
 * A claim made of parts that run one after another on the same project,
 * each breaking its own property under BREAK=1.
 *
 * Plain, the first part whose check does not hold fails the claim. Under
 * BREAK every part still runs: each must be caught (a {@link Violation}) on
 * its own, and one that is not fails the claim, so a later part never hides
 * behind an earlier part's catch.
 */

import { Violation, type Ctx } from "./claim.js";

export type Part = readonly [name: string, run: () => Promise<void>];

export async function parts(ctx: Ctx, list: readonly Part[]): Promise<void> {
  if (!ctx.broken) {
    for (const [, run] of list) await run();
    return;
  }
  const caught: string[] = [];
  for (const [name, run] of list) {
    try {
      await run();
    } catch (e) {
      if (!(e instanceof Violation)) throw e;
      ctx.log(`part ${name}: caught: ${e.message}`);
      caught.push(`${name}: ${e.message}`);
      continue;
    }
    throw new Error(`BREAK: part ${name} held anyway; its break was not caught`);
  }
  throw new Violation(caught.join("; "));
}
