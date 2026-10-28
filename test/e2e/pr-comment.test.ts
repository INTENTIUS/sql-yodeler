/**
 * #16 end to end against the emulator's ClickHouse: the pull request comment
 * carries the digest the migrations Op's gate asks for; `chant approve`
 * with that digest lets the apply after merge run; and when the plan moved
 * after approval (a migration added), the apply applies nothing and
 * `yodel plan` says what moved. Objects in database <prefix>_pr_comment, the
 * history in <prefix>_pr_comment_history (./names.ts). The comment goes to a local GitHub-shaped fake.
 *
 * The first case is retired on a chant with the e2e harness
 * (./harness-fallback.ts): the sy-approval and sy-forge scenarios show it
 * on the harness's Forgejo then. The other two are yodel plan's own output
 * and run on every chant.
 */

import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runChant } from "../../src/chant/process.js";
import type { BuildOutput } from "../../src/chant/build.js";
import { createMigration, readMigrations, writeMigration } from "../../src/migrations/index.js";
import { json, yodel } from "../helpers/run.js";
import { clickhouse, clickhouseReachable } from "./emulator.js";
import { harnessCovers } from "./harness-fallback.js";
import { e2eProject, suiteName } from "./names.js";

const DB = suiteName("pr_comment");
const HISTORY = `${DB}_history`;

const build = (columns: string): BuildOutput => ({
  dialect: "clickhouse",
  objects: [
    { export: "db", type: "ClickHouse::Database", ddl: `CREATE DATABASE ${DB} ENGINE = Atomic`, dependsOn: [] },
    { export: "a", type: "ClickHouse::Table", ddl: `CREATE TABLE ${DB}.a (${columns}) ENGINE = MergeTree ORDER BY id`, dependsOn: ["db"] },
  ],
});

interface PlanDoc {
  planDigest?: string;
  approve?: string;
  pending: Array<{ id: string; steps: Array<{ kind: string; rule?: string; class?: string }> }>;
  approval?: { holds: boolean; digest: string; moved?: { confirmed: boolean; changes: Array<{ part: string; message: string }> } };
}

describe.skipIf(!clickhouseReachable)("the pull request comment and the digest on clickhouse", () => {
  let dir = "";
  let dispose = (): void => undefined;
  const saved = process.env.YODEL_HISTORY_DATABASE;
  const at = (...args: string[]) => [...args, "--dir", dir];
  const migrations = () => join(dir, "migrations");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  let minute = 0;
  const next = (name: string, columns: string) => {
    const made = createMigration({ name, build: build(columns), previous: readMigrations(migrations()).at(-1), now: new Date(Date.UTC(2026, 9, 9, 10, minute++)) });
    if (!made.id) throw new Error(`no change for ${name}`);
    writeMigration(migrations(), made);
    git("add", "-A");
    git("commit", "-q", "-m", `migration ${name}`);
    return made.id;
  };

  // A GitHub-shaped fake for PR #16 of acme/db.
  let server: Server;
  let api = "";
  const comments: Array<{ id: number; body: string }> = [];

  beforeAll(async () => {
    process.env.YODEL_HISTORY_DATABASE = HISTORY;
    process.env.YODEL_E2E_PR_TOKEN = "fake-token";
    await clickhouse(`DROP DATABASE IF EXISTS ${DB}`);
    await clickhouse(`DROP DATABASE IF EXISTS ${HISTORY}`);
    ({ dir, dispose } = e2eProject("clickhouse-pr", DB));
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += String(c)));
      req.on("end", () => {
        const send = (s: number, v: unknown) => {
          res.writeHead(s, { "Content-Type": "application/json" });
          res.end(JSON.stringify(v));
        };
        if (req.headers.authorization !== "Bearer fake-token") { send(401, {}); return; }
        const path = (req.url ?? "").split("?")[0];
        if (path === "/repos/acme/db/issues/16/comments" && req.method === "GET") { send(200, comments); return; }
        if (path === "/repos/acme/db/issues/16/comments" && req.method === "POST") {
          const c = { id: comments.length + 1, body: (JSON.parse(body) as { body: string }).body };
          comments.push(c);
          send(201, c); return;
        }
        const m = /^\/repos\/acme\/db\/issues\/comments\/(\d+)$/.exec(path ?? "");
        const c = m ? comments.find((x) => x.id === Number(m[1])) : undefined;
        if (c && req.method === "PATCH") {
          c.body = (JSON.parse(body) as { body: string }).body;
          send(200, c); return;
        }
        send(404, {});
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    api = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });
  afterAll(async () => {
    server.close();
    dispose();
    delete process.env.YODEL_E2E_PR_TOKEN;
    if (saved === undefined) delete process.env.YODEL_HISTORY_DATABASE;
    else process.env.YODEL_HISTORY_DATABASE = saved;
    await clickhouse(`DROP DATABASE IF EXISTS ${DB}`);
    await clickhouse(`DROP DATABASE IF EXISTS ${HISTORY}`);
  });

  const comment = (...extra: string[]) => yodel(at("plan", "e2e", "--comment", "--forge", "github", "--repo", "acme/db", "--pr", "16", "--api-url", api, "--token-env", "YODEL_E2E_PR_TOKEN", ...extra));
  const plan = async () => {
    const ran = await yodel(at("plan", "e2e", "--json"));
    expect(ran.code, ran.err).toBe(0);
    return json(ran) as PlanDoc;
  };
  const approve = async (command: string) => {
    const ran = await runChant(command.split(" ").slice(1), { cwd: dir });
    expect(ran.code, `${ran.stdout}\n${ran.stderr}`).toBe(0);
  };

  it.skipIf(harnessCovers)("posts the digest the gate asks for; approving it lets the apply after merge run", async () => {
    const one = next("one", "id UInt64");

    const posted = await comment();
    expect(posted.code, posted.err).toBe(0);
    expect(posted.err).toContain("created the plan comment on github acme/db#16");
    expect(comments).toHaveLength(1);
    const body = comments[0]?.body ?? "";
    expect(body.startsWith("<!-- yodel:plan env=e2e -->")).toBe(true);
    expect(body).toContain(`#### \`${one}\``);
    expect(body).toMatch(new RegExp(`\\| 0 \\| statement \\| SQLCH\\d+ \\| \\w+ \\| \`${DB}\` \\|`));
    const digest = /Plan digest the apply gate binds: `(jcs1-sha256:[0-9a-f]{64})`/.exec(body)?.[1];
    const command = /```sh\n(chant approve migrate-e2e approve-migrate-e2e --plan jcs1-sha256:[0-9a-f]{64})\n```/.exec(body)?.[1];
    expect(command).toBe(`chant approve migrate-e2e approve-migrate-e2e --plan ${String(digest)}`);

    // The digest the Op's Plan step prints, which its gate binds, is the comment's.
    const step = await yodel(at("apply", "e2e", "--digest"));
    expect(step.out.trim()).toBe(digest);

    // Approve from the comment alone, with no run having reached the gate.
    await approve(command ?? "");
    const shown = await plan();
    expect(shown.approval).toMatchObject({ holds: true, digest });

    // "After merge": the apply runs through the gate.
    const applied = await yodel(at("apply", "e2e", "--json"));
    expect(applied.code, applied.err).toBe(0);
    expect((json(applied) as { status: string }).status).toBe("applied");
    expect(Number((await clickhouse(`EXISTS TABLE ${DB}.a`)).trim())).toBe(1);

    // The comment updates in place: one comment, nothing pending now.
    const again = await comment();
    expect(again.err).toContain("updated the plan comment");
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("Nothing pending");
  }, 300_000);

  it("a different digest at merge applies nothing, and says what moved", async () => {
    next("two", "id UInt64, y String DEFAULT ''");
    const posted = await comment();
    expect(posted.code, posted.err).toBe(0);
    const approvedPlan = await plan();
    await approve(approvedPlan.approve ?? "");

    // A migration lands after the approval, before the apply runs.
    const three = next("three", "id UInt64, y String DEFAULT '', z UInt8 DEFAULT 0");

    const applied = await yodel(at("apply", "e2e", "--json"));
    expect(applied.code, applied.err).toBe(3);
    const doc = json(applied) as { status: string; gatePlanDigest?: string };
    expect(doc.status).toBe("gated");
    expect(doc.gatePlanDigest).not.toBe(approvedPlan.planDigest);

    // The Apply step itself, handed the approved digest, refuses under the lock and says what moved.
    process.env.YODEL_APPROVED_PLAN = approvedPlan.planDigest;
    try {
      const stale = await yodel(at("apply", "e2e", "--execute"));
      expect(stale.code).toBe(1);
      expect(stale.err).toContain(`the plan moved since it was approved (approved ${String(approvedPlan.planDigest)}`);
      expect(stale.err).toContain(`pending migrations changed: new pending migration: ${three}. Nothing was applied`);
    } finally {
      delete process.env.YODEL_APPROVED_PLAN;
    }
    expect(Number((await clickhouse(`SELECT count() FROM system.columns WHERE database = '${DB}' AND table = 'a' AND name = 'y'`)).trim())).toBe(0);
    expect(Number((await clickhouse(`SELECT count() FROM ${HISTORY}.history WHERE migration_id != '${String(readMigrations(migrations())[0]?.id)}'`)).trim())).toBe(0);

    // What moved: plan names it, confirmed against the approved digest.
    const now = await plan();
    expect(now.approval).toMatchObject({ holds: false, digest: approvedPlan.planDigest, moved: { confirmed: true, changes: [{ part: "pending", message: `new pending migration: ${three}` }] } });
    const text = await yodel(at("plan", "e2e"));
    expect(text.out).toContain(`What moved: pending migrations changed: new pending migration: ${three}.`);

    // And the comment, updated, says it too.
    await comment();
    expect(comments[0]?.body).toContain(`new pending migration: ${three}`);
  }, 300_000);

  it("says the live schema moved when a table changed after approval", async () => {
    const posted = await comment();
    expect(posted.code, posted.err).toBe(0);
    const approvedPlan = await plan();
    await approve(approvedPlan.approve ?? "");
    await clickhouse(`CREATE TABLE ${DB}.handmade (x UInt8) ENGINE = MergeTree ORDER BY x`);
    const applied = await yodel(at("apply", "e2e", "--json"));
    expect(applied.code, applied.err).toBe(3);
    expect(Number((await clickhouse(`SELECT count() FROM system.columns WHERE database = '${DB}' AND table = 'a' AND name = 'y'`)).trim())).toBe(0);

    // Without the comment, yodel rebuilds what it can and concludes the live schema moved.
    const now = await plan();
    expect(now.approval?.moved?.confirmed).toBe(false);
    expect(now.approval?.moved?.changes.at(-1)?.part).toBe("live");

    // The comment carried the approved plan's subject, so the updated comment says it exactly.
    const updated = await comment("--format", "json");
    const doc = json(updated) as PlanDoc;
    expect(doc.approval?.moved).toEqual({ confirmed: true, changes: [{ part: "live", message: expect.stringContaining("not as it was") as unknown }] });
    expect(comments[0]?.body).toContain("What moved: live schema changed:");
    await clickhouse(`DROP TABLE ${DB}.handmade`);
  }, 300_000);
});
