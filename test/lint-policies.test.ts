/**
 * `yodel lint` runs the project's own checks (#227): the modules
 * `chant.config.ts` `lint.policies` names, over each migration's recorded
 * schema, read through `@intentius/chant-lexicon-sql/read`.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BuildOutput, BuiltObject } from "../src/chant/build.js";
import { createMigration, newestMigration, readMigrations, writeMigration, MIGRATION_SQL } from "../src/migrations/index.js";
import { json, projectFrom, yodel } from "./helpers/run.js";

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const d of disposers.splice(0)) d();
});

/** A fixture project whose chant.config.ts names `policies/rules.ts`, holding `policy`. */
function project(fixture: "lint-postgres" | "lint-clickhouse", policy: string): { dir: string; migrations: string; at: (...args: string[]) => string[] } {
  const { dir, dispose } = projectFrom(fixture);
  disposers.push(dispose);
  const config = join(dir, "chant.config.ts");
  writeFileSync(config, readFileSync(config, "utf8").replace('lexicons: ["sql"],', 'lexicons: ["sql"],\n  lint: { policies: ["policies/rules.ts"] },'));
  mkdirSync(join(dir, "policies"));
  writeFileSync(join(dir, "policies", "rules.ts"), policy);
  return { dir, migrations: join(dir, "migrations"), at: (...args) => ["lint", ...args, "--dir", dir] };
}

function add(dir: string, name: string, build: BuildOutput, minute: number): string {
  const m = createMigration({ name, build, previous: newestMigration(readMigrations(dir)), now: new Date(Date.UTC(2026, 9, 12, 9, minute)) });
  if (m.id === undefined) throw new Error(`no change for ${name}`);
  writeMigration(dir, m);
  return m.id;
}

interface LintDoc {
  status: string;
  errors: number;
  findings: Array<{ rule: string; level: string; migration?: string; step?: number; message: string; silenced?: string }>;
}

const PG_POLICY = `import type { PostSynthCheck } from "@intentius/chant/lint/post-synth";
import { canonicalPostgresType, readPostgres } from "@intentius/chant-lexicon-sql/read";

const TZ = canonicalPostgresType("timestamptz");

export const createdAt: PostSynthCheck = {
  id: "ORG-CREATED-AT",
  description: "every table has created_at timestamptz NOT NULL",
  check: (ctx) =>
    readPostgres(ctx).tables
      .filter((t) => { const c = t.column("created_at"); return !c || c.typeName !== TZ || c.nullable; })
      .map((t) => ({ checkId: "ORG-CREATED-AT", severity: "error", entity: t.export, message: t.qualifiedName + " needs created_at timestamptz NOT NULL" })),
};
`;

const CH_POLICY = `import type { PostSynthCheck } from "@intentius/chant/lint/post-synth";
import { readClickHouse } from "@intentius/chant-lexicon-sql/read";

export const sortKey: PostSynthCheck = {
  id: "ORG-SORT-KEY",
  description: "no Nullable column in a sort key",
  check: (ctx) =>
    readClickHouse(ctx).tables.flatMap((t) =>
      t.columns.filter((c) => c.inSortKey && c.nullable).map((c) => ({ checkId: "ORG-SORT-KEY", severity: "error", entity: t.export, message: t.qualifiedName + "." + c.name + " is Nullable and in the sort key" })),
    ),
};
`;

const pgSchema: BuiltObject = { export: "app", type: "Postgres::Schema", ddl: "CREATE SCHEMA yodel_14", dependsOn: [], ...{ name: "yodel_14" } };
/** A Postgres table as chant build serializes it: its columns besides the DDL. */
const pgEvents = (createdAt: string): BuiltObject => ({
  export: "events",
  type: "Postgres::Table",
  ddl: `CREATE TABLE yodel_14.events (id bigint PRIMARY KEY, created_at ${createdAt})`,
  dependsOn: ["app"],
  ...{
    name: "events",
    sqlName: "yodel_14.events",
    schema: "yodel_14",
    columns: [{ name: "id", type: "bigint" }, { name: "created_at", type: createdAt.replace(" NOT NULL", ""), ...(createdAt.endsWith("NOT NULL") ? { notNull: true } : {}) }],
    primaryKey: { columns: ["id"] },
    like: [],
    uniques: [],
    checks: [],
    foreignKeys: [],
    exclusions: [],
    inherits: [],
  },
});
const pg = (...objects: BuiltObject[]): BuildOutput => ({ dialect: "postgres", postgresMajor: 18, objects: [pgSchema, ...objects] });

const chDb: BuiltObject = { export: "db", type: "ClickHouse::Database", ddl: "CREATE DATABASE yodel_14 ENGINE = Atomic", dependsOn: [] };
/** A ClickHouse table as chant build serializes it, sorted by `kind`. */
const chEvents = (kind: string): BuiltObject => ({
  export: "events",
  type: "ClickHouse::Table",
  ddl: `CREATE TABLE yodel_14.events (id UInt64, kind ${kind}) ENGINE = MergeTree ORDER BY (kind, id)`,
  dependsOn: ["db"],
  ...{ name: "events", database: "yodel_14", engine: "MergeTree", orderBy: "(kind, id)", columns: [{ name: "id", type: "UInt64" }, { name: "kind", type: kind }] },
});
const ch = (...objects: BuiltObject[]): BuildOutput => ({ dialect: "clickhouse", objects: [chDb, ...objects] });

describe("yodel lint: the project's own checks (#227)", () => {
  it("fails a Postgres migration whose table breaks a policy, at the policy's level, and passes once the column is right", async () => {
    const p = project("lint-postgres", PG_POLICY);
    const bad = add(p.migrations, "events", pg(pgEvents("timestamp")), 0);
    const ran = await yodel(p.at("--json"));
    expect(ran.code, ran.err).toBe(3);
    const doc = json(ran) as LintDoc;
    expect(doc.findings.filter((f) => f.rule === "ORG-CREATED-AT")).toEqual([
      expect.objectContaining({ level: "error", migration: bad, object: "yodel_14.events", message: expect.stringMatching(/^step \d+: yodel_14\.events needs created_at timestamptz NOT NULL$/) as unknown }),
    ]);

    // The fix is the next migration; the finding stays where it first appeared, so silence it there.
    add(p.migrations, "created-at", pg(pgEvents("timestamp with time zone NOT NULL")), 1);
    const sql = join(p.migrations, bad, MIGRATION_SQL);
    writeFileSync(sql, readFileSync(sql, "utf8").replace(/^(-- .*yodel_14\.events)/m, "-- yodel:allow ORG-CREATED-AT fixed by the next migration\n$1"));
    const fixed = json(await yodel(p.at("--json", "--update-checksum", bad))) as LintDoc;
    expect(fixed.findings.find((f) => f.rule === "ORG-CREATED-AT")).toMatchObject({ silenced: "fixed by the next migration" });
  });

  it("fails a ClickHouse migration with a Nullable sort key column, and lists the policy with --rules", async () => {
    const p = project("lint-clickhouse", CH_POLICY);
    add(p.migrations, "events", ch(chEvents("Nullable(String)")), 0);
    const ran = await yodel(p.at());
    expect(ran.code, ran.err).toBe(3);
    expect(ran.out).toMatch(/error {4}ORG-SORT-KEY: step \d+: yodel_14\.events\.kind is Nullable and in the sort key/);

    const rules = await yodel(p.at("--rules"));
    expect(rules.code, rules.err).toBe(0);
    expect(rules.out).toMatch(/ORG-SORT-KEY\s+the check's level, silenceable\n\s+project policy: no Nullable column in a sort key/);
  });

  it("takes the policy's level from yodel.config.ts lint.rules", async () => {
    const p = project("lint-clickhouse", CH_POLICY);
    writeFileSync(join(p.dir, "yodel.config.ts"), `export default { lint: { rules: { "ORG-SORT-KEY": "warning" } } };\n`);
    add(p.migrations, "events", ch(chEvents("Nullable(String)")), 0);
    const doc = json(await yodel(p.at("--json"))) as LintDoc;
    expect(doc.findings.find((f) => f.rule === "ORG-SORT-KEY")?.level).toBe("warning");
    expect(doc.errors).toBe(0);
  });
});
