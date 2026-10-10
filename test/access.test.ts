/**
 * Postgres access control under review (#45): yodel.config.ts's
 * `environments.<env>.access`, what `yodel new` and the plan say about
 * policies and grants, and lint's `pg-access` and `pg-rls-not-forced`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BuildOutput, BuiltObject } from "../src/chant/build.js";
import { accessItems, describeAccessSteps, renderAccessReview, takesAccessAway } from "../src/chant/access.js";
import { checkYodelConfig } from "../src/config/load.js";
import { declarativeAccessRefusal, environmentAccess } from "../src/config/settings.js";
import { lintMigrations } from "../src/lint/index.js";
import { createMigration, newestMigration, readMigrations, writeMigration, type CreatedMigration } from "../src/migrations/index.js";
import { projectFromConfig, type ProjectConfig } from "../src/project.js";
import { destructiveSteps } from "../src/waves/index.js";

const app: BuiltObject = { export: "app", type: "Postgres::Schema", ddl: "CREATE SCHEMA yodel_45", dependsOn: [] };
const orders = (rls = ""): BuiltObject => ({ export: "orders", type: "Postgres::Table", ddl: `CREATE TABLE yodel_45.orders (id bigint PRIMARY KEY, tenant text);${rls}`, dependsOn: ["app"] });
const reader: BuiltObject = { export: "reader", type: "Postgres::Role", ddl: "CREATE ROLE yodel_45__reader NOLOGIN", dependsOn: [] };
const byTenant: BuiltObject = {
  export: "byTenant",
  type: "Postgres::Policy",
  ddl: "CREATE POLICY orders_tenant ON yodel_45.orders FOR SELECT TO yodel_45__reader USING (tenant = current_setting('app.tenant'))",
  dependsOn: ["orders", "reader"],
};
const readOrders: BuiltObject = { export: "readOrders", type: "Postgres::Grant", ddl: "GRANT SELECT ON TABLE yodel_45.orders TO yodel_45__reader", dependsOn: ["orders", "reader"] };
const count: BuiltObject = { export: "count", type: "Postgres::Function", ddl: "CREATE FUNCTION yodel_45.n() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$", dependsOn: ["app"] };
const countPrivate: BuiltObject = { export: "countPrivate", type: "Postgres::Grant", ddl: "REVOKE EXECUTE ON FUNCTION yodel_45.n() FROM PUBLIC", dependsOn: ["count"] };
const pg = (...objects: BuiltObject[]): BuildOutput => ({ dialect: "postgres", postgresMajor: 18, objects: [app, ...objects] });

const ENABLE = "\nALTER TABLE yodel_45.orders ENABLE ROW LEVEL SECURITY";
const FORCE = ";\nALTER TABLE yodel_45.orders FORCE ROW LEVEL SECURITY";

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "yodel-access-"));
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

describe("environments.<env>.access", () => {
  const config = (access?: boolean): ProjectConfig => ({ lexicons: ["sql"], sql: { dialect: "postgres", profiles: { dev: { url: "postgres://h:5432/db", ...(access !== undefined ? { access } : {}) } } } });
  const yodel = (access: boolean) => ({ path: "/p/yodel.config.ts", config: { environments: { dev: { access } } } });

  it("puts yodel.config.ts's setting on the chant profile yodel hands chant, and keeps chant.config.ts's own", () => {
    const p = projectFromConfig("/p", "/p/chant.config.ts", config(), yodel(true));
    expect((p.config.sql?.profiles?.dev as { access?: boolean }).access).toBe(true);
    expect(p.profileAccess).toEqual({});
    const own = projectFromConfig("/p", "/p/chant.config.ts", config(true));
    expect((own.config.sql?.profiles?.dev as { access?: boolean }).access).toBe(true);
    expect(own.profileAccess).toEqual({ dev: true });
  });

  it("resolves yodel.config.ts first, then the profile, then off", () => {
    expect(environmentAccess({ access: false }, { access: true }, "dev")).toEqual({ access: false, source: "yodel.config.ts" });
    expect(environmentAccess(undefined, { access: true }, "dev")).toEqual({ access: true, source: "sql.profiles.dev.access" });
    expect(environmentAccess(undefined, undefined, "dev")).toEqual({ access: false, source: "default" });
  });

  it("is refused on the declarative path when chant.config.ts, which the ApplyOp reads, says otherwise", () => {
    expect(declarativeAccessRefusal(projectFromConfig("/p", "/p/chant.config.ts", config(true), yodel(true)), "dev")).toBeUndefined();
    expect(declarativeAccessRefusal(projectFromConfig("/p", "/p/chant.config.ts", config(), yodel(false)), "dev")).toBeUndefined();
    expect(declarativeAccessRefusal(projectFromConfig("/p", "/p/chant.config.ts", config(), yodel(true)), "dev")?.message).toMatch(/sets environments\.dev\.access to true, but .* reads sql\.profiles\.dev\.access .* \(unset, so off\)/);
  });

  it("must be true or false", () => {
    expect(() => checkYodelConfig({ environments: { dev: { access: "yes" } } }, "yodel.config.ts", ["dev"])).toThrow(/environments\.dev\.access: expected true or false/);
  });
});

describe("access steps in a migration", () => {
  it("yodel new writes the role, the policy, row-level security and the grant, each with its rule and class", () => {
    const [m] = chain(tempDir(), [["create", pg(orders(ENABLE + FORCE), reader, byTenant, readOrders)]]);
    const steps = m?.statements.steps ?? [];
    const lines = describeAccessSteps(steps);
    expect(lines[0]).toMatch(/^Access control: 5 steps \(SQLPG200 create, SQLPG296 metadata\)$/);
    expect(lines).toHaveLength(1);
  });

  it("names the steps that take access away: a revoke, a dropped policy, row-level security turned off", () => {
    const [, m] = chain(tempDir(), [
      ["create", pg(orders(ENABLE), reader, byTenant, readOrders)],
      ["remove", pg(orders(), reader)],
    ]);
    const lines = describeAccessSteps(m?.statements.steps ?? []);
    expect(lines.join("\n")).toContain("3 taking access away");
    expect(lines.join("\n")).toContain("turns row-level security off");
    expect(lines.join("\n")).toContain("revokes a privilege that no declaration grants any more");
    expect(lines.join("\n")).toContain("drops a policy");
    expect(takesAccessAway({ rule: "SQLPG293", sql: "ALTER TABLE t ENABLE ROW LEVEL SECURITY" })).toBeUndefined();
    expect(takesAccessAway({ rule: "SQLPG293", sql: "ALTER TABLE t NO FORCE ROW LEVEL SECURITY" })).toMatch(/stops forcing/);
  });
});

describe("yodel lint: access control", () => {
  it("pg-access: a revoke and a dropped policy are flagged, and on-destructive waits on them", async () => {
    const dir = tempDir();
    const ms = chain(dir, [
      ["create", pg(orders(ENABLE + FORCE), reader, byTenant, readOrders)],
      ["remove", pg(orders(ENABLE + FORCE), reader)],
    ]);
    const report = await lintMigrations(dir, { dialect: "postgres" });
    const second = report.findings.filter((f) => f.migration === ms[1]?.id);
    expect(second.map((f) => f.rule).sort()).toEqual(["pg-access", "pg-access"]);
    const pending = ms.map((m) => ({ id: m.id, migration: { document: m.document } }));
    expect(destructiveSteps("postgres", pending.slice(1)).map((d) => d.why)).toEqual(["pg-access", "pg-access"]);
  });

  it("pg-access: a revoke on a function the same migration creates takes nothing from anyone", async () => {
    const dir = tempDir();
    chain(dir, [["create", pg(count, countPrivate)]]);
    const report = await lintMigrations(dir, { dialect: "postgres" });
    expect(report.findings.filter((f) => f.rule === "pg-access")).toEqual([]);
  });

  it("pg-rls-not-forced: row-level security enabled but not forced is a warning", async () => {
    const dir = tempDir();
    chain(dir, [["create", pg(orders(ENABLE), reader, byTenant)]]);
    const report = await lintMigrations(dir, { dialect: "postgres" });
    const found = report.findings.filter((f) => f.rule === "pg-rls-not-forced");
    expect(found.map((f) => f.level)).toEqual(["warning"]);
    expect(found[0]?.message).toContain("yodel_45.orders has row-level security enabled but not forced");

    const forced = tempDir();
    chain(forced, [["create", pg(orders(ENABLE + FORCE), reader, byTenant)]]);
    expect((await lintMigrations(forced, { dialect: "postgres" })).findings.filter((f) => f.rule === "pg-rls-not-forced")).toEqual([]);
  });
});

describe("the declarative plan's access section", () => {
  const build = pg(orders(ENABLE), reader, readOrders, count, countPrivate);
  const change = (object: string, rule: string, before: string, after: string) => ({ object, rule, class: "metadata", field: "privileges", before, after }) as never;

  it("marks a revoke no declaration asks for as taking away what was granted by hand", async () => {
    const items = await accessItems(
      [
        change("relation yodel_45.orders TO yodel_45__reader", "SQLPG297", "insert, select", "select"),
        change("routine yodel_45.n() TO PUBLIC", "SQLPG297", "execute", ""),
        change("relation yodel_45.orders TO yodel_45__reader", "SQLPG296", "", "select"),
      ],
      build,
    );
    expect(items.map((i) => [i.rule, i.byHand === true])).toEqual([
      ["SQLPG297", true],
      ["SQLPG297", false],
      ["SQLPG296", false],
    ]);
    const text = renderAccessReview({ managed: true, source: "yodel.config.ts", changes: items }, "dev").join("\n");
    expect(text).toContain("Access control (managed in dev, from yodel.config.ts): 3 changes");
    expect(text).toMatch(/Revoked by this apply, though no declaration revokes it.*\n {2}relation yodel_45\.orders FROM yodel_45__reader: insert\n/);
  });

  it("says when access is not managed", () => {
    expect(renderAccessReview({ managed: false, source: "default", changes: [] }, "dev")).toEqual(["Access control: not managed in dev (off by default); policies, grants, roles and users are not planned."]);
  });
});
