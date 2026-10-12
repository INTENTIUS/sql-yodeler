/**
 * The claims and the bench run only when a person starts them. They are not
 * part of developing a change: nothing merges or releases on them. Between
 * development cycles a person runs them from a real terminal and types
 * `run`. GitHub's own runs (the manual and weekly claims workflows) pass
 * through.
 *
 * A grant lets a coding agent start what a person named, a set number of
 * times: `npm run grant -- <name>...` (scripts/grant.ts) asks the person to
 * type `run` and writes the names, the runs each may have (2 by default: a
 * run, and one more after a fix) and when the grant expires (4 hours by
 * default). With no terminal, the gate passes only when every name the
 * caller passes is granted with a run left, and takes one run of each. A
 * name is a claim (`npm run claims -- --list`), `claims` for every claim, or
 * `bench`.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";

export interface Grant {
  /** Seconds since the epoch. */
  expires: number;
  /** Runs left, by name. */
  runs: Record<string, number>;
}

export const grantFile = (): string =>
  process.env.YODEL_GRANT_FILE ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "sql-yodeler", "agent-grant.json");

export function readGrant(file = grantFile()): Grant | undefined {
  try {
    const g = JSON.parse(readFileSync(file, "utf8")) as Partial<Grant>;
    if (typeof g.expires !== "number" || typeof g.runs !== "object") return undefined;
    return { expires: g.expires, runs: g.runs };
  } catch {
    return undefined;
  }
}

export function writeGrant(g: Grant, file = grantFile()): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(g, null, 2)}\n`);
}

const now = (): number => Math.floor(Date.now() / 1000);

/** The grant entry that covers `name`: the name itself, or `claims` for any claim. */
const entryFor = (g: Grant, name: string, claim: boolean): string | undefined =>
  name in g.runs ? name : claim && "claims" in g.runs ? "claims" : undefined;

/** Why the grant does not cover `names`, or undefined when it does. */
export function grantRefusal(g: Grant | undefined, names: readonly string[], claim: boolean): string | undefined {
  if (!g) return "no grant: a person runs npm run grant -- <name>... first";
  if (now() >= g.expires) return "the grant expired";
  for (const n of names) {
    const e = entryFor(g, n, claim);
    if (e === undefined) return `${n} is not in the grant`;
    if ((g.runs[e] ?? 0) <= 0) return `${n} has no runs left in the grant: report what failed to the person`;
  }
  return undefined;
}

/** Takes one run of each entry covering `names` (an entry once, however many names it covers). */
export function grantTake(g: Grant, names: readonly string[], claim: boolean): Grant {
  const entries = new Set(names.map((n) => entryFor(g, n, claim)).filter((e): e is string => e !== undefined));
  const runs = { ...g.runs };
  for (const e of entries) runs[e] = (runs[e] ?? 0) - 1;
  return { ...g, runs };
}

export const describeGrant = (g: Grant): string =>
  Object.entries(g.runs)
    .map(([n, r]) => `${n} ${String(r)} run${r === 1 ? "" : "s"} left`)
    .join(", ");

const STOP = (what: string, why: string | undefined) => `
STOP. \`npm run ${what}\` is not part of developing a change.${why ? `\nNot granted: ${why}.` : ""}

If you are a coding agent: do not run this, do not write the grant file, and
do not look for another way to start it. Nothing merges or releases on it.
Merge on \`npm run check\` and go on with the work. If a run seems needed,
ask the person to run it, or to grant it with npm run grant -- <name>...

A person runs ${what} between development cycles, from a real terminal,
and types "run" when asked.
`;

/** Asks the person at the terminal to type `run`; exits 3 otherwise. */
export async function askRun(prompt: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${prompt} Type "run" to start it: `);
  rl.close();
  if (answer.trim() !== "run") {
    process.stderr.write(`Not started (you typed ${JSON.stringify(answer.trim())}, not "run").\n`);
    process.exit(3);
  }
}

/**
 * The gate. `names` are what this run starts: the claims selected, or
 * `bench`. With no terminal, a grant covering every one of them lets it
 * through and takes a run of each.
 */
export async function humanGate(what: "claims" | "bench", names: readonly string[] = [what]): Promise<void> {
  if (process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_RUN_ID) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const claim = what === "claims";
    const g = readGrant();
    const why = grantRefusal(g, names, claim);
    if (g && why === undefined) {
      const left = grantTake(g, names, claim);
      writeGrant(left);
      process.stderr.write(`Granted run of ${names.join(", ")}: ${describeGrant(left)}.\n`);
      return;
    }
    process.stderr.write(STOP(what, why));
    process.exit(3);
  }
  await askRun(`\`npm run ${what}\` takes a long time and holds nothing up.`);
}
