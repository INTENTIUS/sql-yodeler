/**
 * sql-yodeler's scenarios on chant's e2e harness (INTENTIUS/sql-yodeler#302):
 *
 *   npm run harness                       every scenario in scenarios/harness/scenarios/
 *   npm run harness -- sy-forge-postgres  the named ones
 *   npm run harness -- --list             the scenarios, their claims and what each step expects
 *
 * Like the claims, a person starts it (scenarios/lib/human-gate.ts: a real
 * terminal and `run`, or a grant naming the scenarios' claims). It needs
 * chant's harness (scenarios/harness/harness.ts): on a chant without it, it
 * says so and exits 3, and the claims keep their own runs.
 *
 * The harness stack is the maintainer's to start, with the sql profile:
 * chant's compose project (`harnessProjectDir()`, built with `chant build
 * <dir>/src --lexicon docker`), floci, Forgejo 16.0.5, forgejo-runner with
 * the docker executor on the project network, and the sql emulator's
 * ClickHouse and Postgres. The servers are reached at the stack's host
 * ports (harnessUrls), and the jobs reach them at the network's names
 * (HARNESS_HOSTS). scenarios/harness/seed.ts lists the people and the
 * repository it reads from the environment.
 *
 * Each scenario runs chant's runClaim: the plain arm, then the BREAK arm,
 * each from a fresh project and repository. Every out-of-band command goes
 * through chant's SafeRun, and the scan of its log and the arm's directory
 * must say CLEAN before anything is recorded. A CLEAN run is recorded as an
 * e2e-claim run record on a ledger of the harness's own
 * (YODEL_HARNESS_LEDGER, default ~/.local/state/sql-yodeler/harness-ledger),
 * and scenarios/harness/rows.json is rendered from it (e2e-claims/v1). The
 * runner prints the product-scenario proof each row gives, for
 * scenarios/product-proofs.json (#301).
 *
 * Exit 0 when every scenario's plain run passed and its BREAK run was
 * caught, 1 when one did not, 2 for a bad argument, 3 without the harness
 * or with a scan that was not CLEAN.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { claims } from "../claims/index.js";
import { run } from "../lib/exec.js";
import { repoRoot } from "../lib/project.js";
import { dialectOf, readScenarios, setupOf } from "./catalog.js";
import { lintLocal, loadHarness, type Harness, type Scenario } from "./harness.js";
import { YodelReports, type CommitStatus } from "./reports.js";

const claimNames = claims.map((c) => c.name);

/** The harness's forge as the runner uses it beside the driver: forceMain and a pull request's comments. */
interface RunnerForge {
  forceMain(sha: string): Promise<void>;
  comments(pull: number): Promise<string[]>;
}

/** The plain run's arm and its break mode: the scenario's break.env YODEL_HARNESS_BREAK (skip-approval or gate-never). */
export const breakModeOf = (s: Scenario): string | undefined => s.break.env.YODEL_HARNESS_BREAK;

/** A postgres:// URL without its credentials, which scenarios/lib/db.ts takes on their own. */
const withoutCredentials = (url: string): string => {
  const u = new URL(url);
  u.username = "";
  u.password = "";
  return u.toString();
};

function list(scenarios: ReturnType<typeof readScenarios>): void {
  for (const { scenario: s } of scenarios.values()) {
    process.stdout.write(`${s.id}  claim=${s.claim}  break=${breakModeOf(s) ?? "-"}\n  ${s.title ?? ""}\n`);
    for (const step of s.steps) process.stdout.write(`    ${step.id} (${step.do})${step.expect?.length ? `: ${step.expect.map((e) => JSON.stringify(e)).join(", ")}` : ""}\n`);
  }
}

async function runOne(h: Harness, s: Scenario, urls: Record<"forgejo" | "clickhouse" | "postgres", string>, root: string): Promise<{ ok: boolean; clean: boolean }> {
  const { forgeAccess, seedArm, pullProject, pushLedger, ledgerRuns, forgejo, envOfGate } = await import("./seed.js");
  const setup = setupOf(s.id);
  const dialect = dialectOf(s.id);
  const work = join(root, s.id);
  mkdirSync(work, { recursive: true });
  const access = forgeAccess(process.env, s.id, urls.forgejo);
  process.env.YODEL_HARNESS_FORGEJO_URL = access.url;
  process.env.YODEL_HARNESS_REPO = access.repo;
  const safe = new h.SafeRun({ scratch: join(work, "safe") });
  const log = (line: string) => {
    process.stdout.write(`${line}\n`);
    safe.log(line);
  };
  const clock = { now: () => Date.now(), sleep: (ms: number) => new Promise<void>((res) => setTimeout(res, ms)) };
  const forge = new h.ForgejoForge({ url: access.url, repo: access.repo, admin: access.admin, author: access.author, reviewer: access.reviewer, baseTree: join(work, "project"), clock, checkout: repoRoot }) as RunnerForge;

  let seeded: Awaited<ReturnType<typeof seedArm>> | undefined;
  let armBreak: string | undefined;
  const project = () => {
    if (!seeded) throw new Error("the arm has no project yet");
    return seeded;
  };
  const sources = {
    comments: (pull: number) => forge.comments(pull),
    async statuses(sha: string): Promise<CommitStatus[]> {
      const got = await forgejo<Array<{ context: string; status: string }>>(access, access.admin, "GET", `/repos/${access.repo}/commits/${sha}/statuses?limit=50`);
      return (got ?? []).map((x) => ({ context: x.context, state: x.status }));
    },
    runs: (env: string, op: string) => ledgerRuns(project(), env, op),
  };
  const ports = {
    forge,
    bucket: new YodelReports(sources, setup.waves),
    chant: {
      // The approve command the plan comment gives, as the forge claim runs it: chant approve of the comment's digest, pushed.
      async approve(input: { pull: number; op: string; gate: string; digest: string }): Promise<void> {
        if (armBreak === "skip-approval") {
          log(`BREAK: pull request ${String(input.pull)} is not approved`);
          return;
        }
        const p = project();
        // A gate that is not one of the project's waves is an error before anything is approved.
        envOfGate(input.gate, setup.waves);
        await pullProject(p);
        const approved = await run("npx", ["chant", "approve", input.op, input.gate, "--plan", input.digest], { cwd: p.dir, env: p.env, timeoutMs: 300_000 });
        if (approved.code !== 0) throw new Error(`chant approve ${input.op} ${input.gate} --plan ${input.digest} exited ${String(approved.code)}: ${approved.err.slice(-400)}`);
        await pushLedger(p);
      },
    },
    ledger: { runs: (env: string, op: string) => ledgerRuns(project(), env, op) },
    outOfBand: { run: (command: string[]) => safe.run(command, { YODEL_HARNESS_PROJECT: project().dir }) },
    overlay(name: string): Record<string, string> {
      const files = project().overlays.get(name);
      if (!files) throw new Error(`the arm made no ${name} overlay (it makes ${[...project().overlays.keys()].join(", ")})`);
      return files;
    },
    async arm(arm: "plain" | "break", env: Record<string, string>): Promise<void> {
      armBreak = arm === "break" ? env.YODEL_HARNESS_BREAK : undefined;
      log(`${s.id}: the ${arm} arm's project and repository, from nothing${armBreak ? ` (BREAK: ${armBreak})` : ""}`);
      seeded = await seedArm({
        id: s.id,
        dialect,
        setup,
        breakMode: armBreak,
        work: join(work, arm),
        access,
        servers: { host: { clickhouse: urls.clickhouse, postgres: urls.postgres }, network: { clickhouse: h.HARNESS_HOSTS.clickhouse, postgres: h.HARNESS_HOSTS.postgres } },
        forceMain: (sha) => forge.forceMain(sha),
      });
    },
    clock,
    log,
  };

  const result = await h.runClaim(s, ports, { approver: `forgejo@forgejo:3000:${access.reviewer.login}` });
  log(`${s.id}: plain ${result.verdicts.plain}${result.plain.reason ? ` (${result.plain.reason})` : ""}, break ${result.verdicts.break}${result.break.reason ? ` (${result.break.reason})` : ""}`);
  const verdict = safe.scan([work]);
  if (verdict.verdict !== "CLEAN") {
    log(`${s.id}: the no-real-cloud scan is not CLEAN; nothing is recorded`);
    return { ok: false, clean: false };
  }

  const ledger = process.env.YODEL_HARNESS_LEDGER ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "sql-yodeler", "harness-ledger");
  mkdirSync(ledger, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", ledger]);
  const version = (JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string }).version;
  const chantVersion = (JSON.parse(readFileSync(join(repoRoot, "node_modules", "@intentius", "chant", "package.json"), "utf8")) as { version: string }).version;
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  const at = new Date();
  const row = h.claimRow({ scenario: s, productCommit: commit, engine: { binary: "yodel", version }, verdicts: result.verdicts, at, chant: chantVersion });
  const { appendRunRecord, readRunLedger } = await import("@intentius/chant/lifecycle/run-ledger");
  await h.recordClaimRow({ row, run: result, verdict, append: async (input: Parameters<typeof appendRunRecord>[0]) => {
      await appendRunRecord(input, { cwd: ledger });
    },
  });
  const { records } = await readRunLedger("local", h.CLAIM_OP, { cwd: ledger });
  writeFileSync(join(repoRoot, "scenarios", "harness", "rows.json"), `${JSON.stringify(h.renderClaims("sql-yodeler", h.claimRowsOf(records)), null, 2)}\n`);
  const ok = result.verdicts.plain === "pass" && result.verdicts.break === "caught";
  if (ok) {
    const proof = { kind: "product-scenario", repo: "INTENTIUS/sql-yodeler", scenario: s.id, claim: s.claim, commit, date: at.toISOString().slice(0, 10), engine_version: version };
    log(`${s.id}: for scenarios/product-proofs.json: ${JSON.stringify(proof)}`);
  }
  return { ok, clean: true };
}

export async function main(argv: string[]): Promise<number> {
  const scenarios = readScenarios();
  if (argv.includes("--list")) {
    list(scenarios);
    return 0;
  }
  const unknown = argv.filter((a) => !scenarios.has(a));
  if (unknown.length) {
    process.stderr.write(`not a harness scenario: ${unknown.join(", ")} (npm run harness -- --list)\n`);
    return 2;
  }
  const selected = (argv.length ? argv : [...scenarios.keys()]).map((id) => scenarios.get(id)?.scenario).filter((s): s is Scenario => s !== undefined);
  const h = await loadHarness();
  for (const s of selected) {
    const findings = [...h.lintScenario(s), ...lintLocal(s, claimNames)];
    if (findings.length) {
      process.stderr.write(`${s.id} is not a scenario the harness runs:\n${findings.map((f) => `  ${f.at}: ${f.message}`).join("\n")}\n`);
      return 2;
    }
  }
  const { humanGate } = await import("../lib/human-gate.js");
  await humanGate("claims", [...new Set(selected.map((s) => s.claim))]);

  const urls = h.harnessUrls(h.harnessStack({ project: process.env.YODEL_HARNESS_PROJECT_NAME ?? "yodel-harness" }), process.env);
  // scenarios/lib/db.ts reads these when seed.ts first loads it.
  process.env.YODEL_CLAIMS_CLICKHOUSE_URL ??= urls.clickhouse;
  process.env.YODEL_CLAIMS_POSTGRES_URL ??= withoutCredentials(urls.postgres);
  process.env.YODEL_CLAIMS_DB_PREFIX ??= "yodel_302";
  const root = mkdtempSync(join(tmpdir(), "yodel-harness-"));
  let failed = 0;
  let dirty = 0;
  for (const s of selected) {
    const r = await runOne(h, s, urls, root);
    if (!r.clean) dirty++;
    else if (!r.ok) failed++;
  }
  process.stdout.write(`harness: ${String(selected.length - failed - dirty)} held, ${String(failed)} did not, ${String(dirty)} not CLEAN; work in ${root}\n`);
  return dirty ? 3 : failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
