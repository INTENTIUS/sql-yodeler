/**
 * The versioned plan as text (`yodel plan <env>`), as the pull request
 * comment's markdown (`--format markdown`, `--comment`) and as JSON.
 *
 * The comment starts with a hidden marker, `<!-- yodel:plan env=<env> -->`,
 * by which `--comment` finds the comment it posted before and updates it,
 * and ends with the digest's subject, hidden, so the next comment can say
 * what moved. Neither holds a secret: migration ids, checksums, a hash of
 * the live catalog. Server addresses and tokens are never rendered.
 */

import type { MigrationStep, StatementChange } from "@intentius/chant-lexicon-sql/migration-statements";
import { describeMove, encodeSubject } from "../versioned/explain.js";
import type { ApprovalView, PendingView, VersionedPlan } from "./model.js";

/** The marker that identifies one environment's plan comment. */
export const commentMarker = (env: string): string => `<!-- yodel:plan env=${env} -->`;
const SUBJECT = /<!-- yodel:subject ([A-Za-z0-9_-]+) -->/;

/** The subject a comment body carries, encoded. */
export const subjectIn = (body: string): string | undefined => SUBJECT.exec(body)?.[1];

/** GitHub refuses a comment over 65536 characters; GitLab and Forgejo allow more. */
export const COMMENT_LIMIT = 65_000;

/** Values a statement may quote that do not belong in a comment, though the file is in the repo. */
export function redact(sql: string): string {
  return sql.replace(/\b(PASSWORD|SECRET|SECRET_ACCESS_KEY|ACCESS_KEY_ID|TOKEN)(\s*=?\s*)'(?:[^'\\]|\\.)*'/gi, "$1$2'[redacted]'");
}

const changes = (cs: readonly StatementChange[]) =>
  cs.map((c) => `${c.rule} ${c.class}${c.destructive ? " (destructive)" : ""} ${c.field}`).join(", ");

const stepRule = (s: MigrationStep): { rule: string; cls: string } =>
  s.kind === "statement"
    ? { rule: s.rule, cls: `${s.class}${s.destructive ? ", destructive" : ""}` }
    : { rule: [...new Set(s.changes.map((c) => c.rule))].join(", "), cls: [...new Set(s.changes.map((c) => `${c.class}${c.destructive ? ", destructive" : ""}`))].join("; ") };

const stepKind = (s: MigrationStep) => (s.kind === "statement" ? "statement" : s.kind === "op" ? `Op ${s.op}` : "manual");

function pendingMarks(p: PendingView): string[] {
  const marks: string[] = [];
  if (p.outOfOrder) marks.push("out of order");
  if (p.resumeAt !== undefined) marks.push(`ran part way; resumes at step ${String(p.resumeAt)}`);
  return marks;
}

function approvalLines(a: ApprovalView | undefined, digest: string | undefined, md: boolean): string[] {
  const code = (s: string) => (md ? `\`${s}\`` : s);
  if (!a) return [];
  if (a.kind === "no-op") return [md ? `No migrations Op: ${a.message.split("\n")[0] ?? ""}` : a.message];
  const out: string[] = [];
  if (a.latest) {
    const l = a.latest;
    if (l.holds) out.push(`Approved by ${l.by} at ${l.at}: the apply after merge runs this plan.`);
    else if (digest && l.digest) {
      out.push(`The newest approval of ${code(a.gate)}, by ${l.by} at ${l.at}, is for ${code(l.digest)}, not this plan; it does not hold.`);
      if (l.moved) out.push(`What moved${l.moved.confirmed ? "" : " (as far as yodel can tell)"}: ${describeMove(l.moved)}.`);
    } else if (!digest) out.push(`The newest approval of ${code(a.gate)} is by ${l.by} at ${l.at}${l.digest ? ` for ${code(l.digest)}` : ""}.`);
  } else if (digest) out.push(`Not approved yet. Approving binds exactly this digest; if anything it covers changes before the apply runs, the gate asks again and nothing is applied.`);
  if (a.ledgerNote) out.push(a.ledgerNote);
  return out;
}

/** `yodel plan <env>` for a project with migrations. */
export function renderPlanText(plan: VersionedPlan): string {
  const lines = [`Plan for ${plan.environment} (${plan.dialect}${plan.history ? `, history ${plan.history}` : ""}): ${String(plan.appliedCount)} applied, ${String(plan.pending.length)} pending`];
  for (const n of plan.notes) lines.push("", n);
  for (const p of plan.pending) {
    const marks = pendingMarks(p);
    lines.push("", `${p.id}${marks.length > 0 ? `  (${marks.join("; ")})` : ""}`);
    for (const { index, step, done, refused: why } of p.steps) {
      const { rule, cls } = stepRule(step);
      lines.push(`  ${String(index)}  ${stepKind(step)}  ${rule} ${cls}  ${step.name}${done ? "  (done in an earlier run)" : ""}`);
      if (step.kind === "statement") lines.push(...redact(step.sql).split("\n").map((l) => `       ${l}`));
      else lines.push(...step.detail.split("\n").map((l) => `       ${l}`));
      if (step.kind !== "statement") lines.push(`       ${why ? `yodel apply refuses it: ${why}` : "yodel apply runs it as this step"}`);
    }
  }
  if (plan.pending.length === 0 && !plan.refusal) lines.push("", "Nothing pending: every migration is applied.");
  if (plan.problems.length > 0) lines.push("", `Integrity problems (${String(plan.problems.length)}):`, ...plan.problems.map((p) => `  ${p}`));
  if (plan.refusal) lines.push("", `yodel apply would refuse (exit ${String(plan.refusal.exitCode)}): ${plan.refusal.message}`);
  if (plan.sinceLast) lines.push("", `Since the last comment's plan (${plan.sinceLast.approved}): ${describeMove(plan.sinceLast)}`);
  if (plan.digest) {
    lines.push("", `Plan digest: ${plan.digest}`);
    if (plan.approval?.kind === "op" && plan.approval.command) lines.push(`Approve it with:`, `  ${plan.approval.command}`);
  }
  const a = approvalLines(plan.approval, plan.digest, false);
  if (a.length > 0) lines.push("", ...a);
  return `${lines.join("\n")}\n`;
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
const fence = (text: string, lang: string) => {
  const ticks = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `${ticks}${lang}\n${text}\n${ticks}`;
};

function pendingMarkdown(p: PendingView, withSql: boolean): string[] {
  const marks = pendingMarks(p);
  const out = [`#### \`${p.id}\`${marks.length > 0 ? ` (${marks.join("; ")})` : ""}`, "", "| # | Step | Rule | Class | Object |", "|---|---|---|---|---|"];
  for (const { index, step, done } of p.steps) {
    const { rule, cls } = stepRule(step);
    out.push(`| ${String(index)} | ${step.kind === "statement" ? "statement" : `**${cell(stepKind(step))}**`}${done ? " (done)" : ""} | ${cell(rule)} | ${cell(cls)} | \`${cell(step.name)}\` |`);
  }
  const statements = p.steps.filter((s) => s.step.kind === "statement");
  if (withSql && statements.length > 0) {
    const sql = statements.map(({ index, step }) => (step.kind === "statement" ? `-- ${String(index)}: ${step.rule} ${step.class}, ${step.name}\n${redact(step.sql)};` : "")).join("\n\n");
    out.push("", `<details><summary>Statements (${String(statements.length)})</summary>`, "", fence(sql, "sql"), "", "</details>");
  }
  const refused = p.steps.filter((s) => s.step.kind !== "statement");
  if (refused.length > 0) {
    out.push("", "Refused changes:");
    for (const { index, step, refused: why } of refused) {
      const runs = why ? ` **yodel apply refuses it:** ${cell(why)}` : step.kind === "op" ? " yodel apply runs it as this step." : "";
      if (step.kind === "op") {
        out.push(`- step ${String(index)}, \`${step.name}\`: made by Op \`${step.op}\` (${cell(changes(step.changes))}).${runs}`);
        out.push("", `  <details><summary>${cell(step.op)} for ${cell(step.object)}</summary>`, "", indent(fence(step.detail, "text")), "", indent(fence(step.declaration, "ts")), "", "  </details>");
      } else if (step.kind === "manual") {
        out.push(`- step ${String(index)}, \`${step.name}\`: manual, no Op makes it (${cell(changes(step.changes))}).${why ? " yodel apply refuses it." : ""}`);
        out.push("", indent(fence(step.detail, "text")));
      }
    }
  }
  return out;
}

const indent = (s: string) => s.split("\n").map((l) => (l ? `  ${l}` : l)).join("\n");

/** The pull request comment body. */
export function renderPlanMarkdown(plan: VersionedPlan, options: { sql?: boolean } = {}): string {
  const withSql = options.sql !== false;
  const out = [
    commentMarker(plan.environment),
    `### yodel plan: \`${plan.environment}\``,
    "",
    `${plan.dialect === "clickhouse" ? "ClickHouse" : "Postgres"}${plan.history ? `, history \`${plan.history}\`` : ""}: ${String(plan.appliedCount)} applied, **${String(plan.pending.length)} pending**.`,
  ];
  for (const n of plan.notes) out.push("", `> ${n}`);
  if (plan.pending.length > 0) {
    for (const p of plan.pending) out.push("", ...pendingMarkdown(p, withSql));
  } else if (!plan.refusal) out.push("", "Nothing pending: every migration is applied.");
  if (plan.problems.length > 0) out.push("", `#### Integrity problems (${String(plan.problems.length)})`, "", ...plan.problems.map((p) => `- ${cell(p)}`));
  if (plan.refusal) out.push("", `**\`yodel apply\` would refuse (exit ${String(plan.refusal.exitCode)})**, and applies nothing:`, "", fence(plan.refusal.message, "text"));
  if (plan.sinceLast) out.push("", `Since the previous version of this comment (\`${plan.sinceLast.approved}\`): ${describeMove(plan.sinceLast)}.`);
  if (plan.digest) {
    out.push("", "#### Approval", "", `Plan digest the apply gate binds: \`${plan.digest}\``);
    if (plan.approval?.kind === "op" && plan.approval.command) out.push("", "Approve it with:", "", fence(plan.approval.command, "sh"));
  }
  const a = approvalLines(plan.approval, plan.digest, true);
  if (a.length > 0) out.push("", ...a);
  if (plan.approval?.kind === "no-op" && plan.digest) {
    out.push("", "<details><summary>Declare one</summary>", "", fence(plan.approval.message.split("\n\n").slice(1).join("\n\n"), "ts"), "", "</details>");
  }
  if (!withSql) out.push("", "_The statements are left out: the comment would be too long. `yodel plan` prints them._");
  if (plan.subject) out.push("", `<!-- yodel:subject ${encodeSubject(plan.subject)} -->`);
  const body = `${out.join("\n")}\n`;
  if (withSql && body.length > COMMENT_LIMIT) return renderPlanMarkdown(plan, { sql: false });
  return body;
}

/** `yodel plan <env> --json` for a project with migrations. */
export function planJsonVersioned(plan: VersionedPlan): Record<string, unknown> {
  const a = plan.approval;
  return {
    environment: plan.environment,
    dialect: plan.dialect,
    mode: "versioned",
    ...(plan.history ? { history: plan.history } : {}),
    applied: plan.appliedCount,
    pending: plan.pending.map((p) => ({
      id: p.id,
      outOfOrder: p.outOfOrder,
      ...(p.resumeAt !== undefined ? { resumeAt: p.resumeAt } : {}),
      steps: p.steps.map(({ index, step, done, refused }) => ({
        index,
        kind: step.kind,
        object: step.object,
        name: step.name,
        ...stepRuleJson(step),
        ...(step.kind === "statement" ? { sql: redact(step.sql) } : { detail: step.detail }),
        ...(step.kind === "op" ? { op: step.op } : {}),
        ...(step.kind !== "statement" ? { applyRuns: refused === undefined, ...(refused ? { refused } : {}) } : {}),
        done,
      })),
    })),
    problems: plan.problems,
    ...(plan.refusal ? { refusal: plan.refusal } : {}),
    ...(plan.digest ? { planDigest: plan.digest } : {}),
    ...(a?.kind === "op"
      ? {
          op: a.op,
          gate: a.gate,
          ...(a.command ? { approve: a.command } : {}),
          ...(a.latest ? { approval: { ...a.latest, moved: a.latest.moved ? { confirmed: a.latest.moved.confirmed, changes: a.latest.moved.changes } : undefined } } : {}),
        }
      : a
        ? { opMissing: a.message.split("\n")[0] }
        : {}),
    ...(plan.sinceLast ? { sinceLast: { digest: plan.sinceLast.approved, confirmed: plan.sinceLast.confirmed, changes: plan.sinceLast.changes } } : {}),
    notes: plan.notes,
  };
}

const stepRuleJson = (s: MigrationStep) =>
  s.kind === "statement" ? { rule: s.rule, class: s.class, ...(s.destructive ? { destructive: true } : {}) } : { changes: s.changes.map((c) => ({ rule: c.rule, class: c.class, field: c.field, ...(c.destructive ? { destructive: true } : {}) })) };
