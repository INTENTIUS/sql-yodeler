import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hold, runParts, type Claim, type Ctx } from "../lib/claim.js";
import { parse, Project } from "../lib/project.js";
import { addColumn, addTable, createTableByHand, mainTable, needsVersioned } from "../lib/schema.js";

/**
 * A pending migration applies only behind the migrations Op's gate: yodel
 * apply stops at the gate with the server untouched, `chant approve` with
 * the command it printed lets the next yodel apply run, and every history
 * row carries the digest that was approved.
 * BREAK: the approval is skipped, so the second apply stops at the gate too.
 */
export async function approvalPart(ctx: Ctx, p: Project): Promise<void> {
  const id = await p.newMigration("create");
  hold(id !== undefined, "yodel new wrote no migration for the fixture's schema");
  await p.commit("the first migration");
  await needsVersioned(p);
  const table = mainTable(ctx);

  const gated = await p.apply();
  hold(gated.ran.code === 3 && gated.doc.status === "gated", `yodel apply did not stop at the gate (exit ${String(gated.ran.code)}, status ${String(gated.doc.status)})`);
  hold(!(await ctx.db.tableExists(table)), `${ctx.db.name}.${table} exists before the approval`);

  if (!ctx.broken) await p.approve(gated.doc.approve);
  const applied = await p.apply();
  hold(applied.ran.code === 0, `yodel apply after the approval exited ${String(applied.ran.code)}, status ${String(applied.doc.status)}`);
  hold(await ctx.db.tableExists(table), `${ctx.db.name}.${table} is not on the server after the approved apply`);
  const digest = gated.doc.planDigest ?? "";
  const rows = await ctx.db.count(`SELECT count(*) FROM ${ctx.db.history}.history`);
  const other = await ctx.db.count(`SELECT count(*) FROM ${ctx.db.history}.history WHERE plan_digest <> '${digest}'`);
  hold(rows > 0 && other === 0, `the history holds ${String(rows)} rows, ${String(other)} not under the approved digest ${digest}`);
}

/**
 * Pre-migration checks (#52): a migration written with `yodel new --check`
 * that may run only while the main table is empty. The table is empty when
 * the plan is approved; a row arrives after. The Op's Apply step, handed the
 * approval, refuses under the lock (exit 4) naming the check, and the
 * history records the refusal; yodel apply then refuses before the gate.
 * The column never reaches the server.
 * BREAK: the check is removed and the checksum updated, so the migration
 * runs on data it should have refused.
 */
export async function preCheckPart(ctx: Ctx, p: Project): Promise<void> {
  // Under BREAK the approval part left the first migration pending.
  if ((await p.approvedApply()).ran.code !== 0) throw new Error("the first migration did not apply");
  const table = `${ctx.db.name}.${mainTable(ctx)}`;
  addColumn(p, "note");
  const id = await p.newMigration("add-note", ["--check", `table-empty: SELECT 1 FROM ${table} LIMIT 1`]);
  if (id === undefined) throw new Error("yodel new wrote no migration");
  const json = `migrations/${id}/migration.json`;
  if (!(p.read(json).includes('"table-empty"'))) throw new Error(`yodel new --check wrote no check into ${json}`);
  if (ctx.broken) {
    const doc = JSON.parse(p.read(json)) as Record<string, unknown>;
    delete doc.checks;
    p.write(json, `${JSON.stringify(doc, null, 2)}\n`);
    await p.yodel(["lint", "--update-checksum", id]);
  }
  await p.commit("add note, only while the table is empty");

  const gated = await p.apply();
  if (gated.ran.code !== 3) throw new Error(`yodel apply did not stop at the gate with the table empty (exit ${String(gated.ran.code)})`);
  await p.approve(gated.doc.approve);
  await ctx.db.exec(ctx.dialect === "ch" ? `INSERT INTO ${table} (id, kind, ts) VALUES (1, 'k', now())` : `INSERT INTO ${table} (amount) VALUES (1)`);

  const step = await p.yodel(["apply", p.env, "--execute"], { env: { YODEL_APPROVED_PLAN: gated.doc.planDigest } });
  hold(step.code === 4 && step.err.includes("check table-empty failed"), `the approved Apply step with a row in ${table} exited ${String(step.code)}, not 4 naming check table-empty: ${step.err.slice(-400)}`);
  const recorded = await ctx.db.count(`SELECT count(*) FROM ${ctx.db.history}.history WHERE migration_id = '${id}' AND status = 'failed' AND error LIKE '%check table-empty failed%'`);
  hold(recorded === 1, `the history records ${String(recorded)} refusals of ${id} by check table-empty`);
  const before = await p.apply();
  hold(before.ran.code === 4 && before.doc.status === "refused", `yodel apply with a row in ${table} exited ${String(before.ran.code)}, status ${String(before.doc.status)}, not refused before the gate`);
  hold(!(await ctx.db.columnExists(mainTable(ctx), "note")), `${table}.note is on the server: the migration ran on a table that was not empty`);

  // Leave the project with nothing pending for the next part: the table emptied, the migration applied.
  await ctx.db.exec(ctx.dialect === "ch" ? `TRUNCATE TABLE ${table}` : `DELETE FROM ${table}`);
  await p.setupApply();
}

/**
 * Policy over the plan (#53): yodel.config.ts refuses a drop in this
 * environment. A migration that drops a table is refused before the gate
 * (exit 4) naming the rule. An override recorded with yodel override counts
 * for exactly the plan digest it was recorded for: once the plan moves (a
 * table made by hand) the rule denies again; back on that digest the plan
 * applies, and the history records the override and its reason. The
 * policy is read at the base commit (#73): the change that adds the drop
 * also deletes the rule, and the drop is still denied.
 * BREAK: the policy is read from the change itself (YODEL_BASE=HEAD), where
 * the rule is gone, so the drop is not refused.
 */
export async function policyPart(ctx: Ctx, p: Project): Promise<void> {
  // A table to drop, applied first. Under BREAK an earlier part may have left migrations pending too.
  addTable(p, "scratch");
  if ((await p.newMigration("add-scratch")) === undefined) throw new Error("yodel new wrote no migration for the scratch table");
  await p.commit("a scratch table");
  await p.setupApply();
  // The branch's policy refuses drops here.
  p.write(
    "yodel.config.ts",
    `export default {\n  policy: {\n    overriders: ["alice"],\n    rules: [{ id: "no-drops", environments: [${JSON.stringify(p.env)}], refuse: { classes: ["drop"] } }],\n  },\n};\n`,
  );
  await p.commit("a policy that refuses drops");
  // The change: the drop, and the rule deleted with it.
  rmSync(p.path("src", "scratch.ts"));
  p.write("yodel.config.ts", "export default {};\n");
  const id = await p.newMigration("drop-scratch");
  if (id === undefined) throw new Error("yodel new wrote no migration for the drop");
  await p.commit("drop the scratch table, and delete the rule that refuses it");
  const gone = async () => !(await ctx.db.tableExists("scratch"));
  // Under BREAK, every apply reads the policy from the change.
  const base = ctx.broken ? { YODEL_BASE: "HEAD" } : {};

  const denied = await p.apply([], base);
  hold(denied.ran.code === 4 && denied.doc.status === "denied", `yodel apply of a drop under the no-drops rule exited ${String(denied.ran.code)}, status ${String(denied.doc.status)}, not denied`);
  hold(!(await gone()), "the dropped object is gone though the policy denied the plan");

  const over = await p.yodel(["override", p.env, "--rule", "no-drops", "--reason", "nothing reads it since TICKET-7", "--by", "alice"], { env: base });
  if (over.code !== 0) throw new Error(`yodel override exited ${String(over.code)}: ${over.err.slice(-400)}`);
  await createTableByHand(ctx, "extra");
  const moved = await p.apply([], base);
  hold(moved.ran.code === 4 && moved.doc.status === "denied", `yodel apply after the plan moved exited ${String(moved.ran.code)}, status ${String(moved.doc.status)}: an override counted for another digest`);
  await ctx.db.exec(`DROP TABLE ${ctx.db.name}.extra`);

  const applied = await p.approvedApply([], base);
  hold(applied.ran.code === 0, `yodel apply with the override for this digest exited ${String(applied.ran.code)}, status ${String(applied.doc.status)}`);
  hold(await gone(), "the dropped object is still there after the overridden apply");
  const recorded = await ctx.db.count(`SELECT count(*) FROM ${ctx.db.history}.history WHERE migration_id = '${id}' AND status = 'started' AND note LIKE '%no-drops%TICKET-7%'`);
  hold(recorded === 1, `the history records the override in ${String(recorded)} of ${id}'s started rows`);
}

/** The parts of `yodel report --json` the audit part reads. */
interface ReportDoc {
  audit: Array<{ kind: string; migration?: string; digest?: string; by?: string; source: { ledger?: string; op?: string; gate?: string } }>;
  gaps: Array<{ kind: string; detail: string }>;
  auditFile?: { missing: Array<{ kind: string; digest?: string }> };
}

/** Removes the approvals of `digest` from the gate's ledger file on the project's chant/lifecycle branch, as someone editing the branch would. */
async function removeApprovals(ctx: Ctx, p: Project, file: string, gate: string, digest: string): Promise<number> {
  const wt = join(ctx.work, "lifecycle");
  await p.git("worktree", "add", "-q", wt, "chant/lifecycle");
  try {
    const lines = readFileSync(join(wt, file), "utf8").split("\n");
    const kept = lines.filter((l) => {
      if (!l.trim()) return true;
      const r = JSON.parse(l) as { kind?: string; gate?: string; planDigest?: string };
      return !((r.kind ?? "resolution") === "resolution" && r.gate === gate && r.planDigest === digest);
    });
    writeFileSync(join(wt, file), kept.join("\n"));
    await p.git("-C", wt, "commit", "-qam", `remove the approval of ${digest}`);
    return lines.length - kept.length;
  } finally {
    await p.git("worktree", "remove", "--force", wt);
  }
}

/**
 * The audit log (#57): yodel report derives it from the history and chant's
 * gate ledger. After the parts above, each migration the history records
 * applied has an applied entry and an approved entry for the same digest,
 * there is no gap, and the audit.jsonl written then passes --check.
 * BREAK: the approval of the newest applied digest is removed from the
 * ledger before --check, which then names the missing entry and the
 * migration applied with no approval.
 */
export async function auditPart(ctx: Ctx, p: Project): Promise<void> {
  // A broken earlier part may have left migrations pending: the policy part's drop, which the base's policy still denies,
  // so the policy is read from the change (with nothing pending, as when every part held, this applies nothing).
  if ((await p.approvedApply([], { YODEL_BASE: "HEAD" })).ran.code !== 0) throw new Error("the earlier migrations did not apply");
  // Before the break: a failure here is not the break being caught.
  const must: (cond: boolean, what: string) => asserts cond = ctx.broken ? (cond, what) => { if (!cond) throw new Error(what); } : hold;
  const file = join(ctx.work, "audit.jsonl");
  const first = await p.yodel(["report", p.env, "--json", "--audit", file]);
  const doc = parse<ReportDoc>(first);
  must(first.code === 0 && doc.gaps.length === 0, `yodel report exited ${String(first.code)} with gaps: ${doc.gaps.map((g) => g.detail).join("; ")}`);
  const appliedIds = await ctx.db.count(`SELECT count(DISTINCT migration_id) FROM ${ctx.db.history}.history WHERE kind = 'migration' AND status = 'succeeded'`);
  const applied = doc.audit.filter((e) => e.kind === "applied");
  must(appliedIds > 0 && applied.length === appliedIds, `the audit log has ${String(applied.length)} applied entries; the history records ${String(appliedIds)} migrations applied`);
  for (const a of applied) {
    must(doc.audit.some((e) => e.kind === "approved" && e.digest === a.digest), `${String(a.migration)} was applied under ${String(a.digest)}, and the audit log has no approval of it`);
  }
  must(doc.audit.some((e) => e.kind === "approval-requested"), "the audit log has no approval-requested entry, though the apply stopped at the gate");
  must(readFileSync(file, "utf8").trim().split("\n").length === doc.audit.length, "audit.jsonl does not hold every entry yodel report printed");

  if (ctx.broken) {
    const newest = applied.at(-1);
    const approval = doc.audit.find((e) => e.kind === "approved" && e.digest === newest?.digest);
    if (!approval?.source.ledger || !approval.source.gate || !newest?.digest) throw new Error("no approval to remove");
    const removed = await removeApprovals(ctx, p, approval.source.ledger, approval.source.gate, newest.digest);
    if (removed === 0) throw new Error(`no approval line of ${newest.digest} in ${approval.source.ledger}`);
  }
  const check = await p.yodel(["report", p.env, "--json", "--audit", file, "--check"]);
  const checked = parse<ReportDoc>(check);
  const missing = checked.auditFile?.missing ?? [];
  hold(
    check.code === 0 && missing.length === 0 && checked.gaps.length === 0,
    `yodel report --check exited ${String(check.code)}: ${String(missing.length)} entries missing (${missing.map((m) => `${m.kind} ${m.digest ?? ""}`).join(", ")}); gaps: ${checked.gaps.map((g) => g.detail).join("; ")}`,
  );
}

/**
 * An approval binds the plan it was given for. A migration is approved,
 * then its migration.sql is edited by hand: yodel apply stops at the gate
 * again, the Op's Apply step handed the old approval refuses, and nothing
 * reaches the server or the history.
 * BREAK: the migration is not edited after the approval, so it applies.
 *
 * It leaves its migration pending, refused: a part added to this claim
 * goes before it.
 */
export async function digestMovedPart(ctx: Ctx, p: Project): Promise<void> {
  // Whatever the parts before left pending (under BREAK, the first migration) is applied first.
  if ((await p.approvedApply()).ran.code !== 0) throw new Error("the earlier migrations did not apply");
  addColumn(p, "memo");
  const id = await p.newMigration("add-memo");
  if (id === undefined) throw new Error("yodel new wrote no migration");
  await p.commit("add memo");

  const gated = await p.apply();
  if (gated.ran.code !== 3) throw new Error(`yodel apply did not stop at the gate (exit ${String(gated.ran.code)})`);
  await p.approve(gated.doc.approve);
  if (!ctx.broken) {
    const sql = `migrations/${id}/migration.sql`;
    if (ctx.dialect === "ch") p.edit(sql, "memo String DEFAULT ''", "memo String DEFAULT 'tampered'");
    else p.edit(sql, "memo text", "memo varchar(8)");
    await p.commit("an edit after the approval");
  }

  const again = await p.apply();
  hold(again.ran.code !== 0, "yodel apply ran a migration edited after its approval");
  const stale = await p.yodel(["apply", p.env, "--execute"], { env: { YODEL_APPROVED_PLAN: gated.doc.planDigest } });
  hold(stale.code !== 0, "the Apply step ran with an approval given before the migration was edited");
  hold(!(await ctx.db.columnExists(mainTable(ctx), "memo")), `${ctx.db.name}.${mainTable(ctx)}.memo is on the server: the moved plan was applied`);
  hold((await ctx.db.count(`SELECT count(*) FROM ${ctx.db.history}.history WHERE migration_id = '${id}'`)) === 0, `the history records ${id}`);
}

/** The parts, in order, on one project. */
const parts = [
  ["approval", approvalPart],
  ["pre-check", preCheckPart],
  ["policy", policyPart],
  ["audit", auditPart],
  ["digest-moved", digestMovedPart],
] as const;

async function body(ctx: Ctx): Promise<void> {
  await runParts(ctx, await Project.create(ctx), parts);
}

export const approval: Claim = {
  name: "approval",
  says: "a pending migration applies only after chant approve of its plan digest, and the history records that digest; a failing pre-migration check refuses it, and so does a policy rule, read at the base commit, unless an override is recorded for that digest; the audit log derived from the history and the ledger accounts for every approval and apply, and names one removed; an approval is refused once the migration changed after it, and nothing is applied",
  dialects: { ch: body, pg: body },
  parts: parts.map(([name]) => name),
};
