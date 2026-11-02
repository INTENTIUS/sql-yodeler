/**
 * The digest the approval claim's pr-comment member and the harness's report
 * bucket read from a plan comment (scenarios/lib/note.ts): chant's note's
 * `Plan digest:` line once chant's note fits yodel (#290, as it does from
 * chant 0.124.67), yodel's own `Plan digest the apply gate binds:` line
 * before. The claim read only yodel's line, so with chant's note it found no
 * digest and failed plain on Postgres.
 */

import { describe, expect, it } from "vitest";
import { commentDigest } from "../scenarios/lib/note.js";
import { readPlanComment } from "../scenarios/harness/reports.js";
import { chantNote, renderPlanNote } from "../src/pr/note.js";
import { renderPlanMarkdown } from "../src/pr/render.js";
import type { VersionedPlan } from "../src/pr/model.js";
import { repoRoot } from "./helpers/run.js";

const DIGEST = `jcs1-sha256:${"cd".repeat(32)}`;
const OLD = `jcs1-sha256:${"ef".repeat(32)}`;

function plan(over: Partial<VersionedPlan> = {}): VersionedPlan {
  return {
    environment: "approval",
    dialect: "postgres",
    history: "app_history.history",
    appliedCount: 1,
    notes: [],
    problems: [],
    digest: DIGEST,
    pending: [
      {
        id: "20261102T2112-note-and-audit",
        outOfOrder: false,
        steps: [{ index: 0, done: false, step: { kind: "statement", object: "app.orders", name: "app.orders.note", rule: "SQLPG201", class: "metadata", sql: "ALTER TABLE app.orders ADD COLUMN note text", destructive: false } as never }],
      },
    ],
    approval: { kind: "op", op: "migrate-approval", gate: "approve-migrate-approval", latest: { digest: OLD, sameDigest: false, holds: false, by: "alex" } as never },
    ...over,
  };
}

describe("the digest a plan comment gives", () => {
  it("is read from chant's line and from yodel's own", () => {
    expect(commentDigest(`### yodel plan for \`dev\`\n\nPlan digest: \`${DIGEST}\`\n`)).toBe(DIGEST);
    expect(commentDigest(`#### Approval\n\nPlan digest the apply gate binds: \`${DIGEST}\`\n`)).toBe(DIGEST);
  });

  it("is not the wave's digest outside the pipeline, an approval that stands for another digest, or a digest mid-line", () => {
    expect(commentDigest(`Plan digest \`yodel apply dev\` binds, outside the pipeline: \`${DIGEST}\``)).toBeUndefined();
    expect(commentDigest(`An approval stands for \`${OLD}\`, not for this digest: the plan changed since it was approved.`)).toBeUndefined();
    expect(commentDigest(`see Plan digest: \`${DIGEST}\``)).toBeUndefined();
    expect(commentDigest("Plan digest: `jcs1-sha256:short`")).toBeUndefined();
  });

  it("is the gate's digest in the note yodel posts with the installed chant, not the one an older approval stands for", async () => {
    const body = (await renderPlanNote(plan(), { dir: repoRoot })) ?? renderPlanMarkdown(plan());
    if (await chantNote()) expect(body).toContain(`Plan digest: \`${DIGEST}\``);
    expect(commentDigest(body)).toBe(DIGEST);
    expect(body).toContain(`yodel approve approval --plan ${DIGEST}`);
  });

  it("is the gate's digest in yodel's own note too", () => {
    expect(commentDigest(renderPlanMarkdown(plan()))).toBe(DIGEST);
  });

  it("is what the harness's report bucket reads from chant's note", () => {
    expect(readPlanComment(`<!-- yodel:plan env=dev -->\n\nPlan digest: \`${DIGEST}\`\n\n\`\`\`\nyodel approve dev --plan ${DIGEST} --sign\n\`\`\`\n`)).toEqual({ digest: DIGEST, op: "yodel-apply", gate: "yodel-apply-wave-1" });
  });
});
