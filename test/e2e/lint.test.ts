/**
 * `yodel lint` against the emulator's ClickHouse: a migration whose risky
 * statements are silenced passes lint, applies behind the gate, and the
 * history records each silence with its reason; an applied migration edited
 * afterwards fails `yodel lint --env`. Everything lives in database yodel_14:
 * the table the migrations make, and the history (YODEL_HISTORY_DATABASE).
 * The database is made by the test, not declared, so the history can share it.
 * The Postgres suite does the same in schema yodel_14.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runChant } from "../../src/chant/process.js";
import type { BuildOutput } from "../../src/chant/build.js";
import { createMigration, MIGRATION_SQL, newestMigration, readMigrations, writeMigration, type CreatedMigration } from "../../src/migrations/index.js";
import { json, projectFrom, yodel } from "../helpers/run.js";
import { clickhouse, clickhouseReachable, postgres, postgresReachable } from "./emulator.js";

const DB = "yodel_14";

const build = (columns: string): BuildOutput => ({
  dialect: "clickhouse",
  objects: [{ export: "events", type: "ClickHouse::Table", ddl: `CREATE TABLE ${DB}.events (${columns}) ENGINE = MergeTree ORDER BY id`, dependsOn: [] }],
});

interface LintDoc {
  status: string;
  errors: number;
  silenced: number;
  findings: Array<{ rule: string; level: string; migration?: string; silenced?: string; message: string }>;
}

describe.skipIf(!clickhouseReachable)("yodel lint on clickhouse", () => {
  let dir = "";
  let dispose = (): void => undefined;
  const saved = process.env.YODEL_HISTORY_DATABASE;
  const at = (...args: string[]) => [...args, "--dir", dir];
  const migrations = () => join(dir, "migrations");
  const made: CreatedMigration[] = [];

  const next = (name: string, minute: number, schema: BuildOutput) => {
    const m = createMigration({ name, build: schema, previous: newestMigration(readMigrations(migrations())), now: new Date(Date.UTC(2026, 9, 9, 11, minute)) });
    if (m.id === undefined) throw new Error(`no change for ${name}`);
    writeMigration(migrations(), m);
    made.push(m);
    return m;
  };

  beforeAll(async () => {
    process.env.YODEL_HISTORY_DATABASE = DB;
    await clickhouse(`DROP DATABASE IF EXISTS ${DB} SYNC`);
    await clickhouse(`CREATE DATABASE ${DB} ENGINE = Atomic`);
    ({ dir, dispose } = projectFrom("lint-clickhouse"));
  });
  afterAll(async () => {
    dispose();
    if (saved === undefined) delete process.env.YODEL_HISTORY_DATABASE;
    else process.env.YODEL_HISTORY_DATABASE = saved;
    await clickhouse(`DROP DATABASE IF EXISTS ${DB} SYNC`);
  });

  it("passes a migration whose risky statements are silenced, and the history records each silence when it applies", async () => {
    next("create", 0, build("id UInt64, n UInt32, gone String"));
    const risky = next("drop-and-widen", 1, build("id UInt64, n UInt64"));

    const unsilenced = json(await yodel(at("lint", "--env", "e2e", "--json"))) as LintDoc;
    expect(unsilenced.findings.map((f) => [f.rule, f.level])).toEqual([
      ["destructive", "error"],
      ["ch-mutation", "error"],
    ]);

    const sqlPath = join(migrations(), risky.id, MIGRATION_SQL);
    const sql = readFileSync(sqlPath, "utf8")
      .replace("ALTER TABLE `yodel_14`.`events` DROP COLUMN `gone`", "-- yodel:allow destructive gone was never read by anything\nALTER TABLE `yodel_14`.`events` DROP COLUMN `gone`")
      .replace("ALTER TABLE `yodel_14`.`events` MODIFY COLUMN `n` UInt64", "-- yodel:allow ch-mutation events is empty in e2e\nALTER TABLE `yodel_14`.`events` MODIFY COLUMN `n` UInt64");
    writeFileSync(sqlPath, sql);

    // Pending in e2e: the edit is a warning there, and --update-checksum records it.
    const pending = json(await yodel(at("lint", "--env", "e2e", "--json"))) as LintDoc;
    expect(pending.findings.map((f) => [f.rule, f.level, f.silenced ?? null])).toEqual([
      ["checksum", "warning", null],
      ["destructive", "error", "gone was never read by anything"],
      ["ch-mutation", "error", "events is empty in e2e"],
    ]);
    expect(pending.status).toBe("passed");
    const signed = await yodel(at("lint", "--env", "e2e", "--update-checksum", risky.id));
    expect(signed.code, signed.out + signed.err).toBe(0);
    expect(signed.out).toContain("2 migrations, against e2e's history: 0 errors, 0 warnings, 2 silenced.");

    const gated = await yodel(at("apply", "e2e", "--json"));
    expect(gated.code, gated.err).toBe(3);
    const approve = (json(gated) as { approve?: string }).approve ?? "";
    expect(approve).toMatch(/^chant approve migrate-e2e approve-migrate-e2e --plan /);
    const approved = await runChant(approve.split(" ").slice(1), { cwd: dir });
    expect(approved.code, approved.stderr).toBe(0);
    const applied = await yodel(at("apply", "e2e", "--json"));
    expect(applied.code, applied.err).toBe(0);

    const rows = (await clickhouse(`SELECT kind, statement_index, status, silences FROM ${DB}.history WHERE migration_id = '${risky.id}' ORDER BY seq FORMAT JSONEachRow`))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { kind: string; statement_index: number; status: string; silences: string });
    expect(rows.map((r) => `${r.kind}:${String(r.statement_index)}:${r.status}`)).toEqual([
      "migration:-1:started",
      "statement:0:started",
      "statement:0:succeeded",
      "statement:1:started",
      "statement:1:succeeded",
      "migration:-1:succeeded",
    ]);
    for (const r of rows) {
      expect(JSON.parse(r.silences)).toEqual([
        { step: 0, rule: "destructive", reason: "gone was never read by anything" },
        { step: 1, rule: "ch-mutation", reason: "events is empty in e2e" },
      ]);
    }
    const first = made[0]?.id ?? "";
    expect((await clickhouse(`SELECT DISTINCT silences FROM ${DB}.history WHERE migration_id = '${first}'`)).trim()).toBe("[]");
  });

  it("fails --env on an applied migration edited since it ran, and will not record its checksum", async () => {
    const first = made[0]?.id ?? "";
    const sqlPath = join(migrations(), first, MIGRATION_SQL);
    writeFileSync(sqlPath, `${readFileSync(sqlPath, "utf8")}-- edited after it was applied\n`);

    const ran = await yodel(at("lint", "--env", "e2e", "--json"));
    expect(ran.code).toBe(3);
    const doc = json(ran) as LintDoc;
    expect(doc.findings.filter((f) => f.rule === "checksum").map((f) => [f.migration, f.level])).toEqual([[first, "error"]]);
    expect(doc.findings.find((f) => f.rule === "checksum")?.message).toContain(`e2e: ${first} was applied with checksum`);

    const refused = await yodel(at("lint", "--env", "e2e", "--update-checksum", first));
    expect(refused.code).toBe(1);
    expect(refused.err).toContain(`it is applied in e2e; record an intended edit there with yodel repair ${first}`);
  });
});

describe.skipIf(!postgresReachable)("yodel lint on postgres", () => {
  let dir = "";
  let dispose = (): void => undefined;
  const saved = process.env.YODEL_HISTORY_DATABASE;
  const at = (...args: string[]) => [...args, "--dir", dir];
  const migrations = () => join(dir, "migrations");
  const orders = (columns: string) => ({ export: "orders", type: "Postgres::Table", ddl: `CREATE TABLE ${DB}.orders (id bigint PRIMARY KEY, ${columns})`, dependsOn: [] });
  const pgBuild = (columns: string, index?: string): BuildOutput => ({
    dialect: "postgres",
    objects: [orders(columns), ...(index ? [{ export: "ix", type: "Postgres::Index", ddl: index, dependsOn: ["orders"] }] : [])],
  });
  const next = (name: string, minute: number, schema: BuildOutput) => {
    const m = createMigration({ name, build: schema, previous: newestMigration(readMigrations(migrations())), now: new Date(Date.UTC(2026, 9, 9, 12, minute)) });
    if (m.id === undefined) throw new Error(`no change for ${name}`);
    writeMigration(migrations(), m);
    return m;
  };

  beforeAll(async () => {
    process.env.YODEL_HISTORY_DATABASE = DB;
    await postgres(`DROP SCHEMA IF EXISTS ${DB} CASCADE; CREATE SCHEMA ${DB}`);
    ({ dir, dispose } = projectFrom("lint-postgres"));
  });
  afterAll(async () => {
    dispose();
    if (saved === undefined) delete process.env.YODEL_HISTORY_DATABASE;
    else process.env.YODEL_HISTORY_DATABASE = saved;
    await postgres(`DROP SCHEMA IF EXISTS ${DB} CASCADE`);
  });

  it("flags a rewrite, a lock and a drop; once silenced it applies and the history records the silences", async () => {
    next("create", 0, pgBuild("n integer, gone text"));
    const risky = next("widen-and-index", 1, pgBuild("n bigint", `CREATE INDEX ix ON ${DB}.orders (n)`));

    const before = json(await yodel(at("lint", "--env", "e2e", "--json"))) as LintDoc;
    const flagged = before.findings.map((f) => [f.rule, f.message.match(/SQLPG\d+/)?.[0]]);
    expect(flagged).toEqual(expect.arrayContaining([["pg-rewrite", "SQLPG207"], ["destructive", "SQLPG204"], ["pg-lock", "SQLPG241"]]));
    expect(before.status).toBe("failed");

    const sqlPath = join(migrations(), risky.id, MIGRATION_SQL);
    const sql = readFileSync(sqlPath, "utf8")
      .replace(`ALTER TABLE ${DB}.orders ALTER COLUMN n TYPE bigint;`, `-- yodel:allow pg-rewrite orders is empty in e2e\nALTER TABLE ${DB}.orders ALTER COLUMN n TYPE bigint;`)
      .replace(`ALTER TABLE ${DB}.orders DROP COLUMN gone;`, `-- yodel:allow destructive gone was never written\nALTER TABLE ${DB}.orders DROP COLUMN gone;`)
      .replace(`CREATE INDEX ix ON ${DB}.orders (n);`, `-- yodel:allow pg-lock nothing writes to orders in e2e\nCREATE INDEX ix ON ${DB}.orders (n);`);
    writeFileSync(sqlPath, sql);
    const signed = await yodel(at("lint", "--env", "e2e", "--update-checksum", risky.id));
    expect(signed.code, signed.out + signed.err).toBe(0);
    expect(signed.out).toContain("0 errors, 0 warnings, 3 silenced.");

    const gated = await yodel(at("apply", "e2e", "--json"));
    expect(gated.code, gated.err).toBe(3);
    const approve = (json(gated) as { approve?: string }).approve ?? "";
    const approved = await runChant(approve.split(" ").slice(1), { cwd: dir });
    expect(approved.code, approved.stderr).toBe(0);
    const applied = await yodel(at("apply", "e2e", "--json"));
    expect(applied.code, applied.err).toBe(0);

    const rows = await postgres<{ kind: string; status: string; silences: string }>(`SELECT kind, status, silences FROM ${DB}.history WHERE migration_id = '${risky.id}' ORDER BY seq`);
    expect(rows.length).toBeGreaterThan(2);
    const reasons = Object.fromEntries((JSON.parse(rows[0]?.silences ?? "[]") as Array<{ rule: string; reason: string }>).map((x) => [x.rule, x.reason]));
    expect(reasons).toEqual({ "pg-rewrite": "orders is empty in e2e", destructive: "gone was never written", "pg-lock": "nothing writes to orders in e2e" });
    expect(new Set(rows.map((r) => r.silences)).size).toBe(1);
  });
});
