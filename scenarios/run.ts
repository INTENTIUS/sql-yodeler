/**
 * Scenario claims: one per feature the README and #21 promise, each run
 * against the emulator (`chant emulator up --lexicon sql`) the way a team
 * would use yodel, plain and with its property broken.
 *
 *   npm run claims                     every claim, plain and under BREAK=1, in parallel
 *   npm run claims -- resume drift     the named claims, both ways
 *   BREAK=1 npm run claims -- resume   the broken run only; it must print "caught"
 *   BREAK=statement npm run claims -- resume
 *                                      the broken run, breaking that part of the claim alone
 *   npm run claims -- --plain          the plain runs only
 *   npm run claims -- --dialect pg     one dialect's runs
 *   npm run claims -- --record FILE    every run, then the verdicts as JSON in FILE
 *   npm run claims -- --record FILE lint new
 *                                      those claims; when FILE exists, only their rows change
 *   npm run claims -- --list           the claims, what each says, and the dialects it runs on
 *   npm run claims -- --skip forgejo,github,gitlab
 *                                      every claim but those named (comma-separated)
 *   npm run claims -- --affected [base]
 *                                      the claims the change since base (default origin/main) can affect
 *   npm run claims -- --affected --list
 *                                      which those are, and why, without running them
 *
 * `npm run claims` builds first; `tsx scenarios/run.ts` alone does not.
 *
 * Each run prints one line:
 *
 *   CLAIM name=<n> dialect=<ch|pg> verdict=pass|caught|fail|pending mode=plain|break seconds=<s> [why="..."] [needs=#N]
 *
 * pass: the claim held. caught: under BREAK=1 the property was broken and a
 * check of the claim saw it; for a claim of several parts, each part broke
 * its own property and caught it. fail: a check did not hold on a plain run, a
 * broken run held anyway (break=not-caught), or the run errored, timed out
 * or stalled; an error under BREAK is a fail, not a catch. pending: the
 * feature is not built yet, and needs= names the issue that builds it; a
 * claim whose feature lands switches itself on (each pending claim says
 * what it looks for). Exit 0 when nothing failed, 1 when a run failed, 2 for
 * a bad argument.
 *
 * A claim makes a scratch project from scenarios/fixtures/<dialect>, runs
 * the built yodel bin in it (node_modules/.bin/yodel, dist/bin.js), and
 * checks the result by querying the server: ClickHouse database or Postgres
 * schema yodel_34_<claim> (yodel_34_<claim>_break for the broken run),
 * history yodel_34_<claim>_history; YODEL_CLAIMS_DB_PREFIX replaces
 * yodel_34, so two people running claims on one server do not collide. Server
 * addresses come from YODEL_CLAIMS_CLICKHOUSE_URL, YODEL_CLAIMS_POSTGRES_URL,
 * YODEL_CLAIMS_POSTGRES_USER and YODEL_CLAIMS_POSTGRES_PASSWORD
 * (scenarios/lib/db.ts has the defaults). On a Mac with its own Postgres on
 * 5432, use the LAN address: YODEL_CLAIMS_POSTGRES_URL=postgres://$(ipconfig getifaddr en0):5432/postgres.
 *
 * The runner: every run is its own process (tsx scenarios/claim.ts) with its
 * output in <log dir>/<claim>.<dialect>.<plain|break>.log, under
 * YODEL_CLAIMS_LOG_DIR (default scenarios/.logs/<time>). Runs go
 * YODEL_CLAIMS_JOBS at a time (default 6). A run holds its own database
 * (the plain and the broken run each have one, so they run at once) and
 * whatever its claim lists in `shares` (one named `<dialect>:<thing>` only
 * on that dialect); a run waits while another holds any of them. The slowest claims start first. A run whose log has not grown for YODEL_CLAIMS_STALL_MIN
 * minutes (default 5, or the claim's own stallMinutes), or that runs past
 * YODEL_CLAIMS_TIMEOUT_MIN (default 20), has its process group killed and
 * fails as stalled, its last lines printed. Verdict lines print as runs
 * finish; the summary and the record list claims in their order here.
 *
 * --record FILE: the record's shape is in scenarios/record.ts. When FILE
 * exists, the run replaces the rows of the claims and dialects it ran and
 * keeps every other row; each row carries the time and commit it was run
 * at, so a record merged from several runs stays honest about its rows'
 * ages. A run of every claim replaces every row. --record runs each claim
 * both ways, so it refuses --plain, --break and BREAK.
 *
 * --affected [base]: the change is everything between the merge base with
 * base and the working tree, untracked files included. Each changed path
 * takes the claims of the first line of scenarios/claim-paths.txt whose
 * glob matches it; a path no line matches runs every claim, and docs,
 * tests and the other inert paths the file lists run none. The runner
 * prints one line per claim picked naming the paths and lines that picked
 * it. It is for local runs: the claims workflow runs every claim on every
 * pull request, since a pull request merges only on a full green run.
 * A new file under src/ needs a line there (test/claim-paths.test.ts).
 *
 * The forge claims need a forge: forgejo a local Forgejo
 * (scenarios/forges/forgejo.ts), github act and a mock GitHub
 * (scenarios/forges/github.ts), gitlab a local GitLab
 * (scenarios/forges/gitlab.ts); each file says which variables it reads.
 * CI on GitHub has none of them and runs
 * --skip forgejo,github,gitlab.
 *
 * A new claim: a file in scenarios/claims/ exporting a Claim, listed in
 * scenarios/claims/index.ts.
 */

import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { affected, changedSince, readClaimPaths, reasons, unknownClaims } from "./affected.js";
import { claims } from "./claims/index.js";
import { partRunsOn, type Dialect } from "./lib/claim.js";
import { clickhouseAt, endpoints, postgresQuery } from "./lib/db.js";
import { killGroup } from "./lib/exec.js";
import { humanGate } from "./lib/human-gate.js";
import { mergeRecord, readRecord, type ClaimsRecord, type RecordRow } from "./record.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);

let args: ReturnType<typeof parseArgs>;
try {
  args = parseArgs({
    // --affected takes an optional base: --affected=main is --affected main.
    args: process.argv.slice(2).flatMap((a) => (a.startsWith("--affected=") ? ["--affected", a.slice("--affected=".length)] : [a])),
    allowPositionals: true,
    options: {
      record: { type: "string" },
      plain: { type: "boolean" },
      break: { type: "boolean" },
      dialect: { type: "string" },
      jobs: { type: "string" },
      list: { type: "boolean" },
      skip: { type: "string" },
      affected: { type: "boolean" },
    },
  });
} catch (e) {
  process.stderr.write(`claims: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(2);
}
const opt = args.values as { record?: string; plain?: boolean; break?: boolean; dialect?: string; jobs?: string; list?: boolean; skip?: string; affected?: boolean };
const skipped = (opt.skip ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const fail2 = (message: string): never => {
  process.stderr.write(`claims: ${message}\n`);
  process.exit(2);
};

// The claims named on the command line, or under --affected the ones the change picks.
let named: string[] = args.positionals;
if (opt.affected) {
  if (args.positionals.length > 1) fail2("--affected takes one base and no claim names");
  const base = args.positionals[0] ?? "origin/main";
  const all = claims.map((c) => c.name);
  const or2 = <T>(f: () => T): T => {
    try {
      return f();
    } catch (e) {
      return fail2(`--affected ${base}: ${e instanceof Error ? (e.message.split("\n")[0] ?? "") : String(e)}`);
    }
  };
  const entries = or2(() => readClaimPaths());
  const change = or2(() => changedSince(base, root));
  const bad = unknownClaims(entries, all);
  if (bad.length) fail2(`scenarios/claim-paths.txt names unknown claims: ${bad.join(", ")}`);
  const a = affected(change.paths, entries, all);
  process.stderr.write(`[affected] ${String(change.paths.length)} ${change.paths.length === 1 ? "path" : "paths"} changed since ${change.mergeBase} (merge base with ${base}); ${String(a.claims.length)} of ${String(all.length)} claims picked\n`);
  for (const line of reasons(a)) process.stderr.write(`[affected] ${line}\n`);
  if (a.inert.length) process.stderr.write(`[affected] no claim: ${a.inert.slice(0, 5).join(", ")}${a.inert.length > 5 ? `, and ${String(a.inert.length - 5)} more` : ""}\n`);
  if (!a.claims.length && !opt.list) process.exit(0);
  named = a.claims;
}

if (opt.list) {
  for (const c of claims) {
    if (opt.affected && !named.includes(c.name)) continue;
    const ds = (Object.entries(c.dialects) as Array<[Dialect, unknown]>).map(([d, b]) => (typeof b === "function" ? d : `${d}(${(b as { needs: string }).needs})`));
    process.stdout.write(`${c.name.padEnd(18)} ${ds.join(",").padEnd(16)} ${c.says}${c.parts ? ` (parts: ${c.parts.map((n) => (c.partDialects?.[n] ? `${n} [${c.partDialects[n].join(",")}]` : n)).join(", ")})` : ""}\n`);
  }
  process.exit(0);
}

const unknown = [...named, ...skipped].filter((n) => !claims.some((c) => c.name === n));
if (unknown.length) {
  process.stderr.write(`claims: unknown claim ${unknown.join(", ")}; --list shows them\n`);
  process.exit(2);
}
if (opt.dialect !== undefined && opt.dialect !== "ch" && opt.dialect !== "pg") {
  process.stderr.write("claims: --dialect is ch or pg\n");
  process.exit(2);
}
const envBreak = !!process.env.BREAK && process.env.BREAK !== "0";
// BREAK=<part>: the broken runs break that part alone, so only claims with that part run.
const breakPart = envBreak && process.env.BREAK !== "1" ? process.env.BREAK : undefined;
const modes: Array<"plain" | "break"> = opt.plain ? ["plain"] : opt.break || envBreak ? ["break"] : ["plain", "break"];
if (opt.record && modes.length !== 2) {
  process.stderr.write("claims: --record runs every claim both ways; drop --plain, --break and BREAK\n");
  process.exit(2);
}
// A record that is there but is not one is refused before anything runs.
let oldRecord: ClaimsRecord | undefined;
try {
  oldRecord = opt.record ? readRecord(opt.record) : undefined;
} catch (e) {
  fail2(`--record: ${e instanceof Error ? e.message : String(e)}`);
}
const jobs = Math.max(1, Number(opt.jobs ?? process.env.YODEL_CLAIMS_JOBS ?? 6) || 6);
const stallMin = Number(process.env.YODEL_CLAIMS_STALL_MIN ?? 5) || 5;
const timeoutMin = Number(process.env.YODEL_CLAIMS_TIMEOUT_MIN ?? 20) || 20;
const logDir = process.env.YODEL_CLAIMS_LOG_DIR ?? join(here, ".logs", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(logDir, { recursive: true });

if (!existsSync(join(root, "dist", "bin.js"))) {
  process.stderr.write("claims: dist/bin.js is missing; run npm run build (npm run claims does)\n");
  process.exit(2);
}

interface Run {
  claim: string;
  dialect: Dialect;
  mode: "plain" | "break";
  holds: string[];
  stallMin: number;
  log: string;
}

interface Verdict {
  line: string;
  verdict: string;
  seconds: number | null;
}

const selected = claims.filter((c) => (!named.length || named.includes(c.name)) && !skipped.includes(c.name) && (breakPart === undefined || c.parts?.includes(breakPart)));
if (breakPart !== undefined && !selected.length) fail2(`BREAK=${breakPart}: no claim selected has that part; --list shows the parts`);
const verdicts = new Map<string, Verdict>(); // key: claim:dialect:mode
const key = (c: string, d: string, m: string) => `${c}:${d}:${m}`;
const queue: Run[] = [];

const parseLine = (line: string): Verdict => ({
  line,
  verdict: /verdict=(\w+)/.exec(line)?.[1] ?? "fail",
  seconds: Number(/seconds=(\d+)/.exec(line)?.[1] ?? NaN) || null,
});
const say = (line: string) => {
  process.stdout.write(`${line}\n`);
};

for (const c of selected) {
  for (const [d, body] of Object.entries(c.dialects) as Array<[Dialect, unknown]>) {
    if (opt.dialect && opt.dialect !== d) continue;
    // BREAK=<part> for a part that runs on other dialects only: nothing to break here.
    if (breakPart !== undefined && !partRunsOn(c, breakPart, d)) continue;
    if (typeof body !== "function") {
      const line = `CLAIM name=${c.name} dialect=${d} verdict=pending needs=${(body as { needs: string }).needs}`;
      for (const m of modes) verdicts.set(key(c.name, d, m), parseLine(line));
      say(line);
      continue;
    }
    for (const m of modes) {
      queue.push({ claim: c.name, dialect: d, mode: m, holds: [`db:${c.name}:${d}:${m}`, ...(c.shares ?? []).filter((x) => !/^(ch|pg):/.test(x) || x.startsWith(`${d}:`))], stallMin: c.stallMinutes ?? stallMin, log: join(logDir, `${c.name}.${d}.${m}.log`) });
    }
  }
}
// The longest runs first, by the committed record, so the last to finish is not a slow one started late.
{
  const committed = (() => {
    try {
      return readRecord(join(here, "claims-record.json"));
    } catch {
      return undefined;
    }
  })();
  // A claim not in the record yet goes first: nothing says it is quick.
  const took = (r: Run) => {
    const row = committed?.rows.find((x) => x.claim === r.claim && x.dialect === r.dialect);
    return (r.mode === "plain" ? row?.seconds.plain : row?.seconds.break) ?? Number.MAX_SAFE_INTEGER;
  };
  queue.sort((a, b) => took(b) - took(a));
}

async function reachable(): Promise<void> {
  const need = new Set(queue.map((r) => r.dialect));
  if (need.has("ch")) {
    await clickhouseAt(endpoints.clickhouse, "SELECT 1").then(
      () => undefined,
      (e: unknown) => process.stderr.write(`claims: ClickHouse at ${endpoints.clickhouse} does not answer (${e instanceof Error ? e.message : String(e)}); its claims will fail\n`),
    );
  }
  if (need.has("pg")) {
    await postgresQuery("SELECT 1").then(
      () => undefined,
      (e: unknown) => process.stderr.write(`claims: Postgres at ${endpoints.postgres} does not answer (${e instanceof Error ? e.message : String(e)}); its claims will fail\n`),
    );
  }
}

interface Running {
  run: Run;
  pid: number;
  started: number;
  lastSize: number;
  lastGrowth: number;
  done: Promise<void>;
  exited: boolean;
}

const held = new Set<string>();
const running: Running[] = [];

function start(run: Run): Running {
  const fd = openSync(run.log, "w");
  const child = spawn(process.execPath, ["--import", "tsx", join(here, "claim.ts"), run.claim, run.dialect], {
    cwd: root,
    env: { ...process.env, BREAK: run.mode === "break" ? (breakPart ?? "1") : "" },
    stdio: ["ignore", fd, fd],
    detached: true,
  });
  closeSync(fd);
  for (const h of run.holds) held.add(h);
  process.stderr.write(`[claims] start ${run.claim} ${run.dialect} ${run.mode}\n`);
  const r: Running = { run, pid: child.pid ?? -1, started: Date.now(), lastSize: 0, lastGrowth: Date.now(), exited: false, done: Promise.resolve() };
  r.done = new Promise((resolve) => {
    child.on("close", () => {
      r.exited = true;
      resolve();
    });
    child.on("error", (e) => {
      appendFileSync(run.log, `[claims] could not start: ${e.message}\n`);
      r.exited = true;
      resolve();
    });
  });
  return r;
}

function lastLines(file: string, n: number): string[] {
  try {
    return readFileSync(file, "utf8").trimEnd().split("\n").slice(-n);
  } catch {
    return [];
  }
}

function finish(r: Running): void {
  const { run } = r;
  for (const h of run.holds) held.delete(h);
  const line = lastLines(run.log, 400).filter((l) => l.startsWith(`CLAIM name=${run.claim} `)).at(-1) ?? `CLAIM name=${run.claim} dialect=${run.dialect} verdict=fail mode=${run.mode} why="no verdict line; see ${run.log}"`;
  const v = parseLine(line);
  verdicts.set(key(run.claim, run.dialect, run.mode), v);
  say(line);
  if (v.verdict === "fail") {
    process.stderr.write(`[claims] ${run.claim} ${run.dialect} ${run.mode} failed; its last lines (${relative(process.cwd(), run.log)}):\n`);
    for (const l of lastLines(run.log, 12)) process.stderr.write(`[claims]   ${l}\n`);
  }
  // A claim whose feature is not built is pending both ways: its broken run is not started.
  if (v.verdict === "pending" && run.mode === "plain") {
    for (let i = queue.length - 1; i >= 0; i--) {
      const q = queue[i];
      if (q && q.claim === run.claim && q.dialect === run.dialect && q.mode === "break") {
        queue.splice(i, 1);
        verdicts.set(key(q.claim, q.dialect, "break"), v);
      }
    }
  }
}

/** Kills a run that stopped writing or ran too long; returns true when it did. */
function stalled(r: Running): boolean {
  const now = Date.now();
  let size = 0;
  try {
    size = statSync(r.run.log).size;
  } catch {
    // Not there yet.
  }
  if (size !== r.lastSize) {
    r.lastSize = size;
    r.lastGrowth = now;
  }
  const silent = now - r.lastGrowth > r.run.stallMin * 60_000;
  const tooLong = now - r.started > timeoutMin * 60_000;
  if (!silent && !tooLong) return false;
  const why = silent ? `stalled: no output for ${String(r.run.stallMin)} minutes` : `timed out after ${String(timeoutMin)} minutes`;
  process.stderr.write(`[claims] ${r.run.claim} ${r.run.dialect} ${r.run.mode} ${why}; its last lines:\n`);
  for (const l of lastLines(r.run.log, 5)) process.stderr.write(`[claims]   ${l}\n`);
  killGroup(r.pid);
  appendFileSync(r.run.log, `\nCLAIM name=${r.run.claim} dialect=${r.run.dialect} verdict=fail mode=${r.run.mode} seconds=${String(Math.round((now - r.started) / 1000))} why="${why}"\n`);
  return true;
}

const killAll = () => {
  for (const r of running) killGroup(r.pid);
};
process.on("SIGINT", () => {
  killAll();
  process.exit(130);
});
process.on("SIGTERM", () => {
  killAll();
  process.exit(143);
});

await humanGate("claims");
await reachable();
process.stderr.write(`[claims] ${String(queue.length)} runs, ${String(jobs)} at a time; logs in ${relative(process.cwd(), logDir) || logDir}\n`);
const began = Date.now();
while (queue.length || running.length) {
  for (let i = running.length - 1; i >= 0; i--) {
    const r = running[i];
    if (!r) continue;
    if (!r.exited && stalled(r)) await r.done;
    if (r.exited) {
      running.splice(i, 1);
      finish(r);
    }
  }
  while (running.length < jobs) {
    const at = queue.findIndex((q) => q.holds.every((h) => !held.has(h)));
    if (at < 0) break;
    const [next] = queue.splice(at, 1);
    if (next) running.push(start(next));
  }
  await new Promise((r) => setTimeout(r, 1000));
}
process.stderr.write(`[claims] every run finished in ${String(Math.round((Date.now() - began) / 1000))}s\n`);

// The summary, in claim order.
const rows: Array<{ claim: string; dialect: Dialect; says: string; needs: string | null; plain: Verdict | undefined; broken: Verdict | undefined }> = [];
for (const c of selected) {
  for (const d of Object.keys(c.dialects) as Dialect[]) {
    if (opt.dialect && opt.dialect !== d) continue;
    const plain = verdicts.get(key(c.name, d, "plain"));
    const broken = verdicts.get(key(c.name, d, "break"));
    const needs = /needs=(#\d+)/.exec(plain?.line ?? broken?.line ?? "")?.[1] ?? null;
    rows.push({ claim: c.name, dialect: d, says: c.says, needs, plain, broken });
  }
}
process.stdout.write(`\n${"claim".padEnd(18)} ${"dialect".padEnd(7)} ${"plain".padEnd(8)} ${"BREAK=1".padEnd(8)} needs\n`);
for (const r of rows) {
  process.stdout.write(`${r.claim.padEnd(18)} ${r.dialect.padEnd(7)} ${(r.plain?.verdict ?? "-").padEnd(8)} ${(r.broken?.verdict ?? "-").padEnd(8)} ${r.needs ?? ""}\n`);
}

if (opt.record) {
  const { execFileSync } = await import("node:child_process");
  const gitOut = (a: string[]): string | null => {
    try {
      return execFileSync("git", a, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return null;
    }
  };
  const stamp = {
    recorded: new Date().toISOString(),
    commit: gitOut(["rev-parse", "--short", "HEAD"]),
    dirty: (gitOut(["status", "--porcelain", "--untracked-files=no"]) ?? "") !== "",
  };
  const fresh: RecordRow[] = rows.map((r) => ({
    claim: r.claim,
    dialect: r.dialect,
    says: r.says,
    needs: r.needs,
    plain: r.plain?.verdict ?? null,
    break: r.broken?.verdict ?? null,
    seconds: { plain: r.plain?.seconds ?? null, break: r.broken?.seconds ?? null },
    ...stamp,
  }));
  const order = claims.map((c) => ({ name: c.name, dialects: Object.keys(c.dialects) as Dialect[] }));
  const doc = mergeRecord(oldRecord, fresh, order, stamp);
  writeFileSync(opt.record, `${JSON.stringify(doc, null, 2)}\n`);
  const kept = doc.rows.length - fresh.length;
  process.stderr.write(`[claims] wrote ${opt.record}: ${String(fresh.length)} rows from this run${kept ? `, ${String(kept)} kept from before` : ""}\n`);
}

const failed = [...verdicts.values()].some((v) => v.verdict === "fail");
process.exit(failed ? 1 : 0);
