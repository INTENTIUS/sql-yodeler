/**
 * `yodel new` on one dialect's fixture project, offline. Each dialect has a
 * file of its own (test/new-clickhouse.test.ts, test/new-postgres.test.ts),
 * so the two run in parallel instead of one file holding both.
 */

import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readMigrations, verifyChecksum } from "../../src/migrations/index.js";
import { json, projectFrom, yodel } from "./run.js";

// `yodel new` reads no database. Every server the fixtures' profiles could
// name is pointed at a port nothing listens on, so a test that reached for
// one would fail; none of them does.
const EMULATOR_ENV = ["YODEL_E2E_CLICKHOUSE_URL", "YODEL_E2E_POSTGRES_URL", "YODEL_E2E_POSTGRES_USER", "YODEL_E2E_POSTGRES_PASSWORD"];

/** Points every emulator variable at a closed port for the file, and puts them back after. */
export function offline(): void {
  const saved = Object.fromEntries(EMULATOR_ENV.map((k) => [k, process.env[k]]));
  beforeAll(() => {
    for (const k of EMULATOR_ENV) Reflect.deleteProperty(process.env, k);
    process.env.YODEL_E2E_CLICKHOUSE_URL = "http://127.0.0.1:9";
    process.env.YODEL_E2E_POSTGRES_URL = "postgres://127.0.0.1:9/postgres";
  });
  afterAll(() => {
    for (const k of EMULATOR_ENV) {
      const v = saved[k];
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    }
  });
}

interface Case {
  /** A change made in place by a statement. */
  addColumn: [string, string];
  /** A change only an Op makes. */
  needsOp: [string, string];
  op: "ClickHouseRebuildOp" | "PostgresMigrationOp";
}

const cases: Record<"clickhouse" | "postgres", Case> = {
  clickhouse: {
    addColumn: ["    ts   DateTime\n", "    ts   DateTime,\n    note String DEFAULT ''\n"],
    needsOp: ["ORDER BY (kind, ts)", "ORDER BY (ts, kind)"],
    op: "ClickHouseRebuildOp",
  },
  postgres: {
    addColumn: ["amount numeric(12, 2) NOT NULL\n", "amount numeric(12, 2) NOT NULL,\n    note   text\n"],
    needsOp: ["amount numeric(12, 2) NOT NULL,", "total  numeric(12, 2) NOT NULL, -- previously: amount"],
    op: "PostgresMigrationOp",
  },
};

export function newSuite(dialect: "clickhouse" | "postgres"): void {
  const c = cases[dialect];
  describe(`yodel new (${dialect})`, () => {
    const project = projectFrom(dialect);
    const dir = project.dir;
    const migrations = join(dir, "migrations");
    const edit = ([from, to]: [string, string]) => {
      const file = join(dir, "src", "schema.ts");
      const text = readFileSync(file, "utf8");
      if (!text.includes(from)) throw new Error(`schema.ts has no ${JSON.stringify(from)}`);
      writeFileSync(file, text.replace(from, to));
    };
    afterAll(() => {
      project.dispose();
    });

    it("writes the first migration from an empty schema, offline", async () => {
      const ran = await yodel(["new", "init", "--dir", dir]);
      expect(ran.err).toBe("");
      expect(ran.code).toBe(0);
      expect(ran.out).toMatch(/^Wrote migrations\/\d{8}T\d{4}-init\/ \(\d+ statements; the first migration\)\n$/);
      const [first] = readMigrations(migrations);
      expect(first?.parent).toBeNull();
      expect(readdirSync(first?.dir ?? "").sort()).toEqual(["migration.json", "migration.sql"]);
      expect(first?.document.schema.dialect).toBe(dialect);
      expect(first?.document.steps.every((s) => s.kind === "statement")).toBe(true);
      expect(first?.files.sql).toMatch(/: SQL(CH|PG)200 create\nCREATE /);
      expect(verifyChecksum(first ?? { sql: "", json: "{}" }).ok).toBe(true);
    });

    it("writes nothing when there is no change, and says so", async () => {
      const ran = await yodel(["new", "again", "--dir", dir]);
      expect(ran.code).toBe(0);
      expect(ran.out).toMatch(/^No changes: the declared schema matches the newest migration's recorded schema \(\d{8}T\d{4}-init\)\. Nothing written\.\n$/);
      expect(readdirSync(migrations)).toHaveLength(1);
      const asJson = await yodel(["new", "again", "--dir", dir, "--json"]);
      expect(json(asJson)).toMatchObject({ written: false, dialect });
    });

    it("writes the next migration with its parent, diffing from the recorded schema", async () => {
      edit(c.addColumn);
      const ran = await yodel(["new", "add-note", "--dir", dir, "--json"]);
      expect(ran.code).toBe(0);
      const [first, second] = readMigrations(migrations);
      expect(json(ran)).toMatchObject({ written: true, id: second?.id, parent: first?.id, checksum: second?.checksum, statements: 1, ops: [], manual: [] });
      expect(second?.parent).toBe(first?.id);
      expect(second?.document.steps).toEqual([expect.objectContaining({ kind: "statement", class: "metadata" })]);
      expect(second?.files.sql).toContain("ADD COLUMN");
    });

    it(`writes a change only an Op makes as a ${c.op} step and says so`, async () => {
      edit(c.needsOp);
      const ran = await yodel(["new", "needs-op", "--dir", dir]);
      expect(ran.code).toBe(0);
      expect(ran.out).toContain(`This migration contains an Op step: ${c.op} for `);
      const chain = readMigrations(migrations);
      const last = chain[chain.length - 1];
      expect(last?.parent).toBe(chain[1]?.id);
      expect(last?.document.refused).toBe(true);
      expect(last?.document.steps.flatMap((s) => (s.kind === "op" ? [s.op] : []))).toEqual([c.op]);
      expect(last?.files.sql).toContain(`made by ${c.op}, not a statement:`);
      expect(last?.files.sql).toContain("-- This migration contains an Op step, not only SQL:");
    });

    it("refuses to follow a directory with a fork, naming both migrations", async () => {
      const chain = readMigrations(migrations);
      const last = chain[chain.length - 1];
      if (!last) throw new Error("no migration");
      // A second child of the same parent, as two merged branches would make.
      const twin = "20991231T2359-other-branch";
      cpSync(last.dir, join(migrations, twin), { recursive: true });
      const doc = JSON.parse(readFileSync(join(migrations, twin, "migration.json"), "utf8")) as { id: string };
      doc.id = twin;
      writeFileSync(join(migrations, twin, "migration.json"), `${JSON.stringify(doc, null, 2)}\n`);
      const ran = await yodel(["new", "after-fork", "--dir", dir]);
      expect(ran.code).toBe(1);
      expect(ran.err).toContain(`fork: ${last.id} and ${twin} both follow ${String(last.parent)}`);
      expect(existsSync(join(migrations, twin))).toBe(true);
      expect(readdirSync(migrations).some((d) => d.endsWith("-after-fork"))).toBe(false);
    });
  });
}
