/**
 * `yodel rebase` and `-- yodel:allow` lines (#40), on each dialect: a
 * rebase carries each silence over to the same statement in the rewritten
 * migration.sql, so lint still passes and apply records the same
 * `{step, rule, reason}`; and refuses, naming the line, when the statement a
 * silence was for is gone.
 *
 * The offline tests always run. The emulator suites apply the silenced
 * migration before the rebase and the rebased chain after it, and compare
 * the history's `silences` column. They run when the e2e variables are set
 * (see test/e2e/emulator.ts), in ClickHouse database and Postgres schema
 * <prefix>_rebase_silences (test/e2e/names.ts), which each suite drops and
 * makes again:
 *
 *   YODEL_E2E_PREFIX=yodel_40 YODEL_E2E_CLICKHOUSE_URL=http://<host>:8123 \
 *   YODEL_E2E_POSTGRES_URL=postgres://<host>:5432/postgres \
 *   YODEL_E2E_POSTGRES_USER=postgres YODEL_E2E_POSTGRES_PASSWORD=chant \
 *   npx vitest run test/rebase-silences.test.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { BuildOutput, BuiltObject } from "../src/chant/build.js";
import { runChant } from "../src/chant/process.js";
import { createMigration, MIGRATION_JSON, MIGRATION_SQL, readMigrations, scanMigrations, writeMigration, type Migration } from "../src/migrations/index.js";
import { migrationSilences } from "../src/lint/index.js";
import { asWritten } from "../src/rebase/index.js";
import { json, yodel } from "./helpers/run.js";
import { clickhouse, clickhouseReachable, postgres, postgresReachable } from "./e2e/emulator.js";
import { e2eProject, suiteName } from "./e2e/names.js";

const S = suiteName("rebase_silences");

interface Dialect {
  name: "clickhouse" | "postgres";
  fixture: string;
  table: (name: string, columns: string) => BuiltObject;
  /** orders as created, and with gone dropped and n widened. */
  created: string;
  changed: string;
  /** A text in each risky statement, and the rule its silence names. */
  drop: string;
  widen: string;
  widenRule: string;
  /** A table's columns with only its key. */
  idOnly: string;
  /** Makes the database or schema empty again; drops it; reads a migration's history rows' silences. */
  reset: () => Promise<unknown>;
  drop40: () => Promise<unknown>;
  historySilences: (id: string) => Promise<string[]>;
  reachable: boolean;
}

const dialects: Dialect[] = [
  {
    name: "clickhouse",
    fixture: "rebase-clickhouse",
    table: (name, columns) => ({ export: name, type: "ClickHouse::Table", ddl: `CREATE TABLE ${S}.${name} (${columns}) ENGINE = MergeTree ORDER BY id`, dependsOn: [] }),
    created: "id UInt64, n UInt32, gone String",
    changed: "id UInt64, n UInt64",
    drop: "DROP COLUMN `gone`",
    widen: "MODIFY COLUMN `n` UInt64",
    widenRule: "ch-mutation",
    idOnly: "id UInt64",
    reset: async () => {
      await clickhouse(`DROP DATABASE IF EXISTS ${S} SYNC`);
      await clickhouse(`CREATE DATABASE ${S} ENGINE = Atomic`);
    },
    drop40: () => clickhouse(`DROP DATABASE IF EXISTS ${S} SYNC`),
    historySilences: async (id) =>
      (await clickhouse(`SELECT silences FROM ${S}.history WHERE migration_id = '${id}' ORDER BY seq FORMAT JSONEachRow`))
        .trim()
        .split("\n")
        .map((l) => (JSON.parse(l) as { silences: string }).silences),
    reachable: clickhouseReachable,
  },
  {
    name: "postgres",
    fixture: "rebase-postgres",
    table: (name, columns) => ({ export: name, type: "Postgres::Table", ddl: `CREATE TABLE ${S}.${name} (${columns})`, dependsOn: [] }),
    created: "id bigint PRIMARY KEY, n integer, gone text",
    changed: "id bigint PRIMARY KEY, n bigint",
    drop: "DROP COLUMN gone",
    widen: "ALTER COLUMN n TYPE bigint",
    widenRule: "pg-rewrite",
    idOnly: "id bigint PRIMARY KEY",
    reset: () => postgres(`DROP SCHEMA IF EXISTS ${S} CASCADE; CREATE SCHEMA ${S}`),
    drop40: () => postgres(`DROP SCHEMA IF EXISTS ${S} CASCADE`),
    historySilences: async (id) => (await postgres<{ silences: string }>(`SELECT silences FROM ${S}.history WHERE migration_id = '${id}' ORDER BY seq`)).map((r) => r.silences),
    reachable: postgresReachable,
  },
];

interface LintDoc {
  status: string;
  errors: number;
  silenced: number;
  findings: Array<{ rule: string; level: string; migration?: string; silenced?: string; message: string }>;
}

/** A project for one dialect, with helpers for the fork the tests rebase. */
function project(d: Dialect) {
  const { dir, dispose } = e2eProject(d.fixture, S);
  const migrations = join(dir, "migrations");
  const at = (...args: string[]) => [...args, "--dir", dir];
  const build = (...objects: BuiltObject[]): BuildOutput => ({ dialect: d.name, objects });
  const read = (id: string): Migration => {
    const m = scanMigrations(migrations).migrations.find((x) => x.id === id);
    if (!m) throw new Error(`no ${id}`);
    return m;
  };
  const add = (name: string, minute: number, schema: BuildOutput, previous?: Migration): Migration => {
    const made = createMigration({ name, build: schema, previous, now: new Date(Date.UTC(2026, 9, 9, 14, minute)) });
    if (made.id === undefined) throw new Error(`no change for ${name}`);
    writeMigration(migrations, made);
    return read(made.id);
  };
  const sqlPath = (id: string) => join(migrations, id, MIGRATION_SQL);
  /** Puts `line` above the first line of `id`'s migration.sql that holds `text`. */
  const above = (id: string, text: string, line: string) => {
    const lines = readFileSync(sqlPath(id), "utf8").split("\n");
    const i = lines.findIndex((l) => l.includes(text));
    if (i < 0) throw new Error(`${id}'s migration.sql has no ${text}`);
    lines.splice(i, 0, line);
    writeFileSync(sqlPath(id), lines.join("\n"));
  };
  const updateChecksum = async (id: string) => {
    const ran = await yodel(at("lint", "--update-checksum", id, "--json"));
    expect(ran.err).toBe("");
  };
  const lint = async () => json(await yodel(at("lint", "--json"))) as LintDoc;
  return { dir, dispose, migrations, at, build, read, add, sqlPath, above, updateChecksum, lint };
}
type Project = ReturnType<typeof project>;

/** orders, then a migration that drops gone and widens n with both silenced. Returns the base and the risky one. */
async function silencedChain(d: Dialect, p: Project): Promise<{ base: Migration; risky: Migration }> {
  const base = p.add("create", 0, p.build(d.table("orders", d.created)));
  const unsigned = p.add("drop-and-widen", 20, p.build(d.table("orders", d.changed)), base);
  p.above(unsigned.id, d.drop, "-- yodel:allow destructive gone was never read; checked on dev");
  p.above(unsigned.id, d.widen, `-- yodel:allow ${d.widenRule} orders is small; the rewrite takes seconds`);
  await p.updateChecksum(unsigned.id);
  const risky = p.read(unsigned.id);
  expect(asWritten(risky)).toBe(true);
  const lint = await p.lint();
  expect(lint.status).toBe("passed");
  expect(lint.silenced).toBe(2);
  return { base, risky };
}

const projects: Array<() => void> = [];
afterEach(() => {
  for (const dispose of projects.splice(0)) dispose();
});

describe.each(dialects)("yodel rebase keeps yodel:allow lines on $name", (d) => {
  const fresh = () => {
    const p = project(d);
    projects.push(p.dispose);
    return p;
  };

  it("carries each silence over to the same statement, so lint passes and the history's silences are the same", async () => {
    const p = fresh();
    const { base, risky } = await silencedChain(d, p);
    const before = migrationSilences(risky);
    expect(JSON.parse(before)).toHaveLength(2);
    const other = p.add("add-b", 10, p.build(d.table("orders", d.created), d.table("b", d.idOnly)), base);

    const ran = await yodel(p.at("rebase", risky.id, "--onto", other.id));
    expect(ran.code, ran.err).toBe(0);
    expect(ran.out).toContain(`${risky.id}: follows ${other.id}; 2 statements; 2 yodel:allow lines carried over;`);

    const chain = readMigrations(p.migrations, { verify: true });
    expect(chain.map((m) => m.id)).toEqual([base.id, other.id, risky.id]);
    const moved = chain[2] as Migration;
    expect(moved.checksum).not.toBe(risky.checksum);
    expect(migrationSilences(moved)).toBe(before);
    expect(asWritten(moved)).toBe(true);
    // Each line is directly above its statement, as the author put it.
    const lines = moved.files.sql.split("\n");
    const dropAt = lines.findIndex((l) => l.includes(d.drop));
    expect(lines[dropAt - 1]).toBe("-- yodel:allow destructive gone was never read; checked on dev");
    const widenAt = lines.findIndex((l) => l.includes(d.widen));
    expect(lines[widenAt - 1]).toBe(`-- yodel:allow ${d.widenRule} orders is small; the rewrite takes seconds`);

    const lint = await p.lint();
    expect(lint.findings.filter((f) => f.level === "error" && !f.silenced)).toEqual([]);
    expect(lint.status).toBe("passed");
    expect(lint.silenced).toBe(2);
  });

  it("refuses, naming the line, when the statement a silence was for is gone after the rebase", async () => {
    const p = fresh();
    const keep = d.table("orders", d.created);
    const old = d.table("old", d.idOnly);
    const c = d.table("c", d.idOnly);
    const base = p.add("create", 0, p.build(keep, old));
    // The other branch drops old too, so the rebased migration only creates c.
    const theirs = p.add("drop-old", 10, p.build(keep), base);
    const ours = p.add("swap-old-for-c", 20, p.build(keep, c), base);
    p.above(ours.id, "DROP TABLE", "-- yodel:allow destructive old is empty");
    await p.updateChecksum(ours.id);
    const sql = readFileSync(p.sqlPath(ours.id), "utf8");
    const jsonText = readFileSync(join(p.migrations, ours.id, MIGRATION_JSON), "utf8");
    const line = sql.split("\n").indexOf("-- yodel:allow destructive old is empty") + 1;

    const ran = await yodel(p.at("rebase", ours.id, "--onto", theirs.id));
    expect(ran.code).toBe(4);
    expect(ran.err).toContain(`refused: ${ours.id} has a yodel:allow line for a statement the rebase does not keep as it was`);
    expect(ran.err).toContain(`migration.sql line ${String(line)}: -- yodel:allow destructive old is empty`);
    expect(ran.err).toContain("which the rebased migration no longer has");
    expect(ran.err).toContain("Nothing was written.");
    expect(readFileSync(p.sqlPath(ours.id), "utf8")).toBe(sql);
    expect(readFileSync(join(p.migrations, ours.id, MIGRATION_JSON), "utf8")).toBe(jsonText);
  });

  it("with --force drops a hand edit but still carries the silences over", async () => {
    const p = fresh();
    const { base, risky } = await silencedChain(d, p);
    p.above(risky.id, d.drop, "-- a note by hand");
    await p.updateChecksum(risky.id);
    const before = migrationSilences(p.read(risky.id));
    expect(asWritten(p.read(risky.id))).toBe(false);
    const other = p.add("add-b", 10, p.build(d.table("orders", d.created), d.table("b", d.idOnly)), base);

    const refused = await yodel(p.at("rebase", risky.id, "--onto", other.id));
    expect(refused.code).toBe(4);
    expect(refused.err).toContain("differ from what yodel wrote");

    const forced = await yodel(p.at("rebase", risky.id, "--onto", other.id, "--force", "--json"));
    expect(forced.code, forced.err).toBe(0);
    const doc = json(forced) as { rewritten: Array<{ handEdited: boolean; silences: Array<{ step: number; rule: string; reason: string }> }> };
    expect(doc.rewritten[0]?.handEdited).toBe(true);
    expect(doc.rewritten[0]?.silences.map((s) => s.rule).sort()).toEqual(["destructive", d.widenRule].sort());
    const moved = p.read(risky.id);
    expect(moved.files.sql).not.toContain("-- a note by hand");
    expect(migrationSilences(moved)).toBe(before);
    expect((await p.lint()).status).toBe("passed");
  });
});

for (const d of dialects) {
  describe.skipIf(!d.reachable)(`yodel rebase keeps yodel:allow lines on ${d.name}, against the emulator`, () => {
    let p: Project;
    const saved = process.env.YODEL_HISTORY_DATABASE;

    beforeAll(async () => {
      process.env.YODEL_HISTORY_DATABASE = S;
      await d.reset();
      p = project(d);
    });
    afterAll(async () => {
      p.dispose();
      if (saved === undefined) delete process.env.YODEL_HISTORY_DATABASE;
      else process.env.YODEL_HISTORY_DATABASE = saved;
      await d.drop40();
    });

    const approvedApply = async () => {
      const gated = await yodel(p.at("apply", "e2e", "--json"));
      expect(gated.code, gated.err).toBe(3);
      const approve = (json(gated) as { approve?: string }).approve ?? "";
      expect(approve).toMatch(/^chant approve migrate-e2e approve-migrate-e2e --plan /);
      const approved = await runChant(approve.split(" ").slice(1), { cwd: p.dir });
      expect(approved.code, approved.stderr).toBe(0);
      const applied = await yodel(p.at("apply", "e2e", "--json"));
      expect(applied.code, applied.err).toBe(0);
    };

    it("applies the rebased migration with the same {step, rule, reason} the history recorded before the rebase", async () => {
      const { base, risky } = await silencedChain(d, p);

      // Before: the silenced migration applied where it was written, on its old parent.
      await approvedApply();
      const before = await d.historySilences(risky.id);
      expect(before.length).toBeGreaterThan(2);
      expect(new Set(before)).toEqual(new Set([migrationSilences(risky)]));
      const recorded = JSON.parse(before[0] ?? "[]") as Array<{ step: number; rule: string; reason: string }>;
      expect(recorded).toHaveLength(2);
      expect(recorded).toEqual(
        expect.arrayContaining([
          { step: expect.any(Number) as number, rule: "destructive", reason: "gone was never read; checked on dev" },
          { step: expect.any(Number) as number, rule: d.widenRule, reason: "orders is small; the rewrite takes seconds" },
        ]),
      );

      // Another branch's migration lands first; rebase onto it, on an empty server.
      await d.reset();
      const other = p.add("add-b", 10, p.build(d.table("orders", d.created), d.table("b", d.idOnly)), base);
      const ran = await yodel(p.at("rebase", risky.id, "--onto", other.id));
      expect(ran.code, ran.err).toBe(0);
      const lint = json(await yodel(p.at("lint", "--env", "e2e", "--json"))) as LintDoc;
      expect(lint.status).toBe("passed");
      expect(lint.silenced).toBe(2);

      // After: the whole rebased chain applied; the rebased migration records what it did before.
      await approvedApply();
      const after = await d.historySilences(risky.id);
      expect(after).toEqual(before);
      expect(await d.historySilences(other.id)).toEqual(expect.arrayContaining(["[]"]));
    }, 600_000);
  });
}
