import { hold, type Claim, type Ctx } from "../../lib/claim.js";
import { Project } from "../../lib/project.js";
import { addColumn, addTable, mainTable } from "../../lib/schema.js";

/**
 * The pull request comment lists each pending migration with every
 * statement's rule and class, and the digest it gives is the one the
 * migrations Op's gate asks for; planning it applies nothing. The body is
 * yodel's (`yodel plan --format markdown` is what --comment posts);
 * posting it on a forge is chant's pr-forge, tested in chant.
 * BREAK: another migration lands after the comment was posted, so the
 * comment no longer shows what the gate asks to approve.
 */
async function body(ctx: Ctx): Promise<void> {
  const p = await Project.create(ctx);
  await p.newMigration("create");
  await p.setupApply();
  addColumn(p, "note");
  addTable(p, "audit");
  const id = await p.newMigration("note-and-audit");
  if (id === undefined) throw new Error("yodel new wrote no migration");
  await p.commit("note and audit");

  const planned = await p.yodel(["plan", p.env, "--format", "markdown"]);
  hold(planned.code === 0, `yodel plan --format markdown exited ${String(planned.code)}: ${planned.err}`);
  if (ctx.broken) {
    addTable(p, "late");
    await p.newMigration("late");
    await p.commit("late");
  }
  const body = planned.out;
  hold(body.startsWith(`<!-- yodel:plan env=${p.env} -->`), "the comment does not start with its marker");
  hold(body.includes(id), `the comment does not list ${id}`);
  const steps = p.migration(id).steps;
  steps.forEach((s, i) => {
    if (s.kind !== "statement") return;
    hold(body.includes(`| ${String(i)} | statement | ${String(s.rule)} | ${String(s.class)} |`), `the comment has no row for statement ${String(i)} (${String(s.rule)}, ${String(s.class)})`);
  });
  const digest = /Plan digest the apply gate binds: `(jcs1-sha256:[0-9a-f]{64})`/.exec(body)?.[1];
  hold(digest !== undefined, "the comment gives no plan digest");
  hold(body.includes(`yodel approve ${p.env} --plan ${digest}`), "the comment gives no yodel approve command for its digest");
  const gate = await p.apply();
  hold(gate.ran.code === 3 && gate.doc.planDigest === digest, `the gate asks for ${String(gate.doc.planDigest)}, the comment shows ${digest}`);
  hold(!(await ctx.db.columnExists(mainTable(ctx), "note")) && !(await ctx.db.tableExists("audit")), "planning changed the server");
}

export const prComment: Claim = {
  name: "pr-comment",
  says: "the pull request comment lists the pending migrations with each statement's class, and the digest the gate asks for",
  // The comment is the same on both dialects.
  dialects: { pg: body },
};
