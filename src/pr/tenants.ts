/**
 * `yodel plan <env>` for an environment with a tenant set (#56): one plan,
 * and one pull request comment, for the whole set. Each tenant is planned
 * against its own history; tenants with the same migrations pending are
 * shown once, as a group, and the wave's one approval of the set digest
 * over every tenant's plan closes it.
 */

import { listTenants, tenantTarget } from "../tenants/index.js";
import { describeTenantSetWave, groupTenants, someNames, viewTenantSetWave, type TenantSetWaveView } from "../tenants/wave.js";
import { resolveEnvironment, type Project, type SqlDialect } from "../project.js";
import { closeVersioned, openVersioned } from "../versioned/engine.js";
import { scanMigrations } from "../migrations/index.js";
import { migrationsDir } from "../versioned/index.js";
import { viewWavePlan } from "../waves/index.js";
import { collectVersionedPlan, type VersionedPlan } from "./model.js";
import { COMMENT_LIMIT, commentMarker, fence, pendingMarkdown, planJsonVersioned, redact } from "./render.js";

export interface TenantSetPlan {
  environment: string;
  dialect: SqlDialect;
  /** The database or schema the migrations are written against. */
  template?: string | undefined;
  tenants: VersionedPlan[];
  /** The set's wave in the apply pipeline, when yodel.config.ts waves names it. */
  wave?: TenantSetWaveView | undefined;
  notes: string[];
}

/** Plans every tenant of `set` now. Reads only. */
export async function collectTenantSetPlan(project: Project, set: string, options: { allowOutOfOrder?: boolean } = {}): Promise<TenantSetPlan> {
  const tenants: VersionedPlan[] = [];
  const views: Array<{ target: string; plan?: Awaited<ReturnType<typeof viewWavePlan>> }> = [];
  const ordered = scanMigrations(migrationsDir(project)).ordered;
  let template: string | undefined;
  for (const t of (await listTenants(project, set)) ?? []) {
    const env = resolveEnvironment(project, tenantTarget(set, t));
    template ??= env.tenant?.template;
    const venv = await openVersioned(project, env);
    try {
      const plan = await collectVersionedPlan(project, env, { allowOutOfOrder: options.allowOutOfOrder === true, ledger: null, venv });
      tenants.push(plan);
      views.push({ target: env.name, ...(plan.refusal || !ordered ? {} : { plan: await viewWavePlan(project, venv, ordered, options) }) });
    } finally {
      await closeVersioned(venv);
    }
  }
  const out: TenantSetPlan = { environment: set, dialect: project.dialect, template, tenants, notes: [] };
  try {
    out.wave = await viewTenantSetWave(project, set, views);
  } catch (e) {
    out.notes.push(`The wave's gate could not be read at the base commit: ${e instanceof Error ? (e.message.split("\n")[0] ?? "") : String(e)}`);
  }
  return out;
}

/** The exit code `yodel plan` gives the set: the first refusal's, else 0. */
export const tenantSetExitCode = (plan: TenantSetPlan): number => plan.tenants.find((t) => t.refusal)?.refusal?.exitCode ?? 0;

const tenantName = (target: string): string => target.slice(target.indexOf("/") + 1);

/** The tenants grouped by what is pending on them, and by what refuses them. */
const groups = (plan: TenantSetPlan) => groupTenants(plan.tenants, (t) => `${t.pending.map((p) => p.id).join(" ")}|${t.refusal?.message ?? ""}`);

function summary(plan: TenantSetPlan): string {
  const behind = plan.tenants.filter((t) => t.pending.length > 0 || t.refusal).length;
  const n = plan.tenants.length;
  return `${String(n)} tenant${n === 1 ? "" : "s"}, each with its own history: ${String(n - behind)} up to date, ${String(behind)} with something pending${plan.template ? `. The statements are written against \`${plan.template}\`; each tenant gets them with its own name` : ""}`;
}

/** `yodel plan <set>`, as text. */
export function renderTenantSetText(plan: TenantSetPlan, options: { runnable?: (command: string) => string } = {}): string {
  const run = options.runnable ?? ((c: string) => c);
  const lines = [`Plan for tenant set ${plan.environment} (${plan.dialect}): ${summary(plan).replace(/`/g, "")}`];
  for (const n of plan.notes) lines.push("", n);
  for (const g of groups(plan)) {
    const first = g.members[0];
    if (!first) continue;
    const names = someNames(g.members.map((m) => tenantName(m.environment)));
    lines.push("", `${names}: ${first.refusal ? `yodel apply would refuse (exit ${String(first.refusal.exitCode)}): ${first.refusal.message}` : first.pending.length === 0 ? "up to date" : `${String(first.pending.length)} pending`}`);
    for (const p of first.pending) {
      lines.push(`  ${p.id}`);
      for (const { index, step } of p.steps) lines.push(`    ${String(index)}  ${step.kind === "statement" ? `${step.rule} ${step.class}` : step.kind === "op" ? `Op ${step.op}` : "manual"}  ${step.name}`);
    }
  }
  if (plan.wave) {
    lines.push("", describeTenantSetWave(plan.wave, plan.tenants.length));
    if (plan.wave.waits && plan.wave.approve) lines.push("Approve it for the pipeline, at a terminal, with:", `  ${run(plan.wave.approve)}`, "which shows every tenant's plan and asks you first.");
  }
  return `${lines.join("\n")}\n`;
}

/** The pull request comment for the whole set: one per tenant set, updated on the next push. */
export function renderTenantSetMarkdown(plan: TenantSetPlan, options: { sql?: boolean; max?: number } = {}): string {
  const withSql = options.sql !== false;
  const max = options.max ?? 30;
  const code = (s: string) => `\`${s}\``;
  const out = [
    commentMarker(plan.environment),
    `### yodel plan: \`${plan.environment}\`, a tenant set`,
    "",
    `${plan.dialect === "clickhouse" ? "ClickHouse" : "Postgres"}, ${summary(plan)}.`,
  ];
  for (const n of plan.notes) out.push("", `> ${n}`);
  for (const g of groups(plan)) {
    const first = g.members[0];
    if (!first) continue;
    const names = someNames(g.members.map((m) => tenantName(m.environment)), code, max);
    const count = g.members.length;
    const what = first.refusal ? "**yodel apply would refuse**" : first.pending.length === 0 ? "up to date" : `**${String(first.pending.length)} pending**`;
    out.push("", `#### ${String(count)} tenant${count === 1 ? "" : "s"}: ${what}`, "", names);
    if (first.refusal) out.push("", fence(redact(first.refusal.message), "text"));
    for (const p of first.pending) out.push("", ...pendingMarkdown(p, withSql, 5));
  }
  if (plan.wave) {
    out.push("", "#### The apply pipeline", "", describeTenantSetWave(plan.wave, plan.tenants.length, code));
    if (plan.wave.waits && plan.wave.approve) {
      out.push("", "Approve it before merging, once for every tenant, at a terminal (it shows every tenant's plan and asks first):", "", fence(`npx ${plan.wave.approve}`, "sh"));
    }
  }
  if (!withSql) out.push("", "_The statements are left out: the comment would be too long. `yodel plan` prints them._");
  const body = `${out.join("\n")}\n`;
  if (body.length > COMMENT_LIMIT) {
    if (withSql) return renderTenantSetMarkdown(plan, { sql: false, max });
    if (max > 5) return renderTenantSetMarkdown(plan, { sql: false, max: 5 });
  }
  return body;
}

/** `yodel plan <set> --json`. */
export function tenantSetJson(plan: TenantSetPlan): Record<string, unknown> {
  return {
    environment: plan.environment,
    dialect: plan.dialect,
    mode: "versioned",
    tenantSet: true,
    ...(plan.template ? { template: plan.template } : {}),
    tenants: plan.tenants.map((t) => planJsonVersioned(t)),
    upToDate: plan.tenants.filter((t) => t.pending.length === 0 && !t.refusal).length,
    total: plan.tenants.length,
    ...(plan.wave ? { wave: plan.wave } : {}),
    notes: plan.notes,
  };
}
