/**
 * npm run bench [measurement...] [-- --sizes 10,100] [--full] [--dialects ch,pg] [--keep]
 *
 * What yodel costs as a schema and a history grow, measured on the emulator,
 * each figure with an oracle beside it (the same statements sent straight).
 * One record per dialect and size under bench/results/, in chant-bench's
 * result-set shape. See bench/README.md.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { humanGate } from "../scenarios/lib/human-gate.js";
import {
  clickhouse,
  dialectName,
  drop,
  exec,
  historyRows,
  lockFigures,
  newRuns,
  now,
  oracle,
  Project,
  psqlVersion,
  repoRoot,
  retarget,
  scalar,
  secs,
  spread,
  serverVersions,
  tableName,
  type Dialect,
  type HistoryRow,
} from "./lib.js";

export const MEASUREMENTS = ["new", "plan", "apply", "pr", "resume", "backfill", "replay", "fanout"] as const;
type Measurement = (typeof MEASUREMENTS)[number];

const SMALL = [10];
const FULL = [10, 100, 1_000, 10_000];

/** yodel did something other than what the stage expects: a measured failure, scored 0; the apparatus still worked. */
class Measured extends Error {}

interface Options {
  measurements: Measurement[];
  sizes: number[];
  dialects: Dialect[];
  keep: boolean;
  replayMax: number;
  fanoutMax: number;
  backfillRows: number | null;
  batches: number;
}

function options(argv: string[]): Options {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      sizes: { type: "string" },
      full: { type: "boolean", default: false },
      dialects: { type: "string", default: "ch,pg" },
      keep: { type: "boolean", default: false },
      "replay-max": { type: "string", default: "1000" },
      "fanout-max": { type: "string", default: "1000" },
      "backfill-rows": { type: "string" },
      batches: { type: "string", default: "10" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(readFileSync(join(repoRoot, "bench", "README.md"), "utf8"));
    process.exit(0);
  }
  const bad = positionals.filter((p) => !(MEASUREMENTS as readonly string[]).includes(p));
  if (bad.length > 0) throw new Error(`unknown measurement ${bad.join(", ")}; the measurements are ${MEASUREMENTS.join(", ")}`);
  const sizes = values.sizes ? values.sizes.split(",").map((s) => Number(s.replace(/_/g, ""))) : values.full ? FULL : SMALL;
  if (sizes.some((n) => !Number.isInteger(n) || n < 1)) throw new Error(`--sizes takes positive integers: ${String(values.sizes)}`);
  const dialects = values.dialects.split(",").map((d) => (d === "clickhouse" ? "ch" : d === "postgres" ? "pg" : d));
  if (dialects.some((d) => d !== "ch" && d !== "pg")) throw new Error(`--dialects takes ch and pg: ${values.dialects}`);
  return {
    measurements: positionals.length > 0 ? (positionals as Measurement[]) : [...MEASUREMENTS],
    sizes,
    dialects: dialects as Dialect[],
    keep: values.keep,
    replayMax: Number(values["replay-max"]),
    fanoutMax: Number(values["fanout-max"]),
    backfillRows: values["backfill-rows"] ? Number(values["backfill-rows"]) : null,
    batches: Number(values.batches),
  };
}

/** One dialect and size: everything a record needs. */
class Scenario {
  readonly stageSeconds: Record<string, number> = {};
  readonly byTask: Record<string, [number]> = {};
  readonly measurement: Record<string, unknown> = {};
  readonly exceptions: Record<string, string> = {};
  readonly names: string[];
  readonly db: string;
  readonly work: string;
  readonly log: string;

  constructor(
    readonly dialect: Dialect,
    readonly size: number,
    readonly o: Options,
    readonly runId: string,
  ) {
    this.db = `yodel_35_${dialect}_${String(size)}`;
    this.names = [this.db, `${this.db}_history`, `${this.db}_oracle`, `${this.db}_r`, `${this.db}_r_history`, `${this.db}_r_oracle`];
    this.work = mkdtempSync(join(tmpdir(), `yodel-bench-${this.db}-`));
    this.log = join(tmpdir(), `${runId}.log`);
    writeFileSync(this.log, "");
  }

  wants(m: Measurement): boolean {
    return this.o.measurements.includes(m);
  }

  /** Runs a stage, timing it; a Measured failure scores 0, anything else is the apparatus failing. */
  async stage(name: string, body: () => Promise<void>): Promise<void> {
    process.stdout.write(`  ${name}${(MEASUREMENTS as readonly string[]).includes(name) && !this.wants(name as Measurement) ? " (setup)" : ""} ... `);
    const t0 = now();
    try {
      await body();
      this.byTask[name] = [1];
      process.stdout.write(`${String(secs(now() - t0))}s\n`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof Measured) this.byTask[name] = [0];
      else this.exceptions[name] = message;
      process.stdout.write(`${e instanceof Measured ? "measured failure" : "harness error"}: ${message.split("\n")[0] ?? ""}\n`);
    } finally {
      this.stageSeconds[name] = secs(now() - t0);
    }
  }

  async cleanup(): Promise<void> {
    for (const n of this.names) await drop(this.dialect, n);
    if (this.wants("fanout")) for (const n of this.fanoutNames()) await drop(this.dialect, n);
    // ClickHouse keeps every environment's receipts in chant's own chant_receipts.receipts; the bench removes its environments' rows.
    if (this.dialect === "ch" && (await scalar("ch", "EXISTS TABLE chant_receipts.receipts")) === "1") {
      await clickhouse(`ALTER TABLE chant_receipts.receipts DELETE WHERE startsWith(address, 'yodel/${this.db}') SETTINGS mutations_sync = 2`);
    }
  }

  async history(p: Project): Promise<HistoryRow[]> {
    try {
      return await historyRows(this.dialect, p.history);
    } catch {
      return [];
    }
  }

  /** The oracle database or schema, fresh. */
  async freshOracle(name: string): Promise<void> {
    await drop(this.dialect, name);
  }

  async main(): Promise<void> {
    const d = this.dialect;
    const p = await Project.create(d, join(this.work, "project"), this.db, this.size, this.log);
    const oracleDb = `${this.db}_oracle`;
    const sendStraight = (stmts: string[]) => oracle(d, stmts.map((s) => retarget(s, this.db, oracleDb)), this.work, this.log);

    // yodel new, the first migration: every object.
    let create = "";
    await this.stage("new", async () => {
      const made = await p.newMigration("create");
      create = made.id;
      await p.commit("create");
      this.measurement.new = {
        what: "yodel new, wall seconds: `create` declares every object from nothing; `incremental` adds a column to every table",
        objects: this.size + 1,
        create_seconds: made.seconds,
        create_statements: p.statements(made.id).length,
        oracle: null,
        oracle_reason: "yodel new reads the declarations and the migrations directory and sends nothing to the server; there is no statement to send straight",
      };
    });
    if (!create) throw new Error("the first migration was not written");

    // yodel plan, with the create migration pending against an empty history.
    if (this.wants("plan")) {
      await this.stage("plan", async () => {
        const ran = await p.yodel(["plan", p.env, "--json"]);
        if (ran.code !== 0) throw new Measured(`yodel plan exited ${String(ran.code)}`);
        this.measurement.plan = {
          what: "yodel plan <env> --json, wall seconds, versioned project: `create_pending` is every object pending on an empty history; `incremental_pending` is a column added to every table pending after the create applied",
          create_pending_seconds: ran.seconds,
          oracle: null,
          oracle_reason: "yodel plan reads the history and changes nothing; there is no statement it would send to time straight",
        };
      });
    }

    // Apply the create migration: the lock, per statement and per migration, against the statements sent straight.
    await this.stage("apply", async () => {
      const before = await this.history(p);
      const applied = await p.approvedApply();
      if (applied.code !== 0) throw new Measured(`yodel apply exited ${String(applied.code)}`);
      // The resume stage's oracle builds on the create migration's objects in the oracle copy.
      if (!this.wants("apply")) {
        if (this.wants("resume")) {
          await this.freshOracle(oracleDb);
          await sendStraight(p.statements(create));
        }
        return;
      }
      const after = await this.history(p);
      const lock = lockFigures(after, newRuns(before, after));
      await this.freshOracle(oracleDb);
      const straight = await sendStraight(p.statements(create));
      this.measurement.apply = {
        what: "the create migration (every object) through yodel apply: the Op to its gate, chant approve, the Op's yodel apply --execute; lock and statement figures from the history's recorded_at",
        statements: p.statements(create).length,
        wall: applied,
        ...lock,
        oracle: straight,
        overhead_seconds: {
          lock_held_minus_oracle: round(lock.lock_held_lower_bound_seconds - straight.wall_seconds),
          apply_wall_minus_oracle: round(applied.seconds - straight.wall_seconds),
          execute_wall_minus_oracle: round(applied.execute_seconds - straight.wall_seconds),
        },
      };
    });

    // A column on every table: yodel new against a schema of `size` objects, then plan and the pull request job's local equivalent.
    p.addColumn("note");
    let note = "";
    if (this.wants("new") || this.wants("plan") || this.wants("pr") || this.wants("resume") || this.wants("backfill")) {
      const made = await p.newMigration("note");
      note = made.id;
      await p.commit("note");
      if (this.wants("new")) Object.assign(this.measurement.new as object, { incremental_seconds: made.seconds, incremental_statements: p.statements(note).length });
      this.stageSeconds.new = round((this.stageSeconds.new ?? 0) + made.seconds);
    }
    if (this.wants("plan") && note) {
      const ran = await p.yodel(["plan", p.env, "--json"]);
      if (ran.code === 0) Object.assign(this.measurement.plan as object, { incremental_pending_seconds: ran.seconds });
      else this.byTask.plan = [0];
      this.stageSeconds.plan = round((this.stageSeconds.plan ?? 0) + ran.seconds);
    }
    if (this.wants("pr") && note) {
      await this.stage("pr", async () => {
        const ran = await p.yodel(["plan", p.env, "--format", "markdown"]);
        if (ran.code !== 0) throw new Measured(`yodel plan --format markdown exited ${String(ran.code)}`);
        this.measurement.pr = {
          what: "the pull request job's local equivalent, not a forge run: yodel plan <env> --format markdown, which plans and renders the comment `yodel plan --comment` posts; no push, no runner, no forge API",
          pending_statements: p.statements(note).length,
          plan_and_render_seconds: ran.seconds,
          comment_bytes: Buffer.byteLength(ran.out),
          oracle: null,
          oracle_reason: "the job sends nothing to the database; there is no statement to send straight",
        };
      });
    }

    if (this.wants("resume")) {
      await this.stage("resume", async () => {
        const stmts = p.migration(note).steps;
        const mid = Math.floor(this.size / 2);
        const at = stmts.findIndex((s) => s.kind === "statement" && new RegExp(`\\b${tableName(mid)}\\b`).test(s.sql ?? "") && /ADD COLUMN/i.test(s.sql ?? ""));
        if (at < 0) throw new Error(`no statement of ${note} adds note to ${tableName(mid)}`);
        const col = d === "ch" ? "note String DEFAULT ''" : "note text";
        // The column is there already, so statement `at` fails after every statement before it ran.
        await exec(d, `ALTER TABLE ${this.db}.${tableName(mid)} ADD COLUMN ${col}`);
        const h0 = await this.history(p);
        const failed = await p.approvedApply();
        if (failed.code !== 1) throw new Measured(`the interrupted apply exited ${String(failed.code)}, not 1`);
        const h1 = await this.history(p);
        await exec(d, `ALTER TABLE ${this.db}.${tableName(mid)} DROP COLUMN note`);
        const resumed = await p.approvedApply();
        if (resumed.code !== 0) throw new Measured(`the resumed apply exited ${String(resumed.code)}`);
        const h2 = await this.history(p);

        // The same shape, clean: another column on every table.
        p.addColumn("note2");
        const clean = await p.newMigration("note2");
        await p.commit("note2");
        const cleanRan = await p.approvedApply();
        if (cleanRan.code !== 0) throw new Measured(`the clean apply exited ${String(cleanRan.code)}`);
        const h3 = await this.history(p);
        // The oracle copy has the create migration's objects (the apply stage); it takes the first column untimed, then the clean migration timed.
        await oracle(d, p.statements(note).map((s) => retarget(s, this.db, oracleDb)), this.work, this.log);
        const straight = await sendStraight(p.statements(clean.id));
        const interrupted = lockFigures(h1, newRuns(h0, h1));
        const resumedLock = lockFigures(h2, newRuns(h1, h2));
        const cleanLock = lockFigures(h3, newRuns(h2, h3));
        const resent = h2.filter((r) => !h1.some((x) => x.seq === r.seq) && r.migration_id === note && r.kind === "statement" && r.status === "started" && r.statement_index < at).length;
        this.measurement.resume = {
          what: "a migration adding a column to every table, failing at the middle table's statement (its column made by hand first), resumed once the column is gone; against another migration of the same shape run clean",
          statements: stmts.filter((s) => s.kind === "statement").length,
          failed_at_statement: at,
          interrupted: { wall: failed, ...interrupted },
          resumed: { wall: resumed, ...resumedLock, statements_resent: resent },
          clean: { wall: cleanRan, ...cleanLock },
          interrupted_plus_resumed_minus_clean_seconds: round(failed.seconds + resumed.seconds - cleanRan.seconds),
          oracle: straight,
          oracle_of: "the clean migration's statements sent straight",
        };
      });
    } else if (note && this.wants("backfill")) {
      const ran = await p.approvedApply();
      if (ran.code !== 0) throw new Error(`setup: applying ${note} exited ${String(ran.code)}`);
    }

    if (this.wants("backfill")) await this.stage("backfill", () => this.backfill(p, oracleDb));
  }

  async backfill(p: Project, oracleDb: string): Promise<void> {
    const d = this.dialect;
    const rows = this.o.backfillRows ?? Math.min(this.size * 1_000, 1_000_000);
    const batches = this.o.batches;
    const bfDecl = (cols: string[]) => {
      const lib = `@intentius/chant-lexicon-sql/${dialectName[d]}`;
      const extra = cols.map((c) => `,\n    ${c} ${d === "ch" ? "String DEFAULT ''" : "text"}`).join("");
      return d === "ch"
        ? `import { table } from "${lib}";\nimport { db } from "./schema.js";\n\nexport const bf = table\`\n  CREATE TABLE \${db}.bf (\n    id UInt64,\n    v String${extra}\n  )\n  ENGINE = MergeTree\n  ORDER BY id\`;\n`
        : `import { table } from "${lib}";\nimport { db } from "./schema.js";\n\nexport const bf = table\`\n  CREATE TABLE \${db}.bf (\n    id bigint PRIMARY KEY,\n    v text${extra}\n  )\`;\n`;
    };
    const fill = `${this.db}.bf`;
    const update = (db: string, col: string, b: number) =>
      d === "ch"
        ? `ALTER TABLE ${db}.bf UPDATE ${col} = concat('n-', v) WHERE id % ${String(batches)} = ${String(b)} SETTINGS mutations_sync = 2`
        : `UPDATE ${db}.bf SET ${col} = 'n-' || v WHERE id % ${String(batches)} = ${String(b)}`;
    const insert = (db: string) =>
      d === "ch"
        ? `INSERT INTO ${db}.bf (id, v) SELECT number, toString(number) FROM numbers(${String(rows)})`
        : `INSERT INTO ${db}.bf (id, v) SELECT g, g::text FROM generate_series(0, ${String(rows - 1)}) g`;
    const module = (col: string) => {
      const fail = d === "ch" ? `activity("yodelSql", { sql: "SELECT throwIf(1, 'forced interruption')" }, "atMostOnce")` : `activity("yodelSql", { sql: "DO $$ BEGIN RAISE EXCEPTION 'forced interruption'; END $$" }, "atMostOnce")`;
      const sql = d === "ch" ? `\`ALTER TABLE ${fill} UPDATE ${col} = concat('n-', v) WHERE id % ${String(batches)} = \${String(b)}\`` : `\`UPDATE ${fill} SET ${col} = 'n-' || v WHERE id % ${String(batches)} = \${String(b)}\``;
      const settings = d === "ch" ? `, settings: { mutations_sync: "2" }` : "";
      return `import { EffectReceipt } from "@intentius/chant";
import { Op, activity, effect, phase } from "@intentius/chant/op";

const batches = ${JSON.stringify([...Array(batches).keys()])};
const failAt = Number(process.env.YODEL_BENCH_FAIL_AT ?? -1);

const batch = (b: number) =>
  effect(EffectReceipt(\`${col}-\${String(b)}\`, { effect: \`${col}/\${String(b)}\`, flavor: "existence" }), [
    ...(b === failAt ? [${fail}] : []),
    activity("yodelSql", { sql: ${sql}${settings} }, "atMostOnce"),
  ]);

export const op = Op({ name: "backfill-${col}", overview: "${col} from v, a batch at a time", phases: [phase("Backfill", batches.map(batch))] });
`;
    };

    p.write("src/bf.ts", bfDecl([]));
    const made = await p.newMigration("bf");
    await p.commit("bf");
    if ((await p.approvedApply()).code !== 0) throw new Error(`setup: applying ${made.id} exited non-zero`);
    await exec(d, insert(this.db));

    // Clean: every batch.
    p.write("src/bf.ts", bfDecl(["f1"]));
    p.write("backfill-f1.ts", module("f1"));
    await p.newMigration("f1", ["--backfill", "backfill-f1.ts"]);
    await p.commit("f1");
    const h0 = await this.history(p);
    const clean = await p.approvedApply();
    if (clean.code !== 0) throw new Measured(`the clean backfill exited ${String(clean.code)}`);
    const h1 = await this.history(p);
    const unfilled = Number(await scalar(d, d === "ch" ? `SELECT count() FROM ${fill} WHERE f1 != concat('n-', v)` : `SELECT count(*) FROM ${fill} WHERE f1 IS DISTINCT FROM 'n-' || v`));
    if (unfilled !== 0) throw new Measured(`${String(unfilled)} rows not filled by the clean backfill`);

    // Interrupted at the middle batch, then resumed from its receipts.
    const failAt = Math.floor(batches / 2);
    p.write("src/bf.ts", bfDecl(["f1", "f2"]));
    p.write("backfill-f2.ts", module("f2"));
    await p.newMigration("f2", ["--backfill", "backfill-f2.ts"]);
    await p.commit("f2");
    const failed = await p.approvedApply({ YODEL_BENCH_FAIL_AT: String(failAt) });
    if (failed.code !== 1) throw new Measured(`the interrupted backfill exited ${String(failed.code)}, not 1`);
    const h2 = await this.history(p);
    const resumed = await p.approvedApply();
    if (resumed.code !== 0) throw new Measured(`the resumed backfill exited ${String(resumed.code)}`);
    const h3 = await this.history(p);

    // The oracle: the same table and rows, the same batch statements sent straight.
    await this.freshOracle(oracleDb);
    await exec(d, d === "ch" ? `CREATE DATABASE ${oracleDb}` : `CREATE SCHEMA ${oracleDb}`);
    await exec(d, retarget(p.statements(made.id).find((s) => /CREATE TABLE/i.test(s)) ?? "", this.db, oracleDb));
    await exec(d, insert(oracleDb));
    await exec(d, d === "ch" ? `ALTER TABLE ${oracleDb}.bf ADD COLUMN f1 String DEFAULT ''` : `ALTER TABLE ${oracleDb}.bf ADD COLUMN f1 text`);
    const straight = await oracle(d, [...Array(batches).keys()].map((b) => update(oracleDb, "f1", b)), this.work, this.log);

    const cleanLock = lockFigures(h1, newRuns(h0, h1));
    const stepSeconds = cleanLock.per_step?.total ?? null;
    this.measurement.backfill = {
      what: "a hand-written backfill step over every row of bf, in batches by id; clean, then another column's backfill interrupted at its middle batch and resumed from its receipts",
      rows,
      batches,
      clean: { wall: clean, ...cleanLock, rows_per_second: stepSeconds ? Math.round(rows / stepSeconds) : null },
      interrupted: { wall: failed, failed_at_batch: failAt, ...lockFigures(h2, newRuns(h1, h2)) },
      resumed: { wall: resumed, ...lockFigures(h3, newRuns(h2, h3)) },
      oracle: { ...straight, rows_per_second: straight.wall_seconds > 0 ? Math.round(rows / straight.wall_seconds) : null },
      oracle_of: "the clean backfill's batch statements sent straight to a copy of bf with the same rows",
    };
  }

  /** A history of min(size, --replay-max) migrations, each adding one table, replayed by yodel lint --replay. */
  async replay(): Promise<void> {
    const d = this.dialect;
    const k = Math.min(this.size, this.o.replayMax);
    const db = `${this.db}_r`;
    const p = await Project.create(d, join(this.work, "replay"), db, 1, this.log);
    const ids: string[] = [];
    const t0 = now();
    ids.push((await p.newMigration("m00000")).id);
    for (let i = 1; i < k; i++) {
      p.size = i + 1;
      p.writeTables();
      ids.push((await p.newMigration(`m${String(i).padStart(5, "0")}`)).id);
    }
    await p.commit("history");
    const generate = secs(now() - t0);
    const ran = await p.yodel(["lint", "--replay", p.env, "--json"]);
    if (ran.code !== 0) throw new Measured(`yodel lint --replay exited ${String(ran.code)}`);
    const oracleDb = `${db}_oracle`;
    await this.freshOracle(oracleDb);
    const straight = await oracle(d, ids.flatMap((id) => p.statements(id)).map((s) => retarget(s, db, oracleDb)), this.work, this.log);
    this.measurement.replay = {
      what: "yodel lint --replay <env>: every migration applied in order to a fresh database on the env's server, each compared with the schema it recorded",
      migrations: k,
      capped: k < this.size ? `--replay-max ${String(this.o.replayMax)}` : null,
      generate_seconds: generate,
      replay_seconds: ran.seconds,
      oracle: straight,
      overhead_seconds: round(ran.seconds - straight.wall_seconds),
    };
  }

  /** The fan-out's template, its tenants, and their histories and oracle copies. */
  fanoutNames(): string[] {
    const base = `${this.db}_f`;
    const tenants = this.fanoutTenants();
    return [base, `${base}_history`, `${base}_registry`, ...tenants, ...tenants.map((t) => `${base}_history_${t}`), ...tenants.map((t) => `${t}_oracle`)];
  }

  fanoutTenants(): string[] {
    const k = Math.min(this.size, this.o.fanoutMax);
    return Array.from({ length: k }, (_, i) => `${this.db}_f_t${String(i).padStart(4, "0")}`);
  }

  /**
   * The fan-out (#56): a tenant set of min(size, --fanout-max) tenants, one
   * table each, applied by its wave behind one approval, the way a wave job
   * runs it (chant run wave over yodel-waves.json): once as a list (a run
   * per tenant), once read by a query (one run that plans and applies every
   * tenant). Each from empty tenants.
   */
  async fanout(): Promise<void> {
    const d = this.dialect;
    const base = `${this.db}_f`;
    const tenants = this.fanoutTenants();
    const p = await Project.create(d, join(this.work, "fanout"), base, 1, this.log);
    const set = p.env;
    const { wavesSpec } = await import("../src/ci/render.js");
    const configure = (expr: string, targets: string[]) => {
      p.write("yodel.config.ts", `export default {\n  environments: { "${set}": { tenants: ${expr} } },\n  waves: [{ env: "${set}", gate: "always" }],\n};\n`);
      p.write("yodel-waves.json", `${JSON.stringify(wavesSpec([{ env: set, gate: "always", targets }]), null, 2)}\n`);
    };
    const wave = ["run", "wave", "--spec", "yodel-waves.json", "--wave", "1"];
    const registry = `${base}_registry`;
    let create = "";
    const modes: Record<string, unknown> = {};
    for (const mode of ["list", "query"] as const) {
      for (const t of tenants) for (const n of [t, `${p.history}_${t}`]) await drop(d, n);
      if (mode === "list") configure(JSON.stringify(tenants), tenants.map((t) => `${set}/${t}`));
      else {
        await drop(d, registry);
        await exec(d, d === "ch" ? `CREATE DATABASE ${registry}` : `CREATE SCHEMA ${registry}`);
        await exec(d, d === "ch" ? `CREATE TABLE ${registry}.tenants (name String) ENGINE = MergeTree ORDER BY name` : `CREATE TABLE ${registry}.tenants (name text PRIMARY KEY)`);
        await exec(d, `INSERT INTO ${registry}.tenants (name) VALUES ${tenants.map((t) => `('${t}')`).join(", ")}`);
        configure(`{ query: "SELECT name FROM ${registry}.tenants" }`, [`${set}/@1of1`]);
      }
      await p.commit(`the tenant set, as a ${mode}`);
      // The wave's policy is read at the commit before: the migration is the commit after the spec.
      if (!create) {
        create = (await p.newMigration("create")).id;
        await p.commit("create");
      }
      const comment = await p.yodel(["plan", set, "--format", "markdown"]);
      if (comment.code !== 0) throw new Measured(`${mode}: yodel plan ${set} --format markdown exited ${String(comment.code)}`);
      const decide = await p.chant(wave);
      if (decide.code !== 3) throw new Measured(`${mode}: the wave did not wait for its approval (exit ${String(decide.code)})`);
      const command = /chant approve \S+ \S+ --plan \S+/.exec(`${decide.out}\n${decide.err}`)?.[0];
      if (!command) throw new Measured(`${mode}: the waiting wave printed no chant approve command`);
      const approved = await p.chant(command.split(" ").slice(1));
      if (approved.code !== 0) throw new Error(`${command} exited ${String(approved.code)}`);
      const applied = await p.chant(wave);
      if (applied.code !== 0) throw new Measured(`${mode}: the approved wave exited ${String(applied.code)}`);
      const inList = tenants.map((t) => `'${t}'`).join(", ");
      const have = Number(await scalar(d, d === "ch" ? `SELECT count() FROM system.tables WHERE database IN (${inList}) AND name = '${tableName(0)}'` : `SELECT count(*) FROM information_schema.tables WHERE table_schema IN (${inList}) AND table_name = '${tableName(0)}'`));
      if (have !== tenants.length) throw new Measured(`${mode}: ${String(have)} of ${String(tenants.length)} tenants have the table`);
      const held: number[] = [];
      for (const t of tenants) {
        const rows = await historyRows(d, `${p.history}_${t}`);
        held.push(lockFigures(rows, new Set(rows.map((r) => r.run_id))).lock_held_lower_bound_seconds);
      }
      modes[mode] = {
        runs: mode === "list" ? tenants.length : 1,
        plan_comment: { seconds: comment.seconds, bytes: Buffer.byteLength(comment.out) },
        decide_seconds: decide.seconds,
        approve_seconds: approved.seconds,
        apply_seconds: applied.seconds,
        wall_seconds: round(decide.seconds + approved.seconds + applied.seconds),
        per_tenant_wall_seconds: round((decide.seconds + applied.seconds) / tenants.length),
        lock_held_per_tenant: spread(held),
      };
    }
    // The oracle: the migration's statements sent straight to a copy of each tenant.
    for (const t of tenants) await drop(d, `${t}_oracle`);
    const straight = await oracle(d, tenants.flatMap((t) => p.statements(create).map((s) => retarget(s, base, `${t}_oracle`))), this.work, this.log);
    this.measurement.fanout = {
      what: "a tenant set of `tenants` empty tenants (#56), one table each, applied by its wave through chant run wave: decide (plans every tenant and waits), one chant approve of the set digest, apply (plans again and applies each tenant under its own lock). `list` renders a run per tenant; `query` reads the set from a registry table when the wave runs, one run for every tenant. `plan_comment` is yodel plan <set> --format markdown, the one comment for the set",
      tenants: tenants.length,
      statements_per_tenant: p.statements(create).length,
      list: modes.list,
      query: modes.query,
      oracle: straight,
      oracle_of: "every tenant's statements sent straight to a copy of it, one after another",
    };
  }

  async runAll(): Promise<void> {
    await this.cleanup();
    try {
      const main = MEASUREMENTS.filter((m) => m !== "replay" && m !== "fanout" && this.wants(m));
      if (main.length > 0) {
        try {
          await this.main();
        } catch (e) {
          this.exceptions.setup = e instanceof Error ? e.message : String(e);
          process.stdout.write(`  harness error: ${this.exceptions.setup.split("\n")[0] ?? ""}\n`);
        }
      }
      if (this.wants("replay")) await this.stage("replay", () => this.replay());
      if (this.wants("fanout")) await this.stage("fanout", () => this.fanout());
    } finally {
      if (!this.o.keep) {
        await this.cleanup();
        rmSync(this.work, { recursive: true, force: true });
      }
    }
    // Stages that ran only as setup for another are not scored.
    for (const k of Object.keys(this.byTask)) if (!this.wants(k as Measurement)) Reflect.deleteProperty(this.byTask, k);
    for (const k of Object.keys(this.stageSeconds)) if (!this.wants(k as Measurement)) Reflect.deleteProperty(this.stageSeconds, k);
    for (const k of Object.keys(this.measurement)) if (!this.wants(k as Measurement)) Reflect.deleteProperty(this.measurement, k);
  }
}

const round = (x: number) => Math.round(x * 1000) / 1000;

function git(...args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

const pkgVersion = (path: string): string => (JSON.parse(readFileSync(join(repoRoot, path), "utf8")) as { version: string }).version;

async function main(): Promise<void> {
  const o = options(process.argv.slice(2));
  await humanGate("bench");
  const versions = await serverVersions();
  const psql = await psqlVersion();
  const commit = git("rev-parse", "--short", "HEAD");
  const dirty = (git("status", "--porcelain", "--untracked-files=no") ?? "") !== "";
  const machine = {
    platform: platform(),
    release: release(),
    arch: arch(),
    cpu: cpus()[0]?.model ?? null,
    cpus: cpus().length,
    memory_gb: Math.round(totalmem() / 2 ** 30),
    node: process.version,
  };
  const outDir = join(repoRoot, "bench", "results");
  mkdirSync(outDir, { recursive: true });
  process.stdout.write(`yodel bench: ${o.measurements.join(", ")} at sizes ${o.sizes.join(", ")} on ${o.dialects.join(", ")}\n`);
  for (const dialect of o.dialects) {
    for (const size of o.sizes) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const runId = `yodel-${dialect}-${String(size)}-${stamp}`;
      process.stdout.write(`${dialectName[dialect]}, ${String(size)} objects (${runId})\n`);
      const s = new Scenario(dialect, size, o, runId);
      const t0 = now();
      await s.runAll();
      const wall = secs(now() - t0);
      const scheduled = o.measurements.length;
      const trials = Object.keys(s.byTask).length;
      const passed = Object.values(s.byTask).filter((v) => v[0] === 1).length;
      const record = {
        schema: 1,
        bench: "sql-yodeler",
        scenario: `yodel-${dialectName[dialect]}-${String(size)}`,
        arm: "yodel",
        run: {
          id: runId,
          finished_at: new Date().toISOString(),
          harness_commit: commit,
          harness_dirty: dirty,
          substrate: "emulator",
          measurements: o.measurements,
          sizes: o.sizes,
          machine,
          emulator: {
            started_with: "chant emulator up --lexicon sql",
            clickhouse: versions.clickhouse,
            postgres: versions.postgres,
          },
          oracle_clients: {
            clickhouse: "the HTTP interface (clickhouse-client is not installed here)",
            postgres: psql ?? "psql (version unknown)",
          },
          versions: {
            "@intentius/sql-yodeler": commit,
            "@intentius/chant": pkgVersion("node_modules/@intentius/chant/package.json"),
            "@intentius/chant-lexicon-sql": pkgVersion("node_modules/@intentius/chant-lexicon-sql/package.json"),
          },
        },
        agent: { name: "none", model: null, k: 1 },
        score: { trials, expected_trials: scheduled, passed, pass_rate: trials > 0 ? round(passed / trials) : 0, by_task: s.byTask },
        gates: {
          audit: Object.keys(s.exceptions).length === 0 && trials === scheduled,
          tool_missing: false,
          exceptions: s.exceptions,
          errored_trials: scheduled - trials,
          complete: trials === scheduled,
        },
        independence: {
          account_reads: null,
          account_reads_status: "not_applicable",
          account_reads_reason: "a schema-migration bench: no cloud account is read; the oracle figures in measurement are this bench's comparison",
        },
        effort: { wall_seconds: wall, stage_seconds: s.stageSeconds },
        measurement: { objects: size + 1, ...s.measurement },
        reproduce: `bench/README.md: npm run bench -- ${o.measurements.join(" ")} --sizes ${String(size)} --dialects ${dialect}`,
      };
      const file = join(outDir, `${runId}.json`);
      writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
      process.stdout.write(`  ${String(passed)}/${String(scheduled)} stages, ${String(wall)}s; ${file} (log: ${s.log})\n`);
    }
  }
}

await main();
