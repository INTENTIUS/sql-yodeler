/**
 * Op steps inside a migration (#12), end to end against the emulator's
 * ClickHouse: a sort-key change refused without approval (nothing made),
 * then applied as a ClickHouseRebuildOp step behind the migrations Op's
 * gate; and a backfill step that fails part way and resumes from its
 * receipts without redoing the batches that finished.
 *
 * Objects in database <prefix>_steps, the history in <prefix>_steps_history
 * (./names.ts); receipts in chant's chant_receipts.receipts, under this
 * test's environment (also <prefix>_steps) and migration ids, deleted first
 * so the suite reruns from scratch. Gated like the other e2e suites:
 *
 *   YODEL_E2E_CLICKHOUSE_URL=http://$(ipconfig getifaddr en0):8123 npx vitest run test/e2e/steps.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { runChant } from "../../src/chant/process.js";
import type { BuildOutput, BuiltObject } from "../../src/chant/build.js";
import { createMigration, readMigrations, writeMigration, type CreatedMigration } from "../../src/migrations/index.js";
import { json, projectFrom, yodel } from "../helpers/run.js";
import { clickhouse, clickhouseReachable } from "./emulator.js";
import { FIXTURE_NAME, suiteName } from "./names.js";

const DB = suiteName("steps");
const HISTORY = `${DB}_history`;
// The environment is named for the suite too: the backfill's receipts, in chant's own
// chant_receipts.receipts, are addressed yodel/<env>/<migration id>/<effect>.
const ENV = DB;
const FAIL_ENV = "YODEL_E2E_STEPS_FAIL_AT";

const events = (orderBy: string, extraColumns = ""): BuiltObject => ({
  export: "events",
  type: "ClickHouse::Table",
  ddl: `CREATE TABLE ${DB}.events (id UInt64, ts DateTime, k String${extraColumns}) ENGINE = MergeTree PARTITION BY toYYYYMM(ts) ORDER BY ${orderBy}`,
  dependsOn: ["db"],
});
const log: BuiltObject = { export: "log", type: "ClickHouse::Table", ddl: `CREATE TABLE ${DB}.backfill_log (batch UInt32, at DateTime64(3) DEFAULT now64(3)) ENGINE = MergeTree ORDER BY batch`, dependsOn: ["db"] };
const build = (...objects: BuiltObject[]): BuildOutput => ({
  dialect: "clickhouse",
  objects: [{ export: "db", type: "ClickHouse::Database", ddl: `CREATE DATABASE ${DB} ENGINE = Atomic`, dependsOn: [] }, ...objects],
});

const MONTHS = [202607, 202608, 202609];

/** Three batches, one per month; the one named by YODEL_E2E_STEPS_FAIL_AT fails before it changes anything. */
const BACKFILL = `
import { EffectReceipt } from "@intentius/chant";
import { Op, activity, effect, phase } from "@intentius/chant/op";

const months = ${JSON.stringify(MONTHS)};
const failAt = Number(process.env.${FAIL_ENV} ?? 0);
const sync = { mutations_sync: "2" };

const batch = (m: number) =>
  effect(EffectReceipt(\`country-\${m}\`, { effect: \`country/\${m}\`, flavor: "existence" }), [
    ...(m === failAt ? [activity("yodelSql", { sql: "SELECT throwIf(1, 'forced interruption')" }, "atMostOnce")] : []),
    activity("yodelSql", { sql: \`ALTER TABLE ${DB}.events UPDATE country = concat('c-', k) WHERE toYYYYMM(ts) = \${m}\`, settings: sync }, "atMostOnce"),
    activity("yodelSql", { sql: \`INSERT INTO ${DB}.backfill_log (batch) VALUES (\${m})\` }, "atMostOnce"),
  ]);

export const op = Op({ name: "backfill-country", overview: "country from k, a month at a time", phases: [phase("Backfill", months.map(batch))] });
`;

interface Doc {
  status?: string;
  approve?: string;
  planDigest?: string;
  pending: Array<{ id: string; partWay: { resumeAt: number; done: number[] } | null; opSteps: Array<{ index: number; op?: string }> }>;
  applied: Array<{ id: string }>;
}

const count = async (sql: string) => Number((await clickhouse(sql)).trim());
const text = async (sql: string) => (await clickhouse(sql)).trim();

describe.skipIf(!clickhouseReachable)("Op steps in a migration, on clickhouse", () => {
  let dir = "";
  let dispose = (): void => undefined;
  const saved = process.env.YODEL_HISTORY_DATABASE;
  const at = (...args: string[]) => [...args, "--dir", dir];
  const migrations = () => join(dir, "migrations");

  const next = (name: string, minute: number, schema: BuildOutput, backfill?: string): CreatedMigration => {
    const made = createMigration({ name, build: schema, previous: readMigrations(migrations()).at(-1), now: new Date(Date.UTC(2026, 9, 9, 16, minute)), ...(backfill ? { backfill: { text: backfill } } : {}) });
    if (made.id === undefined) throw new Error(`no change for ${name}`);
    writeMigration(migrations(), made);
    return made;
  };

  const approve = async (command: string | undefined) => {
    expect(command).toMatch(new RegExp(`^chant approve migrate-${ENV} approve-migrate-${ENV} --plan jcs1-sha256:[0-9a-f]{64}$`));
    const ran = await runChant((command ?? "").split(" ").slice(1), { cwd: dir });
    expect(ran.code, ran.stderr).toBe(0);
  };

  const gated = async () => {
    const ran = await yodel(at("apply", ENV, "--json"));
    expect(ran.code, ran.err).toBe(3);
    const doc = json(ran) as Doc;
    expect(doc.status).toBe("gated");
    return doc;
  };

  const approvedApply = async () => {
    await approve((await gated()).approve);
    return yodel(at("apply", ENV, "--json"));
  };

  const historyRows = (id: string) =>
    text(`SELECT groupArray(concat(kind, ':', toString(statement_index), ':', status)) FROM (SELECT * FROM ${HISTORY}.history WHERE migration_id = '${id}' ORDER BY seq)`);

  beforeAll(async () => {
    process.env.YODEL_HISTORY_DATABASE = HISTORY;
    Reflect.deleteProperty(process.env, FAIL_ENV);
    await clickhouse(`DROP DATABASE IF EXISTS ${DB} SYNC`);
    await clickhouse(`DROP DATABASE IF EXISTS ${HISTORY} SYNC`);
    if ((await count(`EXISTS TABLE chant_receipts.receipts`)) === 1) {
      await clickhouse(`ALTER TABLE chant_receipts.receipts DELETE WHERE startsWith(address, 'yodel/${ENV}/20261009T16') SETTINGS mutations_sync = 2`);
    }
    // The fixture names its environment e2e (test/rebuild-topology.test.ts uses it too); this copy names it ENV, in the profile and the Op.
    ({ dir, dispose } = projectFrom("clickhouse-steps", (text) => text.replaceAll(FIXTURE_NAME, DB).replace(/\be2e\b/g, ENV)));
  });
  afterAll(async () => {
    dispose();
    Reflect.deleteProperty(process.env, FAIL_ENV);
    if (saved === undefined) delete process.env.YODEL_HISTORY_DATABASE;
    else process.env.YODEL_HISTORY_DATABASE = saved;
    await clickhouse(`DROP DATABASE IF EXISTS ${DB} SYNC`);
    await clickhouse(`DROP DATABASE IF EXISTS ${HISTORY} SYNC`);
  });

  it("refuses a rebuild without approval and makes nothing, then rebuilds the sort key as a ClickHouseRebuildOp step behind the gate", async () => {
    next("events", 0, build(events("(k, id)")));
    const first = await approvedApply();
    expect(first.code, first.err).toBe(0);
    await clickhouse(`INSERT INTO ${DB}.events SELECT number, toDateTime('2026-07-01 00:00:00') + toIntervalDay(number * 3), concat('k', toString(number % 4)) FROM numbers(30)`);
    expect(await count(`SELECT uniqExact(toYYYYMM(ts)) FROM ${DB}.events`)).toBe(3);

    const rekey = next("rekey", 1, build(events("(id, k)")));
    expect(rekey.document.steps.map((s) => (s.kind === "op" ? s.op : s.kind))).toEqual(["ClickHouseRebuildOp"]);

    // Refused: the gate has no approval for this plan. Nothing is made.
    const refused = await gated();
    expect(refused.pending).toMatchObject([{ id: rekey.id, opSteps: [{ index: 0, op: "ClickHouseRebuildOp" }] }]);
    process.env.YODEL_APPROVED_PLAN = refused.planDigest;
    try {
      const bypass = await yodel(at("apply", ENV, "--execute"));
      expect(bypass.code).toBe(3);
      expect(bypass.err).toContain("gate ledger holds no approval");
    } finally {
      delete process.env.YODEL_APPROVED_PLAN;
    }
    expect(await count(`SELECT count() FROM system.tables WHERE database = '${DB}' AND name LIKE 'events__chant%'`)).toBe(0);
    expect(await text(`SELECT sorting_key FROM system.tables WHERE database = '${DB}' AND name = 'events'`)).toBe("k, id");
    expect(await count(`SELECT count() FROM ${HISTORY}.history WHERE migration_id = '${rekey.id}'`)).toBe(0);

    // Approved: the rebuild runs inside the migration, under the lock.
    await approve(refused.approve);
    const applied = await yodel(at("apply", ENV, "--json"));
    expect(applied.code, applied.err).toBe(0);
    expect(applied.err).toContain("step 0: ClickHouseRebuildOp for events");
    expect(await text(`SELECT sorting_key FROM system.tables WHERE database = '${DB}' AND name = 'events'`)).toBe("id, k");
    expect(await count(`SELECT count() FROM ${DB}.events`)).toBe(30);
    expect(await count(`EXISTS TABLE ${DB}.events__chant_old`)).toBe(1);
    expect(await count(`EXISTS TABLE ${DB}.events__chant_new`)).toBe(0);
    expect(await historyRows(rekey.id)).toBe("['migration:-1:started','step:0:started','step:0:succeeded','migration:-1:succeeded']");
    const note = JSON.parse(await text(`SELECT note FROM ${HISTORY}.history WHERE migration_id = '${rekey.id}' AND kind = 'step' AND status = 'succeeded'`)) as Record<string, unknown>;
    expect(note).toMatchObject({ op: "ClickHouseRebuildOp", table: `${DB}.events`, state: "rebuild", partitions: 3, copied: 3, skipped: 0, cleared: 0, repaired: 0, verifiedRows: 30, swapped: true, oldTable: `${DB}.events__chant_old` });
  }, 600_000);

  it("resumes a backfill step that failed part way from its receipts, never redoing a finished batch, and the history says it ran", async () => {
    const fill = next("country", 2, build(events("(id, k)", ", country String DEFAULT ''"), log), BACKFILL);
    expect(fill.document.steps.map((s) => (s.kind === "op" ? s.op : s.kind))).toEqual(["statement", "statement", "backfill"]);

    process.env[FAIL_ENV] = String(MONTHS[2]);
    const failed = await approvedApply();
    expect(failed.code, failed.err).toBe(1);
    expect(failed.err).toContain("forced interruption");
    expect(await text(`SELECT groupArray(batch) FROM (SELECT batch FROM ${DB}.backfill_log ORDER BY batch)`)).toBe(`[${String(MONTHS[0])},${String(MONTHS[1])}]`);
    // The two finished months are filled, the third is not.
    expect(await text(`SELECT groupArray((m, filled)) FROM (SELECT toYYYYMM(ts) AS m, countIf(country != '') = count() AS filled FROM ${DB}.events GROUP BY m ORDER BY m)`)).toBe(
      `[(${String(MONTHS[0])},1),(${String(MONTHS[1])},1),(${String(MONTHS[2])},0)]`,
    );
    expect(await count(`SELECT count() FROM chant_receipts.receipts WHERE startsWith(address, 'yodel/${ENV}/${fill.id}/')`)).toBe(2);
    const mid = json(await yodel(at("status", ENV, "--json"))) as Doc;
    expect(mid.pending).toMatchObject([{ id: fill.id, partWay: { resumeAt: 2, done: [0, 1] } }]);
    const failedNote = JSON.parse(await text(`SELECT note FROM ${HISTORY}.history WHERE migration_id = '${fill.id}' AND kind = 'step' AND status = 'failed'`)) as Record<string, unknown>;
    expect(failedNote).toEqual({ op: "backfill", file: "backfill.ts", name: "backfill-country", effects: 3, skipped: 0, ran: 2 });

    // The cause is gone; the rerun resumes at the step and skips the batches with a receipt.
    Reflect.deleteProperty(process.env, FAIL_ENV);
    const resumed = await approvedApply();
    expect(resumed.code, resumed.err).toBe(0);
    expect(resumed.err).toContain("statement 0: succeeded in an earlier run; not sent");
    expect(resumed.err).toContain("step 2: backfill backfill.ts (resuming from its receipts)");
    expect(await text(`SELECT groupArray(batch) FROM (SELECT batch FROM ${DB}.backfill_log ORDER BY batch)`)).toBe(`[${MONTHS.join(",")}]`);
    expect(await count(`SELECT count() FROM ${DB}.events WHERE country = concat('c-', k)`)).toBe(30);
    const note = JSON.parse(await text(`SELECT note FROM ${HISTORY}.history WHERE migration_id = '${fill.id}' AND kind = 'step' AND status = 'succeeded'`)) as Record<string, unknown>;
    expect(note).toEqual({ op: "backfill", file: "backfill.ts", name: "backfill-country", effects: 3, skipped: 2, ran: 1 });
    expect(await historyRows(fill.id)).toBe(
      "['migration:-1:started','statement:0:started','statement:0:succeeded','statement:1:started','statement:1:succeeded','step:2:started','step:2:failed','migration:-1:failed'," +
        "'migration:-1:started','step:2:started','step:2:succeeded','migration:-1:succeeded']",
    );
    const done = json(await yodel(at("status", ENV, "--json"))) as Doc;
    expect(done.pending).toEqual([]);
    expect(done.applied.map((a) => a.id)).toContain(fill.id);
  }, 600_000);
});
