import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { projectFromConfig } from "../src/project.js";
import { checksProblem, computeChecksum, judgeCheck, parseCheckArg, serializeDocument, verifyChecksum, type Migration, type MigrationCheck } from "../src/migrations/index.js";
import { currentDigest, executeApply, inspect, openVersioned, REFUSED, selectToApply, type VersionedEnv } from "../src/versioned/index.js";
import { FakeClickHouse, migration } from "./helpers/fake-clickhouse.js";

/** `m` with these checks in its migration.json and its checksum recomputed, as yodel new --check writes it. */
function withChecks(m: Migration, checks: MigrationCheck[]): Migration {
  const unsigned = { ...m.document, checks, checksum: "" };
  const document = { ...unsigned, checksum: computeChecksum({ sql: m.files.sql, json: unsigned }) };
  return { ...m, checksum: document.checksum, document, files: { ...m.files, json: serializeDocument(document) } };
}

const m1 = migration("20261009T1000-one", null, ["CREATE TABLE yodel_8.a (x UInt8) ENGINE = MergeTree ORDER BY x"]);
const m2 = migration("20261009T1100-two", m1.id, ["ALTER TABLE yodel_8.a DROP COLUMN x"]);
const empty: MigrationCheck = { name: "a-is-empty", sql: "SELECT 1 FROM yodel_8.a LIMIT 1" };

async function setup(answer: (sql: string) => Array<Record<string, unknown>>): Promise<{ ch: FakeClickHouse; venv: VersionedEnv; asked: string[] }> {
  const ch = new FakeClickHouse();
  const url = `http://fake-${randomUUID()}:8123`;
  const project = projectFromConfig("/nowhere", "/nowhere/chant.config.ts", { lexicons: ["sql"], sql: { dialect: "clickhouse", profiles: { e2e: { url, databases: ["yodel_8"] } } } });
  const venv = await openVersioned(project, { name: "e2e", profile: { url } }, { YODEL_HISTORY_DATABASE: "yodel_8_history" }, ch);
  const asked: string[] = [];
  venv.driver.readCheck = (sql) => {
    asked.push(sql);
    return Promise.resolve(answer(sql));
  };
  return { ch, venv, asked };
}

async function apply(venv: VersionedEnv, ordered: Migration[]) {
  const { status } = await inspect(venv, ordered);
  const digest = await currentDigest(venv, status, selectToApply(status, false));
  return executeApply(venv, ordered, { approvedDigest: digest, allowOutOfOrder: false, approve: () => Promise.resolve(), log: () => undefined, processEnv: { USER: "tester" } });
}

describe("pre-migration checks (#52)", () => {
  it("are validated as migration.json is read, and --check names them", () => {
    expect(checksProblem(undefined)).toBeUndefined();
    expect(checksProblem([empty, { name: "n", sql: "SELECT count() FROM t", expect: { max: 10 } }, { name: "t", sql: "SELECT 1", expect: "true" }])).toBeUndefined();
    expect(checksProblem({})).toMatch(/not an array/);
    expect(checksProblem([empty, empty])).toMatch(/two checks are named a-is-empty/);
    expect(checksProblem([{ name: "x", sql: " " }])).toMatch(/no sql/);
    expect(checksProblem([{ name: "x", sql: "SELECT 1", expect: "rows" }])).toMatch(/expect must be/);
    expect(checksProblem([{ name: "x", sql: "SELECT 1", expect: {} }])).toMatch(/min, max or both/);
    expect(parseCheckArg("SELECT 1 FROM t", 2)).toEqual({ name: "check-2", sql: "SELECT 1 FROM t" });
    expect(parseCheckArg("t-empty: SELECT 1 FROM t LIMIT 1", 1)).toEqual({ name: "t-empty", sql: "SELECT 1 FROM t LIMIT 1" });
  });

  it("pass or fail on the rows the query returned", () => {
    expect(judgeCheck(empty, []).passed).toBe(true);
    expect(judgeCheck(empty, [{ "1": 1 }])).toMatchObject({ passed: false, detail: '1 row, the first {"1":1}' });
    const t: MigrationCheck = { name: "t", sql: "SELECT 1", expect: "true" };
    expect(judgeCheck(t, [{ ok: 1 }]).passed).toBe(true);
    expect(judgeCheck(t, [{ ok: false }]).passed).toBe(false);
    expect(judgeCheck(t, []).passed).toBe(false);
    const n: MigrationCheck = { name: "n", sql: "SELECT count() FROM t", expect: { min: 1, max: 100 } };
    expect(judgeCheck(n, [{ "count()": "42" }]).passed).toBe(true);
    expect(judgeCheck(n, [{ "count()": "0" }])).toMatchObject({ passed: false, detail: "0" });
    expect(judgeCheck(n, [{ "count()": "many" }]).passed).toBe(false);
  });

  it("count in the checksum and the plan digest: editing one moves the digest", async () => {
    const { venv } = await setup(() => []);
    const digest = async (ordered: Migration[]) => {
      const { status } = await inspect(venv, ordered);
      return currentDigest(venv, status, status.pending);
    };
    const checked = withChecks(m1, [empty]);
    expect(verifyChecksum(checked).ok).toBe(true);
    expect(checked.checksum).not.toBe(m1.checksum);
    const base = await digest([checked]);
    expect(await digest([m1])).not.toBe(base);
    expect(await digest([withChecks(m1, [{ ...empty, sql: "SELECT 1 FROM yodel_8.a WHERE x > 0 LIMIT 1" }])])).not.toBe(base);
  });

  it("run under the lock before the migration's first statement; a failing one refuses with exit 4, names the check, sends nothing of it, and the history records it", async () => {
    const { ch, venv, asked } = await setup(() => [{ "1": 1 }]);
    const checked = withChecks(m2, [empty]);
    await expect(apply(venv, [m1, checked])).rejects.toMatchObject({ exitCode: REFUSED, message: expect.stringMatching(/check a-is-empty failed: it must return no rows, and returned 1 row/) as unknown });
    expect(asked).toEqual([empty.sql]);
    expect(ch.sent).toEqual([m1.document.steps[0]?.kind === "statement" ? m1.document.steps[0].sql : ""]);
    const row = ch.rows.find((r) => r.migration_id === checked.id);
    expect(row).toMatchObject({ kind: "migration", status: "failed", error: expect.stringMatching(/check a-is-empty failed/) as unknown });
    expect(ch.rows.filter((r) => r.migration_id === checked.id)).toHaveLength(1);
  });

  it("let the migration apply when they pass, the started row carrying their outcome, and are not run again on a resume", async () => {
    let rows: Array<Record<string, unknown>> = [];
    const { ch, venv, asked } = await setup(() => rows);
    const two = withChecks(migration("20261009T1100-two", m1.id, ["ALTER TABLE yodel_8.a ADD COLUMN y UInt8", "ALTER TABLE yodel_8.a ADD COLUMN z UInt8"]), [empty]);
    ch.failWith = (sql) => (sql.includes("ADD COLUMN z") ? "Code: 44. DB::Exception: no" : undefined);
    await expect(apply(venv, [m1, two])).rejects.toMatchObject({ name: "ApplyFailed" });
    expect(asked).toHaveLength(1);
    const started = ch.rows.find((r) => r.migration_id === two.id && r.kind === "migration" && r.status === "started");
    expect(JSON.parse(String(started?.note))).toEqual({ checks: [{ name: "a-is-empty", passed: true, detail: "no rows" }] });
    // A statement of it succeeded: it resumes, and its checks held before the first statement, so they are not run again.
    rows = [{ "1": 1 }];
    ch.failWith = () => undefined;
    expect((await apply(venv, [m1, two])).applied).toEqual([two.id]);
    expect(asked).toHaveLength(1);
  });
});
