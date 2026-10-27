/**
 * The versioned path end to end against the emulator's ClickHouse: apply
 * behind the migrations Op's gate, status, a migration interrupted part way
 * and resumed, checksum and out-of-order refusals, and an approval that no
 * longer holds once the plan moved. The objects live in database
 * <prefix>_versioned, the history in <prefix>_versioned_history (./names.ts). The emulator has no Keeper, so the lock is
 * the local one here; test/e2e/keeper.test.ts covers the Keeper lock.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runChant } from "../../src/chant/process.js";
import type { BuildOutput, BuiltObject } from "../../src/chant/build.js";
import { computeChecksum, createMigration, readMigrations, serializeDocument, writeMigration, type CreatedMigration, type Migration, type MigrationDocument } from "../../src/migrations/index.js";
import { json, yodel } from "../helpers/run.js";
import { clickhouse, clickhouseReachable } from "./emulator.js";
import { e2eProject, suiteName } from "./names.js";

const DB = suiteName("versioned");
const HISTORY = `${DB}_history`;

const build = (aColumns: string, extra: BuiltObject[] = []): BuildOutput => ({
  dialect: "clickhouse",
  objects: [
    { export: "db", type: "ClickHouse::Database", ddl: `CREATE DATABASE ${DB} ENGINE = Atomic`, dependsOn: [] },
    { export: "a", type: "ClickHouse::Table", ddl: `CREATE TABLE ${DB}.a (${aColumns}) ENGINE = MergeTree ORDER BY id`, dependsOn: ["db"] },
    ...extra,
  ],
});
const tableB: BuiltObject = { export: "b", type: "ClickHouse::Table", ddl: `CREATE TABLE ${DB}.b (id UInt64) ENGINE = MergeTree ORDER BY id`, dependsOn: ["db"] };
const tableC: BuiltObject = { export: "c", type: "ClickHouse::Table", ddl: `CREATE TABLE ${DB}.c (id UInt64) ENGINE = MergeTree ORDER BY id`, dependsOn: ["db"] };

interface StatusDoc {
  applied: Array<{ id: string; checksum: string }>;
  pending: Array<{ id: string; outOfOrder: boolean; partWay: { status: string; resumeAt: number; failedStatement: number | null; done: number[]; error: string } | null }>;
  outOfOrder: string[];
  partWay: Array<{ id: string; resumeAt: number; failedStatement: number | null }>;
  mismatches: Array<{ kind: string; id: string }>;
  planDigest?: string;
  status?: string;
  approve?: string;
  gatePlanDigest?: string;
}

const count = async (sql: string) => Number((await clickhouse(sql)).trim());

describe.skipIf(!clickhouseReachable)("the versioned path on clickhouse", () => {
  let dir = "";
  let dispose = (): void => undefined;
  const saved = process.env.YODEL_HISTORY_DATABASE;
  const at = (...args: string[]) => [...args, "--dir", dir];
  const migrations = () => join(dir, "migrations");
  const ids: string[] = [];

  /** Writes the next migration from `schema`, following the newest. */
  const next = (name: string, minute: number, schema: BuildOutput, previous?: Migration): CreatedMigration => {
    const made = createMigration({ name, build: schema, previous: previous ?? readMigrations(migrations()).at(-1), now: new Date(Date.UTC(2026, 9, 9, 10, minute)) });
    if (made.id === undefined) throw new Error(`no change for ${name}`);
    writeMigration(migrations(), made);
    ids.push(made.id);
    return made;
  };

  const approve = async (command: string | undefined) => {
    expect(command).toMatch(/^chant approve migrate-e2e approve-migrate-e2e --plan jcs1-sha256:[0-9a-f]{64}$/);
    const ran = await runChant((command ?? "").split(" ").slice(1), { cwd: dir });
    expect(ran.code, ran.stderr).toBe(0);
  };

  /** yodel apply until the gate, approve, apply again: what a person does. */
  const approvedApply = async (...extra: string[]) => {
    const gated = await yodel(at("apply", "e2e", "--json", ...extra));
    expect(gated.code, gated.err).toBe(3);
    const doc = json(gated) as StatusDoc;
    expect(doc.status).toBe("gated");
    expect(doc.gatePlanDigest).toBe(doc.planDigest);
    await approve(doc.approve);
    return yodel(at("apply", "e2e", "--json", ...extra));
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
    ({ dir, dispose } = e2eProject("clickhouse-versioned", DB));
  });
  afterAll(async () => {
    dispose();
    if (saved === undefined) delete process.env.YODEL_HISTORY_DATABASE;
    else process.env.YODEL_HISTORY_DATABASE = saved;
    await clickhouse(`DROP DATABASE IF EXISTS ${DB}`);
    await clickhouse(`DROP DATABASE IF EXISTS ${HISTORY}`);
  });

  it("applies two migrations behind the gate, and status lists them applied", async () => {
    next("one", 0, build("id UInt64"));
    next("two", 10, build("id UInt64, y String DEFAULT ''"));

    const before = await status(3);
    expect(before.applied).toEqual([]);
    expect(before.pending.map((p) => p.id)).toEqual(ids.slice(0, 2));
    expect(before.planDigest).toMatch(/^jcs1-sha256:/);

    const text = await yodel(at("apply", "e2e", "--plan"));
    expect(text.code, text.err).toBe(0);
    expect(text.out).toContain(`Plan digest: ${String(before.planDigest)}`);

    const applied = await approvedApply();
    expect(applied.code, applied.err).toBe(0);
    expect((json(applied) as StatusDoc).status).toBe("applied");
    // The gate resumes (chant#3947): the second run starts at it, from the gated run's checkpoint.
    expect((json(applied) as StatusDoc & { resumed?: { gate: string } }).resumed?.gate).toBe("approve-migrate-e2e");
    expect(applied.err).toContain(`[resume] at gate "approve-migrate-e2e"`);
    // No Keeper on the emulator: the run says the lock is local.
    expect(applied.err).toContain("cross-runner locking needs Keeper");
    expect(await count(`EXISTS TABLE ${DB}.a`)).toBe(1);

    const after = await status(0);
    expect(after.applied.map((a) => a.id)).toEqual(ids.slice(0, 2));
    expect(after.pending).toEqual([]);
    // One migration row per event, one statement row per statement event, all carrying the approved digest.
    expect(await count(`SELECT count() FROM ${HISTORY}.history WHERE kind = 'migration' AND status = 'succeeded'`)).toBe(2);
    expect(await count(`SELECT countIf(plan_digest NOT LIKE 'jcs1-sha256:%') FROM ${HISTORY}.history`)).toBe(0);
    expect(await count(`SELECT count() FROM ${HISTORY}.history WHERE kind = 'statement' AND status = 'started'`)).toBe(
      await count(`SELECT count() FROM ${HISTORY}.history WHERE kind = 'statement' AND status = 'succeeded'`),
    );
    const engine = (await clickhouse(`SELECT engine FROM system.tables WHERE database = '${HISTORY}' AND name = 'history'`)).trim();
    expect(engine).toBe("MergeTree");

    const again = await yodel(at("apply", "e2e", "--json"));
    expect(again.code, again.err).toBe(0);
    expect((json(again) as StatusDoc).status).toBe("unchanged");
  }, 300_000);

  it("refuses an approval once the plan moved after it", async () => {
    next("three", 20, build("id UInt64, y String DEFAULT '', note String DEFAULT ''", [tableB]));
    const first = await yodel(at("apply", "e2e", "--json"));
    expect(first.code, first.err).toBe(3);
    const gated = json(first) as StatusDoc;

    // The digest alone is not an approval: --execute handed the current digest, with nothing approved in the ledger, refuses.
    process.env.YODEL_APPROVED_PLAN = gated.planDigest;
    try {
      const bypass = await yodel(at("apply", "e2e", "--execute"));
      expect(bypass.code).toBe(3);
      expect(bypass.err).toContain(`gate ledger holds no approval of migrate-e2e / approve-migrate-e2e for plan ${String(gated.planDigest)}`);
    } finally {
      delete process.env.YODEL_APPROVED_PLAN;
    }
    expect(await count(`EXISTS TABLE ${DB}.b`)).toBe(0);

    await approve(gated.approve);

    // The live schema changes after approval: the gate asks again, with a new digest, and nothing is applied.
    await clickhouse(`CREATE TABLE ${DB}.handmade (x UInt8) ENGINE = MergeTree ORDER BY x`);
    const second = await yodel(at("apply", "e2e", "--json"));
    expect(second.code, second.err).toBe(3);
    const regated = json(second) as StatusDoc;
    expect(regated.planDigest).not.toBe(gated.planDigest);
    expect(second.err).toContain("is approved, but not for this plan");

    // The Apply step itself, handed the stale approval, refuses under the lock.
    process.env.YODEL_APPROVED_PLAN = gated.planDigest;
    try {
      const stale = await yodel(at("apply", "e2e", "--execute"));
      expect(stale.code).toBe(1);
      expect(stale.err).toMatch(/the plan moved since it was approved .*Nothing was applied/);
    } finally {
      delete process.env.YODEL_APPROVED_PLAN;
    }
    expect((await status(3)).pending.map((p) => p.id)).toEqual([ids[2]]);
    await clickhouse(`DROP TABLE ${DB}.handmade`);
  }, 300_000);

  it("resumes a migration that failed part way at the statement that failed, never resending the ones that ran", async () => {
    // Table b is there already, so three's second statement (CREATE TABLE b) fails after its first (ADD COLUMN note) ran.
    await clickhouse(`CREATE TABLE ${DB}.b (id UInt64) ENGINE = MergeTree ORDER BY id`);
    const failed = await approvedApply();
    expect(failed.code, failed.err).toBe(1);
    expect((json(failed) as StatusDoc).status).toBe("failed");

    const mid = await status(3);
    expect(mid.partWay).toEqual([{ id: ids[2], resumeAt: 1, failedStatement: 1 }]);
    expect(mid.pending[0]?.partWay).toMatchObject({ status: "failed", done: [0] });
    expect(mid.pending[0]?.partWay?.error).toMatch(/already exists/);
    expect(await count(`SELECT count() FROM system.columns WHERE database = '${DB}' AND table = 'a' AND name = 'note'`)).toBe(1);
    const text = await yodel(at("status", "e2e"));
    expect(text.out).toContain("failed part way at statement 1; resumes at statement 1");

    // Fix the server; the rerun sends statement 1 only. Resending statement 0 (ADD COLUMN note) would fail: the column is there.
    await clickhouse(`DROP TABLE ${DB}.b`);
    const resumed = await approvedApply();
    expect(resumed.code, resumed.err).toBe(0);
    expect(resumed.err).toContain("statement 0: succeeded in an earlier run; not sent");
    expect(await count(`SELECT count() FROM ${HISTORY}.history WHERE migration_id = '${String(ids[2])}' AND kind = 'statement' AND statement_index = 0 AND status = 'started'`)).toBe(1);
    expect(await count(`EXISTS TABLE ${DB}.b`)).toBe(1);
    expect((await status(0)).applied.map((a) => a.id)).toEqual(ids.slice(0, 3));
  }, 300_000);

  it("refuses a checksum mismatch, and an out-of-order migration unless --allow-out-of-order", async () => {
    const [, two, three] = readMigrations(migrations()) as [Migration, Migration, Migration];
    // Main merges "late" after two, before three, which this environment already applied.
    const late = createMigration({ name: "late", build: build("id UInt64, y String DEFAULT ''", [tableC]), previous: two, now: new Date(Date.UTC(2026, 9, 9, 10, 15)) });
    if (late.id === undefined) throw new Error("no change for late");
    writeMigration(migrations(), late);
    const doc = { ...(JSON.parse(readFileSync(join(three.dir, "migration.json"), "utf8")) as MigrationDocument), parent: late.id };
    const moved = { ...doc, checksum: computeChecksum({ sql: three.files.sql, json: doc }) };
    writeFileSync(join(three.dir, "migration.json"), serializeDocument(moved));

    const mismatch = await status(1);
    expect(mismatch.mismatches).toMatchObject([{ kind: "applied", id: three.id }]);
    const refused = await yodel(at("apply", "e2e"));
    expect(refused.code).toBe(1);
    expect(refused.err).toContain(`${three.id} was applied with checksum`);
    expect(refused.err).toContain("yodel repair");

    // What yodel repair (#15) will do: append a migration row recording the new checksum, with the reason.
    const seq = await count(`SELECT max(seq) + 1 FROM ${HISTORY}.history`);
    await clickhouse(
      `INSERT INTO ${HISTORY}.history (seq, run_id, kind, migration_id, parent, checksum, statement_index, status, applied_by, note) VALUES ` +
        `(${String(seq)}, 'repair', 'migration', '${three.id}', '${late.id}', '${moved.checksum}', -1, 'succeeded', 'e2e', 'rebased onto ${late.id}')`,
    );

    const late1 = await status(1);
    expect(late1.mismatches).toEqual([]);
    expect(late1.outOfOrder).toEqual([late.id]);
    expect(late1.pending).toMatchObject([{ id: late.id, outOfOrder: true }]);
    const text = await yodel(at("status", "e2e"));
    expect(text.out).toContain(`Out of order (1): ${late.id}; apply with --allow-out-of-order`);

    const notAllowed = await yodel(at("apply", "e2e"));
    expect(notAllowed.code).toBe(1);
    expect(notAllowed.err).toMatch(new RegExp(`${late.id} is out of order.*--allow-out-of-order`));
    expect(await count(`EXISTS TABLE ${DB}.c`)).toBe(0);

    const allowed = await approvedApply("--allow-out-of-order");
    expect(allowed.code, allowed.err).toBe(0);
    expect(await count(`EXISTS TABLE ${DB}.c`)).toBe(1);
    const done = await status(0);
    expect(done.applied.map((a) => a.id).sort()).toEqual([...ids.slice(0, 3), late.id].sort());
  }, 300_000);
});
