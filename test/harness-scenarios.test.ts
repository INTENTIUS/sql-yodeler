/**
 * sql-yodeler's scenarios on chant's e2e harness (scenarios/harness/, #302):
 * the files, their lint, the overlays and setups they name, and the
 * citations docs/claims.md lists for them. Nothing here starts a forge or
 * a server.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claims } from "../scenarios/claims/index.js";
import { dialectOf, readScenarios, scenariosDir, setupOf, SETUPS } from "../scenarios/harness/catalog.js";
import { lintLocal, loadHarness, type Scenario } from "../scenarios/harness/harness.js";
import { isOverlay } from "../scenarios/harness/overlays.js";
import { breakModeOf } from "../scenarios/harness/run.js";
import { readPendingCitations } from "../scenarios/product-proofs.js";
import { proofsPath } from "../scenarios/status-page.js";

const names = claims.map((c) => c.name);
const scenarios = readScenarios();
const all = [...scenarios.values()].map((v) => v.scenario);
const harness = await loadHarness();

describe("the harness scenarios", () => {
  it("has sy-forge, sy-waves, sy-approval and sy-new on both starter templates", () => {
    expect([...scenarios.keys()].sort()).toEqual(
      Object.keys(SETUPS)
        .flatMap((b) => [`${b}-clickhouse`, `${b}-postgres`])
        .sort(),
    );
  });

  it.each(all.map((s) => [s.id, s] as const))("%s passes the lint, with a claim, a BREAK arm and something expected", (_id, s) => {
    expect(lintLocal(s, names)).toEqual([]);
    expect(s.claim).toBe(setupOf(s.id).claim);
    expect(["skip-approval", "gate-never", "commit:paths", "commit:moved-base"]).toContain(breakModeOf(s));
    expect(s.break.note?.length).toBeGreaterThan(0);
  });

  it.each(all.map((s) => [s.id, s] as const))("%s is on its dialect's starter template", (_id, s) => {
    const base = join(scenariosDir, s.tree.base);
    expect(existsSync(join(base, "chant.template.json"))).toBe(true);
    expect(base.endsWith(dialectOf(s.id) === "ch" ? "templates/clickhouse" : "templates/postgres")).toBe(true);
  });

  it.each(all.map((s) => [s.id, s] as const))("%s opens only the overlays its setup makes, in the order they are made", (_id, s) => {
    const opened = s.steps.flatMap((st) => (st.do === "open" || st.do === "open-concurrent" ? [st.overlay] : []));
    for (const o of opened) expect(isOverlay(o)).toBe(true);
    expect(opened).toEqual([...setupOf(s.id).overlays]);
  });

  it("checks the waves' approvals with yodel approve on the runner, one per wave", () => {
    for (const id of ["sy-waves-clickhouse", "sy-waves-postgres"]) {
      const s = scenarios.get(id)?.scenario;
      const approvals = s?.steps.filter((st) => st.do === "out-of-band" && st.command.includes("approve")).map((st) => (st.do === "out-of-band" ? st.command.at(-1) : ""));
      expect(approvals).toEqual(["dev", "prod"]);
      expect(s?.steps.some((st) => st.do === "approve")).toBe(false);
    }
  });

  it("lists each scenario as a pending citation of its claim on docs/claims.md", () => {
    const pending = readPendingCitations(proofsPath, names);
    expect(pending.map((p) => `${p.scenario}:${p.claim}`).sort()).toEqual(all.map((s) => `${s.id}:${s.claim}`).sort());
    expect(readFileSync(join(proofsPath, "..", "..", "docs", "claims.md"), "utf8")).toContain("`sy-forge-postgres`");
  });
});

describe("the scenario lint", () => {
  const good = (): Scenario => JSON.parse(JSON.stringify(scenarios.get("sy-forge-postgres")?.scenario)) as Scenario;

  it("refuses a scenario with no BREAK=1", () => {
    const s = good();
    (s.break.env as Record<string, string>).BREAK = "0";
    expect(lintLocal(s, names).map((f) => f.at)).toContain("/break/env/BREAK");
  });

  it("refuses a claim the claims do not list, and another product", () => {
    const s = { ...good(), claim: "nonsense", product: "terragucci" };
    expect(lintLocal(s, names).map((f) => f.at).sort()).toEqual(["/claim", "/product"]);
  });

  it("refuses a step naming a pull request or a merge no earlier step made", () => {
    const s = good();
    s.steps = [{ id: "m", do: "merge", pull: "nope" }, { id: "a", do: "apply", merge: "nope", expect: [{ report: { status: "applied" } }] }];
    expect(lintLocal(s, names).map((f) => f.at)).toEqual(["/steps/0/pull", "/steps/1/merge"]);
  });

  it("refuses a scenario that expects nothing, and an outcome on the wrong step", () => {
    const s = good();
    s.steps = [{ id: "o", do: "open", branch: "b", overlay: "add-note", title: "t", expect: [{ exit: 0 }] }];
    expect(lintLocal(s, names).map((f) => f.message)).toEqual(["an exit outcome belongs on an out-of-band step"]);
    s.steps = [{ id: "o", do: "open", branch: "b", overlay: "add-note", title: "t" }];
    expect(lintLocal(s, names).map((f) => f.at)).toEqual(["/steps"]);
  });
});

describe("chant's harness", () => {
  it("lints every scenario file with chant's own lint", () => {
    for (const s of all) expect(harness.lintScenario(s), s.id).toEqual([]);
  });
});

describe("the commit scenarios' parts (#312)", () => {
  it("turns the path check off in the Forgejo push job only, with BREAK=1", async () => {
    const { breakPushJob } = await import("../scenarios/harness/seed.js");
    const yaml = ["on: issue_comment", "jobs:", "  yodel-new:", "    env:", "      CHANT_COMMIT_ON: comment", "    steps: []", "  yodel-new-push:", "    needs: yodel-new", "    env:", "      CHANT_COMMIT_ON: comment", "    steps: []", ""].join("\n");
    const broke = breakPushJob(yaml, "paths") ?? "";
    expect(broke.split("\n").slice(6, 12)).toEqual(["  yodel-new-push:", "    needs: yodel-new", "    env:", '      BREAK: "1"', '      CHANT_COMMIT_HARNESS_BREAK: "paths"', "      CHANT_COMMIT_ON: comment"]);
    expect(broke.split("\n").slice(0, 6)).toEqual(yaml.split("\n").slice(0, 6));
    const bare = ["jobs:", "  yodel-rebase-push:", "    needs: yodel-rebase", "    steps: []", ""].join("\n");
    expect(breakPushJob(bare, "moved-base")).toBe(["jobs:", "  yodel-rebase-push:", "    env:", '      BREAK: "1"', '      CHANT_COMMIT_HARNESS_BREAK: "moved-base"', "    needs: yodel-rebase", "    steps: []", ""].join("\n"));
    expect(breakPushJob("jobs:\n  lint:\n    steps: []\n", "paths")).toBeUndefined();
  });

  it("reads chant's reply to the newest /yodel comment", async () => {
    const { replyTo } = await import("../scenarios/harness/act.js");
    const c = (body: string) => ({ body });
    expect(replyTo([c("<!-- yodel:plan env=dev -->"), c("/yodel new"), c("yodel: pushed `abc` to `b`")])).toBe("yodel: pushed `abc` to `b`");
    expect(replyTo([c("/yodel new"), c("yodel: first"), c("/yodel new again"), c("<!-- yodel:plan -->")])).toBeUndefined();
    expect(replyTo([c("yodel: before anything was asked")])).toBeUndefined();
  });

  it("makes the legacy source: a table in the template's namespace, and sources.legacy in yodel.config.ts", async () => {
    const { legacyDdl, templateNamespace, withLegacySource } = await import("../scenarios/harness/overlays.js");
    expect(templateNamespace("CREATE SCHEMA app_1;\n", "pg")).toBe("app_1");
    expect(templateNamespace("CREATE DATABASE shop\n  ENGINE = Atomic", "ch")).toBe("shop");
    expect(legacyDdl("shop", "ch")).toBe("CREATE TABLE shop.legacy (id UInt64) ENGINE = MergeTree ORDER BY id;\n");
    expect(withLegacySource('export default {\n  ci: { forges: ["forgejo"] },\n};\n')).toBe('export default {\n  sources: { legacy: { file: "db/legacy.sql" } },\n  ci: { forges: ["forgejo"] },\n};\n');
  });
});
