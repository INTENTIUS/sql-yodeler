/**
 * `yodel init --from <env>` end to end against the emulator: objects made by
 * hand (so they carry no ownership marker), adopted in one command, after
 * which `yodel plan` shows no change, `yodel status` lists the baseline
 * applied with nothing pending, and `yodel new` after a declared change
 * writes a migration whose parent is the baseline.
 *
 * ClickHouse: objects in database <prefix>_init, the history in
 * <prefix>_init_history. Postgres: objects in schema <prefix>_init, the
 * history in schema <prefix>_init_history (#13). See ./names.ts.
 *
 * "No change" for an adopted project is two things: the versioned plan
 * (`yodel plan`, which takes the versioned path once migrations/ exists) has
 * nothing pending, and the declared schema diffs clean against the live
 * database (chant's declarative plan, read through the library).
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readMigrations } from "../../src/migrations/index.js";
import { loadProject, resolveEnvironment } from "../../src/project.js";
import { buildSchema } from "../../src/chant/build.js";
import { planEnvironment } from "../../src/chant/plan.js";
import { json, yodel } from "../helpers/run.js";
import { clickhouse, clickhouseReachable, postgres, postgresReachable } from "./emulator.js";
import { e2eProject, suiteName } from "./names.js";

const DB = suiteName("init");
const HISTORY = `${DB}_history`;

interface InitDoc {
  status: string;
  objects: string[];
  schemaFiles: string[];
  migration: { path: string; id: string; checksum: string; statements: number };
  recorded: { history: string; seq: number; note: string };
}

const count = async (sql: string) => Number((await clickhouse(sql)).trim());

/** The declarative diff of the project's declared schema against the live database: what chant's plan would change. */
async function declarativeDiff(dir: string): Promise<{ changes: unknown[]; refused: unknown[] }> {
  const project = await loadProject(dir);
  const build = await buildSchema(project);
  try {
    const plan = await planEnvironment(project, resolveEnvironment(project, "e2e"), build);
    return { changes: plan.diff.changes, refused: plan.refused };
  } finally {
    build.dispose();
  }
}

/** The versioned plan has nothing to apply, and the declared schema diffs clean against the live database. */
async function expectNoChange(at: (...args: string[]) => string[], dir: string, baseline: string): Promise<void> {
  const ran = await yodel(at("plan", "e2e", "--json"));
  expect(ran.code, ran.err).toBe(0);
  expect(json(ran)).toMatchObject({ mode: "versioned", applied: 1, pending: [], problems: [] });
  expect((json(ran) as { refusal?: unknown }).refusal).toBeUndefined();
  const text = await yodel(at("plan", "e2e"));
  expect(text.code, text.err).toBe(0);
  expect(text.out).not.toContain(baseline);
  expect(await declarativeDiff(dir)).toEqual({ changes: [], refused: [] });
}

describe.skipIf(!clickhouseReachable)("yodel init --from on clickhouse", () => {
  let dir = "";
  let dispose = (): void => undefined;
  const saved = process.env.YODEL_HISTORY_DATABASE;
  const at = (...args: string[]) => [...args, "--dir", dir];
  let doc: InitDoc;

  beforeAll(async () => {
    process.env.YODEL_HISTORY_DATABASE = HISTORY;
    await clickhouse(`DROP DATABASE IF EXISTS ${DB}`);
    await clickhouse(`DROP DATABASE IF EXISTS ${HISTORY}`);
    await clickhouse(`CREATE DATABASE ${DB}`);
    await clickhouse(
      `CREATE TABLE ${DB}.events (id UInt64, ts DateTime, kind LowCardinality(String), payload String DEFAULT '' CODEC(ZSTD(3))) ` +
        `ENGINE = MergeTree PARTITION BY toYYYYMM(ts) ORDER BY (kind, id) COMMENT 'raw events'`,
    );
    await clickhouse(`CREATE TABLE ${DB}.daily (day Date, kind String, n UInt64) ENGINE = SummingMergeTree ORDER BY (day, kind)`);
    await clickhouse(`CREATE MATERIALIZED VIEW ${DB}.daily_mv TO ${DB}.daily AS SELECT toDate(ts) AS day, kind, count() AS n FROM ${DB}.events GROUP BY day, kind`);
    await clickhouse(`CREATE VIEW ${DB}.recent AS SELECT * FROM ${DB}.events WHERE ts > now() - INTERVAL 1 DAY`);
    await clickhouse(`INSERT INTO ${DB}.events VALUES (1, now(), 'click', 'x')`);
    ({ dir, dispose } = e2eProject("init-clickhouse", DB));
  });
  afterAll(async () => {
    dispose();
    if (saved === undefined) delete process.env.YODEL_HISTORY_DATABASE;
    else process.env.YODEL_HISTORY_DATABASE = saved;
    await clickhouse(`DROP DATABASE IF EXISTS ${DB}`);
    await clickhouse(`DROP DATABASE IF EXISTS ${HISTORY}`);
  });

  it("adopts the database: declarations, a baseline, recorded applied without running it", async () => {
    const ran = await yodel(at("init", "--from", "e2e", "--json"));
    expect(ran.code, ran.err).toBe(0);
    doc = json(ran) as InitDoc;
    expect(doc.status).toBe("adopted");
    expect(doc.objects).toEqual([`Database ${DB}`, `Table ${DB}.daily`, `MaterializedView ${DB}.daily_mv`, `Table ${DB}.events`, `View ${DB}.recent`]);
    expect(doc.schemaFiles).toEqual(["src/schema.ts"]);
    expect(doc.migration.id).toMatch(/^\d{8}T\d{4}-baseline$/);
    expect(doc.migration.statements).toBe(5);
    expect(doc.recorded.history).toBe(HISTORY);
    expect(doc.recorded.note).toMatch(/^baseline: /);

    const ordered = readMigrations(join(dir, "migrations"), { verify: true });
    expect(ordered.map((m) => [m.id, m.parent])).toEqual([[doc.migration.id, null]]);
    // The baseline's statements create everything, each with chant's marker.
    expect(ordered[0]?.files.sql).toContain(`CREATE TABLE ${DB}.events`);
    expect(ordered[0]?.files.sql).toContain("COMMENT 'raw events [chant managed-by=chant]'");

    // One history row, a succeeded migration row noted as the baseline; no statement rows: nothing ran.
    expect(await count(`SELECT count() FROM ${HISTORY}.history`)).toBe(1);
    expect(await count(`SELECT count() FROM ${HISTORY}.history WHERE kind = 'migration' AND status = 'succeeded' AND note LIKE 'baseline:%' AND checksum = '${doc.migration.checksum}'`)).toBe(1);
    // The live objects are as they were: unmarked, data kept.
    expect((await clickhouse(`SELECT comment FROM system.tables WHERE database = '${DB}' AND name = 'events'`)).trim()).toBe("raw events");
    expect(await count(`SELECT count() FROM ${DB}.events`)).toBe(1);
  }, 300_000);

  it("then yodel plan shows no change", async () => {
    await expectNoChange(at, dir, doc.migration.id);
  }, 300_000);

  it("and yodel status shows the baseline applied with nothing pending", async () => {
    const ran = await yodel(at("status", "e2e", "--json"));
    expect(ran.code, ran.err).toBe(0);
    const status = json(ran) as { applied: Array<{ id: string; checksum: string }>; pending: unknown[]; mismatches: unknown[] };
    expect(status.applied.map((a) => [a.id, a.checksum])).toEqual([[doc.migration.id, doc.migration.checksum]]);
    expect(status.pending).toEqual([]);
    expect(status.mismatches).toEqual([]);
    const apply = await yodel(at("apply", "e2e", "--json"));
    expect(apply.code, apply.err).toBe(0);
    expect((json(apply) as { status: string }).status).toBe("unchanged");
  }, 300_000);

  it("refuses to adopt again, and writes nothing", async () => {
    const before = readFileSync(join(dir, "src", "schema.ts"), "utf8");
    const ran = await yodel(at("init", "--from", "e2e", "--force"));
    expect(ran.code).toBe(4);
    expect(ran.err).toContain("already holds migrations");
    expect(readFileSync(join(dir, "src", "schema.ts"), "utf8")).toBe(before);
    expect(readdirSync(join(dir, "migrations"))).toEqual([doc.migration.id]);
  }, 300_000);

  it("yodel new after a declared change writes a migration whose parent is the baseline", async () => {
    const path = join(dir, "src", "schema.ts");
    const schema = readFileSync(path, "utf8");
    expect(schema).toContain("      n UInt64\n");
    writeFileSync(path, schema.replace("      n UInt64\n", "      n UInt64,\n      note String DEFAULT ''\n"));
    const ran = await yodel(at("new", "add-note", "--json"));
    expect(ran.code, ran.err).toBe(0);
    const made = json(ran) as { written: boolean; id: string; parent: string; statements: number };
    expect(made).toMatchObject({ written: true, parent: doc.migration.id, statements: 1 });

    const status = await yodel(at("status", "e2e", "--json"));
    expect(status.code, status.err).toBe(3);
    const s = json(status) as { applied: Array<{ id: string }>; pending: Array<{ id: string; outOfOrder: boolean }> };
    expect(s.applied.map((a) => a.id)).toEqual([doc.migration.id]);
    expect(s.pending.map((p) => [p.id, p.outOfOrder])).toEqual([[made.id, false]]);
  }, 300_000);
});

describe.skipIf(!clickhouseReachable)("yodel init --from on clickhouse, refused", () => {
  let dir = "";
  let dispose = (): void => undefined;
  const saved = process.env.YODEL_HISTORY_DATABASE;

  beforeAll(() => {
    process.env.YODEL_HISTORY_DATABASE = `${HISTORY}_refused`;
    ({ dir, dispose } = e2eProject("init-clickhouse", DB));
  });
  afterAll(async () => {
    dispose();
    if (saved === undefined) delete process.env.YODEL_HISTORY_DATABASE;
    else process.env.YODEL_HISTORY_DATABASE = saved;
    await clickhouse(`DROP DATABASE IF EXISTS ${HISTORY}_refused`);
  });

  it("refuses a source directory that already declares a schema, before reading the server", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "mine.ts"), "export {};\n");
    const ran = await yodel(["init", "--from", "e2e", "--dir", dir]);
    expect(ran.code).toBe(4);
    expect(ran.err).toContain("already declares a schema (mine.ts)");
    expect(existsSync(join(dir, "migrations"))).toBe(false);
    expect(readdirSync(join(dir, "src"))).toEqual(["mine.ts"]);
  }, 300_000);
});

describe.skipIf(!postgresReachable)("yodel init --from on postgres", () => {
  let dir = "";
  let dispose = (): void => undefined;
  const saved = process.env.YODEL_HISTORY_DATABASE;
  const at = (...args: string[]) => [...args, "--dir", dir];
  let doc: InitDoc;

  beforeAll(async () => {
    process.env.YODEL_HISTORY_DATABASE = HISTORY;
    await postgres(`DROP SCHEMA IF EXISTS ${DB} CASCADE; DROP SCHEMA IF EXISTS ${HISTORY} CASCADE`);
    await postgres(`
      CREATE SCHEMA ${DB};
      CREATE TABLE ${DB}.customers (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, email text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE ${DB}.orders (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        customer_id bigint NOT NULL REFERENCES ${DB}.customers(id),
        status text NOT NULL DEFAULT 'placed' CHECK (status <> ''),
        amount numeric(12, 2) NOT NULL
      );
      CREATE INDEX orders_status_idx ON ${DB}.orders (status);
      COMMENT ON TABLE ${DB}.orders IS 'customer orders';
      CREATE VIEW ${DB}.open_orders AS SELECT id, amount FROM ${DB}.orders WHERE status = 'placed';`);
    ({ dir, dispose } = e2eProject("init-postgres", DB));
  });
  afterAll(async () => {
    dispose();
    if (saved === undefined) delete process.env.YODEL_HISTORY_DATABASE;
    else process.env.YODEL_HISTORY_DATABASE = saved;
    await postgres(`DROP SCHEMA IF EXISTS ${DB} CASCADE; DROP SCHEMA IF EXISTS ${HISTORY} CASCADE`);
  });

  it("writes the declarations and the baseline, and records the baseline applied in the history schema", async () => {
    const ran = await yodel(at("init", "--from", "e2e", "--json"));
    expect(ran.code, ran.err).toBe(0);
    doc = json(ran) as InitDoc;
    expect(doc.status).toBe("adopted");
    expect(doc.recorded).toMatchObject({ history: HISTORY, seq: 1, note: expect.stringMatching(/^baseline: /) as unknown });
    const rows = await postgres<{ kind: string; status: string; checksum: string }>(`SELECT kind, status, checksum FROM ${HISTORY}.history`);
    expect(rows).toEqual([{ kind: "migration", status: "succeeded", checksum: doc.migration.checksum }]);
    expect(doc.objects).toEqual([`Schema ${DB}`, `Table ${DB}.customers`, `Table ${DB}.orders`, `View ${DB}.open_orders`, `Index ${DB}.orders_status_idx`]);
    const ordered = readMigrations(join(dir, "migrations"), { verify: true });
    expect(ordered.map((m) => [m.id, m.parent])).toEqual([[doc.migration.id, null]]);
    expect(ordered[0]?.files.sql).toContain(`CREATE TABLE ${DB}.orders`);
    // Nothing was sent: the live comment is still the one made by hand, unmarked.
    expect((await postgres<{ c: string }>(`SELECT obj_description('${DB}.orders'::regclass, 'pg_class') AS c`))[0]?.c).toBe("customer orders");
  }, 300_000);

  it("then yodel plan shows no change", async () => {
    await expectNoChange(at, dir, doc.migration.id);
  }, 300_000);

  it("and yodel status shows the baseline applied with nothing pending", async () => {
    const ran = await yodel(at("status", "e2e", "--json"));
    expect(ran.code, ran.err).toBe(0);
    expect(json(ran)).toMatchObject({ applied: [{ id: doc.migration.id }], pending: [] });
  }, 300_000);

  it("yodel new after a declared change writes a migration whose parent is the baseline", async () => {
    const path = join(dir, "src", "schema.ts");
    const schema = readFileSync(path, "utf8");
    expect(schema).toContain("      amount numeric(12,2) NOT NULL,\n");
    writeFileSync(path, schema.replace("      amount numeric(12,2) NOT NULL,\n", "      amount numeric(12,2) NOT NULL,\n      note text,\n"));
    const ran = await yodel(at("new", "add-note", "--json"));
    expect(ran.code, ran.err).toBe(0);
    expect(json(ran)).toMatchObject({ written: true, parent: doc.migration.id, statements: 1 });
  }, 300_000);
});
