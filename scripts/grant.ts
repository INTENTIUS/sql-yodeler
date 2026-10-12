/**
 * A person grants a coding agent runs of named claims, or of the bench,
 * without typing "run" for each (scenarios/lib/human-gate.ts).
 *
 *   npm run grant -- <name>... [--runs N] [--hours H]   N runs each (2), for H hours (4)
 *   npm run grant -- --show                             what the grant holds now
 *   npm run grant -- --end                              end the grant
 *
 * A name is a claim (`npm run claims -- --list`), `claims` for every claim,
 * or `bench`. Granting replaces any grant before it. Only a person grants:
 * with no terminal this stops.
 */

import { parseArgs } from "node:util";
import { claims } from "../scenarios/claims/index.js";
import { askRun, describeGrant, grantFile, readGrant, writeGrant } from "../scenarios/lib/human-gate.js";

const args = parseArgs({
  allowPositionals: true,
  options: { runs: { type: "string" }, hours: { type: "string" }, show: { type: "boolean" }, end: { type: "boolean" }, help: { type: "boolean", short: "h" } },
});
const o = args.values;

const fail = (msg: string): never => {
  process.stderr.write(`grant: ${msg}\n`);
  process.exit(2);
};

const show = (): void => {
  const g = readGrant();
  if (!g || Date.now() / 1000 >= g.expires) {
    process.stdout.write("no grant\n");
    return;
  }
  process.stdout.write(`until ${new Date(g.expires * 1000).toLocaleString()}: ${describeGrant(g)}\n`);
};

if (o.help || (!o.show && !o.end && !args.positionals.length)) {
  process.stdout.write("usage: npm run grant -- <claim|claims|bench>... [--runs N] [--hours H] | --show | --end\n");
  process.exit(o.help ? 0 : 2);
}
if (o.show) {
  show();
  process.exit(0);
}
if (o.end) {
  writeGrant({ expires: 0, runs: {} });
  process.stdout.write("no grant\n");
  process.exit(0);
}

const whole = (v: string | undefined, flag: string, d: number): number => {
  if (v === undefined) return d;
  if (!/^[1-9][0-9]*$/.test(v)) fail(`--${flag} takes a whole number from 1`);
  return Number(v);
};
const runs = whole(o.runs, "runs", 2);
const hours = whole(o.hours, "hours", 4);
const known = new Set(["claims", "bench", ...claims.map((c) => c.name)]);
for (const n of args.positionals) if (!known.has(n)) fail(`${n} is not a claim (npm run claims -- --list), claims, or bench`);

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stderr.write("grant: only a person grants, from a real terminal. A coding agent does not run this.\n");
  process.exit(3);
}
await askRun(`This lets a coding agent run ${args.positionals.join(", ")}, ${String(runs)} time${runs === 1 ? "" : "s"} each, for ${String(hours)} hour${hours === 1 ? "" : "s"}.`);
writeGrant({ expires: Math.floor(Date.now() / 1000) + hours * 3600, runs: Object.fromEntries(args.positionals.map((n) => [n, runs])) });
process.stdout.write(`${grantFile()}\n`);
show();
