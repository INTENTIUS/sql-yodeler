import { copyFileSync, cpSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hold, runParts, Violation, type Claim, type Ctx } from "../../lib/claim.js";
import { parse, parseOr, Project } from "../../lib/project.js";
import { addColumn, addTable, mainTable, needsVersioned } from "../../lib/schema.js";

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
 * (exit 4) naming the rule. An override recorded with yodel override lets
 * the plan apply, and the history records the override and its reason.
 * Which overrides count (the digest, the rules, the overriders, spent once)
 * is chant's override gate, and its claims. The policy is read at the base
 * commit (#73): the change that adds the drop also deletes the rule, and
 * the drop is still denied.
 * BREAK: the policy is read from the change itself (YODEL_BASE=HEAD), where
 * the rule is gone, so the drop is not refused.
 */
async function policyOverApply(ctx: Ctx, p: Project): Promise<void> {
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

  const applied = await p.approvedApply([], base);
  hold(applied.ran.code === 0, `yodel apply with the override for this digest exited ${String(applied.ran.code)}, status ${String(applied.doc.status)}`);
  hold(await gone(), "the dropped object is still there after the overridden apply");
  const recorded = await ctx.db.count(`SELECT count(*) FROM ${ctx.db.history}.history WHERE migration_id = '${id}' AND status = 'started' AND note LIKE '%no-drops%TICKET-7%'`);
  hold(recorded === 1, `the history records the override in ${String(recorded)} of ${id}'s started rows`);
}

/** The rule the policy part's config declares: drops refused in this environment, a dropped column (destructive) too. */
const noDrops = (p: Project): string =>
  `export default {\n  policy: {\n    overriders: ["alice"],\n    rules: [{ id: "no-drops", environments: [${JSON.stringify(p.env)}], refuse: { classes: ["drop"], destructive: true } }],\n  },\n};\n`;

/**
 * Under BREAK, yodel with the policy over a revert taken out: the project's
 * yodel copied, its judgeRevert made to judge nothing, before the gate and
 * under the lock alike.
 */
function withoutRevertPolicy(ctx: Ctx, p: Project): string[] {
  const pkg = realpathSync(p.path("node_modules", "@intentius", "sql-yodeler"));
  const root = join(ctx.work, "yodel-without-revert-policy");
  mkdirSync(root, { recursive: true });
  cpSync(join(pkg, "dist"), join(root, "dist"), { recursive: true });
  copyFileSync(join(pkg, "package.json"), join(root, "package.json"));
  symlinkSync(p.path("node_modules"), join(root, "node_modules"));
  const file = join(root, "dist", "versioned", "policy.js");
  const text = readFileSync(file, "utf8");
  const patched = text.replace(/export async function judgeRevert\(input\) \{/, "$& return [];");
  if (patched === text) throw new Error(`judgeRevert is not in ${file}; the broken build cannot take it out`);
  writeFileSync(file, patched);
  ctx.log("BREAK: yodel built without the policy over a revert");
  return ["node", join(root, "dist", "bin.js")];
}

/**
 * Policy over a revert (#97): the base commit's policy refuses drops here.
 * A table is added and applied; yodel revert of that migration, which
 * drops the table, is denied before the gate (exit 4) naming the rule, and
 * the table stays. An override recorded with yodel override --revert for
 * the revert's digest lets it through the policy: the revert stops at the
 * gate, runs once approved, the table is gone, and the reverted row
 * records the override. The migration is then deleted, as after any revert.
 * BREAK: yodel is built without the policy over a revert, so the revert is
 * not denied and stops at the gate instead.
 */
async function policyOverRevert(ctx: Ctx, p: Project): Promise<void> {
  // Under BREAK the half before may have left the drop pending, which the base's policy (no rule) lets through.
  if ((await p.approvedApply([], { YODEL_BASE: "HEAD" })).ran.code !== 0) throw new Error("the earlier migrations did not apply");
  p.write("yodel.config.ts", noDrops(p));
  addTable(p, "undo_me");
  const id = await p.newMigration("add-undo-me");
  if (id === undefined) throw new Error("yodel new wrote no migration for the table");
  await p.commit("a table, and the rule that refuses drops again");
  await p.setupApply();
  // A commit on top, so the base (the first parent) is the one that has the rule.
  await p.git("commit", "-q", "--allow-empty", "-m", `revert ${id}`);
  const there = () => ctx.db.tableExists("undo_me");
  if (!(await there())) throw new Error("the table to revert is not on the server");
  const bin = ctx.broken ? { bin: withoutRevertPolicy(ctx, p) } : {};
  const revert = () => p.yodel(["revert", p.env, id, "--json"], { timeoutMs: 600_000, ...bin });

  const denied = await revert();
  const doc = parseOr<{ status?: string; policy?: Array<{ id: string; outcome: string }> }>(denied, {});
  hold(denied.code === 4 && doc.status === "denied" && doc.policy?.some((r) => r.id === "no-drops" && r.outcome === "denied") === true, `yodel revert of a migration that added a table, under the no-drops rule, exited ${String(denied.code)}, status ${String(doc.status)}, not denied by no-drops`);
  hold(await there(), "the table is gone though the policy denied its revert");

  const over = await p.yodel(["override", p.env, "--revert", id, "--rule", "no-drops", "--reason", "added by mistake in TICKET-8", "--by", "alice"]);
  if (over.code !== 0) throw new Error(`yodel override --revert exited ${String(over.code)}: ${over.err.slice(-400)}`);
  const gated = await revert();
  const gatedDoc = parseOr<{ status?: string; approve?: string }>(gated, {});
  hold(gated.code === 3 && gatedDoc.status === "gated", `yodel revert with the override for its digest exited ${String(gated.code)}, status ${String(gatedDoc.status)}, not at the gate`);
  await p.approve(gatedDoc.approve);
  const ran = await revert();
  hold(ran.code === 0, `yodel revert after the approval exited ${String(ran.code)}`);
  hold(!(await there()), "the table is still there after the overridden revert");
  const recorded = await ctx.db.count(`SELECT count(*) FROM ${ctx.db.history}.history WHERE migration_id = '${id}' AND status = 'reverted' AND note LIKE '%no-drops%TICKET-8%'`);
  hold(recorded === 1, `the history records the override in ${String(recorded)} of ${id}'s reverted rows`);

  // As after any revert: the migration deleted (it would apply again), the table no longer declared.
  p.removeMigration(id);
  rmSync(p.path("src", "undo_me.ts"));
  await p.commit(`delete ${id}, reverted`);
}

/**
 * The policy (#53, #73, #97), over an apply and over a revert. Each half
 * breaks its own property under BREAK, and the part is caught only when
 * both caught theirs.
 */
export async function policyPart(ctx: Ctx, p: Project): Promise<void> {
  const caught: string[] = [];
  for (const [name, half] of [["apply", policyOverApply], ["revert", policyOverRevert]] as const) {
    try {
      await half(ctx, p);
    } catch (e) {
      if (!(ctx.broken && e instanceof Violation)) throw e;
      ctx.log(`policy over ${name} caught its break: ${e.message}`);
      caught.push(`over ${name}: ${e.message}`);
      continue;
    }
    if (ctx.broken) ctx.log(`policy over ${name} held with its property broken`);
  }
  if (caught.length === 2) throw new Violation(caught.join("; "));
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

/** The claim's reader and writer on the emulator, made for the reader-writer part: a user each, the reader only able to read. */
async function readerAndWriter(ctx: Ctx): Promise<{ reader: string; writer: string; password: string }> {
  const { name, history } = ctx.db;
  const reader = `${name}__ro`;
  const writer = `${name}__rw`;
  const password = "yodel-claim-50";
  if (ctx.dialect === "ch") {
    for (const sql of [
      `CREATE USER IF NOT EXISTS ${reader} IDENTIFIED WITH plaintext_password BY '${password}' SETTINGS readonly = 1`,
      `GRANT SELECT, SHOW ON ${name}.* TO ${reader}`,
      `GRANT SELECT, SHOW ON ${history}.* TO ${reader}`,
      `CREATE USER IF NOT EXISTS ${writer} IDENTIFIED WITH plaintext_password BY '${password}'`,
      `GRANT ALL ON ${name}.* TO ${writer}`,
      `GRANT ALL ON ${history}.* TO ${writer}`,
    ]) {
      await ctx.db.exec(sql);
    }
  } else {
    await ctx.db.exec(`DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${reader}') THEN CREATE ROLE ${reader} LOGIN PASSWORD '${password}'; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${writer}') THEN CREATE ROLE ${writer} LOGIN PASSWORD '${password}'; END IF;
    END $$`);
    await ctx.db.exec(`GRANT USAGE ON SCHEMA ${name}, ${history} TO ${reader}; GRANT SELECT ON ALL TABLES IN SCHEMA ${name}, ${history} TO ${reader}`);
    await ctx.db.exec(`GRANT ALL ON SCHEMA ${name}, ${history} TO ${writer}`);
  }
  return { reader, writer, password };
}

/** Under BREAK, yodel with the refusal of a shared reader and writer taken out, and apply's refusal of the reader (#159): the project's yodel copied, its loadProject made to check nothing and its apply to refuse nothing for the credentials. */
function withoutSharedRefusal(ctx: Ctx, p: Project): string[] {
  const pkg = realpathSync(p.path("node_modules", "@intentius", "sql-yodeler"));
  const root = join(ctx.work, "yodel-without-shared-refusal");
  mkdirSync(root, { recursive: true });
  cpSync(join(pkg, "dist"), join(root, "dist"), { recursive: true });
  copyFileSync(join(pkg, "package.json"), join(root, "package.json"));
  symlinkSync(p.path("node_modules"), join(root, "node_modules"));
  const file = join(root, "dist", "project.js");
  const text = readFileSync(file, "utf8");
  const patched = text.replace(/const shared = sharedCredentialsIn\([^;]*\);/, "const shared = undefined;");
  if (patched === text) throw new Error(`the refusal of a shared reader and writer is not in ${file}; the broken build cannot take it out`);
  writeFileSync(file, patched);
  const applyFile = join(root, "dist", "commands", "apply.js");
  const applyText = readFileSync(applyFile, "utf8");
  const applyPatched = applyText.replace(/const asReader = writes \? readerRefusal\([^;]*;/, "const asReader = undefined;");
  if (applyPatched === applyText) throw new Error(`apply's refusal of the reader is not in ${applyFile}; the broken build cannot take it out`);
  writeFileSync(applyFile, applyPatched);
  ctx.log("BREAK: yodel built without the refusal of a shared reader and writer, and without apply's refusal of the reader");
  return ["node", join(root, "dist", "bin.js")];
}

/**
 * Credentials (#50): the environment's profile made with credentials(), a
 * reader and a writer, the reader's password minted by a command token
 * source (the test double for a cloud's). With the reader, yodel config
 * check --write-probe connects (the token minted) and the server refuses
 * the write; with the writer (YODEL_CREDENTIALS=writer:<env>) the probe's
 * write goes through and it exits 4. With the writer's user variable
 * holding the reader's user, yodel refuses the project, exit 4 naming both
 * variables and the user, and nothing runs. yodel apply with the reader
 * (#159) refuses before the gate, exit 4 naming YODEL_CREDENTIALS=writer:<env>,
 * and the history is as it was. The profile is put back after.
 * BREAK: yodel is built without those refusals, so the shared config runs
 * and the apply as the reader goes on to the gate or the server's refusal.
 */
export async function readerWriterPart(ctx: Ctx, p: Project): Promise<void> {
  const { reader, writer, password } = await readerAndWriter(ctx);
  const config = p.read("chant.config.ts");
  const dialect = ctx.dialect === "ch" ? "clickhouse" : "postgres";
  const roles = `{ reader: { user: { env: "CLAIM_READER_USER" }, password: { token: "command", command: ["node", "-e", "process.stdout.write(process.env.CLAIM_READER_SECRET ?? '')"] } }, writer: { user: { env: "CLAIM_WRITER_USER" }, password: { env: "CLAIM_WRITER_PASSWORD" } } }`;
  const spread = `...credentials(${JSON.stringify(p.env)}, "${dialect}", ${roles}),`;
  const withRoles =
    ctx.dialect === "ch"
      ? config.replace(/(url: process\.env\.YODEL_CLAIMS_CLICKHOUSE_URL \?\? "[^"]*",)/, `$1 ${spread}`)
      : config.replace(/user: \{ env: "YODEL_CLAIMS_POSTGRES_USER" \},\s*password: \{ env: "YODEL_CLAIMS_POSTGRES_PASSWORD" \},/, spread);
  if (withRoles === config) throw new Error("could not make the profile with credentials()");
  p.write("chant.config.ts", withRoles.replace(/^(import "@intentius\/chant-lexicon-sql";)$/m, '$1\nimport { credentials } from "@intentius/sql-yodeler";'));
  const apart = { CLAIM_READER_USER: reader, CLAIM_READER_SECRET: password, CLAIM_WRITER_USER: writer, CLAIM_WRITER_PASSWORD: password };
  const bin = ctx.broken ? { bin: withoutSharedRefusal(ctx, p) } : {};
  try {
    // Not the property under BREAK: the probe, which the broken build keeps.
    const must: (cond: boolean, what: string) => asserts cond = ctx.broken ? (cond, what) => { if (!cond) throw new Error(what); } : hold;
    const read = await p.yodel(["config", "check", p.env, "--write-probe"], { env: apart, ...bin });
    must(read.code === 0 && read.out.includes("write probe   cannot write") && read.out.includes("password a command token (node)"), `yodel config check --write-probe with the reader exited ${String(read.code)}: ${read.out}${read.err}`);
    const wrote = await p.yodel(["config", "check", p.env, "--write-probe"], { env: { ...apart, YODEL_CREDENTIALS: `writer:${p.env}` }, ...bin });
    must(wrote.code === 4 && wrote.err.includes("the credentials this process holds can write"), `yodel config check --write-probe with the writer exited ${String(wrote.code)}, not 4: ${wrote.out}${wrote.err}`);

    const shared = await p.yodel(["status", p.env], { env: { ...apart, CLAIM_WRITER_USER: reader }, ...bin });
    hold(
      shared.code === 4 && shared.err.includes(`the reader (CLAIM_READER_USER) and the writer (CLAIM_WRITER_USER) are the same user, ${reader}`),
      `yodel status with the reader's user as the writer's exited ${String(shared.code)}, not 4 naming both: ${shared.err.slice(-400)}`,
    );

    // An apply as the reader (#159) refuses before the gate and writes nothing to the history.
    const history = async () => (await p.yodel(["status", p.env, "--json"], { env: apart, ...bin })).out;
    const before = await history();
    const asReader = await p.yodel(["apply", p.env], { env: apart, ...bin });
    const after = await history();
    hold(
      asReader.code === 4 && asReader.err.includes(`YODEL_CREDENTIALS=writer:${p.env}`) && !asReader.err.includes("\n    at ") && after === before,
      `yodel apply as the reader exited ${String(asReader.code)}, not 4 naming YODEL_CREDENTIALS=writer:${p.env}${after === before ? "" : ", and the history moved"}: ${asReader.err.slice(-400)}`,
    );
  } finally {
    p.write("chant.config.ts", config);
  }
}

/** The parts, in order, on one project. */
const parts = [
  ["approval", approvalPart],
  ["pre-check", preCheckPart],
  ["policy", policyPart],
  ["audit", auditPart],
  ["reader-writer", readerWriterPart],
  ["digest-moved", digestMovedPart],
] as const;

async function body(ctx: Ctx): Promise<void> {
  await runParts(ctx, await Project.create(ctx), parts);
}

export const approval: Claim = {
  name: "approval",
  says: "a pending migration applies only after chant approve of its plan digest, and the history records that digest; a failing pre-migration check refuses it, and so does a policy rule, read at the base commit, unless an override is recorded for that digest, for a yodel revert as for an apply; the audit log derived from the history and the ledger accounts for every approval and apply, and names one removed; a reader and a writer that are one user are refused, and the reader, its password a minted token, cannot write; an approval is refused once the migration changed after it, and nothing is applied",
  dialects: { ch: body, pg: body },
  parts: parts.map(([name]) => name),
};
