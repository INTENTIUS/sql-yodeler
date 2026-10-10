/**
 * Postgres functions, procedures and triggers in migrations (#44): what
 * `yodel new` writes for them and what `yodel lint` says about them.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BuildOutput, BuiltObject } from "../src/chant/build.js";
import { createMigration, newestMigration, readMigrations, writeMigration, type CreatedMigration } from "../src/migrations/index.js";
import { lintMigrations } from "../src/lint/index.js";

const app: BuiltObject = { export: "app", type: "Postgres::Schema", ddl: "CREATE SCHEMA yodel_44", dependsOn: [] };
const orders: BuiltObject = { export: "orders", type: "Postgres::Table", ddl: "CREATE TABLE yodel_44.orders (id bigint PRIMARY KEY, status text)", dependsOn: ["app"] };
const touch = (body = "BEGIN RETURN NEW; END"): BuiltObject => ({
  export: "touch",
  type: "Postgres::Function",
  ddl: `CREATE FUNCTION yodel_44.touch() RETURNS trigger LANGUAGE plpgsql AS $$ ${body} $$`,
  dependsOn: ["app"],
});
const archive = (params: string): BuiltObject => ({
  export: "archive",
  type: "Postgres::Procedure",
  ddl: `CREATE PROCEDURE yodel_44.archive(${params}) LANGUAGE sql AS $$ DELETE FROM yodel_44.orders WHERE id < before_id $$`,
  dependsOn: ["orders"],
});
const ordersTouch: BuiltObject = {
  export: "ordersTouch",
  type: "Postgres::Trigger",
  ddl: "CREATE TRIGGER orders_touch BEFORE UPDATE ON yodel_44.orders FOR EACH ROW EXECUTE FUNCTION yodel_44.touch()",
  dependsOn: ["orders", "touch"],
};
const pg = (...objects: BuiltObject[]): BuildOutput => ({ dialect: "postgres", postgresMajor: 18, objects: [app, orders, ...objects] });

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "yodel-routines-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function chain(dir: string, builds: Array<[string, BuildOutput]>): CreatedMigration[] {
  return builds.map(([name, build], i) => {
    const m = createMigration({ name, build, previous: newestMigration(readMigrations(dir)), now: new Date(Date.UTC(2026, 9, 10, 12, i)) });
    if (m.id === undefined) throw new Error(`no change for ${name}`);
    writeMigration(dir, m);
    return m;
  });
}

const at = (ms: CreatedMigration[], i: number): CreatedMigration => {
  const m = ms[i];
  if (!m) throw new Error(`no migration ${String(i)}`);
  return m;
};

const statements = (m: CreatedMigration) => m.document.steps.flatMap((s) => (s.kind === "statement" ? [`${s.rule} ${s.class} ${s.sql.split("\n")[0] ?? ""}`] : []));

describe("yodel new: functions, procedures and triggers", () => {
  it("creates a trigger after its function and table, as part of the create when the table is new", () => {
    const sql = statements(at(chain(tempDir(), [["create", pg(touch(), ordersTouch)]]), 0)).filter((s) => !s.includes("COMMENT ON"));
    expect(sql.findIndex((s) => s.includes("CREATE TABLE"))).toBeLessThan(sql.findIndex((s) => s.includes("CREATE TRIGGER")));
    expect(sql.findIndex((s) => s.includes("CREATE FUNCTION"))).toBeLessThan(sql.findIndex((s) => s.includes("CREATE TRIGGER")));
    expect(sql.find((s) => s.includes("CREATE TRIGGER"))).toMatch(/^SQLPG200 create /);
  });

  it("labels a trigger created on a table that already exists SQLPG283 metadata, its comment too", () => {
    const ms = chain(tempDir(), [
      ["create", pg(touch())],
      ["trigger", pg(touch(), ordersTouch)],
    ]);
    const second = at(ms, 1);
    const triggers = second.document.steps.filter((s) => s.kind === "statement" && s.type === "Postgres::Trigger");
    expect(triggers.map((s) => (s.kind === "statement" ? `${s.rule} ${s.class}` : ""))).toEqual(["SQLPG283 metadata", "SQLPG283 metadata"]);
    expect(second.files.sql).toContain("SQLPG283 metadata\nCREATE TRIGGER orders_touch");
  });

  it("replaces a body with CREATE OR REPLACE and drops a trigger before the function it calls", () => {
    const ms = chain(tempDir(), [
      ["create", pg(touch(), ordersTouch)],
      ["noop", pg(touch(), ordersTouch, archive("before_id bigint"))],
      ["body", pg(touch("BEGIN NEW.status := 'x'; RETURN NEW; END"), ordersTouch, archive("before_id bigint"))],
      ["drop", pg(archive("before_id bigint"))],
    ]);
    expect(statements(at(ms, 2))).toEqual([expect.stringMatching(/^SQLPG280 metadata CREATE OR REPLACE FUNCTION yodel_44\.touch\(\)/)]);
    expect(statements(at(ms, 3))).toEqual(["SQLPG285 drop DROP TRIGGER orders_touch ON yodel_44.orders", "SQLPG270 drop DROP FUNCTION yodel_44.touch()"]);
  });
});

describe("yodel lint: functions, procedures and triggers", () => {
  it("pg-signature: a routine dropped and created with other parameter types", async () => {
    const dir = tempDir();
    chain(dir, [
      ["create", pg(archive("before_id bigint"))],
      ["widen", pg(archive("before_id bigint, keep int"))],
    ]);
    const report = await lintMigrations(dir, { dialect: "postgres" });
    expect(report.findings.map((f) => [f.rule, f.step])).toEqual([["pg-signature", 0]]);
    expect(report.findings[0]?.message).toContain("drops procedure yodel_44.archive(bigint) and creates it as yodel_44.archive(bigint,integer)");
  });

  it("a body replaced in place is not flagged", async () => {
    const dir = tempDir();
    chain(dir, [
      ["create", pg(touch(), archive("before_id bigint"))],
      ["body", pg(touch("BEGIN NEW.status := 'x'; RETURN NEW; END"), archive("before_id bigint"))],
    ]);
    expect((await lintMigrations(dir, { dialect: "postgres" })).findings).toEqual([]);
  });

  it("pg-routine-in-use: a function dropped while a declared trigger still executes it by name", async () => {
    const dir = tempDir();
    const byName: BuiltObject = { ...ordersTouch, dependsOn: ["orders"] };
    chain(dir, [
      ["create", pg(touch(), ordersTouch)],
      ["drop-fn", pg(byName)],
    ]);
    const report = await lintMigrations(dir, { dialect: "postgres" });
    expect(report.findings.map((f) => f.rule)).toEqual(["pg-routine-in-use"]);
    expect(report.findings[0]?.message).toContain("drops function yodel_44.touch(), which trigger ordersTouch (orders_touch ON yodel_44.orders) still executes");
    expect(report.errors).toBe(1);
  });

  it("does not flag a function dropped with its trigger", async () => {
    const dir = tempDir();
    chain(dir, [
      ["create", pg(touch(), ordersTouch)],
      ["drop", pg()],
    ]);
    expect((await lintMigrations(dir, { dialect: "postgres" })).findings.map((f) => f.rule)).toEqual([]);
  });
});
