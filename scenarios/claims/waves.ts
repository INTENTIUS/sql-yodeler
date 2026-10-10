import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { clickhouseImage } from "@intentius/chant-lexicon-sql/spec/pin";
import { parseYAMLDocument } from "@intentius/chant/yaml";
import { applyPipelines, type Wave, type WaveGate } from "../../src/ci/render.js";
import { hold, Violation, type Claim, type Ctx } from "../lib/claim.js";
import { clickhouseAt, endpoints, postgresQuery } from "../lib/db.js";
import { run } from "../lib/exec.js";
import { Project } from "../lib/project.js";
import { addColumn, mainTable } from "../lib/schema.js";

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
 * Parts, each broken on its own under BREAK=1:
 *
 * - gate-policy: under `on-destructive` a new table applies with no
 *   approval, and a column drop waits (exit 3) with the column still there;
 *   approved, it applies. BREAK: the pipeline is rendered with `gate:
 *   never`, so the drop applies unapproved.
 * - wave-order: with staging waiting for an approval, prod (gate `never`)
 *   does not run; approved, both apply. BREAK: prod's job does not need
 *   staging's, so prod applies first.
 * - approval-at-base: a change that sets prod's gate to `never` merges and
 *   prod still waits under the base's `always`. BREAK: the policy is read
 *   from the change itself (`--base HEAD`, YODEL_BASE=HEAD), so prod applies.
 * - promotion (#43): prod requires staging (the wave before, by default).
 *   prod's wave run on its own, and `yodel apply` of prod, refuse (exit 4,
 *   nothing applied) a migration staging has not applied; `yodel plan` of
 *   prod shows it has not run on staging; once staging has applied it, prod
 *   applies it. BREAK: the requirement is removed (`requires: false`), so the
 *   column reaches prod first.
 */

const PARTS = ["gate-policy", "wave-order", "approval-at-base", "promotion"] as const;
type Part = (typeof PARTS)[number];

interface Envs {
  staging: string;
  prod: string;
}

interface State {
  p: Project;
  envs: Envs;
  /** Each environment's server, asked directly. */
  columnOn: (env: keyof Envs, column: string) => Promise<boolean>;
  tableOn: (env: keyof Envs) => Promise<boolean>;
}

const ENV_KEYS = ["staging", "prod"] as const;

/** Whether `part` runs broken: under BREAK=1 every part, under BREAK=<part> that one. */
function breaks(ctx: Ctx, part: Part): boolean {
  const named = process.env.BREAK;
  if (!ctx.broken) return false;
  return named === "1" || named === "true" || named === part || !(PARTS as readonly string[]).includes(named ?? "");
}

// ── The pipeline, as a forge runs it ─────────────────────────────────────────

/** Writes yodel.config.ts with these waves, and the pipelines and the waves spec rendered from it; the options break the rendering. */
async function render(st: State, waves: readonly Wave[], options: { allNever?: boolean; noNeeds?: string; noRequires?: boolean } = {}): Promise<void> {
  const { p } = st;
  const ws: readonly Wave[] = options.allNever ? waves.map((w): Wave => ({ ...w, gate: "never" })) : waves;
  p.write("yodel.config.ts", yodelConfig(st, waves, options.noRequires === true));
  const files = await applyPipelines(p.dir, { dialect: p.ctx.dialect === "ch" ? "clickhouse" : "postgres", names: ws.map((w) => w.env), replay: false, waves: ws });
  for (const f of files) {
    let content = f.content;
    if (options.noNeeds && f.path === ".github/workflows/yodel-apply.yml") {
      const job = `wave-2-${options.noNeeds}`;
      const before = content;
      content = content.replace(new RegExp(`(\\n {2}${job}:\\n(?: {4}.*\\n)*?) {4}needs:\\n(?: {6}- .*\\n)+`), "$1");
      if (content === before) throw new Error(`could not remove ${job}'s needs from the rendered workflow`);
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

function yodelConfig(st: State, waves: readonly Wave[], noRequires = false): string {
  const history = st.p.ctx.db.history;
  return `import type { YodelConfig } from "@intentius/sql-yodeler";

export default {
  environments: {
${ENV_KEYS.map((k) => `    "${st.envs[k]}": { history: { database: "${history}" } },`).join("\n")}
  },
  waves: [
${waves.map((w, i) => `    { env: "${w.env}", gate: "${w.gate}"${noRequires && i > 0 ? ", requires: false" : ""} },`).join("\n")}
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

async function setup(ctx: Ctx, prodUrl: string): Promise<State> {
  const p = await Project.create(ctx, { ops: "none" });
  const envs: Envs = { staging: `${ctx.env}-staging`, prod: `${ctx.env}-prod` };
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
    },
  },
} satisfies ChantConfig;
`,
  );
  for (const env of [envs.staging, envs.prod]) p.write(`ops/migrate-${env}.op.ts`, migrateOp(env));
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
  await st.p.approve(approveCommand(staging));
  const after = await pipeline(st, drop);
  hold(after.get(job(st, 1, "staging"))?.ok === true, "the approved drop did not apply at staging");
  hold(!(await st.columnOn("staging", "gone")), "the column is still on staging after the approved drop");
  // prod waits on its own gate for the same drop; approve it so the parts after start level.
  const prod = after.get(job(st, 2, "prod"));
  hold(prod?.code === 3, `the drop did not wait at prod under on-destructive (exit ${String(prod?.code)})`);
  await st.p.approve(approveCommand(prod));
  hold((await pipeline(st, after)).get(job(st, 2, "prod"))?.ok === true, "the approved drop did not apply at prod");
}

async function waveOrder(ctx: Ctx, st: State, broken: boolean): Promise<void> {
  await render(st, waves(st, "always", "never"), broken ? { noNeeds: st.envs.prod } : {});
  await st.p.commit("the waves: staging always, prod never");
  addColumn(st.p, "note");
  await migrate(st, "add-note", "feat: a note column");
  const ran = await pipeline(st);
  const staging = ran.get(job(st, 1, "staging"));
  hold(staging?.code === 3, `staging did not wait under always (exit ${String(staging?.code)})`);
  hold(!(await st.columnOn("prod", "note")), "prod applied the change while staging waited for its approval");
  hold(!ran.has(job(st, 2, "prod")), "prod's job ran while staging's waited");
  await st.p.approve(approveCommand(staging));
  const again = await pipeline(st, ran);
  hold(again.get(job(st, 1, "staging"))?.ok === true && again.get(job(st, 2, "prod"))?.ok === true, "after staging's approval, the waves did not both apply");
  hold((await st.columnOn("staging", "note")) && (await st.columnOn("prod", "note")), "the column is not on both servers after the approval");
}

async function approvalAtBase(ctx: Ctx, st: State, broken: boolean): Promise<void> {
  await render(st, waves(st, "never", "always"));
  await st.p.commit("the waves: staging never, prod always");
  // The change: sets prod to never, and adds a column.
  await render(st, waves(st, "never", "never"));
  addColumn(st.p, "extra");
  await migrate(st, "add-extra", "feat: an extra column, and prod's gate never");
  const env = broken ? { YODEL_BASE: "HEAD" } : {};
  const ran = await pipeline(st, new Map(), env, broken ? ["--base", "HEAD"] : []);
  hold(ran.get(job(st, 1, "staging"))?.ok === true && (await st.columnOn("staging", "extra")), "staging (never at the base) did not apply the change");
  const prod = ran.get(job(st, 2, "prod"));
  hold(prod?.code === 3, `prod did not wait under its base policy, always, with the change setting it to never (exit ${String(prod?.code)})`);
  hold(!(await st.columnOn("prod", "extra")), "prod applied the change under the gate the change itself set");
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

const RUN: Record<Part, (ctx: Ctx, st: State, broken: boolean) => Promise<void>> = {
  "gate-policy": gatePolicy,
  "wave-order": waveOrder,
  "approval-at-base": approvalAtBase,
  promotion,
};

async function body(ctx: Ctx): Promise<void> {
  const prod = await prodServer(ctx);
  const caught: string[] = [];
  const held: string[] = [];
  try {
    const st = await setup(ctx, prod.url);
    for (const part of PARTS) {
      const broken = breaks(ctx, part);
      ctx.log(`part ${part}${broken ? " (broken)" : ""}`);
      try {
        await RUN[part](ctx, st, broken);
      } catch (e) {
        if (!(e instanceof Violation) || !broken) throw e instanceof Violation ? new Violation(`${part}: ${e.message}`) : e;
        ctx.log(`part ${part} caught its break: ${e.message}`);
        caught.push(`${part}: ${e.message}`);
        // A broken part leaves the servers where its break took them; the parts after start from a fresh project state.
        await level(st);
        continue;
      }
      if (broken) held.push(part);
    }
  } finally {
    await prod.close();
  }
  if (held.length > 0) throw new Error(`break=not-caught: ${held.join(", ")} held with the property broken`);
  if (caught.length > 0) throw new Violation(caught.join("; "));
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
  says: "the apply pipeline runs one wave per environment, in order, each behind its gate policy read from the base commit, and applies only what the wave before applied",
  dialects: { ch: body, pg: body },
};
