/**
 * The plan note through chant's note renderer (#290): chant's layout in
 * yodel's words, the SQL rows in the member detail section, yodel's marker
 * on the first line so an open pull request keeps one note, and yodel's own
 * note while the installed chant's does not fit (no renderer, or an approve
 * line without the environment).
 *
 * The cases that read chant's layout skip on a chant without
 * `@intentius/chant/ci-product`.
 */

import { describe, expect, it } from "vitest";
import { chantNote, chantRenderer, planDetailLines, renderPlanNote, renderTenantSetNote } from "../src/pr/note.js";
import { commentMarker, renderPlanMarkdown } from "../src/pr/render.js";
import type { VersionedPlan } from "../src/pr/model.js";
import type { TenantSetPlan } from "../src/pr/tenants.js";
import { repoRoot } from "./helpers/run.js";

const renderer = await chantRenderer();

function plan(env = "prod", over: Partial<VersionedPlan> = {}): VersionedPlan {
  return {
    environment: env,
    dialect: "postgres",
    history: "app_history.history",
    appliedCount: 3,
    notes: [],
    problems: [],
    digest: "jcs1-sha256:abc",
    pending: [
      {
        id: "20261027_add_col",
        outOfOrder: false,
        steps: [{ index: 0, done: false, step: { kind: "statement", object: "app.users", name: "app.users.email", rule: "add-column", class: "safe", sql: "ALTER TABLE app.users ADD COLUMN email text", destructive: false } as never }],
      },
    ],
    approval: { kind: "op", op: "migrate-prod", gate: "approve-migrate-prod" },
    policy: [{ id: "no-drops", outcome: "denied", reasons: ["drops a column"] } as never],
    ...over,
  };
}

describe("the SQL detail section (#290)", () => {
  it("carries each statement with its rule and class, the policy outcome with its override line, and no marker or heading", () => {
    const lines = planDetailLines(plan(), true).join("\n");
    expect(lines).toContain("| 0 | statement | add-column | safe | `app.users.email` |");
    expect(lines).toContain("#### Policy");
    expect(lines).toContain("**denied**");
    expect(lines).toContain("yodel override prod --rule no-drops");
    expect(lines).not.toContain(commentMarker("prod"));
    expect(lines).not.toContain("### yodel plan");
  });

  it("leaves the statements out on request, and says so", () => {
    const lines = planDetailLines(plan(), false).join("\n");
    expect(lines).not.toContain("ALTER TABLE");
    expect(lines).toContain("The statements are left out");
  });
});

describe.skipIf(!renderer)("the note through chant (#290)", () => {
  it("is chant's layout in yodel's words, yodel's marker first, the SQL rows in a detail section", async () => {
    const body = (await renderPlanNote(plan(), { dir: repoRoot, ...(renderer ? { note: renderer } : {}) })) ?? "";
    expect(body.split("\n")[0]).toBe(commentMarker("prod"));
    expect(body).toContain("### yodel plan for `prod`");
    expect(body).toContain("| `prod` |");
    expect(body).toContain("Plan digest: `jcs1-sha256:abc`");
    expect(body).toContain("<details><summary>The SQL plan for `prod`</summary>");
    expect(body).toContain("| 0 | statement | add-column | safe | `app.users.email` |");
    expect(body).toContain("**denied**");
  });

  it("keeps the digest's subject at the end, hidden, so the next note can say what moved", async () => {
    const body = (await renderPlanNote(plan("prod", { subject: { migrations: [] } as never }), { dir: repoRoot, ...(renderer ? { note: renderer } : {}) })) ?? "";
    expect(body.trimEnd().split("\n").at(-1)).toMatch(/^<!-- yodel:subject [A-Za-z0-9_-]+ -->$/);
  });

  it("renders a tenant set on the same path: a row per tenant, a section per tenant", async () => {
    const set: TenantSetPlan = { environment: "prod", dialect: "postgres", tenants: [plan("prod/acme"), plan("prod/globex")], notes: [] };
    const body = (await renderTenantSetNote(set, { dir: repoRoot, ...(renderer ? { note: renderer } : {}) })) ?? "";
    expect(body.split("\n")[0]).toBe(commentMarker("prod"));
    expect(body).toContain("| `prod/acme` |");
    expect(body).toContain("| `prod/globex` |");
  });

  it("is used for --comment only when chant's approve line names the environment and does not send a per-wave merge to a release", async () => {
    const fits = await chantNote();
    const body = (await renderPlanNote(plan(), { dir: repoRoot })) ?? renderPlanMarkdown(plan());
    if (fits) {
      expect(body).toContain("yodel approve prod --plan");
      expect(body).not.toContain("a release deploys it");
    } else {
      expect(body).toBe(renderPlanMarkdown(plan()));
    }
  });
});

describe("the note on a chant without a renderer that fits (#290)", () => {
  it("is yodel's own note", async () => {
    if (await chantNote()) return;
    expect(await renderPlanNote(plan(), { dir: repoRoot })).toBeUndefined();
  });
});
