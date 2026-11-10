/**
 * #16 end to end against the emulator's ClickHouse: when the plan moved after
 * approval (a migration added), the apply applies nothing and `yodel plan`
 * says what moved. The note carrying the digest the gate asks for, and the
 * approval and apply after it, are the sy-approval and sy-forge scenarios on
 * chant's e2e harness (scenarios/harness/, #302). Objects in database <prefix>_pr_comment, the
 * history in <prefix>_pr_comment_history (./names.ts). `yodel plan --pr-note`
 * writes chant's plan note hand-off (sql-yodeler issue 345); chant's note job,
 * which posts it, compares its subject with the previous note's (chant issue
 * 4972), as `sinceLastLine` does here.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runChant } from "@intentius/chant/chant-install";
import { sinceLastLine, type PrPlanBodyHandoff } from "@intentius/chant/pr-plan-note";
import type { BuildOutput } from "../../src/chant/build.js";
import { createMigration, readMigrations, writeMigration } from "../../src/migrations/index.js";
import { SUBJECT_PART_WORDS } from "../../src/pr/note.js";
import { json, yodel } from "../helpers/run.js";
import { clickhouse, clickhouseReachable } from "./emulator.js";
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

describe.skipIf(!clickhouseReachable)("the pull request note and the digest on clickhouse", () => {
  let dir = "";
  let dispose = (): void => undefined;
  const saved = process.env.YODEL_HISTORY_DATABASE;
  const savedPr = process.env.PR_NUMBER;
  const notes = mkdtempSync(join(tmpdir(), "yodel-pr-note-"));
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

  beforeAll(async () => {
    process.env.YODEL_HISTORY_DATABASE = HISTORY;
    process.env.PR_NUMBER = "16";
    await clickhouse(`DROP DATABASE IF EXISTS ${DB}`);
    await clickhouse(`DROP DATABASE IF EXISTS ${HISTORY}`);
    ({ dir, dispose } = e2eProject("clickhouse-pr", DB));
  });
  afterAll(async () => {
    dispose();
    rmSync(notes, { recursive: true, force: true });
    if (savedPr === undefined) delete process.env.PR_NUMBER;
    else process.env.PR_NUMBER = savedPr;
    if (saved === undefined) delete process.env.YODEL_HISTORY_DATABASE;
    else process.env.YODEL_HISTORY_DATABASE = saved;
    await clickhouse(`DROP DATABASE IF EXISTS ${DB}`);
    await clickhouse(`DROP DATABASE IF EXISTS ${HISTORY}`);
  });

  /** `yodel plan e2e --pr-note`, as chant's plan job runs it, and the hand-off it wrote. */
  const note = async (): Promise<PrPlanBodyHandoff> => {
    const ran = await yodel(at("plan", "e2e", "--pr-note", notes));
    expect(ran.code, ran.err).toBe(0);
    return JSON.parse(readFileSync(join(notes, "pr-plan-note.json"), "utf8")) as PrPlanBodyHandoff;
  };
  const plan = async () => {
    const ran = await yodel(at("plan", "e2e", "--json"));
    expect(ran.code, ran.err).toBe(0);
    return json(ran) as PlanDoc;
  };
  const approve = async (command: string) => {
    const ran = await runChant(command.split(" ").slice(1), { cwd: dir, noColor: true, resolveFallback: true });
    expect(ran.code, `${ran.stdout}\n${ran.stderr}`).toBe(0);
  };

  it("a different digest at merge applies nothing, and says what moved", async () => {
    next("two", "id UInt64, y String DEFAULT ''");
    const first = await note();
    expect(first).toMatchObject({ kind: "plan-note-handoff", pr: 16, env: "yodel-pr", member: "e2e", marker: "env=e2e", state: "success" });
    const approvedPlan = await plan();
    expect(first.subject?.id).toBe(approvedPlan.planDigest);
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

    // And the next note says it too, in its body and from its subject.
    const second = await note();
    expect(second.body).toContain(`new pending migration: ${three}`);
    expect(first.subject && second.subject ? sinceLastLine(first.subject, second.subject, { subjectParts: SUBJECT_PART_WORDS }) : "").toContain(`${three} now pending`);
  }, 300_000);

  it("says the live schema moved when a table changed after approval", async () => {
    const before = await note();
    const approvedPlan = await plan();
    await approve(approvedPlan.approve ?? "");
    await clickhouse(`CREATE TABLE ${DB}.handmade (x UInt8) ENGINE = MergeTree ORDER BY x`);
    const applied = await yodel(at("apply", "e2e", "--json"));
    expect(applied.code, applied.err).toBe(3);
    expect(Number((await clickhouse(`SELECT count() FROM system.columns WHERE database = '${DB}' AND table = 'a' AND name = 'y'`)).trim())).toBe(0);

    // yodel rebuilds what it can and concludes the live schema moved.
    const now = await plan();
    expect(now.approval?.moved?.confirmed).toBe(false);
    expect(now.approval?.moved?.changes.at(-1)?.part).toBe("live");

    // The previous note kept the approved plan's subject, so chant's note job says exactly that the live schema changed.
    const after = await note();
    expect(before.subject && after.subject ? sinceLastLine(before.subject, after.subject, { subjectParts: SUBJECT_PART_WORDS }) : "").toContain("the live schema changed");
    await clickhouse(`DROP TABLE ${DB}.handmade`);
  }, 300_000);
});
