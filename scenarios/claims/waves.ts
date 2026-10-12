import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clickhouseImage } from "@intentius/chant-lexicon-sql/spec/pin";
import { parseYAMLDocument } from "@intentius/chant/yaml";
import { applyPipelines, withTenants, type Wave } from "../../src/ci/render.js";
import type { WaveGate } from "../../src/config/define.js";
import { hold, partDialects, partNames, runParts, Violation, type Claim, type Ctx, type PartEntry } from "../lib/claim.js";
import { clickhouseAt, endpoints, postgresQuery } from "../lib/db.js";
import { run, type Ran } from "../lib/exec.js";
import { parse, Project } from "../lib/project.js";
import { addColumn, addTable, mainTable } from "../lib/schema.js";

/**
 * The apply pipeline as waves (#42): two environments, staging then prod,
 * each a wave of the pipeline yodel ci renders from
 * yodel.config.ts `waves`, run here the way a forge runs it: each job's
 * `chant run wave` in the order of the rendered GitHub workflow, a job
 * running only when the jobs it needs succeeded, on commits whose first
 * parent is the base the gate policy is read at. The environments are two
 * servers: on Postgres two databases of the emulator (the claim's schema in
 * each), on ClickHouse the emulator and a scratch server (the same database
 * name in each, as two environments have).
 *
 * Which approvals count (read at the base, sealed, stale) and the order the
 * jobs run in are chant's op-waves, proven by chant. The parts, each broken
 * on its own under BREAK=1; only tenants differs by dialect, so the rest
 * run on Postgres:
 *
 * - gate-policy: under `on-destructive` a new table applies with no
 *   approval, and a column drop waits (exit 3) with the column still there;
 *   `yodel approve <staging>` at a terminal (#87, the answer typed is the
 *   environment's name) approves the wave's gate, and it applies. BREAK: the
 *   pipeline is rendered with `gate: never`, so the drop applies unapproved.
 * - promotion (#43): prod requires staging (the wave before, by default).
 *   prod's wave run on its own, and `yodel apply` of prod, refuse (exit 4,
 *   nothing applied) a migration staging has not applied; `yodel plan` of
 *   prod shows it has not run on staging; once staging has applied it, prod
 *   applies it. BREAK: the requirement is removed (`requires: false`), so the
 *   column reaches prod first.
 * - report (#87): after the waves above applied, `yodel report` of both
 *   environments finds every applied migration's approval, on the wave's
 *   gate, or none needed by the wave's policy, and shows no gap. BREAK:
 *   yodel built to look for approvals on the migrations Op's gate alone, so
 *   the migrations the waves applied are gaps.
 * - tenants (#56): a third environment is a tenant set of three schemas
 *   (Postgres) or databases (ClickHouse) on the staging server, its wave
 *   split into a deciding job and two share jobs. The wave waits once, on
 *   one approval of the set digest, with nothing applied; approved, every
 *   tenant gets every migration, each in its own history, and `yodel
 *   status` counts them up to date. Then the set is read by a query (a
 *   registry table): the pipeline is rendered once, and a tenant added to
 *   the registry afterwards renders the same files. A migration with a
 *   backfill step: `yodel plan <set> --format markdown` is one comment for
 *   every tenant, naming the digest the deciding job then waits on; `yodel
 *   approve <set>` approves it; the wave applies to all four tenants, the
 *   new one from its first migration, and the backfill runs on each
 *   tenant's own table. BREAK: the wave is rendered with the first tenant
 *   alone, so the others never get the migrations.
 * - steps (#64): staging has steps around apply, read at the base commit,
 *   as chant's stage hooks (#206): a before command that appends a line to
 *   a file, and an after step. The wave applies, the command having run
 *   once (#107), and the history records the steps' outcomes, which `yodel
 *   report` lists. BREAK: the waves spec runs the command as a before-plan
 *   hook too, so it runs when the wave is planned as well.
 */

interface Envs {
  staging: string;
  prod: string;
  /** A tenant set on the staging server (#56): its tenants are {@link tenantNames}. */
  tenants: string;
}

interface State {
  p: Project;
  envs: Envs;
  /** Each environment's server, asked directly. */
  columnOn: (env: keyof Envs, column: string) => Promise<boolean>;
  tableOn: (env: keyof Envs) => Promise<boolean>;
}

const ENV_KEYS = ["staging", "prod"] as const;

// ── The pipeline, as a forge runs it ─────────────────────────────────────────

/** Writes yodel.config.ts with these waves, and the pipelines and the waves spec rendered from it; the options break the rendering. */
async function render(st: State, waves: readonly Wave[], options: { allNever?: boolean; noRequires?: boolean; firstTenantOnly?: boolean; steps?: string; tenantQuery?: string; dropBeforeCommand?: boolean } = {}): Promise<void> {
  const { p } = st;
  p.write("yodel.config.ts", yodelConfig(st, waves, options.noRequires === true, options.steps, options.tenantQuery));
  // A tenant set's wave has a run per tenant, as yodel ci renders it.
  let ws: readonly Wave[] = await withTenants(p.dir, options.allNever ? waves.map((w): Wave => ({ ...w, gate: "never" })) : waves);
  if (options.firstTenantOnly) ws = ws.map((w) => (w.targets ? { ...w, targets: w.targets.slice(0, 1), shares: 1 } : w));
  const files = await applyPipelines(p.dir, { dialect: p.ctx.dialect === "ch" ? "clickhouse" : "postgres", names: ws.map((w) => w.env), replay: false, waves: ws });
  for (const f of files) {
    let content = f.content;
    if (options.dropBeforeCommand && f.path === "yodel-waves.json") {
      const spec = JSON.parse(content) as { waves: Array<{ hooks?: { before?: { apply?: Array<{ command: string[] }> } } }> };
      let dropped = 0;
      for (const w of spec.waves) {
        const before = w.hooks?.before;
        if (!before?.apply) continue;
        const kept = before.apply.filter((h) => h.command[0] !== "sh");
        dropped += before.apply.length - kept.length;
        before.apply = kept;
      }
      if (dropped === 0) throw new Error("the rendered waves spec has no before command to drop");
      content = `${JSON.stringify(spec, null, 2)}\n`;
    }
    p.write(f.path, content);
  }
}

interface JobResult {
  ok: boolean;
  code: number;
  out: string;
}

/**
 * Runs the rendered GitHub workflow's jobs in order: a job whose needs did
 * not all succeed is skipped, and a job that already succeeded (in `done`)
 * is not run again, as "re-run failed jobs" does.
 */
async function pipeline(st: State, done: Map<string, JobResult> = new Map(), env: Record<string, string> = {}, extraArgs: string[] = []): Promise<Map<string, JobResult>> {
  const doc = parseYAMLDocument(st.p.read(".github/workflows/yodel-apply.yml")) as { jobs: Record<string, { needs?: string[]; steps: Array<{ run?: string }> }> };
  const results = new Map(done);
  for (const [name, job] of Object.entries(doc.jobs)) {
    if (results.get(name)?.ok) continue;
    if ((job.needs ?? []).some((n) => !results.get(n)?.ok)) {
      st.p.ctx.log(`${name}: skipped, a job it needs did not succeed`);
      results.delete(name);
      continue;
    }
    const command = job.steps.map((s) => s.run ?? "").find((r) => r.startsWith("chant run wave "));
    if (!command) throw new Error(`${name} runs no chant run wave`);
    const ran = await run("chant", [...command.split(" ").slice(1), ...extraArgs], { cwd: st.p.dir, env: st.p.envFor(env), timeoutMs: 600_000 });
    results.set(name, { ok: ran.code === 0, code: ran.code, out: `${ran.out}\n${ran.err}` });
  }
  return results;
}

/** The chant approve command a waiting wave printed. */
function approveCommand(result: JobResult | undefined): string {
  const cmd = /chant approve \S+ \S+ --plan \S+/.exec(result?.out ?? "")?.[0];
  if (!cmd) throw new Error("the waiting wave printed no chant approve command");
  return cmd;
}

const job = (st: State, k: number, env: keyof Envs) => `wave-${String(k)}-${st.envs[env]}`;

// ── The project ──────────────────────────────────────────────────────────────

/** yodel.config.ts with these waves; `stagingSteps` is staging's `steps`, as TypeScript. */
function yodelConfig(st: State, waves: readonly Wave[], noRequires = false, stagingSteps?: string, tenantQuery?: string): string {
  const history = st.p.ctx.db.history;
  return `import type { YodelConfig } from "@intentius/sql-yodeler";

export default {
  environments: {
${ENV_KEYS.map((k) => `    "${st.envs[k]}": { history: { database: "${history}" }${k === "staging" && stagingSteps ? `, steps: ${stagingSteps}` : ""} },`).join("\n")}
    "${st.envs.tenants}": { history: { database: "${history}" }, tenants: ${tenantQuery ? `{ query: ${JSON.stringify(tenantQuery)} }` : JSON.stringify(tenantNames(st.p.ctx))} },
  },
  waves: [
${waves.map((w, i) => `    { env: "${w.env}", gate: "${w.gate}"${noRequires && i > 0 ? ", requires: false" : ""}${w.shares ? `, shares: ${String(w.shares)}` : ""}${w.approval ? `, approval: "${w.approval}"` : ""} },`).join("\n")}
  ],
} satisfies YodelConfig;
`;
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

/** prod's server: a database of its own on the Postgres emulator, or a scratch ClickHouse server. */
async function prodServer(ctx: Ctx): Promise<{ url: string; close: () => Promise<void> }> {
  if (ctx.dialect === "pg") {
    const name = `${ctx.db.name}_prod`;
    const drop = () => postgresQuery(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await drop();
    await postgresQuery(`CREATE DATABASE ${name}`);
    const url = new URL(endpoints.postgres);
    url.pathname = `/${name}`;
    return { url: url.toString(), close: async () => { await drop(); } };
  }
  const name = `yodel-34-waves-${randomBytes(3).toString("hex")}`;
  const docker = (args: string[]) => spawnSync("docker", args, { encoding: "utf8" });
  const started = docker(["run", "--detach", "--rm", "--name", name, "--publish", "127.0.0.1::8123", "--env", "CLICKHOUSE_SKIP_USER_SETUP=1", clickhouseImage()]);
  if (started.status !== 0) throw new Error(`could not start prod's ClickHouse server: ${started.stderr}`);
  const close = () => {
    docker(["rm", "--force", "--volumes", name]);
    return Promise.resolve();
  };
  try {
    const port = /:(\d+)\s*$/m.exec(docker(["port", name, "8123/tcp"]).stdout)?.[1];
    if (!port) throw new Error(`docker did not publish ${name}'s port 8123`);
    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; ; i++) {
      try {
        await clickhouseAt(url, "SELECT 1");
        break;
      } catch (e) {
        if (i > 60) throw e;
        await new Promise((ok) => setTimeout(ok, 1000));
      }
    }
    ctx.log(`prod's ClickHouse server: ${name} on ${url}`);
    return { url, close };
  } catch (e) {
    await close();
    throw e;
  }
}

/** The tenant set's tenants: three schemas or databases beside the claim's own on the staging server. */
const tenantNames = (ctx: Ctx): string[] => ["t1", "t2", "t3"].map((t) => `${ctx.db.name}_${t}`);

/** The tenant added to the registry once the set is read by a query. */
const lateTenant = (ctx: Ctx): string => `${ctx.db.name}_t4`;

/** The registry a tenant set read by a query lists its tenants from: a table of names in a database (schema) of its own. */
const registry = (ctx: Ctx): string => `${ctx.db.name}_registry`;

/** Drops the tenants, their histories and the registry. */
async function dropTenants(ctx: Ctx): Promise<void> {
  if (ctx.dialect === "ch") await clickhouseAt(endpoints.clickhouse, `DROP DATABASE IF EXISTS ${registry(ctx)} SYNC`);
  else await postgresQuery(`DROP SCHEMA IF EXISTS ${registry(ctx)} CASCADE`);
  for (const t of [...tenantNames(ctx), lateTenant(ctx)]) {
    for (const name of [t, `${ctx.db.history}_${t}`]) {
      if (ctx.dialect === "ch") await clickhouseAt(endpoints.clickhouse, `DROP DATABASE IF EXISTS ${name} SYNC`);
      else await postgresQuery(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
    }
  }
}

async function setup(ctx: Ctx, prodUrl: string): Promise<State> {
  const p = await Project.create(ctx, { ops: "none" });
  const envs: Envs = { staging: `${ctx.env}-staging`, prod: `${ctx.env}-prod`, tenants: `${ctx.env}-tenants` };
  const db = ctx.db.name;
  const profile = (url: string) =>
    ctx.dialect === "ch"
      ? `{ url: "${url}", databases: ["${db}"] }`
      : `{ url: "${url}", user: { env: "YODEL_CLAIMS_POSTGRES_USER" }, password: { env: "YODEL_CLAIMS_POSTGRES_PASSWORD" }, schemas: ["${db}"], lockTimeoutMs: 500 }`;
  p.write(
    "chant.config.ts",
    `import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-sql";

export default {
  lexicons: ["sql"],
  sql: {
    dialect: "${ctx.dialect === "ch" ? "clickhouse" : "postgres"}",
    profiles: {
      "${envs.staging}": ${profile(ctx.dialect === "ch" ? endpoints.clickhouse : endpoints.postgres)},
      "${envs.prod}": ${profile(prodUrl)},
      "${envs.tenants}": ${profile(ctx.dialect === "ch" ? endpoints.clickhouse : endpoints.postgres)},
    },
  },
} satisfies ChantConfig;
`,
  );
  for (const env of [envs.staging, envs.prod, envs.tenants]) p.write(`ops/migrate-${env}.op.ts`, migrateOp(env));
  const table = mainTable(ctx);
  const ask = async (env: keyof Envs, sql: { ch: string; pg: string }): Promise<number> => {
    if (ctx.dialect === "ch") return Number((await clickhouseAt(env === "staging" ? endpoints.clickhouse : prodUrl, sql.ch)).trim() || "0");
    if (env === "staging") return Number(Object.values((await postgresQuery(sql.pg))[0] ?? {})[0] ?? 0);
    const pg = (await import("pg")).default;
    const url = new URL(prodUrl);
    const client = new pg.Client({ host: url.hostname, port: Number(url.port || 5432), database: url.pathname.slice(1), user: endpoints.postgresUser, password: endpoints.postgresPassword });
    await client.connect();
    try {
      return Number(Object.values(((await client.query(sql.pg)) as { rows: Array<Record<string, unknown>> }).rows[0] ?? {})[0] ?? 0);
    } finally {
      await client.end();
    }
  };
  const st: State = {
    p,
    envs,
    columnOn: async (env, column) =>
      (await ask(env, {
        ch: `SELECT count() FROM system.columns WHERE database = '${db}' AND table = '${table}' AND name = '${column}'`,
        pg: `SELECT count(*) FROM information_schema.columns WHERE table_schema = '${db}' AND table_name = '${table}' AND column_name = '${column}'`,
      })) === 1,
    tableOn: async (env) =>
      (await ask(env, {
        ch: `SELECT count() FROM system.tables WHERE database = '${db}' AND name = '${table}'`,
        pg: `SELECT count(*) FROM information_schema.tables WHERE table_schema = '${db}' AND table_name = '${table}'`,
      })) === 1,
  };
  return st;
}

const waves = (st: State, staging: WaveGate, prod: WaveGate): Wave[] => [
  { env: st.envs.staging, gate: staging },
  { env: st.envs.prod, gate: prod },
];

/** A migration from the schema as it is now, committed. */
async function migrate(st: State, name: string, message: string): Promise<void> {
  const id = await st.p.newMigration(name);
  if (!id) throw new Error(`yodel new ${name} wrote no migration`);
  await st.p.commit(message);
}

// ── The parts ────────────────────────────────────────────────────────────────

async function gatePolicy(ctx: Ctx, st: State, broken: boolean): Promise<void> {
  // The base: both waves on-destructive (rendered as never under BREAK).
  await render(st, waves(st, "on-destructive", "on-destructive"), { allNever: broken });
  addColumn(st.p, "gone");
  await st.p.commit("the waves, on-destructive");
  await migrate(st, "create", "feat: the schema");
  const first = await pipeline(st);
  hold(first.get(job(st, 1, "staging"))?.ok === true && first.get(job(st, 2, "prod"))?.ok === true, "a new table did not apply to both waves without an approval under on-destructive");
  hold((await st.tableOn("staging")) && (await st.tableOn("prod")), "the new table is not on both servers");

  // A column drop waits at staging, with the column still there.
  st.p.edit("src/schema.ts", new RegExp(`,\\n {4}gone [^\\n]*`), "");
  await migrate(st, "drop-gone", "feat: drop gone");
  const drop = await pipeline(st);
  const staging = drop.get(job(st, 1, "staging"));
  hold(staging?.code === 3, `the column drop did not wait at staging under on-destructive (exit ${String(staging?.code)})`);
  hold(await st.columnOn("staging", "gone"), "the column was dropped on staging with no approval");
  const approved = await yodelBuild(ctx, st.p, "yodel").ask(st.envs.staging, ["approve", st.envs.staging]);
  if (approved.code !== 0) throw new Error(`yodel approve ${st.envs.staging} exited ${String(approved.code)}:\n${approved.out}\n${approved.err}`);
  const after = await pipeline(st, drop);
  hold(after.get(job(st, 1, "staging"))?.ok === true, `after yodel approve ${st.envs.staging}, the drop did not apply at staging`);
  hold(!(await st.columnOn("staging", "gone")), "the column is still on staging after the approved drop");
  // prod waits on its own gate for the same drop; approve it so the parts after start level.
  const prod = after.get(job(st, 2, "prod"));
  hold(prod?.code === 3, `the drop did not wait at prod under on-destructive (exit ${String(prod?.code)})`);
  await st.p.approve(approveCommand(prod));
  hold((await pipeline(st, after)).get(job(st, 2, "prod"))?.ok === true, "the approved drop did not apply at prod");
}

async function promotion(ctx: Ctx, st: State, broken: boolean): Promise<void> {
  // Both waves never: only the requirement stands between the change and prod.
  await render(st, waves(st, "never", "never"), { noRequires: broken });
  await st.p.commit("the waves: both never, prod after staging");
  addColumn(st.p, "promo");
  await migrate(st, "add-promo", "feat: a promo column");

  // prod's job alone (a re-run, or staging's skipped): refused before anything is applied.
  const alone = await run("chant", ["run", "wave", "--spec", "yodel-waves.json", "--wave", "2"], { cwd: st.p.dir, env: st.p.envFor(), timeoutMs: 600_000 });
  hold(!(await st.columnOn("prod", "promo")), "prod applied a migration staging has not applied");
  hold(alone.code !== 0 && /refused: \S+ applies only migrations \S+ applied first/.test(`${alone.out}${alone.err}`), `prod's wave did not refuse a migration staging has not applied (exit ${String(alone.code)})`);
  const local = await st.p.yodel(["apply", st.envs.prod, "--json"], { timeoutMs: 600_000 });
  hold(local.code === 4, `yodel apply ${st.envs.prod} did not refuse (exit 4) a migration staging has not applied (exit ${String(local.code)})`);
  const plan = await st.p.yodel(["plan", st.envs.prod, "--json"]);
  const wave = (JSON.parse(plan.out.slice(plan.out.indexOf("{"))) as { wave?: { blocked?: boolean; promotions?: Array<{ env: string; migrations: Array<{ ran: string }> }> } }).wave;
  hold(wave?.blocked === true && wave.promotions?.[0]?.env === st.envs.staging && wave.promotions[0].migrations.some((m) => m.ran === "not applied"), "yodel plan of prod does not show the migration has not run on staging");

  // The pipeline: staging, then prod.
  const ran = await pipeline(st);
  hold(ran.get(job(st, 1, "staging"))?.ok === true && ran.get(job(st, 2, "prod"))?.ok === true, "once staging applied the migration, the waves did not both apply");
  hold((await st.columnOn("staging", "promo")) && (await st.columnOn("prod", "promo")), "the column is not on both servers after the pipeline");
}

/**
 * A copy of the project's yodel at `<work>/<name>`, with `patch` applied to
 * one file of its build (a part's broken build), and `ask.mjs` beside it:
 * yodel's CLI with a terminal that answers every question with argv[2].
 */
function yodelBuild(ctx: Ctx, p: Project, name: string, patch?: { file: string; from: string; to: string }): { ask: (answer: string, args: string[]) => Promise<Ran>; bin: string } {
  const root = join(ctx.work, name);
  if (!existsSync(root)) {
    const pkg = realpathSync(p.path("node_modules", "@intentius", "sql-yodeler"));
    mkdirSync(root, { recursive: true });
    cpSync(join(pkg, "dist"), join(root, "dist"), { recursive: true });
    copyFileSync(join(pkg, "package.json"), join(root, "package.json"));
    symlinkSync(p.path("node_modules"), join(root, "node_modules"));
    mkdirSync(join(root, "bin"));
    symlinkSync("../dist/bin.js", join(root, "bin", "yodel"));
    if (patch) {
      const file = join(root, "dist", patch.file);
      const text = readFileSync(file, "utf8");
      if (!text.includes(patch.from)) throw new Error(`${patch.from} is not in ${file}; the broken build cannot be made`);
      writeFileSync(file, text.replace(patch.from, patch.to));
    }
    writeFileSync(
      join(root, "ask.mjs"),
      `import { register } from "tsx/esm/api";
register();
const { main } = await import("./dist/cli.js");
const [answer, ...args] = process.argv.slice(2);
process.exitCode = await main(args, {
  out: (t) => process.stdout.write(t),
  err: (t) => process.stderr.write(t),
  ask: async (q) => { process.stderr.write(q + answer + "\\n"); return answer; },
});
`,
    );
  }
  return {
    ask: (answer, args) => run("node", [join(root, "ask.mjs"), answer, ...args], { cwd: p.dir, env: p.envFor(), timeoutMs: 600_000 }),
    // A directory holding this build as `yodel`, to put first on a pipeline's PATH.
    bin: join(root, "bin"),
  };
}

interface ReportDoc {
  gaps: Array<{ environment: string; detail: string }>;
  audit: Array<{ kind: string; environment: string; migration?: string; wave?: { status: string } }>;
}

async function report(ctx: Ctx, st: State, broken: boolean): Promise<void> {
  const yodel = broken ? yodelBuild(ctx, st.p, "yodel-reads-the-migrations-gate", { file: "report/audit.js", from: "const wave = a.wave;", to: "const wave = undefined;" }) : undefined;
  if (broken) ctx.log("BREAK: yodel report built to look for approvals on the migrations Op's gate alone");
  const args = ["report", st.envs.staging, st.envs.prod, "--json"];
  const ran = yodel ? await yodel.ask("", args) : await st.p.yodel(args);
  const doc = parse<ReportDoc>(ran);
  const approvedByWave = doc.audit.filter((e) => e.kind === "applied" && e.wave?.status === "approved");
  if (!broken && approvedByWave.length === 0) throw new Error("no applied migration records a wave's approval; the report part has nothing to read");
  hold(ran.code === 0 && doc.gaps.length === 0, `yodel report shows gaps after the waves applied (exit ${String(ran.code)}): ${doc.gaps.map((g) => g.detail).join("; ")}`);
}

/** Whether `table` (default the main table) has `column` (or exists, without one) in tenant `t`. */
async function onTenant(ctx: Ctx, t: string, column?: string, table = mainTable(ctx)): Promise<boolean> {
  const sql =
    ctx.dialect === "ch"
      ? column
        ? `SELECT count() FROM system.columns WHERE database = '${t}' AND table = '${table}' AND name = '${column}'`
        : `SELECT count() FROM system.tables WHERE database = '${t}' AND name = '${table}'`
      : column
        ? `SELECT count(*) FROM information_schema.columns WHERE table_schema = '${t}' AND table_name = '${table}' AND column_name = '${column}'`
        : `SELECT count(*) FROM information_schema.tables WHERE table_schema = '${t}' AND table_name = '${table}'`;
  if (ctx.dialect === "ch") return Number((await clickhouseAt(endpoints.clickhouse, sql)).trim() || "0") === 1;
  return Number(Object.values((await postgresQuery(sql))[0] ?? {})[0] ?? 0) === 1;
}

async function tenants(ctx: Ctx, st: State, broken: boolean): Promise<void> {
  const names = tenantNames(ctx);
  const set = st.envs.tenants;
  const tenantWave: Wave = { env: set, gate: "always", shares: 2 };
  if (broken) ctx.log("BREAK: the tenant set's wave is rendered with its first tenant alone");
  await render(st, [{ env: st.envs.staging, gate: "never" }, tenantWave], { firstTenantOnly: broken });
  await st.p.commit("the waves: staging never, a tenant set always, in two shares");
  // On ClickHouse no part runs before this one: the schema's first migration.
  if (!existsSync(st.p.path("migrations"))) await migrate(st, "create", "feat: the schema");
  const decide = `wave-2-${set}-decide`;

  // One gate for the whole set: the deciding job waits, nothing applied anywhere.
  const first = await pipeline(st);
  hold(first.get(job(st, 1, "staging"))?.ok === true, "staging's wave did not run before the tenant set's");
  const waiting = broken ? first.get(`wave-2-${set}`) : first.get(decide);
  hold(waiting?.code === 3, `the tenant set's wave did not wait for an approval (exit ${String(waiting?.code)})`);
  for (const t of names) hold(!(await onTenant(ctx, t)), `${t} got the migrations before the wave was approved`);
  const approve = approveCommand(waiting);
  hold(new Set(waiting.out.match(/chant approve \S+ \S+ --plan \S+/g)).size === 1, "the tenant set's wave asked for more than one approval");
  await st.p.approve(approve);
  const applied = await pipeline(st, first);
  for (const t of names) hold(await onTenant(ctx, t), `${t} does not have the migrations after the tenant set's wave was approved`);
  hold([...applied.values()].every((r) => r.ok), `a job of the approved tenant wave failed: ${[...applied].filter(([, r]) => !r.ok).map(([n, r]) => `${n} exit ${String(r.code)}`).join(", ")}`);

  // Each tenant has its own history, and yodel status counts them.
  const status = await st.p.yodel(["status", set, "--json"]);
  const doc = parse<{ tenants: Array<{ environment: string; history: string }>; upToDate: number; total: number }>(status);
  hold(status.code === 0 && doc.upToDate === 3 && doc.total === 3, `yodel status ${set} does not count 3 of 3 tenants up to date (exit ${String(status.code)}, ${String(doc.upToDate)} of ${String(doc.total)})`);
  hold(new Set(doc.tenants.map((t) => t.history)).size === 3, "the tenants do not each have a history of their own");

  // A migration decided for every tenant, applied by both shares.
  addColumn(st.p, "tenanted");
  await migrate(st, "add-tenanted", "feat: a column for every tenant");
  const second = await pipeline(st);
  const waits = second.get(decide);
  hold(waits?.code === 3, `the tenant set's wave did not wait for the new column (exit ${String(waits?.code)})`);
  await st.p.approve(approveCommand(waits));
  const shared = await pipeline(st, second);
  hold([...shared.values()].every((r) => r.ok), `a job of the approved tenant wave failed: ${[...shared].filter(([, r]) => !r.ok).map(([n, r]) => `${n} exit ${String(r.code)}`).join(", ")}`);
  for (const t of names) hold(await onTenant(ctx, t, "tenanted"), `${t} does not have the new column after its share applied`);

  await tenantsByQuery(ctx, st, names);
}

/** Sends SQL to the staging server, where the tenants are. */
const onStaging = (ctx: Ctx, sql: string) => (ctx.dialect === "ch" ? clickhouseAt(endpoints.clickhouse, sql) : postgresQuery(sql));

/**
 * The tenant set read by a query (#56): rendered once, read again when the
 * wave runs; one plan comment and one yodel approve for the set; an Op step
 * (a backfill) on each tenant.
 */
async function tenantsByQuery(ctx: Ctx, st: State, names: readonly string[]): Promise<void> {
  const set = st.envs.tenants;
  const reg = registry(ctx);
  const t4 = lateTenant(ctx);
  await onStaging(ctx, ctx.dialect === "ch" ? `CREATE DATABASE ${reg}` : `CREATE SCHEMA ${reg}`);
  await onStaging(ctx, ctx.dialect === "ch" ? `CREATE TABLE ${reg}.tenants (name String) ENGINE = MergeTree ORDER BY name` : `CREATE TABLE ${reg}.tenants (name text PRIMARY KEY)`);
  await onStaging(ctx, `INSERT INTO ${reg}.tenants (name) VALUES ${names.map((n) => `('${n}')`).join(", ")}`);
  const tenantQuery = `SELECT name FROM ${reg}.tenants ORDER BY name`;
  const tenantWaves: Wave[] = [{ env: st.envs.staging, gate: "never" }, { env: set, gate: "always", shares: 2 }];
  await render(st, tenantWaves, { tenantQuery });
  await st.p.commit("the tenant set, read by a query");

  // A tenant comes; the pipeline rendered again is the same.
  await onStaging(ctx, `INSERT INTO ${reg}.tenants (name) VALUES ('${t4}')`);
  await render(st, tenantWaves, { tenantQuery });
  const changed = (await st.p.git("status", "--porcelain")).out.trim();
  hold(changed === "", `rendering the pipeline again after a tenant was added changed it: ${changed}`);

  // A migration with an Op step: a backfill writing one row to a new table.
  addTable(st.p, "filled");
  st.p.write(
    "backfills/fill.ts",
    `import { EffectReceipt } from "@intentius/chant";
import { Op, activity, effect, phase } from "@intentius/chant/op";

export const op = Op({
  name: "backfill-fill",
  overview: "one row in filled",
  phases: [phase("Backfill", [effect(EffectReceipt("fill-all", { effect: "fill/all", flavor: "existence" }), [activity("yodelSql", { sql: "INSERT INTO ${ctx.db.name}.filled (id) VALUES (1)" }, "atMostOnce")])])],
});
`,
  );
  const id = await st.p.newMigration("fill", ["--backfill", "backfills/fill.ts"]);
  if (!id) throw new Error("yodel new fill wrote no migration");
  await st.p.commit("feat: a table filled by a backfill");

  // Staging applies, and the deciding job waits; one plan comment for the set names the digest it waits on.
  const first = await pipeline(st);
  const waiting = first.get(`wave-2-${set}-decide`);
  hold(waiting?.code === 3, `the tenant set read by a query did not wait for an approval (exit ${String(waiting?.code)})`);
  const digest = / --plan (\S+)/.exec(approveCommand(waiting))?.[1];
  const comment = await st.p.yodel(["plan", set, "--format", "markdown"]);
  const commented = /one approval of `(jcs1-[^`]+)`/.exec(comment.out)?.[1];
  hold(comment.code === 0 && [...names, t4].every((t) => comment.out.includes(`\`${t}\``)), `yodel plan ${set} --format markdown is not one comment naming every tenant (exit ${String(comment.code)})`);
  hold(commented !== undefined && commented === digest, `the plan comment's digest (${String(commented)}) is not the one the deciding job waits on (${String(digest)})`);

  const approved = await yodelBuild(ctx, st.p, "yodel").ask(set, ["approve", set]);
  hold(approved.code === 0, `yodel approve ${set} exited ${String(approved.code)}: ${approved.err.split("\n").slice(-3).join(" ")}`);
  const applied = await pipeline(st, first);
  hold([...applied.values()].every((r) => r.ok), `a job of the tenant set's wave failed after yodel approve: ${[...applied].filter(([, r]) => !r.ok).map(([n, r]) => `${n} exit ${String(r.code)}`).join(", ")}`);
  for (const t of [...names, t4]) {
    const rows = ctx.dialect === "ch" ? Number((await clickhouseAt(endpoints.clickhouse, `SELECT count() FROM ${t}.filled`)).trim()) : Number(Object.values((await postgresQuery(`SELECT count(*) FROM ${t}.filled`))[0] ?? {})[0] ?? 0);
    hold(rows === 1, `the backfill wrote ${String(rows)} rows to ${t}.filled, not 1`);
  }
  hold(await onTenant(ctx, t4, "tenanted"), `${t4}, added after the pipeline was rendered, did not get every migration`);
  const status = parse<{ upToDate: number; total: number }>(await st.p.yodel(["status", set, "--json"]));
  hold(status.upToDate === 4 && status.total === 4, `yodel status ${set} does not count 4 of 4 tenants up to date (${String(status.upToDate)} of ${String(status.total)})`);
}

async function steps(ctx: Ctx, st: State, broken: boolean): Promise<void> {
  const db = ctx.db.name;
  const table = mainTable(ctx);
  // A command with a side effect (#107): a line in a file outside the project, each time it runs.
  const notified = join(ctx.work, "notify.log");
  const notify = `echo "$YODEL_ENV" >> ${notified}`;
  const runs = () => (existsSync(notified) ? readFileSync(notified, "utf8").split("\n").filter(Boolean).length : 0);
  const steps = `{ before: [{ name: "notify", command: ${JSON.stringify(notify)} }], after: [{ name: "smoke", sql: "SELECT ${ctx.dialect === "ch" ? "count()" : "count(*)"} FROM ${db}.${table}", expect: { min: 0 } }] }`;
  // Broken: the rendered spec loses the before command, so the apply runs without it.
  if (broken) ctx.log("BREAK: the rendered waves spec drops the before command");
  await render(st, waves(st, "never", "never"), { steps, dropBeforeCommand: broken });
  await st.p.commit("the waves: both never, staging with steps around apply");
  addColumn(st.p, "checked");
  await migrate(st, "add-checked", "feat: a checked column");

  const ran = await pipeline(st);
  hold(ran.get(job(st, 1, "staging"))?.ok === true && (await st.columnOn("staging", "checked")), "staging's wave did not apply with its steps around it");
  hold(runs() === 1, `the before command ran ${String(runs())} times for one apply, not once`);
  hold(ran.get(job(st, 2, "prod"))?.ok === true, "prod's wave did not apply after staging's");

  // The history records both steps, and yodel report lists them.
  const report = parse<{ audit: Array<{ kind: string; environment: string; detail?: string }> }>(await st.p.yodel(["report", st.envs.staging, "--json"]));
  const recorded = report.audit.filter((e) => e.kind === "step").map((e) => e.detail ?? "");
  hold(recorded.some((d) => d.startsWith("before step notify passed")), "the history does not record the before command");
  hold(recorded.some((d) => d.startsWith("after step smoke passed")), "the history does not record the after step");
}

/** The parts, run by runParts; a part that caught its break leaves the servers where its break took them, so they are levelled for the parts after. */
const levelled = (part: (ctx: Ctx, st: State, broken: boolean) => Promise<void>) => async (ctx: Ctx, st: State) => {
  try {
    await part(ctx, st, ctx.broken);
  } catch (e) {
    if (e instanceof Violation && ctx.broken) await level(st);
    throw e;
  }
};

const parts: ReadonlyArray<PartEntry<State>> = [
  ["gate-policy", levelled(gatePolicy), ["pg"]],
  ["promotion", levelled(promotion), ["pg"]],
  ["report", levelled(report), ["pg"]],
  ["tenants", levelled(tenants)],
  ["steps", levelled(steps), ["pg"]],
];

async function body(ctx: Ctx): Promise<void> {
  const prod = await prodServer(ctx);
  await dropTenants(ctx);
  try {
    await runParts(ctx, await setup(ctx, prod.url), parts);
  } finally {
    await prod.close();
    await dropTenants(ctx);
  }
}

/** After a caught break: approve and apply whatever is pending on both environments, outside the pipeline. */
async function level(st: State): Promise<void> {
  await st.p.git("checkout", "-q", "--", ".");
  for (const env of [st.envs.staging, st.envs.prod]) {
    const plan = (await st.p.yodel(["apply", env, "--digest"])).out.trim();
    if (!plan.startsWith("jcs1-")) continue;
    await st.p.approve(`chant approve migrate-${env} approve-migrate-${env} --plan ${plan}`);
    const ran = await st.p.yodel(["apply", env, "--execute"], { env: { YODEL_APPROVED_PLAN: plan }, timeoutMs: 600_000 });
    if (ran.code !== 0) throw new Error(`levelling ${env}: yodel apply --execute exited ${String(ran.code)}`);
  }
}

export const wavesClaim: Claim = {
  name: "waves",
  says: "the apply pipeline runs one wave per environment, each behind its gate policy, approved with yodel approve; a wave applies only what the wave before applied, yodel report finds each wave's approvals, a tenant set's migrations reach every tenant behind one gate, and the steps around apply run once under the lock and are recorded",
  dialects: { ch: body, pg: body },
  parts: partNames(parts),
  partDialects: partDialects(parts),
};
