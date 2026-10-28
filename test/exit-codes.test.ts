import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { memoryGateLedgerPort } from "@intentius/chant/op/gate";
import { EXIT_CODES, EXIT_MISPLACED, FALLBACK_EXIT, PLAN_PENDING_NOTE, useChantExitTable } from "../src/exit.js";
import { help } from "../src/cli.js";
import { commands } from "../src/commands/index.js";
import { projectFromConfig } from "../src/project.js";
import { createMigration, newestMigration, readMigrations, writeMigration, type CreatedMigration } from "../src/migrations/index.js";
import type { BuildOutput, BuiltObject } from "../src/chant/build.js";
import { currentDigest, executeApply, inspect, openVersioned, readStepExit, recordStepExit, STEP_EXIT_ENV, verifyApproval, type MigrateOpRef } from "../src/versioned/index.js";
import { collectVersionedPlan } from "../src/pr/model.js";
import { renderPlanText } from "../src/pr/render.js";
import { FakeClickHouse, migration } from "./helpers/fake-clickhouse.js";
import { projectFrom, repoRoot, yodel } from "./helpers/run.js";

const dirs: Array<() => void> = [];
afterEach(() => {
  for (const d of dirs.splice(0)) d();
});

/** yodel exits by chant's one table (#288, chant#4553). */
describe("chant's exit-code table (#288)", () => {
  it("the fallback has chant's numbers, and chant's table, when the installed chant exports it, is the same", async () => {
    expect(FALLBACK_EXIT).toEqual({ done: 0, failed: 1, drift: 2, waiting: 3, moved: 4, held: 5, superseded: 6, denied: 7, declined: 8, misplaced: 9 });
    const specifier = "@intentius/chant/exit-codes";
    const chant = await import(specifier).then((m: { CHANT_EXIT?: unknown }) => m.CHANT_EXIT, () => undefined);
    const from = await useChantExitTable();
    expect(from).toBe(chant === undefined ? "fallback" : "chant");
    if (chant !== undefined) {
      expect(chant).toEqual(FALLBACK_EXIT);
      expect(EXIT_MISPLACED).toBe(FALLBACK_EXIT.misplaced);
    }
  });

  it("every command's --help lists only codes on chant's table, each once", async () => {
    const table = new Set<number>(Object.values(FALLBACK_EXIT));
    for (const c of commands.filter((x) => x.implemented)) {
      const ran = await yodel([c.name, "--help"]);
      expect(ran.code, `${c.name}: ${ran.err}`).toBe(0);
      const section = ran.out.slice(ran.out.indexOf("\nExit codes:"));
      const codes = [...section.matchAll(/^ {2}(\d+) {2}/gm)].map((m) => Number(m[1]));
      for (const code of codes) expect(table.has(code), `yodel ${c.name} --help lists ${String(code)}`).toBe(true);
      expect(new Set(codes).size, `yodel ${c.name} --help lists a code twice`).toBe(codes.length);
    }
  });
});

/** docs/cli.md's exit-code table and `yodel --help` say the same as src/exit.ts. */
describe("the exit code table (#13)", () => {
  it("yodel --help lists every code", () => {
    const text = help().replace(/\s+/g, " ");
    for (const [code, meaning] of EXIT_CODES) expect(text).toContain(`${String(code)} ${meaning}`);
    expect(text).toContain(PLAN_PENDING_NOTE);
  });

  it("docs/cli.md's exit-code table lists every code with the same meaning", () => {
    const text = readFileSync(join(repoRoot, "docs", "cli.md"), "utf8");
    const section = text.slice(text.indexOf("\n## Exit codes\n"), text.indexOf("\n## JSON output\n"));
    const rows = [...section.matchAll(/^\| (\d+) \| (.+) \|$/gm)].map((m) => [Number(m[1]), (m[2] ?? "").replace(/`/g, "")]);
    expect(rows).toEqual(EXIT_CODES.map(([code, meaning]) => [code, meaning]));
    expect(section.replace(/\s+/g, " ").replace(/`/g, "")).toContain(PLAN_PENDING_NOTE);
  });

  it("an Op step's exit code reaches the outer apply through the file it names", () => {
    const dir = mkdtempSync(join(tmpdir(), "yodel-step-exit-"));
    dirs.push(() => { rmSync(dir, { recursive: true, force: true }); });
    const file = join(dir, "step-exit");
    expect(readStepExit(file)).toBeUndefined();
    recordStepExit(5, { [STEP_EXIT_ENV]: file });
    expect(readStepExit(file)).toBe(5);
    recordStepExit(4, {});
    expect(readStepExit(file)).toBe(5);
  });
});

const db: BuiltObject = { export: "db", type: "ClickHouse::Database", ddl: "CREATE DATABASE yodel_14 ENGINE = Atomic", dependsOn: [] };
const events = (columns: string): BuiltObject => ({ export: "events", type: "ClickHouse::Table", ddl: `CREATE TABLE yodel_14.events (${columns}) ENGINE = MergeTree ORDER BY id`, dependsOn: ["db"] });
const ch = (columns: string): BuildOutput => ({ dialect: "clickhouse", objects: [db, events(columns)] });

function add(dir: string, name: string, build: BuildOutput, minute: number, parent?: CreatedMigration): CreatedMigration {
  const previous = parent ? readMigrations(dir).find((m) => m.id === parent.id) : newestMigration(readMigrations(dir));
  const m = createMigration({ name, build, previous, now: new Date(Date.UTC(2026, 9, 9, 9, minute)) });
  if (m.id === undefined) throw new Error(`no change for ${name}`);
  writeMigration(dir, m);
  return m;
}

describe("a fork in the migrations directory (#13)", () => {
  it("apply and status refuse it with exit 1, before reading the server", async () => {
    const { dir, dispose } = projectFrom("lint-clickhouse");
    dirs.push(dispose);
    const migrations = join(dir, "migrations");
    const first = add(migrations, "create", ch("id UInt64"), 0);
    add(migrations, "add-a", ch("id UInt64, a String DEFAULT ''"), 1, first);
    add(migrations, "add-b", ch("id UInt64, b String DEFAULT ''"), 2, first);
    for (const verb of ["apply", "status"]) {
      const ran = await yodel([verb, "e2e", "--dir", dir]);
      expect(ran.code, ran.err).toBe(1);
      expect(ran.err).toContain("refused: the migrations directory is not one unbroken chain; nothing can be applied until it is:");
      expect(ran.err).toMatch(/fork: .* both follow /);
    }
  });

  it("plan says apply would refuse with exit 1, and counts the migrations the history has applied", async () => {
    const OP: MigrateOpRef = { name: "migrate-e2e", filePath: "/p/ops/migrate-e2e.op.ts", gate: "approve-migrate-e2e", quorum: false };
    const m1 = migration("20261009T1000-one", null, ["CREATE DATABASE yodel_8"]);
    const a = migration("20261009T1100-a", m1.id, ["CREATE TABLE yodel_8.a (x UInt8) ENGINE = MergeTree ORDER BY x"]);
    const b = migration("20261009T1101-b", m1.id, ["CREATE TABLE yodel_8.b (x UInt8) ENGINE = MergeTree ORDER BY x"]);
    const dir = mkdtempSync(join(tmpdir(), "yodel-fork-plan-"));
    dirs.push(() => { rmSync(dir, { recursive: true, force: true }); });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    const url = `http://fake-${randomUUID()}:8123`;
    const project = projectFromConfig(dir, join(dir, "chant.config.ts"), { lexicons: ["sql"], sql: { dialect: "clickhouse", profiles: { e2e: { url, databases: ["yodel_8"] } } } });
    const env = { name: "e2e", profile: { url } };
    const venv = await openVersioned(project, env, { YODEL_HISTORY_DATABASE: "yodel_8_history" }, new FakeClickHouse());

    // m1 and a are applied, then b is added on m1 as well.
    const { status } = await inspect(venv, [m1, a]);
    const d = await currentDigest(venv, status, status.pending);
    const ledger = memoryGateLedgerPort({ resolutions: [{ version: 1, op: OP.name, gate: OP.gate, resolvedBy: "alice", timestamp: "2026-10-09T11:00:00.000Z", planDigest: d }] });
    await executeApply(venv, [m1, a], { approvedDigest: d, allowOutOfOrder: false, approve: (x) => verifyApproval(ledger, OP, x), log: () => undefined });
    for (const m of [m1, a, b]) writeMigration(join(dir, "migrations"), m);

    const plan = await collectVersionedPlan(project, env, { venv, op: OP, ledger: null });
    expect(plan.refusal?.exitCode).toBe(1);
    expect(plan.appliedCount).toBe(2);
    const text = renderPlanText(plan);
    expect(text.split("\n")[0]).toMatch(/: 2 applied, 0 pending$/);
    expect(text).toContain("yodel apply would refuse (exit 1): the migrations directory is not one unbroken chain");
  });
});
