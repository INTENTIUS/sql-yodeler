/**
 * A REVOKE that chant files under SQLPG296 (a revoke and a grant for the
 * same grantee and object) or SQLPG298 (default privileges) takes access
 * away as a SQLPG297 revoke does (#398): `yodel lint` raises `pg-access` on
 * it, the access steps name it, and the declarative plan marks a swapped
 * hand-made grant `byHand`.
 *
 * The migrations are written by createMigration, as `yodel new` writes them,
 * and linted with `yodel lint --json`.
 */

import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BuildOutput, BuiltObject } from "../src/chant/build.js";
import { accessItems, accessSteps, removed, renderAccessReview, takesAccessAway } from "../src/chant/access.js";
import { changeFindings } from "../src/declarative/review.js";
import { stepFindings } from "../src/lint/statements.js";
import { createMigration, newestMigration, readMigrations, writeMigration } from "../src/migrations/index.js";
import type { MigrationStep } from "@intentius/chant-lexicon-sql/migration-statements";
import { json, projectFrom, yodel } from "./helpers/run.js";

const S = "yodel_398_lint";
const W = "yodel_398_writer";
const app: BuiltObject = { export: "app", type: "Postgres::Schema", ddl: `CREATE SCHEMA ${S}`, dependsOn: [] };
const orders: BuiltObject = { export: "orders", type: "Postgres::Table", ddl: `CREATE TABLE ${S}.orders (id bigint PRIMARY KEY)`, dependsOn: ["app"] };
const grant = (exp: string, ddl: string): BuiltObject => ({ export: exp, type: "Postgres::Grant", ddl, dependsOn: ["orders"] });
const defaults = (exp: string, ddl: string): BuiltObject => ({ export: exp, type: "Postgres::DefaultPrivileges", ddl, dependsOn: ["app"] });
const pg = (...objects: BuiltObject[]): BuildOutput => ({ dialect: "postgres", postgresMajor: 18, objects: [app, orders, ...objects] });

interface LintDoc {
  findings: Array<{ rule: string; migration?: string; step?: number; message: string }>;
}

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const d of disposers.splice(0)) d();
});

/** A project whose migrations are `builds` in order; the last migration's steps and `yodel lint --json`'s findings on it. */
async function lint(...builds: BuildOutput[]): Promise<{ steps: Extract<MigrationStep, { kind: "statement" }>[]; all: MigrationStep[]; findings: LintDoc["findings"] }> {
  const { dir, dispose } = projectFrom("lint-postgres", (t) => t.replaceAll("yodel_e2e_fixture", S));
  disposers.push(dispose);
  const migrations = join(dir, "migrations");
  builds.forEach((build, i) => {
    const m = createMigration({ name: `m${String(i)}`, build, previous: newestMigration(readMigrations(migrations)), now: new Date(Date.UTC(2026, 10, 21, 12, i)) });
    if (m.id === undefined) throw new Error(`no change at ${String(i)}`);
    writeMigration(migrations, m);
  });
  const last = readMigrations(migrations).at(-1);
  const ran = await yodel(["lint", "--json", "--dir", dir]);
  const all = last?.document.steps ?? [];
  return {
    all,
    steps: all.filter((s): s is Extract<MigrationStep, { kind: "statement" }> => s.kind === "statement"),
    findings: (json(ran) as LintDoc).findings.filter((f) => f.migration === last?.id),
  };
}

const access = (f: LintDoc["findings"]) => f.filter((x) => x.rule === "pg-access").map((x) => x.step);

describe("yodel lint: a REVOKE filed under SQLPG296 or SQLPG298", () => {
  it("a declaration deleted is one SQLPG297 revoke, and pg-access is raised on it", async () => {
    const r = await lint(pg(grant("w", `GRANT INSERT ON TABLE ${S}.orders TO ${W}`)), pg());
    expect(r.steps.map((s) => [s.rule, s.sql])).toEqual([["SQLPG297", `REVOKE INSERT ON TABLE ${S}.orders FROM ${W}`]]);
    expect(access(r.findings)).toEqual([0]);
  });

  it("a step that only grants raises nothing", async () => {
    const r = await lint(pg(), pg(grant("w", `GRANT UPDATE ON TABLE ${S}.orders TO ${W}`)));
    expect(r.steps.map((s) => s.rule)).toEqual(["SQLPG296"]);
    expect(access(r.findings)).toEqual([]);
  });

  it("raises pg-access on the REVOKE of a swap (INSERT to UPDATE, both steps SQLPG296) and not on its GRANT", async () => {
    const r = await lint(pg(grant("w", `GRANT INSERT ON TABLE ${S}.orders TO ${W}`)), pg(grant("w", `GRANT UPDATE ON TABLE ${S}.orders TO ${W}`)));
    expect(r.steps.map((s) => [s.rule, s.object, s.sql])).toEqual([
      ["SQLPG296", "w", `REVOKE INSERT ON TABLE ${S}.orders FROM ${W}`],
      ["SQLPG296", "w", `GRANT UPDATE ON TABLE ${S}.orders TO ${W}`],
    ]);
    expect(access(r.findings)).toEqual([0]);
    expect(accessSteps(r.all).map((a) => a.away)).toEqual(["revokes a privilege", undefined]);
  });

  it("raises pg-access on REVOKE GRANT OPTION FOR beside a grant (SQLPG296)", async () => {
    const r = await lint(
      pg(grant("w", `GRANT INSERT ON TABLE ${S}.orders TO ${W} WITH GRANT OPTION`)),
      pg(grant("w", `GRANT INSERT ON TABLE ${S}.orders TO ${W}`), grant("u", `GRANT UPDATE ON TABLE ${S}.orders TO ${W}`)),
    );
    expect(r.steps[0]?.sql).toBe(`REVOKE GRANT OPTION FOR INSERT ON TABLE ${S}.orders FROM ${W}`);
    expect(r.steps[0]?.rule).toBe("SQLPG296");
    expect(access(r.findings)).toEqual([0]);
  });

  it("raises pg-access on ALTER DEFAULT PRIVILEGES ... REVOKE (SQLPG298) and not on its GRANT", async () => {
    const r = await lint(
      pg(defaults("d", `ALTER DEFAULT PRIVILEGES IN SCHEMA ${S} GRANT SELECT ON TABLES TO ${W}`)),
      pg(defaults("d", `ALTER DEFAULT PRIVILEGES IN SCHEMA ${S} GRANT INSERT ON TABLES TO ${W}`)),
    );
    const revoke = r.steps.findIndex((s) => s.sql.startsWith("ALTER DEFAULT PRIVILEGES") && s.sql.includes(" REVOKE "));
    const grantAt = r.steps.findIndex((s) => s.sql.startsWith("ALTER DEFAULT PRIVILEGES") && s.sql.includes(" GRANT "));
    expect(r.steps[revoke]?.rule).toBe("SQLPG298");
    expect(access(r.findings)).toContain(revoke);
    expect(access(r.findings)).not.toContain(grantAt);
  });

  it("marks the acl revoke a default-privilege swap writes on an existing table (SQLPG296) undeclared and taking access away", async () => {
    const r = await lint(
      pg(defaults("d", `ALTER DEFAULT PRIVILEGES IN SCHEMA ${S} GRANT SELECT ON TABLES TO ${W}`)),
      pg(defaults("d", `ALTER DEFAULT PRIVILEGES IN SCHEMA ${S} GRANT INSERT ON TABLES TO ${W}`)),
    );
    const index = r.all.findIndex((s) => s.kind === "statement" && s.object.startsWith("acl ") && s.sql.startsWith("REVOKE"));
    const step = r.all[index];
    expect(step?.kind === "statement" ? [step.rule, step.object, step.sql] : undefined).toEqual(["SQLPG296", `acl relation ${S}.orders TO ${W}`, `REVOKE SELECT ON TABLE ${S}.orders FROM ${W}`]);
    expect(accessSteps(r.all).find((a) => a.index === index)).toMatchObject({ away: "revokes a privilege", undeclared: true });
    expect(access(r.findings)).toContain(index);
  });

  it("a revoke whose declaration was deleted, beside a new grant, is filed under the new grant's declaration and is not marked undeclared", async () => {
    const r = await lint(pg(grant("w1", `GRANT INSERT ON TABLE ${S}.orders TO ${W}`)), pg(grant("w2", `GRANT UPDATE ON TABLE ${S}.orders TO ${W}`)));
    expect(r.steps.map((s) => [s.rule, s.object, s.sql.split(" ")[0]])).toEqual([
      ["SQLPG296", "w2", "REVOKE"],
      ["SQLPG296", "w2", "GRANT"],
    ]);
    // Neither the rule nor the object says no declaration is behind it; it still takes access away.
    expect(accessSteps(r.all).map((a) => [a.away, a.undeclared])).toEqual([
      ["revokes a privilege", undefined],
      [undefined, undefined],
    ]);
    expect(access(r.findings)).toEqual([0]);
  });
});

describe("takesAccessAway and the steps it reads", () => {
  const statement = (rule: string, sql: string, name = `${S}.orders`): MigrationStep => ({ kind: "statement", rule, class: "metadata", sql, name, type: "Postgres::Grant", object: "w" }) as never;

  it("reads SQLPG296 and SQLPG298 steps by their SQL", () => {
    expect(takesAccessAway({ rule: "SQLPG296", sql: `REVOKE INSERT ON TABLE ${S}.orders FROM ${W}` })).toBe("revokes a privilege");
    expect(takesAccessAway({ rule: "SQLPG296", sql: `  revoke grant option for INSERT ON TABLE ${S}.orders FROM ${W}` })).toBe("revokes a privilege");
    expect(takesAccessAway({ rule: "SQLPG298", sql: `ALTER DEFAULT PRIVILEGES FOR ROLE "owner" IN SCHEMA "${S}" REVOKE SELECT ON TABLES FROM ${W}` })).toBe("revokes a privilege");
    expect(takesAccessAway({ rule: "SQLPG296", sql: `GRANT UPDATE ON TABLE ${S}.orders TO ${W} WITH GRANT OPTION` })).toBeUndefined();
    expect(takesAccessAway({ rule: "SQLPG298", sql: `ALTER DEFAULT PRIVILEGES IN SCHEMA ${S} GRANT SELECT ON TABLES TO revoker` })).toBeUndefined();
  });

  it("reads a declarative SQLPG296 change by its before and after", () => {
    expect(takesAccessAway({ rule: "SQLPG296", before: "insert", after: "update" })).toBe("revokes a privilege");
    expect(takesAccessAway({ rule: "SQLPG296", before: "insert*", after: "insert, update" })).toBe("revokes a privilege");
    expect(takesAccessAway({ rule: "SQLPG296", before: "insert", after: "insert*, update" })).toBeUndefined();
    expect(takesAccessAway({ rule: "SQLPG296", after: "select" })).toBeUndefined();
    expect(removed({ before: "insert*, select", after: "insert, update" })).toEqual(["grant option for insert", "select"]);
  });

  it("leaves out a REVOKE beside a grant on a table the same migration creates", () => {
    const step = statement("SQLPG296", `REVOKE INSERT ON TABLE ${S}.orders FROM ${W}`);
    expect(stepFindings("postgres", step, { created: new Set([`${S}.orders`]) }).map((f) => f.rule)).toEqual([]);
    expect(stepFindings("postgres", step, { created: new Set([`${S}.other`]) }).map((f) => f.rule)).toEqual(["pg-access"]);
  });

  it("declarative lint raises pg-access on a SQLPG296 change that takes a privilege away, and not on one that only grants", () => {
    const change = (before: string, after: string) => ({ object: `relation ${S}.orders TO ${W}`, rule: "SQLPG296", class: "metadata", field: "privileges", before, after }) as never;
    expect(changeFindings("postgres", [change("insert", "update"), change("", "update")]).map((f) => f.rule)).toEqual(["pg-access"]);
  });
});

describe("the declarative plan's access section: a hand-made grant swapped by a declaration", () => {
  const writeOrders: BuiltObject = grant("writeOrders", `GRANT UPDATE ON TABLE ${S}.orders TO ${W}`);
  const change = (rule: string, before: string, after: string) => ({ object: `relation ${S}.orders TO ${W}`, rule, class: "metadata", field: "privileges", before, after }) as never;

  it("marks a SQLPG296 change that takes a privilege away byHand and lists it under Revoked by this apply", async () => {
    const items = await accessItems([change("SQLPG296", "insert", "update")], pg(writeOrders));
    expect(items.map((i) => [i.rule, i.byHand === true])).toEqual([["SQLPG296", true]]);
    const text = renderAccessReview({ managed: true, source: "yodel.config.ts", changes: items }, "dev").join("\n");
    expect(text).toContain(`Revoked by this apply`);
    expect(text).toContain(`  relation ${S}.orders FROM ${W}: insert\n`);
  });

  it("does not mark a SQLPG296 change that only grants", async () => {
    const items = await accessItems([change("SQLPG296", "insert", "insert, update")], pg(writeOrders));
    expect(items.map((i) => i.byHand === true)).toEqual([false]);
  });
});
