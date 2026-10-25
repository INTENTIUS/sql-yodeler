/**
 * `yodel plan <env>` for a project with no migrations (#249): chant's plan
 * from the live database to the declared schema, with the review
 * `./review.ts` gives it: the lint findings over the planned changes, the
 * policy's outcome and how the ApplyOp's gate is approved. Collected once,
 * rendered as text, as the pull request comment (`--format markdown`,
 * `--comment`) and as JSON. Nothing here writes. As on the versioned path,
 * the comment names no server address.
 */

import type { ClassifiedChange } from "@intentius/chant-lexicon-sql/core/classifier";
import { YodelError, type Environment, type Project, type SqlDialect } from "../project.js";
import { declaredChanges, planExitCode, planJson, renderPlan, unreadableOf, type Plan } from "../chant/plan.js";
import { accessReview, renderAccessReview, type AccessReview } from "../chant/access.js";
import { applyOpExample, findApplyOp } from "../chant/apply.js";
import type { Build } from "../chant/build.js";
import { describeServer, probeServer, type ServerInfo } from "../server.js";
import { describeSettingsTopology, environmentSettings } from "../config/settings.js";
import { policyAtBase } from "../config/base.js";
import { migrationsApprovalAtBase } from "../approval-mode/index.js";
import { lintSettings, renderLint, LINT_RULES, SCHEMA_RULES, lintJson, type LintReport, type LintSettings } from "../lint/index.js";
import { loadPolicies, policyRules } from "../lint/policies.js";
import { describeResults, judgePolicyPlan, overrideCommand, overrideSourceAt, overrideSubject, policyRefusal, type OverrideSource, type RuleResult } from "../versioned/policy.js";
import type { PolicyConfig } from "../config/define.js";
import type { StandingOverride } from "@intentius/chant/override-gate";
import { cell, commentMarker, COMMENT_LIMIT, fence } from "../pr/render.js";
import { changeFindings, declarativeDigest, declarativeLint, declarativePolicyPlan } from "./review.js";

export type DeclarativeApproval = { kind: "op"; op: string; gate: string } | { kind: "no-op"; message: string };

export interface DeclarativePlan {
  environment: string;
  dialect: SqlDialect;
  server?: ServerInfo | undefined;
  /** chant's plan. */
  plan: Plan;
  /** The changes to declared objects: the work the ApplyOp would do. */
  changes: ClassifiedChange[];
  /** chant's report of the plan, as text. */
  report: string;
  /** The same report for the pull request comment, its title naming no server address. */
  commentReport: string;
  access: AccessReview;
  /** The lint findings over the planned changes. */
  lint: LintReport;
  /** The digest a policy override binds; absent when there is nothing to apply. */
  digest?: string | undefined;
  /** Each policy rule's outcome, with an override that counts; absent when yodel.config.ts declares no policy or nothing would change. */
  policy?: RuleResult[] | undefined;
  approval: DeclarativeApproval;
  notes: string[];
}

/** The lint settings a declarative review reads, with the project's own checks. */
export async function declarativeLintSettings(project: Project): Promise<{ settings: LintSettings; policies: Awaited<ReturnType<typeof loadPolicies>> }> {
  const policies = await loadPolicies(project);
  const rules = { ...LINT_RULES, ...SCHEMA_RULES, ...policyRules(policies) };
  return { settings: lintSettings(project.yodel?.config.lint as Record<string, unknown> | undefined, rules, project.yodel?.path), policies };
}

/** The policy of `env`'s declarative plan, with the override on the ledger for its digest. Empty when there is no policy or nothing to apply. */
export async function judgeDeclarative(input: {
  policy: PolicyConfig | undefined;
  environment: string;
  dialect: SqlDialect;
  changes: readonly ClassifiedChange[];
  digest: string;
  ledger: () => Promise<OverrideSource | undefined>;
  spend?: (override: StandingOverride) => Promise<void>;
}): Promise<RuleResult[]> {
  if (!input.policy || input.changes.length === 0) return [];
  return judgePolicyPlan(input.policy, declarativePolicyPlan(input.environment, input.dialect, input.changes, input.digest), input.digest, input.ledger, input.spend);
}

/** The override ledger for the ApplyOp `op` of `env`, as the environment's approval mode at base counts it. */
export async function declarativeOverrideSource(project: Project, env: string, op: string): Promise<OverrideSource> {
  return overrideSourceAt(project.dir, overrideSubject(op), await migrationsApprovalAtBase(project, env));
}

/** Collects the plan and its review; `build` is the current build of src/. */
export async function collectDeclarativePlan(project: Project, env: Environment, build: Build, plan: Plan, options: { opName?: string | undefined; processEnv?: NodeJS.ProcessEnv } = {}): Promise<DeclarativePlan> {
  const notes: string[] = [];
  const server = await probeServer(project, env);
  const topology = project.dialect === "clickhouse" ? `, topology ${describeSettingsTopology(environmentSettings(project, env.name))}` : "";
  const report = await renderPlan(plan, `Plan for ${env.name} (${server ? describeServer(server) : project.dialect}, sql.profiles.${env.name}${topology})`);
  const commentReport = await renderPlan(plan, `Plan for ${env.name} (${project.dialect}, sql.profiles.${env.name}${topology})`);
  const access = await accessReview(project, env.name, plan.diff.changes, build.output);
  const changes = declaredChanges(plan, build);
  const { settings, policies } = await declarativeLintSettings(project);
  const lint = declarativeLint({ project, settings, policies, schema: [], plan: { environment: env.name, findings: changeFindings(project.dialect, changes, plan.refused) } });

  let approval: DeclarativeApproval;
  try {
    const op = await findApplyOp(project, env, options.opName);
    approval = { kind: "op", op: op.name, gate: op.gate };
  } catch (e) {
    if (!(e instanceof YodelError)) throw e;
    approval = { kind: "no-op", message: e.message.includes("no Op applies") ? `no Op applies the declared schema to ${env.name}; declare one, for example:\n\n${applyOpExample(env.name, project.dialect)}` : e.message };
  }

  const digest = changes.length > 0 ? await declarativeDigest(env.name, project.dialect, changes) : undefined;
  let policy: RuleResult[] | undefined;
  // The policy as the base commit has it (#73): a pull request that loosens a rule is judged by the old one.
  const base = await policyAtBase(project, options.processEnv);
  if (base.note) notes.push(base.note);
  if (base.policy && digest) {
    policy = await judgeDeclarative({
      policy: base.policy,
      environment: env.name,
      dialect: project.dialect,
      changes,
      digest,
      ledger: async () => {
        if (approval.kind !== "op") return undefined;
        try {
          return await declarativeOverrideSource(project, env.name, approval.op);
        } catch {
          return undefined;
        }
      },
    });
  }
  return { environment: env.name, dialect: project.dialect, server, plan, changes, report, commentReport, access, lint, digest, policy, approval, notes };
}

/** The exit code: chant's plan's (2 when a change needs its own Op or a live object could not be read). */
export const declarativePlanExitCode = (p: DeclarativePlan): number => planExitCode(p.plan);

/** Why `yodel apply` would refuse the plan before its gate, or `undefined`. */
export function declarativeRefusalOf(p: DeclarativePlan): YodelError | undefined {
  return p.policy ? policyRefusal(p.policy, p.environment, p.digest, "before the gate") : undefined;
}

/** `yodel plan <env>` as text: chant's report, the access review, the findings and the policy. */
export function renderDeclarativeText(p: DeclarativePlan): string {
  const out = [p.report];
  const review = renderAccessReview(p.access, p.environment);
  if (review.length > 0) out.push("", ...review);
  if (p.lint.findings.length > 0) out.push("", renderLint(p.lint).trimEnd());
  for (const n of p.notes) out.push("", n);
  if (p.policy && p.policy.length > 0) {
    out.push("", ...describeResults(p.policy));
    const refusal = declarativeRefusalOf(p);
    if (refusal) out.push(`yodel apply ${p.environment} refuses this plan before the gate until someone policy.overriders lists records why: ${overrideCommand(p.environment, p.policy.filter((r) => r.outcome === "denied").map((r) => r.id))}`);
  }
  return `${out.join("\n")}\n`;
}

/** The policy's outcome: a table of the rules, then how to override a denial. */
function policyMarkdown(results: readonly RuleResult[], environment: string): string[] {
  const out = ["#### Policy", "", "| Rule | Outcome | Why |", "|---|---|---|"];
  for (const r of results) {
    const outcome = r.outcome === "allowed" ? "allowed" : r.outcome === "denied" ? "**denied**" : `overridden by ${cell(r.override?.by ?? "")}`;
    const why = r.outcome === "overridden" ? `${cell(r.reasons.join("; "))}; override: ${cell(r.override?.reason ?? "")}` : cell(r.reasons.join("; "));
    out.push(`| \`${cell(r.id)}\`${r.description ? ` ${cell(r.description)}` : ""} | ${outcome} | ${why} |`);
  }
  const denied = results.filter((r) => r.outcome === "denied");
  if (denied.length > 0) out.push("", "`yodel apply` refuses this plan before the gate until someone `policy.overriders` lists records why, for exactly this plan:", "", fence(overrideCommand(environment, denied.map((r) => r.id)), "sh"));
  return out;
}

/**
 * Why there is no plan to approve yet although the environment has an
 * ApplyOp, and what to do instead, or undefined: `yodel apply` refuses a
 * change that needs its own Op or a live object it could not read (exit 2),
 * and a policy denial before the gate (exit 4), so approving the gate would
 * approve nothing it runs.
 */
export function approvalHeld(p: DeclarativePlan): string | undefined {
  const unreadable = unreadableOf(p.plan);
  const refused = p.plan.refused.length;
  if (unreadable.length > 0) {
    return `Nothing to approve yet: \`yodel apply ${p.environment}\` would refuse this plan, since ${unreadable.map((u) => `\`${u.object}\``).join(", ")} could not be read (${unreadable.map((u) => u.reason).join("; ")}). Plan again once ${unreadable.length === 1 ? "it can be" : "they can be"}.`;
  }
  if (refused > 0) {
    const op = p.dialect === "clickhouse" ? "ClickHouseRebuildOp" : "PostgresMigrationOp";
    return `Nothing to approve yet: \`yodel apply ${p.environment}\` would refuse this plan. Move ${refused === 1 ? "the change that needs its own Op" : "each change that needs its own Op"} into one (${op}), or into a versioned migration that runs one, then plan again.`;
  }
  if (declarativeRefusalOf(p)) {
    return `Nothing to approve yet: \`yodel apply ${p.environment}\` refuses this plan before the gate while the policy denies it. Record the override above first; the gate then asks for its own approval of this plan.`;
  }
  return undefined;
}

/** The pull request comment body; the same marker as the versioned comment, so a project that adopts migrations updates the same comment. */
export function renderDeclarativeMarkdown(p: DeclarativePlan, options: { report?: boolean } = {}): string {
  const withReport = options.report !== false;
  const n = p.changes.length;
  const out = [
    commentMarker(p.environment),
    `### yodel plan: \`${p.environment}\``,
    "",
    `${p.dialect === "clickhouse" ? "ClickHouse" : "Postgres"}${p.server?.version ? ` ${cell(p.server.version)}` : ""}, the declared schema against the live database: **${n === 0 ? "no change" : `${String(n)} change${n === 1 ? "" : "s"}`}**.`,
  ];
  for (const note of p.notes) out.push("", `> ${note}`);
  if (withReport) out.push("", fence(p.commentReport.trimEnd(), "text"));
  const access = renderAccessReview(p.access, p.environment);
  if (access.length > 0) out.push("", "#### Access", "", ...access.map((l) => `- ${cell(l)}`));
  const unreadable = unreadableOf(p.plan);
  if (p.plan.refused.length > 0 || unreadable.length > 0) {
    out.push("", `**\`yodel apply\` would refuse (exit 2)**, and applies nothing: ${unreadable.length > 0 ? `${unreadable.map((u) => `\`${cell(u.object)}\``).join(", ")} could not be read` : `${String(p.plan.refused.length)} change${p.plan.refused.length === 1 ? "" : "s"} need${p.plan.refused.length === 1 ? "s" : ""} ${p.plan.refused.length === 1 ? "its" : "their"} own Op`}.`);
  }
  if (p.lint.findings.length > 0) {
    out.push("", `#### Lint (${String(p.lint.errors)} error${p.lint.errors === 1 ? "" : "s"}, ${String(p.lint.warnings)} warning${p.lint.warnings === 1 ? "" : "s"})`, "", "| Level | Rule | Finding |", "|---|---|---|");
    for (const f of p.lint.findings) out.push(`| ${f.level === "error" ? "**error**" : f.level} | \`${cell(f.rule)}\` | ${cell(f.message)} |`);
    out.push("", "_On the declarative path nothing is silenced: `yodel.config.ts` `lint.rules` sets a rule's level, and a policy override answers a denial._");
  }
  if (p.policy && p.policy.length > 0) out.push("", ...policyMarkdown(p.policy, p.environment));
  const held = approvalHeld(p);
  out.push("", "#### Approval", "");
  if (p.approval.kind === "no-op") {
    out.push(`No ApplyOp: ${cell(p.approval.message.split("\n")[0] ?? "")}`);
    const example = p.approval.message.split("\n\n").slice(1).join("\n\n");
    if (example) out.push("", "<details><summary>Declare one</summary>", "", fence(example, "ts"), "", "</details>");
  } else if (held !== undefined) {
    out.push(cell(held));
  } else if (n === 0) {
    out.push(`Nothing to approve: \`${p.environment}\` already matches the declared schema.`);
  } else {
    out.push(
      `After merge, \`yodel apply ${p.environment}\` runs \`${p.approval.op}\`, which stops at gate \`${p.approval.gate}\` with this plan. Approve it at a terminal (it shows the plan and asks you first):`,
      "",
      fence(`npx yodel approve ${p.environment}`, "sh"),
      "",
      "The gate binds the plan it stopped with: if the live database or `src/` changes before the apply runs, it asks again and nothing is applied.",
    );
  }
  if (!withReport) out.push("", "_chant's report is left out: the comment would be too long. `yodel plan` prints it._");
  const body = `${out.join("\n")}\n`;
  if (withReport && body.length > COMMENT_LIMIT) return renderDeclarativeMarkdown(p, { report: false });
  return body;
}

/** The approval's `command` when there is a plan to approve, else its `message` saying why not; nothing when nothing changes. */
function declarativeApprovalNext(p: DeclarativePlan): { command?: string; message?: string } {
  const held = approvalHeld(p);
  if (held !== undefined) return { message: held };
  return p.changes.length > 0 ? { command: `yodel approve ${p.environment}` } : {};
}

/** `yodel plan <env> --json` for a declarative project: chant's diff as before, with the review. */
export function declarativePlanJson(p: DeclarativePlan): Record<string, unknown> {
  const lint = lintJson(p.lint);
  return {
    ...planJson(p.plan),
    access: p.access,
    ...(p.server ? { server: p.server } : {}),
    lint: { status: lint.status, errors: lint.errors, warnings: lint.warnings, findings: lint.findings },
    ...(p.digest ? { digest: p.digest } : {}),
    ...(p.policy ? { policy: p.policy } : {}),
    approval: p.approval.kind === "op" ? { op: p.approval.op, gate: p.approval.gate, ...declarativeApprovalNext(p) } : { message: p.approval.message },
    ...(p.notes.length > 0 ? { notes: p.notes } : {}),
  };
}
