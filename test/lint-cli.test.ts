import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BuildOutput, BuiltObject } from "../src/chant/build.js";
import { createMigration, MIGRATION_SQL, newestMigration, readMigrations, writeMigration, type CreatedMigration } from "../src/migrations/index.js";
import { json, projectFrom, yodel } from "./helpers/run.js";

const db: BuiltObject = { export: "db", type: "ClickHouse::Database", ddl: "CREATE DATABASE yodel_14 ENGINE = Atomic", dependsOn: [] };
const events = (columns: string): BuiltObject => ({ export: "events", type: "ClickHouse::Table", ddl: `CREATE TABLE yodel_14.events (${columns}) ENGINE = MergeTree ORDER BY id`, dependsOn: ["db"] });
const ch = (columns: string): BuildOutput => ({ dialect: "clickhouse", objects: [db, events(columns)] });

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const d of disposers.splice(0)) d();
});

function project(name = "lint-clickhouse"): { dir: string; migrations: string; at: (...args: string[]) => string[] } {
  const { dir, dispose } = projectFrom(name);
  disposers.push(dispose);
  return { dir, migrations: join(dir, "migrations"), at: (...args) => ["lint", ...args, "--dir", dir] };
}

function add(dir: string, name: string, build: BuildOutput, minute: number, parent?: CreatedMigration): CreatedMigration {
  const previous = parent ? readMigrations(dir).find((m) => m.id === parent.id) : newestMigration(readMigrations(dir));
  const m = createMigration({ name, build, previous, now: new Date(Date.UTC(2026, 9, 9, 9, minute)) });
  if (m.id === undefined) throw new Error(`no change for ${name}`);
  writeMigration(dir, m);
  return m;
}

interface LintDoc {
  status: string;
  errors: number;
  warnings: number;
  silenced: number;
  migrations: string[];
  findings: Array<{ rule: string; level: string; migration?: string; step?: number; silenced?: string; message: string }>;
  silences: Record<string, Array<{ step: number; rule: string; reason: string }>>;
}

describe("yodel lint (the command)", () => {
  it("exits 0 on a clean directory and on a project with no migrations", async () => {
    const p = project();
    const none = await yodel(p.at());
    expect(none.code, none.err).toBe(0);
    expect(none.out).toContain("0 migrations: 0 errors, 0 warnings, 0 silenced.");

    add(p.migrations, "create", ch("id UInt64"), 0);
    const ran = await yodel(p.at("--json"));
    expect(ran.code, ran.err).toBe(0);
    expect(json(ran)).toMatchObject({ status: "passed", errors: 0, findings: [] });
  });

  it("exits 3 on a fork, naming both migrations, in text and JSON", async () => {
    const p = project();
    const first = add(p.migrations, "create", ch("id UInt64"), 0);
    const a = add(p.migrations, "add-a", ch("id UInt64, a String DEFAULT ''"), 1, first);
    const b = add(p.migrations, "add-b", ch("id UInt64, b String DEFAULT ''"), 2, first);

    const text = await yodel(p.at());
    expect(text.code).toBe(3);
    expect(text.out).toContain(`error    fork: ${a.id} and ${b.id} both follow ${first.id}`);
    expect(text.out).toContain("3 migrations: 1 error, 0 warnings, 0 silenced.");

    const doc = json(await yodel(p.at("--json"))) as LintDoc;
    expect(doc.status).toBe("failed");
    expect(doc.findings.map((f) => f.rule)).toEqual(["fork"]);
  });

  it("exits 3 on a destructive change until it is silenced with a reason, and the checksum is recorded", async () => {
    const p = project();
    add(p.migrations, "create", ch("id UInt64, gone String"), 0);
    const drop = add(p.migrations, "drop-gone", ch("id UInt64"), 1);

    const before = await yodel(p.at());
    expect(before.code).toBe(3);
    expect(before.out).toContain(`${drop.id}\n  error    destructive: step 0: SQLCH202 Drop a column on yodel_14.events`);
    expect(before.out).toContain("-- yodel:allow <rule> <reason>");

    const sqlPath = join(p.migrations, drop.id, MIGRATION_SQL);
    const sql = readFileSync(sqlPath, "utf8");
    writeFileSync(sqlPath, sql.replace("ALTER TABLE `yodel_14`.`events` DROP COLUMN `gone`", "-- yodel:allow destructive gone was never read\nALTER TABLE `yodel_14`.`events` DROP COLUMN `gone`"));

    // The silence changed the file: the checksum rule says so, and how to record it.
    const edited = json(await yodel(p.at("--json"))) as LintDoc;
    expect(edited.findings.map((f) => [f.rule, f.level, f.silenced ?? null])).toEqual([
      ["checksum", "error", null],
      ["destructive", "error", "gone was never read"],
    ]);
    expect(edited.findings[0]?.message).toContain(`yodel lint --update-checksum ${drop.id}`);

    const signed = await yodel(p.at("--update-checksum", drop.id));
    expect(signed.code, signed.out).toBe(0);
    expect(signed.err).toMatch(new RegExp(`${drop.id}: checksum sha256:[0-9a-f]{64} is now sha256:[0-9a-f]{64}`));
    expect(signed.out).toContain("silenced destructive: step 0");
    expect(signed.out).toContain("reason: gone was never read");
    expect(signed.out).toContain("2 migrations: 0 errors, 0 warnings, 1 silenced.");

    const doc = json(await yodel(p.at("--json"))) as LintDoc;
    expect(doc.silences[drop.id]).toEqual([{ step: 0, rule: "destructive", reason: "gone was never read", line: expect.any(Number) as number }]);
  });

  it("takes rule levels from yodel.config.ts and refuses lowering an integrity rule", async () => {
    const p = project();
    add(p.migrations, "create", ch("id UInt64, n UInt32"), 0);
    add(p.migrations, "widen", ch("id UInt64, n UInt64"), 1);
    expect((await yodel(p.at())).code).toBe(3);

    const config = join(p.dir, "yodel.config.ts");
    writeFileSync(config, `export default { lint: { rules: { "ch-mutation": "warning" } } };\n`);
    const warned = await yodel(p.at());
    expect(warned.code, warned.out).toBe(0);
    expect(warned.out).toContain("warning  ch-mutation: step 0: SQLCH210");

    const rules = await yodel(p.at("--rules"));
    expect(rules.code).toBe(0);
    expect(rules.out).toMatch(/^ch-mutation\s+warning, silenceable, clickhouse$/m);
    expect(rules.out).toMatch(/^fork\s+error$/m);

    // A config module is imported once per process, so the bad one goes in another project.
    const q = project();
    writeFileSync(join(q.dir, "yodel.config.ts"), `export default { lint: { rules: { fork: "off" } } };\n`);
    const refused = await yodel(q.at());
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("lint.rules.fork: fork is an integrity rule and is always an error");
  });

  it("lints a Postgres project's migrations offline", async () => {
    const p = project("lint-postgres");
    const schema: BuiltObject = { export: "app", type: "Postgres::Schema", ddl: "CREATE SCHEMA yodel_14", dependsOn: [] };
    const orders = (cols: string): BuiltObject => ({ export: "orders", type: "Postgres::Table", ddl: `CREATE TABLE yodel_14.orders (id bigint PRIMARY KEY, ${cols})`, dependsOn: ["app"] });
    const pg = (...o: BuiltObject[]): BuildOutput => ({ dialect: "postgres", postgresMajor: 18, objects: [schema, ...o] });
    add(p.migrations, "create", pg(orders("n integer")), 0);
    add(p.migrations, "index", pg(orders("n bigint"), { export: "ix", type: "Postgres::Index", ddl: "CREATE INDEX ix ON yodel_14.orders (n)", dependsOn: ["orders"] }), 1);
    const doc = json(await yodel(p.at("--json"))) as LintDoc;
    expect(doc.findings.map((f) => f.rule)).toEqual(["pg-rewrite", "pg-lock"]);
  });

  it("exits 1 on bad arguments and an unknown migration, and prints help", async () => {
    const p = project();
    const bad = await yodel(p.at("prod"));
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("usage: yodel lint");
    const unknown = await yodel(p.at("--update-checksum", "20260101T0000-nope"));
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain("no such migration");
    const reset = await yodel(p.at("--reset"));
    expect(reset.code).toBe(1);
    expect(reset.err).toContain("--reset, --reset-shared and --keep go with --replay <env>");
    const unknownEnv = await yodel(p.at("--replay", "nowhere"));
    expect(unknownEnv.code).toBe(1);
    expect(unknownEnv.err).toContain('no environment "nowhere"');
    expect((await yodel(p.at("--rules"))).out).toMatch(/^replay\s+error$/m);
    const help = await yodel(["lint", "--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("-- yodel:allow <rule> <reason>");
    expect(help.out).toContain("3  at least one error");
  });
});
