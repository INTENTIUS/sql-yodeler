import { describe, expect, it } from "vitest";
import type { ClassifiedChange } from "@intentius/chant-lexicon-sql/core/classifier";
import { changeFindings, DECLARED, declarativeDigest, declarativeLint, declarativePolicyPlan, declaredSchemaFindings, planScope } from "../src/declarative/review.js";
import { renderDeclarativeMarkdown, renderDeclarativeText, declarativePlanJson, type DeclarativePlan } from "../src/declarative/plan.js";
import { commentMarker } from "../src/pr/render.js";
import { evaluatePolicy } from "../src/versioned/policy.js";
import { lintSettings, LINT_RULES, SCHEMA_RULES, renderLint } from "../src/lint/index.js";
import type { Plan } from "../src/chant/plan.js";

const drop: ClassifiedChange = { object: "events (app.events)", field: "columns.note", before: "String", rule: "SQLCH202", class: "metadata", destructive: true };
const mutation: ClassifiedChange = { object: "events (app.events)", field: "columns.kind.type", before: "String", after: "LowCardinality(String)", rule: "SQLCH210", class: "rewrite" };
const rebuild: ClassifiedChange = { object: "events (app.events)", field: "orderBy", before: "(kind, ts)", after: "(ts, kind)", rule: "SQLCH220", class: "rebuild" };
const revoke: ClassifiedChange = { object: "grants reader", field: "grants", before: "SELECT ON app.*", rule: "SQLCH274", class: "metadata" };
const pgRewrite: ClassifiedChange = { object: "orders (shop.orders)", field: "columns.total.type", before: "integer", after: "bigint", rule: "SQLPG212", class: "rewrite" };
const pgRevoke: ClassifiedChange = { object: "relation shop.orders TO reader", field: "privileges", before: "SELECT", rule: "SQLPG297", class: "catalog" };

const settings = (rules?: Record<string, string>) => lintSettings(rules ? { rules } : undefined, { ...LINT_RULES, ...SCHEMA_RULES });

describe("the declarative path's lint (#249)", () => {
  it("checks each planned change against the rules that read its rule and class", () => {
    const ch = changeFindings("clickhouse", [drop, mutation, rebuild, revoke], [rebuild]);
    expect(ch.map((f) => f.rule)).toEqual(["destructive", "ch-mutation", "ch-rebuild", "refused-step", "ch-access"]);
    expect(ch.find((f) => f.rule === "refused-step")?.message).toContain("needs its own Op (ClickHouseRebuildOp)");
    expect(ch.find((f) => f.rule === "destructive")?.message).toContain("events (app.events) columns.note");

    const pg = changeFindings("postgres", [pgRewrite, pgRevoke]);
    expect(pg.map((f) => f.rule)).toEqual(["pg-rewrite", "pg-access"]);
    expect(pg[1]?.message).toContain("revokes a privilege");
  });

  it("gives each finding the level lint.rules sets, drops one set off, and silences nothing", () => {
    const findings = changeFindings("clickhouse", [drop, mutation]);
    const report = declarativeLint({ project: { dir: "/p", dialect: "clickhouse" }, settings: settings({ "ch-mutation": "warning", destructive: "off" }), schema: [], plan: { environment: "prod", findings } });
    expect(report.findings).toMatchObject([{ rule: "ch-mutation", level: "warning", migration: planScope("prod") }]);
    expect(report).toMatchObject({ errors: 0, warnings: 1, silenced: 0, declarative: true, environment: "prod", migrations: [] });
    expect(renderLint(report)).toContain("The declared schema and the plan for prod: 0 errors, 1 warning.");
    expect(renderLint(report)).not.toContain("yodel:allow");
  });

  it("leaves out another dialect's rules", () => {
    const report = declarativeLint({ project: { dir: "/p", dialect: "clickhouse" }, settings: settings(), schema: [], plan: { environment: "prod", findings: [{ rule: "pg-rewrite", object: "x", message: "m" }] } });
    expect(report.findings).toEqual([]);
  });

  it("checks lint.naming over the declared schema, offline", () => {
    const build = {
      dialect: "postgres" as const,
      objects: [
        { export: "shop", type: "Postgres::Schema", ddl: "CREATE SCHEMA shop", dependsOn: [] },
        { export: "orders", type: "Postgres::Table", ddl: "CREATE TABLE shop.\"Orders\" (id bigint PRIMARY KEY)", dependsOn: ["shop"] },
      ],
    };
    const s = lintSettings({ naming: { table: "snake_case" } }, { ...LINT_RULES, ...SCHEMA_RULES });
    const found = declaredSchemaFindings(build, { settings: s });
    expect(found.filter((f) => f.rule === "naming").map((f) => f.message)).toEqual([expect.stringContaining('"Orders" does not match the naming rule for tables')]);
  });
});

describe("the declarative path's policy (#249)", () => {
  it("shows a rule the planned changes as one entry, declared, and judges them", async () => {
    const digest = await declarativeDigest("prod", "clickhouse", [drop, mutation]);
    const plan = declarativePolicyPlan("prod", "clickhouse", [drop, mutation], digest, new Date("2026-10-12T00:00:00Z"));
    expect(plan).toMatchObject({ environment: "prod", declarative: true, pending: [{ id: DECLARED, checksum: digest, outOfOrder: false, silences: [] }] });
    expect(plan.pending[0]?.steps[0]).toEqual({ index: 0, kind: "statement", object: "events (app.events)", name: "events (app.events) columns.note", classes: ["metadata"], destructive: true, rules: ["SQLCH202"] });
    const results = evaluatePolicy({ rules: [{ id: "no-drops", refuse: { destructive: true } }, { id: "no-rewrites", refuse: { classes: ["rewrite"] }, environments: ["staging"] }] }, plan);
    expect(results).toEqual([{ id: "no-drops", outcome: "denied", reasons: ["declared step 0 (events (app.events) columns.note) is destructive"] }]);
  });

  it("takes the override digest over the changes, whatever their order, and moves it with any change", async () => {
    const a = await declarativeDigest("prod", "clickhouse", [drop, mutation]);
    expect(await declarativeDigest("prod", "clickhouse", [mutation, drop])).toBe(a);
    expect(await declarativeDigest("staging", "clickhouse", [drop, mutation])).not.toBe(a);
    expect(await declarativeDigest("prod", "clickhouse", [drop, { ...mutation, after: "Enum8('a' = 1)" }])).not.toBe(a);
    expect(a).toMatch(/sha256:[0-9a-f]{64}$/);
  });
});

const view = (over: Partial<DeclarativePlan> = {}): DeclarativePlan => {
  const plan: Plan = { environment: "prod", dialect: "clickhouse", diff: { changes: [drop, mutation], rebuilds: [], hints: [] } as never, refused: [] };
  const findings = changeFindings("clickhouse", [drop, mutation]);
  return {
    environment: "prod",
    dialect: "clickhouse",
    plan,
    changes: [drop, mutation],
    report: "Plan for prod (clickhouse 26.8 at db.internal:8123, sql.profiles.prod)\n  events: 2 changes",
    commentReport: "Plan for prod (clickhouse, sql.profiles.prod)\n  events: 2 changes",
    server: { dialect: "clickhouse", version: "26.8", address: "db.internal:8123" },
    access: { managed: false, source: "default", changes: [] },
    lint: declarativeLint({ project: { dir: "/p", dialect: "clickhouse" }, settings: settings(), schema: [], plan: { environment: "prod", findings } }),
    digest: "sha256:abc",
    approval: { kind: "op", op: "applyProd", gate: "approve" },
    notes: [],
    ...over,
  };
};

describe("the declarative plan comment (#249)", () => {
  it("carries the plan comment's marker, chant's report, the findings and how to approve", () => {
    const md = renderDeclarativeMarkdown(view());
    expect(md.startsWith(commentMarker("prod"))).toBe(true);
    expect(md).toContain("ClickHouse 26.8, the declared schema against the live database: **2 changes**.");
    expect(md).not.toContain("db.internal");
    expect(md).toContain("events: 2 changes");
    expect(md).toContain("#### Lint (2 errors, 0 warnings)");
    expect(md).toContain("| **error** | `destructive` |");
    expect(md).toContain("runs `applyProd`, which stops at gate `approve`");
    expect(md).toContain("npx yodel approve prod");
    expect(md).not.toContain("#### Policy");
  });

  it("shows a policy denial and the override that answers it, in the comment and the text", () => {
    const denied = view({ policy: [{ id: "no-drops", outcome: "denied", reasons: ["declared step 0 (events (app.events) columns.note) is destructive"] }] });
    const md = renderDeclarativeMarkdown(denied);
    expect(md).toContain("| `no-drops` | **denied** |");
    expect(md).toContain('yodel override prod --rule no-drops --reason "<why>"');
    const text = renderDeclarativeText(denied);
    expect(text).toContain("policy no-drops: denied");
    expect(text).toContain("refuses this plan before the gate");
    // apply refuses before the gate, so there is nothing to approve until the override is recorded.
    expect(md).toContain("Nothing to approve yet: `yodel apply prod` refuses this plan before the gate while the policy denies it.");
    expect(md).not.toContain("npx yodel approve prod");
    const json = declarativePlanJson(denied);
    expect(json).toMatchObject({ environment: "prod", digest: "sha256:abc", policy: [{ id: "no-drops", outcome: "denied" }], lint: { status: "failed", errors: 2 }, approval: { op: "applyProd", gate: "approve" } });
    expect(json.approval).not.toHaveProperty("command");
    expect((json.approval as { message: string }).message).toContain("Record the override above first");
    expect(declarativePlanJson(view())).toMatchObject({ approval: { op: "applyProd", command: "yodel approve prod" } });
  });

  it("says when nothing changes, and when no ApplyOp applies the environment", () => {
    expect(renderDeclarativeMarkdown(view({ changes: [], digest: undefined }))).toContain("Nothing to approve: `prod` already matches the declared schema.");
    const none = renderDeclarativeMarkdown(view({ approval: { kind: "no-op", message: "no Op applies the declared schema to prod; declare one, for example:\n\nexport const applyProd = ..." } }));
    expect(none).toContain("No ApplyOp: no Op applies the declared schema to prod");
    expect(none).toContain("export const applyProd = ...");
  });

  it("says apply refuses a change that needs its own Op", () => {
    const p = view();
    const md = renderDeclarativeMarkdown({ ...p, plan: { ...p.plan, refused: [rebuild] } });
    expect(md).toContain("**`yodel apply` would refuse (exit 3)**");
    expect(md).toContain("1 change needs its own Op");
    expect(md).toContain("Nothing to approve yet: `yodel apply prod` would refuse this plan. Move the change that needs its own Op into one (ClickHouseRebuildOp)");
    expect(md).not.toContain("npx yodel approve prod");
    const refusedApproval = declarativePlanJson({ ...p, plan: { ...p.plan, refused: [rebuild] } }).approval as Record<string, string>;
    expect(Object.keys(refusedApproval)).toEqual(["op", "gate", "message"]);
    expect(refusedApproval.message).toContain("would refuse this plan");
  });

  it("says apply refuses a live object it could not read, not that there is nothing to approve", () => {
    const p = view({ changes: [], digest: undefined });
    const unreadable = { ...p, plan: { ...p.plan, diff: { changes: [], rebuilds: [], hints: [], unreadable: [{ object: "app.legacy", type: "table", reason: "SHOW CREATE denied" }] } as never } };
    const md = renderDeclarativeMarkdown(unreadable);
    expect(md).toContain("**`yodel apply` would refuse (exit 1)**");
    expect(md).toContain("Nothing to approve yet: `yodel apply prod` would refuse this plan, since `app.legacy` could not be read (SHOW CREATE denied).");
    expect(md).not.toContain("already matches the declared schema");
    const approval = declarativePlanJson(unreadable).approval as Record<string, string>;
    expect(Object.keys(approval)).toEqual(["op", "gate", "message"]);
    expect(approval.message).toContain("could not be read");
  });
});
