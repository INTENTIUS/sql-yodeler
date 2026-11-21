import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseYAMLDocument } from "@intentius/chant/yaml";
import { hold, partNames, runParts, Violation, type Claim, type Ctx, type PartEntry } from "../lib/claim.js";
import { endpoints, postgresQuery } from "../lib/db.js";
import { run, type Ran } from "../lib/exec.js";
import { Project } from "../lib/project.js";
import { addColumn, mainTable } from "../lib/schema.js";

/**
 * The environments as stages of chant's pipeline (#384): one change going
 * dev, staging, prod, a soak that holds a promote, and the change risk
 * record. The project's yodel.config.ts sets `ci.promotion` to its three
 * waves, `yodel ci` writes `.chant/pipeline.ts` and the GitHub apply
 * workflow, and the merge's jobs are run here the way a forge runs them:
 * each job's `chant run wave` in the workflow's order, a job running only
 * when the jobs it needs succeeded. The later stages are taken with `yodel
 * promote`, the line each promote job runs. The three environments are the
 * claim's schema in three databases of the Postgres emulator.
 *
 * The parts, each broken on its own under BREAK=1:
 *
 * - stages: dev's and staging's gates are `never`, and the merge's wave
 *   applies a new column to dev and cuts a release (`yodel chant release
 *   cut`), with the column on neither staging nor prod. `yodel promote --to
 *   prod` with staging not yet promoted is refused, nothing applied to prod.
 *   `yodel promote --to staging --release <release>` applies the migration
 *   there. prod takes two approvals: its stage gate (one approval rule)
 *   waits on the release digest, `chant approve yodel-apply <prod> --env
 *   <prod> --plan <release digest>`; approved, the same promote runs prod's
 *   wave, whose gate `always` waits on its plan under the op
 *   `yodel-apply-<prod>`; approved, the same promote again applies the
 *   column to prod. BREAK: the promote into prod passes `--allow-skip`, with
 *   each gate it waits on approved, so the column reaches prod before
 *   staging.
 * - soak-hold: dev soaks for a minute on a command check that fails while a
 *   file is missing. The promote into staging exits 3 naming the soak, with
 *   nothing applied to staging. Once the file is there and the soak's
 *   minute has passed, the promote goes through. BREAK: the soak is left
 *   out of the config, so the promote goes through while the check fails.
 * - risk: with `ci.risk.approveAbove` set, a migration that drops a column
 *   gets a change risk record in `yodel plan <dev> --format markdown` that
 *   names the sql lexicon's destructive class, and dev's wave under gate
 *   `never` waits for an approval (exit 3) with the column still there.
 *   Approved, it applies. BREAK: the risk keys are left out, so the drop
 *   applies unapproved.
 *
 * The record has no row for it until a maintainer runs it: `docs/claims.md`
 * shows it as not recorded.
 */

const STAGES = ["dev", "staging", "prod"] as const;
type Stage = (typeof STAGES)[number];

interface State {
  p: Project;
  /** Each stage's yodel environment and chant profile. */
  envs: Record<Stage, string>;
  /** Whether `column` is on the main table of `stage`'s server. */
  columnOn: (stage: Stage, column: string) => Promise<boolean>;
  /** The file the soak's command check looks for. */
  soakFile: string;
}

// ── The project ──────────────────────────────────────────────────────────────

/** Each later stage's database on the Postgres emulator, beside the one the claim's schema lives in. */
const databaseOf = (ctx: Ctx, stage: Stage): string | undefined => (stage === "dev" ? undefined : `${ctx.db.name}_${stage}`);

function urlOf(ctx: Ctx, stage: Stage): string {
  const db = databaseOf(ctx, stage);
  if (!db) return endpoints.postgres;
  const url = new URL(endpoints.postgres);
  url.pathname = `/${db}`;
  return url.toString();
}

async function dropDatabases(ctx: Ctx): Promise<void> {
  for (const stage of STAGES) {
    const db = databaseOf(ctx, stage);
    if (db) await postgresQuery(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  }
}

async function queryOn(ctx: Ctx, stage: Stage, sql: string): Promise<number> {
  if (stage === "dev") return Number(Object.values((await postgresQuery(sql))[0] ?? {})[0] ?? 0);
  const pg = (await import("pg")).default;
  const url = new URL(urlOf(ctx, stage));
  const client = new pg.Client({ host: url.hostname, port: Number(url.port || 5432), database: url.pathname.slice(1), user: endpoints.postgresUser, password: endpoints.postgresPassword });
  await client.connect();
  try {
    return Number(Object.values(((await client.query(sql)) as { rows: Array<Record<string, unknown>> }).rows[0] ?? {})[0] ?? 0);
  } finally {
    await client.end();
  }
}

const migrateOp = (env: string) => `import { Op, phase, gate, shell, stepOutput } from "@intentius/chant/op";

const plan = shell("yodel apply ${env} --digest", { id: "plan" });
const digest = stepOutput(plan, "stdout");

export const op = Op({
  name: "migrate-${env}",
  overview: "Apply the pending migrations to ${env}",
  phases: [
    phase("Plan", [plan]),
    phase("Approve", [gate("approve-migrate-${env}", { plan: digest })]),
    phase("Apply", [shell("yodel apply ${env} --execute", { env: { YODEL_APPROVED_PLAN: digest }, timeout: "2h" })]),
  ],
});
`;

async function setup(ctx: Ctx): Promise<State> {
  for (const stage of STAGES) {
    const db = databaseOf(ctx, stage);
    if (db) await postgresQuery(`CREATE DATABASE ${db}`);
  }
  const p = await Project.create(ctx, { ops: "none" });
  const envs = Object.fromEntries(STAGES.map((s) => [s, `${ctx.env}-${s}`])) as Record<Stage, string>;
  const profile = (stage: Stage) =>
    `{ url: "${urlOf(ctx, stage)}", user: { env: "YODEL_CLAIMS_POSTGRES_USER" }, password: { env: "YODEL_CLAIMS_POSTGRES_PASSWORD" }, schemas: ["${ctx.db.name}"], lockTimeoutMs: 500 }`;
  p.write(
    "chant.config.ts",
    `import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-sql";

export default {
  lexicons: ["sql"],
  sql: {
    dialect: "postgres",
    profiles: {
${STAGES.map((s) => `      "${envs[s]}": ${profile(s)},`).join("\n")}
    },
  },
} satisfies ChantConfig;
`,
  );
  for (const s of STAGES) p.write(`ops/migrate-${envs[s]}.op.ts`, migrateOp(envs[s]));
  const table = mainTable(ctx);
  const st: State = {
    p,
    envs,
    soakFile: join(ctx.work, "soak-ok"),
    columnOn: async (stage, column) =>
      (await queryOn(ctx, stage, `SELECT count(*) FROM information_schema.columns WHERE table_schema = '${ctx.db.name}' AND table_name = '${table}' AND column_name = '${column}'`)) === 1,
  };
  return st;
}

/** What a part sets beside the three stages. */
interface Keys {
  /** dev soaks for a minute on the command check. */
  soak?: boolean;
  /** `ci.risk.approveAbove`. */
  risk?: boolean;
  /** prod's two gates: an approval rule on its stage gate, and its wave's gate `always`. */
  twoGates?: boolean;
}

/** yodel.config.ts: the three waves, gate `never` unless `keys` says otherwise, as the stages of chant's pipeline. */
function yodelConfig(st: State, keys: Keys = {}): string {
  const history = st.p.ctx.db.history;
  const stageKeys = [
    ...(keys.soak ? [`"${st.envs.dev}": { soak: { duration: "1m", checks: [{ kind: "command", command: ["test", "-f", ${JSON.stringify(st.soakFile)}] }] } }`] : []),
    ...(keys.twoGates ? [`"${st.envs.prod}": { approvalRules: [{ count: 1 }] }`] : []),
  ];
  const soak = stageKeys.length > 0 ? `, environments: { ${stageKeys.join(", ")} }` : "";
  const risk = keys.risk ? `, risk: { approveAbove: 0.1 }` : "";
  const gate = (s: Stage) => (keys.twoGates && s === "prod" ? "always" : "never");
  return `import type { YodelConfig } from "@intentius/sql-yodeler";

export default {
  environments: {
${STAGES.map((s) => `    "${st.envs[s]}": { history: { database: "${history}" } },`).join("\n")}
  },
  waves: [
${STAGES.map((s) => `    { env: "${st.envs[s]}", gate: "${gate(s)}" },`).join("\n")}
  ],
  ci: { forges: ["github"], promotion: [${STAGES.map((s) => `"${st.envs[s]}"`).join(", ")}]${soak}${risk} },
} satisfies YodelConfig;
`;
}

/** Writes yodel.config.ts and what `yodel ci` writes from it, and commits both. */
async function render(st: State, message: string, keys: Keys = {}): Promise<void> {
  st.p.write("yodel.config.ts", yodelConfig(st, keys));
  const ran = await st.p.yodel(["ci"], { timeoutMs: 300_000 });
  if (ran.code !== 0) throw new Error(`yodel ci exited ${String(ran.code)}:\n${ran.out}\n${ran.err}`);
  if (!existsSync(st.p.path(".chant", "pipeline.ts"))) throw new Error("yodel ci wrote no .chant/pipeline.ts with ci.promotion set");
  await st.p.commit(message);
}

/** A migration from the schema as it is now, committed. */
async function migrate(st: State, name: string, message: string): Promise<void> {
  const id = await st.p.newMigration(name);
  if (!id) throw new Error(`yodel new ${name} wrote no migration`);
  await st.p.commit(message);
}

// ── The merge's jobs and the promotes ────────────────────────────────────────

interface JobResult {
  ok: boolean;
  code: number;
  out: string;
}

/** Runs the rendered GitHub apply workflow's jobs in order, as waves.ts does: a job whose needs did not all succeed is skipped, and one that already succeeded is not run again. */
async function merge(st: State, done: Map<string, JobResult> = new Map()): Promise<Map<string, JobResult>> {
  const doc = parseYAMLDocument(st.p.read(".github/workflows/yodel-apply.yml")) as { jobs: Record<string, { needs?: string[]; steps: Array<{ run?: string }> }> };
  const results = new Map(done);
  for (const [name, job] of Object.entries(doc.jobs)) {
    if (results.get(name)?.ok) continue;
    if ((job.needs ?? []).some((n) => !results.get(n)?.ok)) {
      results.delete(name);
      continue;
    }
    const command = job.steps.map((s) => (s.run ?? "").replace(/^yodel chant /, "chant ")).find((r) => r.startsWith("chant run wave "));
    if (!command) continue;
    const ran = await run("chant", command.split(" ").slice(1), { cwd: st.p.dir, env: st.p.envFor(), timeoutMs: 600_000 });
    results.set(name, { ok: ran.code === 0, code: ran.code, out: `${ran.out}\n${ran.err}` });
  }
  return results;
}

/** dev's wave job: the only wave the merge runs with ci.promotion set. */
const devWave = (results: Map<string, JobResult>): JobResult | undefined => [...results].find(([name]) => /^wave-\d+-/.test(name))?.[1];

/** The release the merge's wave cut at HEAD, from `chant release list --json`: its label (else its digest), and its digest. */
async function releaseAtHead(st: State): Promise<{ ref: string; digest: string }> {
  const head = (await st.p.git("rev-parse", "HEAD")).out.trim();
  const listed = await st.p.chant(["release", "list", "--json"]);
  if (listed.code !== 0) throw new Error(`chant release list exited ${String(listed.code)}: ${listed.err}`);
  const doc = JSON.parse(listed.out) as { releases?: Array<{ releaseDigest: string; label?: string | null; commit?: string }> };
  const cut = (doc.releases ?? []).filter((r) => r.commit === head).at(-1);
  if (!cut) throw new Error(`the merge's wave cut no release at ${head.slice(0, 12)}`);
  return { ref: cut.label ?? cut.releaseDigest, digest: cut.releaseDigest };
}

/** `yodel promote --to <stage> --release <release>`, the line each promote job runs. */
const promote = (st: State, to: Stage, release: string, extra: string[] = []): Promise<Ran> => st.p.yodel(["promote", "--to", st.envs[to], "--release", release, ...extra], { timeoutMs: 600_000 });

/** The `chant approve` line a waiting gate printed (in yodel's words or chant's), as chant's own. */
function approveLine(ran: Ran): string | undefined {
  const line = /(?:yodel )?chant approve \S+ \S+(?: --env \S+)? --plan \S+/.exec(`${ran.out}\n${ran.err}`)?.[0];
  return line?.replace(/^yodel /, "");
}

/** A promote whose waiting gates are each approved and the same promote run again, as a person would, up to four times. */
async function promoteThrough(st: State, to: Stage, release: string, extra: string[] = []): Promise<Ran> {
  let ran = await promote(st, to, release, extra);
  for (let i = 0; i < 4 && ran.code === 3; i++) {
    const line = approveLine(ran);
    if (!line) break;
    await st.p.approve(line, { approver: "claims-approver" });
    ran = await promote(st, to, release, extra);
  }
  return ran;
}

const said = (ran: Pick<Ran, "code" | "out" | "err">): string => `exit ${String(ran.code)}: ${`${ran.out}\n${ran.err}`.trim().split("\n").slice(-3).join(" ")}`;

// ── The parts ────────────────────────────────────────────────────────────────

async function stages(ctx: Ctx, st: State): Promise<void> {
  await render(st, "the stages: dev, staging, prod; prod with two gates", { twoGates: true });
  addColumn(st.p, "staged");
  await migrate(st, "add-staged", "feat: a staged column");

  const merged = await merge(st);
  const wave = devWave(merged);
  hold(wave?.ok === true, `the merge's wave did not apply dev (${wave ? said({ code: wave.code, out: wave.out, err: "" }) : "no wave job"})`);
  hold(await st.columnOn("dev", "staged"), "the column is not on dev after the merge's wave");
  hold(!(await st.columnOn("staging", "staged")) && !(await st.columnOn("prod", "staged")), "the merge applied a later stage; with ci.promotion it applies the first stage alone");
  const { ref: release, digest } = await releaseAtHead(st);
  ctx.log(`the merge cut release ${release}`);

  // prod before staging: refused, nothing applied. Broken, the promote passes --allow-skip and each gate it waits on is approved.
  if (ctx.broken) ctx.log("BREAK: the promote into prod passes --allow-skip, with each gate it waits on approved");
  const early = ctx.broken ? await promoteThrough(st, "prod", release, ["--allow-skip"]) : await promote(st, "prod", release);
  hold(!(await st.columnOn("prod", "staged")), `prod got the column before staging (${said(early)})`);
  hold(early.code !== 0, `yodel promote --to prod with staging not promoted was not refused (${said(early)})`);

  const toStaging = await promote(st, "staging", release);
  hold(toStaging.code === 0 && (await st.columnOn("staging", "staged")), `yodel promote --to staging did not apply the release there (${said(toStaging)})`);

  // prod's first approval: its stage gate, on the release digest.
  const atStage = await promote(st, "prod", release);
  const stageLine = approveLine(atStage);
  hold(atStage.code === 3 && !(await st.columnOn("prod", "staged")), `the promote into prod did not wait at prod's stage gate (${said(atStage)})`);
  hold(stageLine !== undefined && stageLine.includes(` --env ${st.envs.prod} `) && stageLine.endsWith(` --plan ${digest}`), `prod's stage gate does not wait on the release digest ${digest}: ${String(stageLine)}`);
  await st.p.approve(stageLine, { approver: "claims-approver" });

  // prod's second approval: its wave's gate, on the wave's plan, under the op yodel-apply-<prod>.
  const atWave = await promote(st, "prod", release);
  const waveLine = approveLine(atWave);
  hold(atWave.code === 3 && !(await st.columnOn("prod", "staged")), `with prod's stage gate approved, prod's wave under gate always did not wait (${said(atWave)})`);
  hold(waveLine !== undefined && waveLine.startsWith(`chant approve yodel-apply-${st.envs.prod} `) && !waveLine.endsWith(` --plan ${digest}`), `prod's wave does not wait on its plan under the op yodel-apply-${st.envs.prod}: ${String(waveLine)}`);
  await st.p.approve(waveLine, { approver: "claims-approver" });

  const toProd = await promote(st, "prod", release);
  hold(toProd.code === 0 && (await st.columnOn("prod", "staged")), `yodel promote --to prod did not apply the release once both gates were approved (${said(toProd)})`);
}

async function soakHold(ctx: Ctx, st: State): Promise<void> {
  if (ctx.broken) ctx.log("BREAK: dev's soak is left out of the config");
  await render(st, "dev soaks for a minute on a command check", { soak: !ctx.broken });
  addColumn(st.p, "soaked");
  await migrate(st, "add-soaked", "feat: a soaked column");
  const wave = devWave(await merge(st));
  hold(wave?.ok === true, "the merge's wave did not apply dev");
  const { ref: release } = await releaseAtHead(st);

  // The check fails while the file is missing: the promote into staging waits on dev's soak.
  const held = await promote(st, "staging", release);
  hold(!(await st.columnOn("staging", "soaked")), `staging got the column while dev's soak check failed (${said(held)})`);
  hold(held.code === 3 && /soak/i.test(`${held.out}\n${held.err}`), `the promote into staging did not wait on dev's soak (${said(held)})`);

  // The check passes, and once the soak's minute has passed the promote goes through.
  writeFileSync(st.soakFile, "ok\n");
  await new Promise((ok) => setTimeout(ok, 65_000));
  const through = await promote(st, "staging", release);
  hold(through.code === 0 && (await st.columnOn("staging", "soaked")), `the promote into staging did not go through once dev's soak passed (${said(through)})`);
}

async function risk(ctx: Ctx, st: State): Promise<void> {
  if (ctx.broken) ctx.log("BREAK: the risk keys are left out of the config");
  await render(st, "a change risk threshold for every stage", { risk: !ctx.broken });
  addColumn(st.p, "gone");
  await migrate(st, "add-gone", "feat: a column to drop");
  hold(devWave(await merge(st))?.ok === true, "the merge's wave did not apply the column to drop");

  st.p.edit("src/schema.ts", /,\n {4}gone [^\n]*/, "");
  await migrate(st, "drop-gone", "feat: drop gone");
  const note = await st.p.yodel(["plan", st.envs.dev, "--format", "markdown"]);
  hold(note.code === 0 && /destructive migration classes: [^\n]*destructive/.test(note.out), `yodel plan ${st.envs.dev} --format markdown shows no change risk naming the destructive class (exit ${String(note.code)})`);

  const first = await merge(st);
  const waiting = devWave(first);
  hold(waiting?.code === 3, `dev's wave did not wait for an approval over the risk threshold (exit ${String(waiting?.code)})`);
  hold(await st.columnOn("dev", "gone"), "the column was dropped on dev with no approval");
  const approve = /chant approve \S+ \S+ --plan \S+/.exec(waiting.out)?.[0];
  if (!approve) throw new Error("the waiting wave printed no chant approve command");
  await st.p.approve(approve);
  const after = devWave(await merge(st, first));
  hold(after?.ok === true && !(await st.columnOn("dev", "gone")), "the approved drop did not apply on dev");
}

/** A part that caught its break leaves the stages apart; the next part renders its own config and starts from a new migration, so nothing is levelled. */
const caught = (part: (ctx: Ctx, st: State) => Promise<void>) => async (ctx: Ctx, st: State) => {
  try {
    await part(ctx, st);
  } catch (e) {
    if (e instanceof Violation) await st.p.git("checkout", "-q", "--", ".");
    throw e;
  }
};

const parts: ReadonlyArray<PartEntry<State>> = [
  ["stages", caught(stages)],
  ["soak-hold", caught(soakHold)],
  ["risk", caught(risk)],
];

async function body(ctx: Ctx): Promise<void> {
  await dropDatabases(ctx);
  try {
    await runParts(ctx, await setup(ctx), parts);
  } finally {
    await dropDatabases(ctx);
  }
}

export const pipeline: Claim = {
  name: "pipeline",
  says: "with ci.promotion, one change goes dev, staging, prod through chant's folded pipeline: the merge applies dev and cuts a release, and yodel promote takes it into staging and prod, each behind its stage gate; a failing soak check on a stage holds the promote into the stage after it; a migration that drops a column gets a change risk record naming the sql lexicon's destructive class, shown in the plan note, and over the stage's threshold its wave waits for an approval",
  dialects: { pg: body },
  parts: partNames(parts),
  stallMinutes: 20,
};
