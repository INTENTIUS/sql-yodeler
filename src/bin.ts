#!/usr/bin/env node
// Published chant and its sql lexicon ship TypeScript source (their exports'
// "default" condition is ./src/*.ts), and chant evaluates the project's
// chant.config.ts and *.op.ts in this process. Register tsx's loader before
// anything imports them, the way chant's own bin runs under tsx.
import { register } from "tsx/esm/api";

register();
const { main } = await import("./cli.js");

const code = await main(process.argv.slice(2), {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
});
process.exitCode = code;
