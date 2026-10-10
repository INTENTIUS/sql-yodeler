import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkYodelConfig } from "../src/config/load.js";
import { environmentSettings } from "../src/config/settings.js";
import { wavesSpec } from "../src/ci/render.js";
import { projectFromConfig, resolveEnvironment, type ProjectConfig } from "../src/project.js";
import { expandTargets, readTenantFile, renameIdentifier, splitTarget, tenantDriver } from "../src/tenants/index.js";
import { requiredEnvironments } from "../src/waves/promotion.js";
import { waveGate } from "../src/waves/index.js";
import type { VersionedDriver } from "../src/versioned/driver.js";
import type { YodelConfig } from "../src/config/define.js";

const pgConfig = (): ProjectConfig => ({
  lexicons: ["sql"],
  sql: { dialect: "postgres", profiles: { staging: { url: "postgres://h/db", schemas: ["app"] }, prod: { url: "postgres://h/db", schemas: ["app"] } } },
});

const yodel = (config: YodelConfig) => ({ path: "/p/yodel.config.ts", config });

describe("tenant targets", () => {
  it("splits env/tenant", () => {
    expect(splitTarget("prod/acme")).toEqual({ env: "prod", tenant: "acme" });
    expect(splitTarget("prod")).toEqual({ env: "prod" });
  });

  it("renames the template as an identifier, never inside a longer name", () => {
    const sql = `CREATE SCHEMA app;\nCREATE TABLE app.orders (id int);\nCREATE TABLE "app"."x" (); ALTER TABLE app_archive.t ADD c int; SELECT \`app\`.y`;
    expect(renameIdentifier(sql, "app", "acme")).toBe(`CREATE SCHEMA acme;\nCREATE TABLE acme.orders (id int);\nCREATE TABLE "acme"."x" (); ALTER TABLE app_archive.t ADD c int; SELECT \`acme\`.y`);
  });

  it("reads a tenant file as lines or a JSON array", () => {
    const dir = mkdtempSync(join(tmpdir(), "yodel-tenants-"));
    writeFileSync(join(dir, "a.txt"), "acme\n# a comment\nglobex  # trailing\n\n");
    writeFileSync(join(dir, "b.json"), '["acme", "initech"]');
    writeFileSync(join(dir, "c.txt"), "acme\nnot-a-name\n");
    expect(readTenantFile(join(dir, "a.txt"))).toEqual(["acme", "globex"]);
    expect(readTenantFile(join(dir, "b.json"))).toEqual(["acme", "initech"]);
    expect(() => readTenantFile(join(dir, "c.txt"))).toThrow(/"not-a-name".*not a tenant name/);
  });
});

describe("tenant config", () => {
  it("takes a list, a file or a query, and shares on a wave", () => {
    expect(() => checkYodelConfig({ environments: { prod: { tenants: ["acme", "globex"] } }, waves: [{ env: "prod", shares: 2 }] }, "y")).not.toThrow();
    expect(() => checkYodelConfig({ environments: { prod: { tenants: { file: "t.txt" } } } }, "y")).not.toThrow();
    expect(() => checkYodelConfig({ environments: { prod: { tenants: { query: "SELECT 1" } } } }, "y")).not.toThrow();
    expect(() => checkYodelConfig({ environments: { prod: { tenants: ["a-b"] } } }, "y")).toThrow(/not a tenant name/);
    expect(() => checkYodelConfig({ environments: { prod: { tenants: { file: "t", query: "q" } } } }, "y")).toThrow(/expected a list of tenant names/);
    expect(() => checkYodelConfig({ waves: [{ env: "prod", shares: 0 }] }, "y")).toThrow(/shares: expected a whole number/);
  });
});

describe("a tenant environment", () => {
  const project = () => projectFromConfig("/p", "/p/chant.config.ts", pgConfig(), yodel({ environments: { prod: { tenants: ["acme", "globex"], history: { database: "hist" } }, staging: { tenants: ["acme"] } }, waves: [{ env: "staging", gate: "never" }, { env: "prod", gate: "always" }] }));

  it("is the environment's profile on the tenant's schema, added to the profiles", () => {
    const p = project();
    const env = resolveEnvironment(p, "prod/acme");
    expect(env.tenant).toEqual({ env: "prod", name: "acme", template: "app" });
    expect(env.profile).toMatchObject({ url: "postgres://h/db", schemas: ["acme"] });
    expect(p.config.sql?.profiles?.["prod/acme"]).toBe(env.profile);
    expect(() => resolveEnvironment(p, "prod/initech")).toThrow(/no tenant "initech" in prod's tenant set/);
    expect(() => resolveEnvironment(projectFromConfig("/p", "/p/c", pgConfig()), "prod/acme")).toThrow(/prod has no tenant set/);
  });

  it("has its environment's settings and a history of its own", () => {
    const p = project();
    expect(environmentSettings(p, "prod/acme", {}).historyDatabase).toBe("hist_acme");
    expect(environmentSettings(p, "prod", {}).historyDatabase).toBe("hist");
  });

  it("has its environment's wave gate, and requires the same tenant of a tenant set before it", async () => {
    const p = project();
    expect(waveGate(p.yodel?.config, "prod/acme")).toEqual({ gate: "always", declared: true });
    expect((await requiredEnvironments(p, "prod/acme")).map((r) => r.env)).toEqual(["staging/acme"]);
  });

  it("lists every tenant of a set where its environment is named", async () => {
    expect(await expandTargets(project(), ["prod", "staging/acme"])).toEqual(["prod/acme", "prod/globex", "staging/acme"]);
  });

  it("sends statements and checks renamed, and runs no Op step", async () => {
    const sent: string[] = [];
    const driver = {
      dialect: "postgres",
      runStatement: (step: { sql: string }) => { sent.push(step.sql); return Promise.resolve(); },
      readCheck: (sql: string, where: { defaultSchema?: string }) => { sent.push(`${sql} @${where.defaultSchema ?? ""}`); return Promise.resolve([]); },
      stepContext: () => ({}),
    } as unknown as VersionedDriver;
    const t = tenantDriver(driver, { env: "prod", name: "acme", template: "app" });
    await t.runStatement({ sql: "ALTER TABLE app.orders ADD c int" } as never, { succeeded: () => Promise.resolve(), log: () => undefined });
    await t.readCheck("SELECT count(*) FROM app.orders", { defaultSchema: "app" });
    expect(sent).toEqual(["ALTER TABLE acme.orders ADD c int", "SELECT count(*) FROM acme.orders @acme"]);
    expect(() => t.stepContext()).toThrow(/Op step does not run on a tenant/);
  });
});

describe("a tenant set's wave", () => {
  it("is a run per tenant behind the wave's one gate, split into shares", () => {
    const spec = wavesSpec([{ env: "staging", gate: "never" }, { env: "prod", gate: "always", targets: ["prod/acme", "prod/globex", "prod/initech"], shares: 2 }]);
    expect(spec.waves[1]).toEqual({
      name: "prod",
      gate: "always",
      shares: 2,
      runs: [
        { target: "prod/acme", op: "migrate-prod" },
        { target: "prod/globex", op: "migrate-prod" },
        { target: "prod/initech", op: "migrate-prod" },
      ],
    });
    expect(spec.waves[0]?.runs).toEqual([{ target: "staging", op: "migrate-staging" }]);
  });
});
