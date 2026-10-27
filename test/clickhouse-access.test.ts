/**
 * ClickHouse dictionaries, functions and access control (#46): what the
 * plan, `yodel new`, lint, the waves, drift's recorded source, the replay
 * and `yodel init --from` make of users, roles, row policies and grants, and
 * how their statements are rendered per topology. No server.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BuildOutput, BuiltObject } from "../src/chant/build.js";
import { accessItems, clickhouseAccessManaged, describeAccessSteps, isAccessChange, renderAccessReview, takesAccessAway } from "../src/chant/access.js";
import { declaredChanges, planExitCode, type Plan } from "../src/chant/plan.js";
import { recordedAccessSource } from "../src/chant/drift.js";
import { ordered, templateOf, withoutAuthentication } from "../src/init/clickhouse-access.js";
import { lintMigrations } from "../src/lint/index.js";
import { createMigration, newestMigration, readMigrations, writeMigration, type CreatedMigration } from "../src/migrations/index.js";
import { declarativeRefusal } from "../src/config/settings.js";
import { projectFromConfig, type ProjectConfig } from "../src/project.js";
import { alterToDeclared, clickhouseDatabases, clickhouseGlobals, dropGlobal } from "../src/replay/clickhouse.js";
import { renderForEnvironment } from "../src/topology/render.js";
import { destructiveSteps } from "../src/waves/index.js";

const db: BuiltObject = { export: "db", type: "ClickHouse::Database", ddl: "CREATE DATABASE yodel_46 ENGINE = Atomic", dependsOn: [] };
const events: BuiltObject = { export: "events", type: "ClickHouse::Table", ddl: "CREATE TABLE yodel_46.events (id UInt64, kind String) ENGINE = MergeTree ORDER BY id", dependsOn: ["db"] };
const daily: BuiltObject = {
  export: "dailyN",
  type: "ClickHouse::Dictionary",
  ddl: "CREATE DICTIONARY yodel_46.daily_n (day Date, n UInt64 DEFAULT 0) PRIMARY KEY day SOURCE(CLICKHOUSE(TABLE 'daily' DB 'yodel_46')) LAYOUT(COMPLEX_KEY_HASHED()) LIFETIME(300)",
  dependsOn: ["db"],
};
const scale: BuiltObject = { export: "scale", type: "ClickHouse::Function", ddl: "CREATE FUNCTION yodel_46_scale AS (x, k) -> x * k", dependsOn: [] };
const reader: BuiltObject = { export: "reader", type: "ClickHouse::Role", ddl: "CREATE ROLE yodel_46_reader", dependsOn: [] };
const svc: BuiltObject = { export: "svc", type: "ClickHouse::User", ddl: "CREATE USER yodel_46_svc DEFAULT ROLE yodel_46_reader", dependsOn: ["reader"] };
const clicks: BuiltObject = { export: "clicks", type: "ClickHouse::RowPolicy", ddl: "CREATE ROW POLICY clicks ON yodel_46.events FOR SELECT USING kind = 'click' TO yodel_46_reader", dependsOn: ["events", "reader"] };
const readEvents: BuiltObject = { export: "readEvents", type: "ClickHouse::Grant", ddl: "GRANT SELECT ON yodel_46.events TO yodel_46_reader", dependsOn: ["events", "reader"] };
const insertEvents: BuiltObject = { export: "insertEvents", type: "ClickHouse::Grant", ddl: "GRANT INSERT ON yodel_46.events TO yodel_46_reader", dependsOn: ["events", "reader"] };
const ch = (...objects: BuiltObject[]): BuildOutput => ({ dialect: "clickhouse", objects: [db, events, ...objects] });

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "yodel-ch-access-"));
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

describe("ClickHouse access in a plan", () => {
  const change = (object: string, rule: string, field: string, before?: string, after?: string) => ({ object, rule, class: rule === "SQLCH200" ? "create" : "metadata", field, before, after }) as never;

  it("picks out users, roles, row policies and grants, and marks every revoke as taking away what no declaration grants", async () => {
    expect(isAccessChange(change("reader (role yodel_46_reader)", "SQLCH200", "object"))).toBe(true);
    expect(isAccessChange(change("grants yodel_46_reader", "SQLCH200", "object"))).toBe(true);
    expect(isAccessChange(change("events (yodel_46.events)", "SQLCH200", "object"))).toBe(false);
    expect(isAccessChange(change("scale (function yodel_46_scale)", "SQLCH260", "lambda"))).toBe(false);
    const items = await accessItems(
      [change("grants yodel_46_reader", "SQLCH274", "grants.INSERT ON yodel_46.events", "INSERT ON yodel_46.events"), change("grants yodel_46_reader", "SQLCH273", "grants.SELECT ON yodel_46.events", undefined, "SELECT ON yodel_46.events")],
      ch(reader, readEvents),
    );
    expect(items.map((i) => [i.rule, i.byHand === true])).toEqual([
      ["SQLCH274", true],
      ["SQLCH273", false],
    ]);
    const text = renderAccessReview({ managed: true, source: "yodel.config.ts", changes: items }, "dev").join("\n");
    expect(text).toMatch(/Revoked by this apply, though no declaration revokes it.*\n {2}INSERT ON yodel_46\.events FROM yodel_46_reader\n/);
  });

  it("counts a grantee's grants as work for the apply, and a plan with an object it cannot read as refused", () => {
    const plan = (changes: unknown[], unreadable?: unknown[]): Plan => ({ environment: "dev", dialect: "clickhouse", diff: { changes, rebuilds: [], hints: [], ...(unreadable ? { unreadable } : {}) } as never, refused: [] });
    const build = { path: "", output: ch(reader, readEvents), dispose: () => undefined };
    expect(declaredChanges(plan([change("grants yodel_46_reader", "SQLCH274", "grants.INSERT ON yodel_46.events", "INSERT ON yodel_46.events")]), build)).toHaveLength(1);
    expect(planExitCode(plan([]))).toBe(0);
    expect(planExitCode(plan([], [{ object: "yodel_46.odd", type: "ClickHouse::Dictionary", reason: "its definition does not parse" }]))).toBe(1);
  });

  it("leaves access to chant's profile switch, and refuses a yodel.config.ts that says otherwise on the declarative path", () => {
    const config = (access?: boolean): ProjectConfig => ({ lexicons: ["sql"], sql: { dialect: "clickhouse", profiles: { dev: { url: "http://h:8123", ...(access === undefined ? {} : { access }) } } } });
    const yodel = (access: boolean) => ({ path: "/p/yodel.config.ts", config: { environments: { dev: { access } } } });
    const off = projectFromConfig("/p", "/p/chant.config.ts", config());
    expect(clickhouseAccessManaged(off, "dev")).toBe(false);
    expect(declarativeRefusal(off, "dev")).toBeUndefined();
    expect(clickhouseAccessManaged(projectFromConfig("/p", "/p/chant.config.ts", config(true)), "dev")).toBe(true);
    const both = projectFromConfig("/p", "/p/chant.config.ts", config(true), yodel(true));
    expect(clickhouseAccessManaged(both, "dev")).toBe(true);
    expect(declarativeRefusal(both, "dev")).toBeUndefined();
    expect(declarativeRefusal(projectFromConfig("/p", "/p/chant.config.ts", config(), yodel(true)), "dev")?.message).toMatch(/sets environments\.dev\.access to true, but .* reads sql\.profiles\.dev\.access .* \(unset, so off\)/);
  });
});

describe("ClickHouse access in a migration", () => {
  it("yodel new writes dictionaries, functions, roles, users, row policies and grants, and names a revoke", () => {
    const [first, second] = chain(tempDir(), [
      ["create", ch(daily, scale, reader, svc, clicks, readEvents, insertEvents)],
      ["tighten", ch(daily, scale, reader, svc, clicks, readEvents)],
    ]);
    const sql = first?.files.sql ?? "";
    for (const want of ["CREATE DICTIONARY yodel_46.daily_n", "CREATE FUNCTION yodel_46_scale", "CREATE ROLE yodel_46_reader", "CREATE ROW POLICY clicks", "GRANT SELECT ON"]) expect(sql).toContain(want);
    // A user declared without IDENTIFIED is the environment's to create; its declared clauses (DEFAULT ROLE) are set on it (SQLCH271).
    expect(sql).not.toContain("CREATE USER");
    expect(sql).toMatch(/ALTER USER \S*yodel_46_svc\S* DEFAULT ROLE/);
    expect(describeAccessSteps(first?.statements.steps ?? [])[0]).toMatch(/^Access control: \d+ steps \(SQLCH200 create, SQLCH271 metadata, SQLCH273 metadata\)$/);
    const lines = describeAccessSteps(second?.statements.steps ?? []).join("\n");
    expect(lines).toContain("1 taking access away");
    expect(lines).toContain("revokes a privilege that no declaration grants any more: REVOKE INSERT ON");
    expect(takesAccessAway({ rule: "SQLCH274", sql: "REVOKE `r` FROM `u`" })).toBe("revokes a role");
    expect(takesAccessAway({ rule: "SQLCH274", sql: "REVOKE ON CLUSTER `c` SELECT ON `d`.`t` FROM `r`" })).toBe("revokes a privilege");
  });

  it("ch-access: a revoke is flagged, and on-destructive waits on it", async () => {
    const dir = tempDir();
    const ms = chain(dir, [
      ["create", ch(reader, readEvents, insertEvents)],
      ["tighten", ch(reader, readEvents)],
    ]);
    const report = await lintMigrations(dir, { dialect: "clickhouse" });
    expect(report.findings.filter((f) => f.migration === ms[0]?.id)).toEqual([]);
    const second = report.findings.filter((f) => f.migration === ms[1]?.id);
    expect(second.map((f) => [f.rule, f.level])).toEqual([["ch-access", "error"]]);
    const pending = ms.map((m) => ({ id: m.id, migration: { document: m.document } }));
    expect(destructiveSteps("clickhouse", pending.slice(1)).map((d) => d.why)).toEqual(["ch-access"]);
  });

  it("renders each statement for the environment's topology", () => {
    const cluster = { kind: "cluster", cluster: "main" } as const;
    expect(renderForEnvironment("CREATE FUNCTION f AS (x) -> x * 2", cluster)).toBe("CREATE FUNCTION f ON CLUSTER `main` AS (x) -> x * 2");
    expect(renderForEnvironment("CREATE ROLE r", cluster)).toBe("CREATE ROLE r ON CLUSTER `main`");
    expect(renderForEnvironment("CREATE USER u NOT IDENTIFIED DEFAULT ROLE r", cluster)).toBe("CREATE USER u ON CLUSTER `main` NOT IDENTIFIED DEFAULT ROLE r");
    expect(renderForEnvironment("CREATE ROW POLICY p ON db.t FOR SELECT USING k = 1 TO r", cluster)).toBe("CREATE ROW POLICY p ON CLUSTER `main` ON db.t FOR SELECT USING k = 1 TO r");
    expect(renderForEnvironment("GRANT SELECT ON `db`.`t` TO `r`", cluster)).toBe("GRANT ON CLUSTER `main` SELECT ON `db`.`t` TO `r`");
    expect(renderForEnvironment("REVOKE INSERT ON `db`.`t` FROM `r`", cluster)).toBe("REVOKE ON CLUSTER `main` INSERT ON `db`.`t` FROM `r`");
    expect(renderForEnvironment("CREATE DICTIONARY db.d (k UInt64) PRIMARY KEY k SOURCE(NULL()) LAYOUT(FLAT()) LIFETIME(0)", cluster)).toMatch(/^CREATE DICTIONARY db\.d ON CLUSTER `main` /);
    // Inside a Replicated database alone, the database's log carries the DDL; a function, user or grant is not in it, and is sent to the node.
    const replicated = { kind: "replicated" } as const;
    expect(renderForEnvironment("GRANT SELECT ON `db`.`t` TO `r`", replicated as never)).toBe("GRANT SELECT ON `db`.`t` TO `r`");
    expect(renderForEnvironment("CREATE FUNCTION f AS (x) -> x * 2", { kind: "replicated", cluster: "main" } as never)).toBe("CREATE FUNCTION f ON CLUSTER `main` AS (x) -> x * 2");
  });
});

describe("the replay and drift", () => {
  it("empties only databases, and drops the functions, users, roles and row policies the history declares", async () => {
    const schema = ch(daily, scale, reader, svc, clicks, readEvents);
    expect(await clickhouseDatabases(schema, "default")).toEqual(["yodel_46"]);
    const globals = await clickhouseGlobals(schema, "default");
    expect(globals.map(dropGlobal).sort()).toEqual([
      "DROP FUNCTION IF EXISTS `yodel_46_scale`",
      "DROP ROLE IF EXISTS `yodel_46_reader`",
      "DROP ROW POLICY IF EXISTS `clicks` ON `yodel_46`.`events`",
      "DROP USER IF EXISTS `yodel_46_svc`",
    ]);
    expect(globals.find((g) => g.kind === "user")?.withheld).toBe(true);
    expect(alterToDeclared(svc.ddl)).toBe("ALTER USER yodel_46_svc DEFAULT ROLE yodel_46_reader");
    expect(alterToDeclared("CREATE USER u")).toBeUndefined();
    expect(alterToDeclared("CREATE USER u NOT IDENTIFIED")).toBeUndefined();
  });

  it("writes a recorded schema's access objects as declarations, which chant's generator leaves out", () => {
    const text = recordedAccessSource([reader, svc, clicks, { ...readEvents, ddl: "GRANT SELECT ON `yodel_46`.`events` TO `yodel_46_reader`" }]);
    expect(text).toContain('import { grant, policy, role, user } from "@intentius/chant-lexicon-sql/clickhouse";');
    expect(text).toContain("export const reader = role`CREATE ROLE yodel_46_reader`;");
    expect(text).toContain("export const readEvents = grant`GRANT SELECT ON \\`yodel_46\\`.\\`events\\` TO \\`yodel_46_reader\\``;");
  });
});

describe("yodel init --from: ClickHouse access", () => {
  it("leaves out a user's authentication, which is the environment's", () => {
    expect(withoutAuthentication("CREATE USER u IDENTIFIED WITH sha256_password HOST LOCAL SETTINGS max_threads = 2")).toBe("CREATE USER u HOST LOCAL SETTINGS max_threads = 2");
    expect(withoutAuthentication("CREATE USER u IDENTIFIED WITH no_password DEFAULT ROLE r")).toBe("CREATE USER u DEFAULT ROLE r");
    expect(withoutAuthentication("CREATE USER u NOT IDENTIFIED")).toBe("CREATE USER u");
  });

  it("interpolates the tables and principals a statement names, never its own name or a string", () => {
    const tables = new Map([["yodel_46.events", "events"]]);
    const principals = new Map([
      ["reader", "reader"],
      ["svc", "svc"],
    ]);
    expect(templateOf({ kind: "grant", sql: "GRANT SELECT ON yodel_46.events TO reader" }, tables, principals).body).toBe("GRANT SELECT ON ${events} TO ${reader}");
    expect(templateOf({ kind: "grant", sql: "GRANT reader TO svc" }, tables, principals).body).toBe("GRANT ${reader} TO ${svc}");
    expect(templateOf({ kind: "user", own: "svc", sql: "CREATE USER svc DEFAULT ROLE reader SETTINGS max_threads = 2" }, tables, principals).body).toBe("CREATE USER svc DEFAULT ROLE ${reader} SETTINGS max_threads = 2");
    expect(templateOf({ kind: "role", own: "reader", sql: "CREATE ROLE reader" }, tables, principals).body).toBe("CREATE ROLE reader");
    expect(templateOf({ kind: "policy", own: "clicks", sql: "CREATE ROW POLICY clicks ON yodel_46.events FOR SELECT USING kind = 'reader' TO reader" }, tables, principals).body).toBe(
      "CREATE ROW POLICY clicks ON ${events} FOR SELECT USING kind = 'reader' TO ${reader}",
    );
  });

  it("interpolates the settings profile a user, role or profile names, never the profile's own name (#256)", () => {
    const none = new Map<string, string>();
    const principals = new Map([["analyst", "analyst"]]);
    const profiles = new Map([
      ["base", "base"],
      ["wide", "wide"],
    ]);
    expect(templateOf({ kind: "user", own: "svc", sql: "CREATE USER svc SETTINGS PROFILE `base`" }, none, principals, profiles).body).toBe("CREATE USER svc SETTINGS PROFILE ${base}");
    expect(templateOf({ kind: "role", own: "analyst", sql: "CREATE ROLE analyst SETTINGS PROFILE `base`" }, none, principals, profiles).body).toBe("CREATE ROLE analyst SETTINGS PROFILE ${base}");
    expect(templateOf({ kind: "settingsProfile", own: "wide", sql: "CREATE SETTINGS PROFILE `wide` SETTINGS INHERIT `base` TO analyst" }, none, principals, profiles).body).toBe(
      "CREATE SETTINGS PROFILE \\`wide\\` SETTINGS INHERIT ${base} TO ${analyst}",
    );
    expect(templateOf({ kind: "settingsProfile", own: "base", sql: "CREATE SETTINGS PROFILE `base` SETTINGS max_threads = 4" }, none, principals, profiles).body).toBe("CREATE SETTINGS PROFILE \\`base\\` SETTINGS max_threads = 4");
  });

  it("lists each declaration after the ones it names, and breaks a profile assigned TO a user that names it (#256)", () => {
    const none = new Map<string, string>();
    const principals = new Map([["svc", "svc"]]);
    const profiles = new Map([["base", "base"]]);
    const stmts = [
      { kind: "user" as const, exportName: "svc", own: "svc", sql: "CREATE USER svc SETTINGS PROFILE `base`" },
      { kind: "quota" as const, exportName: "q", own: "q", sql: "CREATE QUOTA q FOR INTERVAL 1 hour MAX queries = 100 TO svc" },
      { kind: "settingsProfile" as const, exportName: "base", own: "base", sql: "CREATE SETTINGS PROFILE `base` SETTINGS max_threads = 4 TO svc" },
    ];
    const warnings: string[] = [];
    const out = ordered(
      stmts.map((s) => ({ s, ...templateOf(s, none, principals, profiles) })),
      (b, cut) => ({ s: b.s, ...templateOf(b.s, none, new Map([...principals].filter(([, e]) => e !== cut)), profiles) }),
      warnings,
    );
    expect(out.map((b) => b.s.exportName)).toEqual(["base", "svc", "q"]);
    expect(out[0]?.body).toBe("CREATE SETTINGS PROFILE \\`base\\` SETTINGS max_threads = 4 TO svc");
    expect(out[2]?.body).toBe("CREATE QUOTA q FOR INTERVAL 1 hour MAX queries = 100 TO ${svc}");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("SettingsProfile base is assigned TO svc");
  });
});
