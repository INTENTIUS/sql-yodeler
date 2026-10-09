/**
 * yodel repair and yodel rebase --env against the emulator's ClickHouse:
 * apply a migration behind the gate, edit it, see status refuse the
 * mismatch, repair it with a reason, see status clean and the reason in the
 * history; and a rebase refused for a migration the history records. The
 * objects live in database yodel_15, the history in yodel_15_history.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runChant } from "../../src/chant/process.js";
import type { BuildOutput, BuiltObject } from "../../src/chant/build.js";
import { computeChecksum, createMigration, scanMigrations, writeMigration, type Migration } from "../../src/migrations/index.js";
import { json, projectFrom, yodel } from "../helpers/run.js";
import { clickhouse, clickhouseReachable } from "./emulator.js";

const DB = "yodel_15";
const HISTORY = "yodel_15_history";

const db: BuiltObject = { export: "db", type: "ClickHouse::Database", ddl: `CREATE DATABASE ${DB} ENGINE = Atomic`, dependsOn: [] };
const table = (name: string): BuiltObject => ({ export: name, type: "ClickHouse::Table", ddl: `CREATE TABLE ${DB}.${name} (id UInt64) ENGINE = MergeTree ORDER BY id`, dependsOn: ["db"] });
const build = (...names: string[]): BuildOutput => ({ dialect: "clickhouse", objects: [db, ...names.map(table)] });

interface StatusDoc {
  applied: Array<{ id: string; checksum: string }>;
  mismatches: Array<{ kind: string; id: string; recorded: string; actual: string }>;
  planDigest?: string;
  status?: string;
  approve?: string;
}

describe.skipIf(!clickhouseReachable)("yodel repair and rebase on clickhouse", () => {
  let dir = "";
  let dispose = (): void => undefined;
  const saved = process.env.YODEL_HISTORY_DATABASE;
  const at = (...args: string[]) => [...args, "--dir", dir];
  const migrations = () => join(dir, "migrations");
  const add = (name: string, minute: number, schema: BuildOutput, previous?: Migration): Migration => {
    const made = createMigration({ name, build: schema, previous, now: new Date(Date.UTC(2026, 9, 9, 11, minute)) });
    if (made.id === undefined) throw new Error(`no change for ${name}`);
    writeMigration(migrations(), made);
    return scanMigrations(migrations()).migrations.find((m) => m.id === made.id) as Migration;
  };
  const status = async (code: number) => {
    const ran = await yodel(at("status", "e2e", "--json"));
    expect(ran.code, ran.err).toBe(code);
    return json(ran) as StatusDoc;
  };

  beforeAll(async () => {
    process.env.YODEL_HISTORY_DATABASE = HISTORY;
    await clickhouse(`DROP DATABASE IF EXISTS ${DB}`);
    await clickhouse(`DROP DATABASE IF EXISTS ${HISTORY}`);
    ({ dir, dispose } = projectFrom("clickhouse-repair"));
  });
  afterAll(async () => {
    dispose();
    if (saved === undefined) delete process.env.YODEL_HISTORY_DATABASE;
    else process.env.YODEL_HISTORY_DATABASE = saved;
    await clickhouse(`DROP DATABASE IF EXISTS ${DB}`);
    await clickhouse(`DROP DATABASE IF EXISTS ${HISTORY}`);
  });

  let one: Migration;

  it("repairs an applied migration whose files were edited, recording the reason", async () => {
    one = add("one", 0, build("a"));
    const gated = await yodel(at("apply", "e2e", "--json"));
    expect(gated.code, gated.err).toBe(3);
    const approve = (json(gated) as StatusDoc).approve ?? "";
    const approved = await runChant(approve.split(" ").slice(1), { cwd: dir });
    expect(approved.code, approved.stderr).toBe(0);
    const applied = await yodel(at("apply", "e2e", "--json"));
    expect(applied.code, applied.err).toBe(0);
    expect((await status(0)).applied.map((a) => a.id)).toEqual([one.id]);

    const notNeeded = await yodel(at("repair", one.id, "--reason", "nothing changed", "e2e"));
    expect(notNeeded.code).toBe(4);
    expect(notNeeded.err).toContain("already hash to the checksum");

    // The intended edit: a comment in migration.sql, as a server upgrade's reformat would be.
    appendFileSync(join(one.dir, "migration.sql"), "-- reviewed after the 26.8 upgrade\n");
    const edited = computeChecksum({ sql: readFileSync(join(one.dir, "migration.sql"), "utf8"), json: readFileSync(join(one.dir, "migration.json"), "utf8") });
    const mismatch = await status(4);
    expect(mismatch.mismatches).toMatchObject([{ kind: "applied", id: one.id, recorded: one.checksum, actual: edited }]);
    const refused = await yodel(at("apply", "e2e"));
    expect(refused.code).toBe(4);
    expect(refused.err).toContain("yodel repair");

    const noReason = await yodel(at("repair", one.id, "e2e"));
    expect(noReason.code).toBe(1);

    const reason = "comment added after the 26.8 upgrade; statements unchanged";
    const repaired = await yodel(at("repair", one.id, "--reason", reason, "e2e"));
    expect(repaired.code, repaired.err).toBe(0);
    expect(repaired.out).toContain(`old checksum: ${one.checksum}`);
    expect(repaired.out).toContain(`new checksum: ${edited}`);
    expect(repaired.out).toContain(`reason: ${reason}`);

    const clean = await status(0);
    expect(clean.mismatches).toEqual([]);
    expect(clean.applied).toMatchObject([{ id: one.id, checksum: edited }]);
    const row = JSON.parse(
      await clickhouse(`SELECT checksum, status, note FROM ${HISTORY}.history WHERE migration_id = '${one.id}' AND kind = 'migration' ORDER BY seq DESC LIMIT 1 FORMAT JSONEachRow`),
    ) as { checksum: string; status: string; note: string };
    expect(row).toEqual({ checksum: edited, status: "succeeded", note: reason });

    const again = await yodel(at("repair", one.id, "--reason", reason, "e2e"));
    expect(again.code).toBe(4);
    const pending = await yodel(at("repair", "20261009T1159-nope", "--reason", reason, "e2e"));
    expect(pending.code).toBe(4);
    expect(pending.err).toContain("not in the migrations directory");
  }, 300_000);

  it("refuses to rebase a migration the environment's history records", async () => {
    // A fork after one: the newer one is applied here (merged and applied first), so it cannot move.
    const older = add("add-b", 10, build("a", "b"), one);
    const newer = add("add-c", 20, build("a", "c"), one);
    await clickhouse(
      `INSERT INTO ${HISTORY}.history (seq, run_id, kind, migration_id, parent, checksum, statement_index, status, applied_by, note) ` +
        `SELECT max(seq) + 1, 'e2e', 'migration', '${newer.id}', '${one.id}', '${newer.checksum}', -1, 'succeeded', 'e2e', '' FROM ${HISTORY}.history`,
    );
    const refused = await yodel(at("rebase", "--env", "e2e"));
    expect(refused.code).toBe(4);
    expect(refused.err).toContain(`e2e's history records ${newer.id} (applied)`);

    const other = await yodel(at("rebase", older.id, "--env", "e2e", "--json"));
    expect(other.code, other.err).toBe(0);
    expect(json(other)).toMatchObject({ moved: older.id, onto: newer.id, historiesChecked: ["e2e"] });
  }, 300_000);
});
