import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkYodelConfig } from "../src/config/load.js";
import { environmentSettings } from "../src/config/settings.js";
import { wavesSpec } from "../src/ci/render.js";
import { projectFromConfig, resolveEnvironment, type ProjectConfig } from "../src/project.js";
import { expandTargets, readTenantFile, renameIdentifier, splitTarget, tenantDriver } from "../src/tenants/index.js";
import { applySlot, slotDigest, slotIndex, splitSlot, waveTargets, type SlotPlanFile } from "../src/tenants/wave.js";
import { renameDeep } from "../src/steps/index.js";
import { WavePlanMoved, type WavePlanFile } from "../src/waves/index.js";
import { renderTenantSetMarkdown, type TenantSetPlan } from "../src/pr/tenants.js";
import type { VersionedPlan } from "../src/pr/model.js";
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

  it("sends statements and checks renamed, and hands an Op step the tenant", async () => {
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
    expect(t.stepContext()).toEqual({ tenant: { env: "prod", name: "acme", template: "app" } });
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

describe("an Op step on a tenant", () => {
  it("has the template renamed in its options and its recorded schema", () => {
    const schema = { objects: [{ name: "app", sqlName: "app" }, { database: "app", sqlName: "app.events", ddl: "CREATE TABLE app.events (id UInt64)", columns: [{ name: "app_id" }] }] };
    expect(renameDeep(schema, (s) => renameIdentifier(s, "app", "acme"))).toEqual({
      objects: [{ name: "acme", sqlName: "acme" }, { database: "acme", sqlName: "acme.events", ddl: "CREATE TABLE acme.events (id UInt64)", columns: [{ name: "app_id" }] }],
    });
  });
});

describe("a tenant set read at run time", () => {
  const project = (tenants: YodelConfig["environments"] = { prod: { tenants: { query: "SELECT name FROM tenants" } } }) =>
    projectFromConfig("/p", "/p/chant.config.ts", pgConfig(), yodel({ environments: tenants, waves: [{ env: "prod", gate: "always", shares: 3 }] }));

  it("is rendered as slots, with no server read, so the pipeline stays the same as tenants come and go", async () => {
    expect(await waveTargets(project(), "prod", 3)).toEqual(["prod/@1of3", "prod/@2of3", "prod/@3of3"]);
    expect(await waveTargets(project(), "prod")).toEqual(["prod/@1of1"]);
    expect(await waveTargets(project({ prod: { tenants: ["acme", "globex"] } }), "prod", 3)).toEqual(["prod/acme", "prod/globex"]);
    expect(await waveTargets(project(), "staging")).toBeUndefined();
  });

  it("puts a tenant in the same slot whatever else the set lists", () => {
    expect(splitSlot("prod/@2of3")).toEqual({ env: "prod", index: 2, count: 3 });
    expect(splitSlot("prod/@4of3")).toBeUndefined();
    expect(splitSlot("prod/acme")).toBeUndefined();
    const names = Array.from({ length: 50 }, (_, i) => `t${String(i)}`);
    const slots = names.map((n) => slotIndex(n, 4));
    expect(slots.every((i) => i >= 1 && i <= 4)).toBe(true);
    expect(new Set(slots).size).toBe(4);
    expect(names.map((n) => slotIndex(n, 4))).toEqual(slots);
  });

  it("digests a slot over its tenants' plans, in any order", async () => {
    const a = { target: "prod/a", planDigest: "jcs1-sha256:aa" };
    const b = { target: "prod/b", planDigest: "jcs1-sha256:bb" };
    expect(await slotDigest("prod/@1of1", [a, b])).toBe(await slotDigest("prod/@1of1", [b, a]));
    expect(await slotDigest("prod/@1of1", [a, b])).not.toBe(await slotDigest("prod/@1of1", [a, { ...b, planDigest: "jcs1-sha256:cc" }]));
  });

  it("applies each tenant of a slot, and refuses one whose plan moved, naming it, after the others (exit 4)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yodel-slot-"));
    const plan = (env: string) => ({ planDigest: `jcs1-sha256:${env}`, environment: env }) as unknown as WavePlanFile;
    const file: SlotPlanFile = { planDigest: "jcs1-sha256:slot", destructive: false, empty: false, environment: "prod/@1of1", tenants: ["prod/a", "prod/b", "prod/c"].map((t) => ({ target: t, plan: plan(t) })) };
    writeFileSync(join(dir, "slot.json"), JSON.stringify(file));
    const applied: string[] = [];
    const lines: string[] = [];
    const code = await applySlot("prod/@1of1", join(dir, "slot.json"), (tenant, _file, decidedAs) => {
      expect(decidedAs).toEqual({ target: "prod/@1of1", planDigest: "jcs1-sha256:slot" });
      if (tenant === "prod/b") throw new WavePlanMoved("refused: moved");
      applied.push(tenant);
      return Promise.resolve(0);
    }, (l) => lines.push(l));
    expect(code).toBe(4);
    expect(applied).toEqual(["prod/a", "prod/c"]);
    expect(lines.some((l) => l.startsWith("prod/b: its plan moved"))).toBe(true);
    await expect(applySlot("prod/@1of2", join(dir, "slot.json"), () => Promise.resolve(0), () => undefined)).rejects.toThrow(/prod\/@1of1's plan, not prod\/@1of2's/);
  });
});

describe("a tenant set's plan comment", () => {
  const tenant = (name: string, pending: string[]): VersionedPlan => ({
    environment: `prod/${name}`,
    dialect: "postgres",
    appliedCount: 1,
    pending: pending.map((id) => ({ id, outOfOrder: false, steps: [] })),
    problems: [],
    notes: [],
  });

  it("is one comment for the set: tenants with the same migrations once, then one approval for every tenant", () => {
    const plan: TenantSetPlan = {
      environment: "prod",
      dialect: "postgres",
      template: "app",
      tenants: [tenant("acme", ["m2"]), tenant("globex", ["m2"]), tenant("initech", [])],
      wave: { wave: 2, gate: "always", base: "0123456789abcdef", baseSource: "first-parent", runs: [], refused: [], blocked: [], waits: true, digest: "jcs1-sha256:set", approve: "chant approve yodel-apply yodel-apply-wave-2 --plan jcs1-sha256:set" },
      notes: [],
    };
    const md = renderTenantSetMarkdown(plan);
    expect(md.startsWith("<!-- yodel:plan env=prod -->\n")).toBe(true);
    expect(md).toContain("#### 2 tenants: **1 pending**\n\n`acme`, `globex`");
    expect(md).toContain("##### `m2`");
    expect(md).toContain("#### 1 tenant: up to date\n\n`initech`");
    expect(md).toContain("one approval of `jcs1-sha256:set`, for all 3 tenants");
    expect(md).toContain("chant approve yodel-apply yodel-apply-wave-2 --plan jcs1-sha256:set");
    expect(md).toContain("`yodel approve prod`");
  });
});
