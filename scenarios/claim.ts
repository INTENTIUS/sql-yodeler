/**
 * One run of one claim: `tsx scenarios/claim.ts <claim> <ch|pg>`, plain, or
 * broken with BREAK=1 (for a claim with parts, BREAK=<part> breaks that
 * part alone). Prints what it does, then one verdict line:
 *
 *   CLAIM name=<claim> dialect=<ch|pg> verdict=pass|caught|fail|pending mode=plain|break seconds=<n> [why="..."] [needs=#N]
 *
 * scenarios/run.ts starts these, one process per run, and reads the line
 * from the run's log. A broken run has its own environment, <claim>-break,
 * and database, so a claim's plain and broken runs can run at once. The
 * run's database and schema are dropped before and after
 * (YODEL_CLAIMS_KEEP=1 keeps them, and the scratch project, to look at).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claims } from "./claims/index.js";
import { dialectName, NotCaught, partRunsOn, Pending, Violation, type Ctx, type Dialect } from "./lib/claim.js";
import { dbFor } from "./lib/db.js";

const [name, dialectArg] = process.argv.slice(2);
const claim = claims.find((c) => c.name === name);
if (!claim || (dialectArg !== "ch" && dialectArg !== "pg")) {
  process.stderr.write(`usage: tsx scenarios/claim.ts <claim> <ch|pg>; claims: ${claims.map((c) => c.name).join(", ")}\n`);
  process.exit(2);
}
const dialect: Dialect = dialectArg;
const body = claim.dialects[dialect];
if (!body) {
  process.stderr.write(`claim ${claim.name} has no ${dialect} run\n`);
  process.exit(2);
}

const breakVar = process.env.BREAK ?? "";
const broken = breakVar !== "" && breakVar !== "0";
const breaking = broken && breakVar !== "1" ? breakVar : undefined;
if (breaking !== undefined && !claim.parts?.includes(breaking)) {
  process.stderr.write(`BREAK=${breaking}: ${claim.parts ? `${claim.name}'s parts are ${claim.parts.join(", ")}` : `${claim.name} has no parts; BREAK=1 breaks it`}\n`);
  process.exit(2);
}
if (breaking !== undefined && !partRunsOn(claim, breaking, dialect)) {
  process.stderr.write(`BREAK=${breaking}: ${claim.name}'s part ${breaking} runs on ${(claim.partDialects?.[breaking] ?? []).map((d) => dialectName[d]).join(", ")} only, not ${dialectName[dialect]}\n`);
  process.exit(2);
}
const mode = broken ? "break" : "plain";
const keep = process.env.YODEL_CLAIMS_KEEP === "1";
const started = Date.now();

const quote = (s: string) => JSON.stringify(s.replace(/\s+/g, " ").trim().slice(0, 400));
function verdict(v: "pass" | "caught" | "fail" | "pending", detail = ""): never {
  const seconds = Math.round((Date.now() - started) / 1000);
  const name = claim?.name ?? "";
  process.stdout.write(`CLAIM name=${name} dialect=${dialect} verdict=${v} mode=${mode} seconds=${String(seconds)}${detail ? ` ${detail}` : ""}\n`);
  process.exit(v === "fail" ? 1 : 0);
}

if (typeof body !== "function") verdict("pending", `needs=${body.needs}`);

// A broken run's environment and database are its own, so it never meets the plain run of the same claim.
const env = broken ? `${claim.name}-break` : claim.name;
const db = dbFor(dialect, env);
const work = mkdtempSync(join(tmpdir(), `yodel-claim-${env}-${dialect}-`));
const ctx: Ctx = {
  claim: claim.name,
  dialect,
  broken,
  ...(breaking !== undefined ? { breaking } : {}),
  db,
  env,
  work,
  log: (text) => process.stdout.write(`[${claim.name} ${dialect} ${mode}] ${text}\n`),
};

ctx.log(`${claim.says}${broken ? ` (BREAK=${breakVar}: ${breaking ? `part ${breaking} is` : "the property is"} broken first; the claim must catch it)` : ""}`);
ctx.log(`database ${db.name}, history ${db.history}, scratch ${work}`);

let outcome: { kind: "held"; why?: string } | { kind: "violated"; why: string } | { kind: "pending"; needs: string; why: string } | { kind: "error"; why: string };
try {
  await db.reset();
  await body(ctx);
  outcome = { kind: "held" };
} catch (e) {
  if (e instanceof Pending) outcome = { kind: "pending", needs: e.needs, why: e.message };
  else if (e instanceof NotCaught) outcome = { kind: "held", why: e.message };
  else if (e instanceof Violation) outcome = { kind: "violated", why: e.message };
  else outcome = { kind: "error", why: e instanceof Error ? (e.stack ?? e.message) : String(e) };
}

if (outcome.kind !== "held" || outcome.why) ctx.log(`${outcome.kind}: ${outcome.why ?? ""}`);
if (keep) ctx.log(`kept ${work} and ${db.name}`);
else {
  await db.reset().catch((e: unknown) => {
    ctx.log(`cleanup: ${e instanceof Error ? e.message : String(e)}`);
  });
  rmSync(work, { recursive: true, force: true });
}

switch (outcome.kind) {
  case "pending":
    verdict("pending", `needs=${outcome.needs} why=${quote(outcome.why)}`);
    break;
  case "error":
    verdict("fail", `why=${quote(`error: ${outcome.why.split("\n")[0] ?? ""}`)}`);
    break;
  case "held":
    if (broken) verdict("fail", `why=${quote(`break=not-caught: ${outcome.why ?? "the claim held with its property broken"}`)}`);
    verdict("pass");
    break;
  case "violated":
    verdict(broken ? "caught" : "fail", `why=${quote(outcome.why)}`);
}
