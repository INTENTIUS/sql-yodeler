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
import { chantNote, chantRenderer, planDetailLines, renderPlanNote, renderTenantSetNote, tenantSetNoteFits, type ChantNote } from "../src/pr/note.js";
import { commentMarker, renderPlanMarkdown } from "../src/pr/render.js";
import type { VersionedPlan } from "../src/pr/model.js";
import { renderTenantSetMarkdown, type TenantSetPlan } from "../src/pr/tenants.js";
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

  it("carries a tenant set only when its approve line names the set once, not each tenant", async () => {
    const body = await renderTenantSetNote(tenantSet(), { dir: repoRoot, ...(renderer ? { note: renderer } : {}) });
    if (renderer && tenantSetNoteFits(renderer)) {
      expect(body).toContain("yodel approve prod --plan jcs1-sha256:set");
      expect(body).not.toContain("yodel approve prod/");
    } else {
      expect(body).toBeUndefined();
    }
  });

  it("gives yodel plan <set> --format markdown one comment naming every tenant and the one digest the wave waits on (the waves claim's tenants part)", async () => {
    const set = tenantSet();
    // What src/commands/plan.ts prints for --format markdown.
    const body = (await renderTenantSetNote(set, { dir: repoRoot })) ?? renderTenantSetMarkdown(set);
    for (const t of ["acme", "globex"]) expect(body).toContain(`\`${t}\``);
    expect(/one approval of `(jcs1-[^`]+)`/.exec(body)?.[1]).toBe("jcs1-sha256:set");
    expect(body).not.toMatch(/yodel approve prod\/\S+ --plan/);
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

/** A tenant set of two, its wave waiting for one approval of the set digest. */
function tenantSet(): TenantSetPlan {
  return {
    environment: "prod",
    dialect: "postgres",
    tenants: [plan("prod/acme", { approval: undefined }), plan("prod/globex", { approval: undefined })],
    wave: { wave: 2, gate: "always", base: "0123456789abcdef", baseSource: "first-parent", runs: [], refused: [], blocked: [], waits: true, digest: "jcs1-sha256:set", approve: "yodel approve prod --plan jcs1-sha256:set", chantApprove: "chant approve yodel-apply yodel-apply-wave-2 --plan jcs1-sha256:set" },
    notes: [],
  };
}

/**
 * A stand-in for chant's renderer: a table row per member, the approve lines
 * for the report's approveTargets when `readsTargets`, else one per member
 * (chant 0.124.67's prApproveTargets), then each detail section.
 */
function fakeNote(readsTargets: boolean): ChantNote {
  return {
    product: {} as never,
    words: {},
    composeChangeSet: () => ({ members: [], summary: { byMember: {} } }),
    renderPrNote: (r) => {
      const report = r as { env: string; digest: string; members: Array<{ member: string }>; approveTargets?: string[]; details: Array<{ member: string; title?: string; lines: string[] }> };
      const targets = readsTargets && report.approveTargets ? report.approveTargets : report.members.map((m) => m.member);
      return [
        `### yodel plan for \`${report.env}\``,
        ...report.members.map((m) => `| \`${m.member}\` |`),
        "```",
        ...targets.map((t) => `yodel approve ${t} --plan ${report.digest} --sign`),
        "```",
        ...report.details.flatMap((d) => [`<details><summary>${d.title ?? d.member}</summary>`, ...d.lines, "</details>"]),
      ].join("\n");
    },
  };
}

describe("a tenant set's note (#56, #290)", () => {
  it("is yodel's own while chant's would ask for an approval per tenant", async () => {
    const note = fakeNote(false);
    expect(tenantSetNoteFits(note)).toBe(false);
    expect(await renderTenantSetNote(tenantSet(), { dir: repoRoot, note })).toBeUndefined();
  });

  it("goes through chant once chant names the set in one approve line, with every tenant by name and the wave's one approval", async () => {
    const note = fakeNote(true);
    expect(tenantSetNoteFits(note)).toBe(true);
    const body = (await renderTenantSetNote(tenantSet(), { dir: repoRoot, note })) ?? "";
    expect(body.split("\n")[0]).toBe(commentMarker("prod"));
    expect(body.match(/^yodel approve .*$/gm)).toEqual(["yodel approve prod --plan jcs1-sha256:set --sign"]);
    expect(body).toContain("<details><summary>The tenant set `prod`</summary>");
    expect(body).toContain("- 1 pending: `acme`, `globex`");
    expect(body).toContain("one approval of `jcs1-sha256:set`, for all 2 tenants");
    expect(body).toContain("npx yodel approve prod --plan jcs1-sha256:set");
    expect(body).toContain("| `prod/acme` |");
  });
});

describe("the note on a chant without a renderer that fits (#290)", () => {
  it("is yodel's own note", async () => {
    if (await chantNote()) return;
    expect(await renderPlanNote(plan(), { dir: repoRoot })).toBeUndefined();
  });
});
