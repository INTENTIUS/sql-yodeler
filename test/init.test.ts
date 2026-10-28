import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import type { Io } from "../src/command.js";
import { projectFromConfig, YodelError, type Environment, type Project } from "../src/project.js";
import { deriveState, isApplied, type HistoryRow } from "../src/history/index.js";
import { compareHistory, currentDigest, executeApply, inspect, openVersioned, selectToApply, statusReport, type VersionedEnv } from "../src/versioned/index.js";
import {
  BASELINE_NOTE,
  baselineNote,
  baselineRow,
  declarationFiles,
  historyRefusal,
  isBaselineRow,
  isDeclarationFile,
  Journal,
  preflight,
  recordBaseline,
  schemaDir,
} from "../src/init/index.js";
import { FakeClickHouse, migration } from "./helpers/fake-clickhouse.js";
import { EXIT_FAILED } from "../src/exit.js";

const baseline = migration("20261009T1000-baseline", null, ["CREATE DATABASE yodel_8", "CREATE TABLE yodel_8.a (x UInt8) ENGINE = MergeTree ORDER BY x"]);
const next = migration("20261009T1100-add-y", baseline.id, ["ALTER TABLE yodel_8.a ADD COLUMN y UInt8"]);

async function setup(ch = new FakeClickHouse()): Promise<{ ch: FakeClickHouse; venv: VersionedEnv }> {
  const url = `http://fake-${randomUUID()}:8123`;
  const project = projectFromConfig("/nowhere", "/nowhere/chant.config.ts", { lexicons: ["sql"], sql: { dialect: "clickhouse", profiles: { e2e: { url, databases: ["yodel_8"] } } } });
  const venv = await openVersioned(project, { name: "e2e", profile: { url } }, { YODEL_HISTORY_DATABASE: "yodel_8_history" }, ch);
  return { ch, venv };
}

const row = (m = baseline, seq = 1): HistoryRow => baselineRow(m, { seq, runId: "run-1", appliedBy: "tester@host", environment: "e2e" });

describe("the baseline row", () => {
  it("is one succeeded migration row with the baseline note, the checksum and no parent", () => {
    const r = row();
    expect(r).toMatchObject({
      seq: 1,
      kind: "migration",
      migration_id: baseline.id,
      parent: "",
      checksum: baseline.checksum,
      statement_index: -1,
      statement_sha: "",
      status: "succeeded",
      error: "",
      plan_digest: "",
      silences: "[]",
    });
    expect(r.note).toBe(baselineNote("e2e"));
    expect(r.note.startsWith(`${BASELINE_NOTE}:`)).toBe(true);
    expect(r.note).toContain("its statements were not run");
    expect(isBaselineRow(r)).toBe(true);
  });

  it("is only for a first migration", () => {
    expect(() => row(next)).toThrow(/only a first migration can be a baseline/);
  });

  it("tells a baseline row from a repair or an ordinary row", () => {
    const r = row();
    expect(isBaselineRow({ kind: "migration", note: "baseline" })).toBe(true);
    expect(isBaselineRow({ ...r, note: "" })).toBe(false);
    expect(isBaselineRow({ ...r, note: "repair: server upgrade" })).toBe(false);
    expect(isBaselineRow({ ...r, note: "baselines are nice" })).toBe(false);
    expect(isBaselineRow({ ...r, kind: "statement" })).toBe(false);
  });

  it("reads as applied to deriveState and compareHistory, so it is never pending", () => {
    const state = deriveState([row()]);
    expect(isApplied(state.byId.get(baseline.id))).toBe(true);
    const status = compareHistory([baseline], state);
    expect(status.applied.map((a) => a.id)).toEqual([baseline.id]);
    expect(status.pending).toEqual([]);
    expect(status.mismatches).toEqual([]);
  });

  it("puts the next migration after it as the only pending one, not out of order", () => {
    const status = compareHistory([baseline, next], deriveState([row()]));
    expect(status.applied.map((a) => a.id)).toEqual([baseline.id]);
    expect(status.pending.map((p) => [p.id, p.outOfOrder])).toEqual([[next.id, false]]);
  });

  it("has its checksum checked like any applied migration's", () => {
    const changed = migration(baseline.id, null, ["CREATE DATABASE yodel_8"]);
    const status = compareHistory([changed], deriveState([row()]));
    expect(status.mismatches.map((m) => [m.kind, m.id])).toEqual([["applied", baseline.id]]);
  });
});

describe("historyRefusal", () => {
  it("allows an empty history and refuses one that records anything", () => {
    expect(historyRefusal(deriveState([]), "h.history")).toBeUndefined();
    const refusal = historyRefusal(deriveState([row()]), "h.history");
    expect(refusal).toBeInstanceOf(YodelError);
    expect(refusal?.exitCode).toBe(EXIT_FAILED);
    expect(refusal?.message).toContain(baseline.id);
    expect(refusal?.message).toContain("Nothing was written");
  });
});

describe("recordBaseline", () => {
  it("makes the history, appends the one row, and status shows it applied with nothing pending", async () => {
    const { ch, venv } = await setup();
    const { row: written, lock } = await recordBaseline(venv, baseline, { USER: "tester" });
    expect(ch.historyExists).toBe(true);
    expect(lock.kind).toBe("local");
    expect(ch.rows).toHaveLength(1);
    expect(ch.rows[0]).toMatchObject({ seq: 1, migration_id: baseline.id, status: "succeeded", note: baselineNote("e2e") });
    expect(written.applied_by).toMatch(/^tester@/);
    // None of the baseline's statements was sent.
    expect(ch.sent).toEqual([]);

    const report = await statusReport(venv, [baseline]);
    expect(report.status.applied.map((a) => a.id)).toEqual([baseline.id]);
    expect(report.status.pending).toEqual([]);
    expect(report.refusal).toBeUndefined();
    expect(report.digest).toBeUndefined();
  });

  it("refuses when the history already records a migration, and appends nothing", async () => {
    const { ch, venv } = await setup();
    await recordBaseline(venv, baseline, { USER: "tester" });
    await expect(recordBaseline(venv, baseline, { USER: "tester" })).rejects.toMatchObject({ exitCode: EXIT_FAILED });
    expect(ch.rows).toHaveLength(1);
  });

  it("leaves apply to send the next migration's statements only, never the baseline's", async () => {
    const { ch, venv } = await setup();
    await recordBaseline(venv, baseline, { USER: "tester" });
    const ordered = [baseline, next];
    const { status } = await inspect(venv, ordered);
    expect(selectToApply(status, false).map((p) => p.id)).toEqual([next.id]);
    const digest = await currentDigest(venv, status, status.pending);
    const result = await executeApply(venv, ordered, { approvedDigest: digest, allowOutOfOrder: false, approve: () => Promise.resolve(), log: () => undefined, processEnv: { USER: "tester" } });
    expect(result.applied).toEqual([next.id]);
    expect(ch.sent).toEqual(["ALTER TABLE yodel_8.a ADD COLUMN y UInt8"]);
  });
});

describe("the files init writes", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });
  const tmp = () => (dir = mkdtempSync(join(tmpdir(), "yodel-init-")));

  it("counts TypeScript and SQL declarations, not tests, type declarations, dot files or node_modules", () => {
    expect(["schema.ts", "a.mts", "b.sql"].every(isDeclarationFile)).toBe(true);
    expect(["a.test.ts", "a.spec.ts", "a.d.ts", "README.md", "a.json"].some(isDeclarationFile)).toBe(false);
    const d = tmp();
    mkdirSync(join(d, "nested"));
    mkdirSync(join(d, "node_modules"));
    mkdirSync(join(d, ".cache"));
    for (const f of ["schema.ts", "nested/views.sql", "nested/x.test.ts", "node_modules/y.ts", ".cache/z.ts", "notes.md"]) writeFileSync(join(d, f), "");
    expect(declarationFiles(d)).toEqual(["nested/views.sql", "schema.ts"]);
    expect(declarationFiles(join(d, "missing"))).toEqual([]);
  });

  it("takes back what it wrote: a new file and directory removed, an overwritten file restored", () => {
    const d = tmp();
    writeFileSync(join(d, "keep.ts"), "old");
    const j = new Journal();
    j.mkdir(join(d, "src", "deep"));
    j.write(join(d, "src", "deep", "schema.ts"), "new");
    j.write(join(d, "keep.ts"), "overwritten");
    mkdirSync(join(d, "made"));
    j.created(join(d, "made"));
    expect(readFileSync(join(d, "keep.ts"), "utf8")).toBe("overwritten");
    j.undo();
    expect(existsSync(join(d, "src"))).toBe(false);
    expect(existsSync(join(d, "made"))).toBe(false);
    expect(readFileSync(join(d, "keep.ts"), "utf8")).toBe("old");
  });
});

describe("preflight", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  const project = (dialect: "clickhouse" | "postgres", profile: Record<string, unknown>, sourceDir?: string): { p: Project; env: Environment } => {
    dir = mkdtempSync(join(tmpdir(), "yodel-init-"));
    const p = projectFromConfig(dir, join(dir, "chant.config.ts"), { lexicons: ["sql"], ...(sourceDir ? { sourceDir } : {}), sql: { dialect, profiles: { e2e: profile as never } } });
    return { p, env: { name: "e2e", profile: profile as never } };
  };
  const ch = { url: "http://ch:8123", databases: ["yodel_8"] };
  const env = { YODEL_HISTORY_DATABASE: "yodel_8_history" };

  it("passes a project with no declarations and no migrations", () => {
    const { p, env: e } = project("clickhouse", ch);
    expect(() => { preflight(p, e, { processEnv: env }); }).not.toThrow();
    expect(schemaDir(p)).toBe(join(dir, "src"));
  });

  it("writes to sourceDir when the config names one", () => {
    const { p } = project("clickhouse", ch, "schema");
    expect(schemaDir(p)).toBe(join(dir, "schema"));
  });

  it("refuses declarations already there unless forced", () => {
    const { p, env: e } = project("clickhouse", ch);
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "schema.ts"), "export {}");
    expect(() => { preflight(p, e, { processEnv: env }); }).toThrow(/already declares a schema \(schema\.ts\).*--force/s);
    expect(() => { preflight(p, e, { force: true, processEnv: env }); }).not.toThrow();
  });

  it("refuses a project that already has migrations, forced or not", () => {
    const { p, env: e } = project("clickhouse", ch);
    mkdirSync(join(dir, "migrations", baseline.id), { recursive: true });
    for (const force of [false, true]) {
      try {
        preflight(p, e, { force, processEnv: env });
        expect.unreachable();
      } catch (err) {
        expect(err).toMatchObject({ exitCode: EXIT_FAILED });
        expect((err as Error).message).toContain("already holds migrations");
      }
    }
  });

  it("refuses a ClickHouse profile with no databases, or with the history's", () => {
    const none = project("clickhouse", { url: "http://ch:8123" });
    expect(() => { preflight(none.p, none.env, { processEnv: env }); }).toThrow(/names no databases.*yodel_8_history/s);
    rmSync(dir, { recursive: true, force: true });
    const withHistory = project("clickhouse", { url: "http://ch:8123", databases: ["yodel_8", "yodel_8_history"] });
    expect(() => { preflight(withHistory.p, withHistory.env, { processEnv: env }); }).toThrow(/includes yodel_8_history, the history's database/);
  });

  it("asks a Postgres profile for its schemas, the history's not among them", () => {
    const none = project("postgres", { url: "postgres://pg:5432/db" });
    expect(() => { preflight(none.p, none.env, { processEnv: env }); }).toThrow(/names no schemas, so the import would read every schema on the server/);
    const own = project("postgres", { url: "postgres://pg:5432/db", schemas: ["app", "yodeler"] });
    expect(() => { preflight(own.p, own.env, { processEnv: {} }); }).toThrow(/schemas includes yodeler, the history's schema/);
    const ok = project("postgres", { url: "postgres://pg:5432/db", schemas: ["app"] });
    expect(() => { preflight(ok.p, ok.env, { processEnv: {} }); }).not.toThrow();
  });
});

describe("yodel init arguments", () => {
  const run = async (argv: string[]) => {
    let out = "";
    let err = "";
    const io: Io = { out: (t) => (out += t), err: (t) => (err += t) };
    return { code: await main(argv, io), out, err };
  };

  it("needs --from", async () => {
    for (const args of [[], ["--from"], ["--from", ""], ["prod"]]) {
      const r = await run(["init", ...args]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("usage: yodel init --from <env>");
    }
  });

  it("refuses a bad baseline name before reading anything", async () => {
    const r = await run(["init", "--from", "prod", "--name", "Bad Name"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('migration name "Bad Name"');
  });

  it("says what must exist first, for both dialects, in --help", async () => {
    const r = await run(["init", "--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("What must exist first");
    expect(r.out).toContain("sql.profiles.<env>.databases");
    expect(r.out).toContain("sql.profiles.<env>.schemas");
    expect(r.out).not.toContain("#13");
  });

  it("fails without a project", async () => {
    const d = mkdtempSync(join(tmpdir(), "yodel-init-"));
    try {
      const r = await run(["init", "--from", "prod", "--dir", d]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("no chant.config.ts");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("a migration runner's table on ClickHouse (#17)", () => {
  it("is left out of the import with the Postgres import's warning", async () => {
    const { withoutRunnerTables } = await import("../src/init/live.js");
    const table = (name: string) => ({ type: "ClickHouse::Table", logicalId: name, properties: { database: "legacy", name } });
    const warnings: string[] = [];
    const kept = await withoutRunnerTables([table("orders"), table("schema_migrations"), table("goose_db_version"), { type: "ClickHouse::Database", logicalId: "db", properties: { name: "schema_migrations" } }] as never, warnings);
    expect(kept.map((r) => r.logicalId)).toEqual(["orders", "db"]);
    expect(warnings).toEqual([
      "legacy.schema_migrations is kept by a migration runner (Rails, golang-migrate, dbmate); left out, since declaring it would have chant change what that tool owns",
      "legacy.goose_db_version is kept by goose; left out, since declaring it would have chant change what that tool owns",
    ]);
  });
});
