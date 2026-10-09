import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { hold, type Claim, type Ctx } from "../lib/claim.js";
import { Project } from "../lib/project.js";
import { addColumn, addTable, mainTable } from "../lib/schema.js";

/** A GitHub-shaped fake holding the comments of acme/db#34. */
async function fakeGitHub(): Promise<{ api: string; comments: Array<{ id: number; body: string }>; close: () => void }> {
  const comments: Array<{ id: number; body: string }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += String(c)));
    req.on("end", () => {
      const send = (s: number, v: unknown) => {
        res.writeHead(s, { "Content-Type": "application/json" });
        res.end(JSON.stringify(v));
      };
      if (req.headers.authorization !== "Bearer fake-token") { send(401, {}); return; }
      const path = (req.url ?? "").split("?")[0] ?? "";
      if (path === "/repos/acme/db/issues/34/comments" && req.method === "GET") { send(200, comments); return; }
      if (path === "/repos/acme/db/issues/34/comments" && req.method === "POST") {
        const c = { id: comments.length + 1, body: (JSON.parse(body) as { body: string }).body };
        comments.push(c);
        send(201, c); return;
      }
      const m = /^\/repos\/acme\/db\/issues\/comments\/(\d+)$/.exec(path);
      const c = m ? comments.find((x) => x.id === Number(m[1])) : undefined;
      if (c && req.method === "PATCH") {
        c.body = (JSON.parse(body) as { body: string }).body;
        send(200, c); return;
      }
      send(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { api: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, comments, close: () => server.close() };
}

/**
 * The pull request comment lists each pending migration with every
 * statement's rule and class, and the digest it gives is the one the
 * migrations Op's gate asks for; posting it applies nothing.
 * BREAK: another migration lands after the comment was posted, so the
 * comment no longer shows what the gate asks to approve.
 */
async function body(ctx: Ctx): Promise<void> {
  const p = await Project.create(ctx);
  await p.newMigration("create");
  if ((await p.approvedApply()).ran.code !== 0) throw new Error("the first migration did not apply");
  addColumn(p, "note");
  addTable(p, "audit");
  const id = await p.newMigration("note-and-audit");
  if (id === undefined) throw new Error("yodel new wrote no migration");
  await p.commit("note and audit");

  const gh = await fakeGitHub();
  try {
    const posted = await p.yodel(["plan", p.env, "--comment", "--forge", "github", "--repo", "acme/db", "--pr", "34", "--api-url", gh.api, "--token-env", "YODEL_34_TOKEN"], {
      env: { YODEL_34_TOKEN: "fake-token" },
    });
    hold(posted.code === 0 && gh.comments.length === 1, `yodel plan --comment exited ${String(posted.code)} and posted ${String(gh.comments.length)} comments`);
    if (ctx.broken) {
      addTable(p, "late");
      await p.newMigration("late");
      await p.commit("late");
    }
    const body = gh.comments[0]?.body ?? "";
    hold(body.startsWith(`<!-- yodel:plan env=${p.env} -->`), "the comment does not start with its marker");
    hold(body.includes(id), `the comment does not list ${id}`);
    const steps = p.migration(id).steps;
    steps.forEach((s, i) => {
      if (s.kind !== "statement") return;
      hold(body.includes(`| ${String(i)} | statement | ${String(s.rule)} | ${String(s.class)} |`), `the comment has no row for statement ${String(i)} (${String(s.rule)}, ${String(s.class)})`);
    });
    const digest = /Plan digest the apply gate binds: `(jcs1-sha256:[0-9a-f]{64})`/.exec(body)?.[1];
    hold(digest !== undefined, "the comment gives no plan digest");
    hold(body.includes(`chant approve migrate-${p.env} approve-migrate-${p.env} --plan ${digest}`), "the comment gives no chant approve command for its digest");
    const gate = await p.apply();
    hold(gate.ran.code === 3 && gate.doc.planDigest === digest, `the gate asks for ${String(gate.doc.planDigest)}, the comment shows ${digest}`);
    hold(!(await ctx.db.columnExists(mainTable(ctx), "note")) && !(await ctx.db.tableExists("audit")), "planning and commenting changed the server");
  } finally {
    gh.close();
  }
}

export const prComment: Claim = {
  name: "pr-comment",
  says: "the pull request comment lists the pending migrations with each statement's class, and the digest the gate asks for",
  dialects: { ch: body, pg: body },
};
