/**
 * A tenant set's wave (#56): how the apply pipeline runs it, and what
 * `yodel plan` and `yodel approve` show of it.
 *
 * A set given as a list or a file is a run per tenant, `<env>/<tenant>`,
 * written into the rendered pipeline. A set given by a query is read when
 * the wave runs, never when the pipeline is rendered: its wave is `shares`
 * slots (one without `shares`), `<env>/@<i>of<n>`, and a slot is every
 * tenant the query lists at that moment whose name hashes to it
 * ({@link slotIndex}). Tenants come and go without a change to the
 * pipeline, and a tenant always lands in the same slot.
 *
 * A slot's plan (`yodel apply <env>/@<i>of<n> --wave-plan`) is each of its
 * tenants' wave plans and a digest over them, so the wave's one gate binds
 * every tenant's plan whichever way the set is given. `--wave-apply` applies
 * each tenant under its own lock, and refuses (exit 4) a tenant whose plan
 * moved since the decision, naming it, after applying the others.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { TenantSet, WaveGate } from "../config/define.js";
import type { Migration } from "../migrations/index.js";
import { resolveEnvironment, YodelError, type Project } from "../project.js";
import { EXIT_REFUSED } from "../exit.js";
import { closeVersioned, openVersioned } from "../versioned/engine.js";
import { statusReport, type StatusReport } from "../versioned/index.js";
import { gateAtBase, planWave, viewWavePlan, WAVES_PIPELINE, WavePlanMoved, type PlanWaveOptions, type WavePlanFile } from "../waves/index.js";
import { listTenants, tenantSetOf } from "./index.js";
import { splitTarget, tenantTarget } from "./target.js";
import { approveCommand, describeApprovalMode, signFlag, waveApproval, type ApprovalMode } from "../approval-mode/index.js";

/** A slot's tenant part: `@<i>of<n>`. */
const SLOT = /^@([1-9][0-9]*)of([1-9][0-9]*)$/;

/** Which slot of which set's wave a target is, when it is one: `prod/@2of4`. */
export function splitSlot(target: string): { env: string; index: number; count: number } | undefined {
  const { env, tenant } = splitTarget(target);
  const m = tenant === undefined ? null : SLOT.exec(tenant);
  if (!m) return undefined;
  const index = Number(m[1]);
  const count = Number(m[2]);
  return index <= count ? { env, index, count } : undefined;
}

export const slotTarget = (env: string, index: number, count: number): string => tenantTarget(env, `@${String(index)}of${String(count)}`);

/** The slot, 1 to `count`, a tenant's name hashes to: the same whatever else the set lists. */
export function slotIndex(tenant: string, count: number): number {
  return (Number.parseInt(createHash("sha256").update(tenant).digest("hex").slice(0, 8), 16) % count) + 1;
}

/** A set given by a query is read when its wave runs. */
export const readAtRunTime = (set: TenantSet | undefined): boolean => set !== undefined && !Array.isArray(set) && "query" in set;

/**
 * The runs of `env`'s wave, when it has a tenant set: a run per tenant, or
 * for a set given by a query, `shares` slots (one without), with no server
 * read. Undefined for an environment without a tenant set.
 */
export async function waveTargets(project: Project, env: string, shares?: number): Promise<string[] | undefined> {
  const set = tenantSetOf(project, env);
  if (set === undefined) return undefined;
  if (readAtRunTime(set)) {
    const n = Math.max(1, shares ?? 1);
    return Array.from({ length: n }, (_, i) => slotTarget(env, i + 1, n));
  }
  const tenants = (await listTenants(project, env)) ?? [];
  if (tenants.length === 0) throw new YodelError(`${env}'s tenant set lists no tenant, so its wave would apply nothing`);
  return tenants.map((t) => tenantTarget(env, t));
}

/** The tenants of a slot now, sorted. */
export async function slotTenants(project: Project, slot: { env: string; index: number; count: number }): Promise<string[]> {
  return ((await listTenants(project, slot.env)) ?? []).filter((t) => slotIndex(t, slot.count) === slot.index).sort();
}

/** The digest of a slot's plan: over each of its tenants' wave plan digests. */
export async function slotDigest(environment: string, tenants: ReadonlyArray<{ target: string; planDigest: string }>): Promise<string> {
  const { computePlanDigest } = await import("@intentius/chant/lifecycle/plan-digest");
  return computePlanDigest("yodel-wave-slot", { environment, tenants: [...tenants].sort((a, b) => (a.target < b.target ? -1 : 1)).map((t) => ({ target: t.target, planDigest: t.planDigest })) });
}

/** What `--wave-plan` writes for a slot: chant's fields over the slot, and each tenant's own plan. */
export interface SlotPlanFile {
  planDigest: string;
  destructive: boolean;
  empty: boolean;
  /** The slot, `<env>/@<i>of<n>`. */
  environment: string;
  tenants: Array<{ target: string; plan: WavePlanFile }>;
}

/** `yodel apply <env>/@<i>of<n> --wave-plan <file>`: plans every tenant of the slot, as the query lists them now. */
export async function writeSlotPlan(project: Project, target: string, ordered: readonly Migration[], file: string, options: PlanWaveOptions, log: (line: string) => void): Promise<SlotPlanFile> {
  const slot = splitSlot(target);
  if (!slot) throw new YodelError(`${target} is not a slot of a tenant set's wave`);
  const path = resolve(file);
  const before = existsSync(path) ? readSlotPlanSoftly(path) : undefined;
  const tenants: SlotPlanFile["tenants"] = [];
  for (const t of await slotTenants(project, slot)) {
    const env = resolveEnvironment(project, tenantTarget(slot.env, t));
    const venv = await openVersioned(project, env);
    try {
      const plan = await planWave(project, venv, ordered, options);
      tenants.push({ target: env.name, plan });
      log(`${env.name}: ${plan.empty ? "nothing to apply" : `${String(plan.pending.length)} pending (${plan.pending.join(", ")})`}; plan ${plan.planDigest}`);
      const was = before?.tenants.find((x) => x.target === env.name)?.plan.planDigest;
      if (was !== undefined && was !== plan.planDigest) log(`${env.name}: its plan moved since the plan before this one (${was}, now ${plan.planDigest})`);
    } finally {
      await closeVersioned(venv);
    }
  }
  const doc: SlotPlanFile = {
    planDigest: await slotDigest(target, tenants.map((t) => ({ target: t.target, planDigest: t.plan.planDigest }))),
    destructive: tenants.some((t) => t.plan.destructive),
    empty: tenants.every((t) => t.plan.empty),
    environment: target,
    tenants,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
  log(`${target}: ${String(tenants.length)} tenant${tenants.length === 1 ? "" : "s"} of ${slot.env} (read now); plan ${doc.planDigest}`);
  return doc;
}

function readSlotPlanSoftly(path: string): SlotPlanFile | undefined {
  try {
    const doc = JSON.parse(readFileSync(path, "utf8")) as SlotPlanFile;
    return Array.isArray(doc.tenants) ? doc : undefined;
  } catch {
    return undefined;
  }
}

/** Reads a slot's plan file. */
export function readSlotPlan(file: string): SlotPlanFile {
  const path = resolve(file);
  if (!existsSync(path)) throw new YodelError(`refused: the slot's plan file is not at ${path}. --wave-apply runs inside chant run wave, after it decided the wave; nothing was applied`, EXIT_REFUSED);
  const doc = readSlotPlanSoftly(path);
  if (!doc || typeof doc.planDigest !== "string") throw new YodelError(`${file} is not a plan yodel apply <env>/@<i>of<n> --wave-plan wrote`);
  return doc;
}

/**
 * `yodel apply <env>/@<i>of<n> --wave-apply <file>`: each tenant the slot's
 * plan names, through `applyTenant` (the tenant's own `--wave-apply`, with
 * the decision checked for the slot). The exit code is 1 when a tenant
 * failed, else 4 when a tenant's plan moved since the decision, else 0.
 */
export async function applySlot(
  target: string,
  file: string,
  applyTenant: (tenant: string, planFile: string, decidedAs: { target: string; planDigest: string }) => Promise<number>,
  log: (line: string) => void,
): Promise<number> {
  const planned = readSlotPlan(file);
  if (planned.environment !== target) throw new YodelError(`refused: ${file} is ${planned.environment}'s plan, not ${target}'s; nothing was applied`, EXIT_REFUSED);
  const moved: string[] = [];
  const failed: string[] = [];
  for (const { target: tenant, plan } of planned.tenants) {
    const tenantFile = `${resolve(file)}.${splitTarget(tenant).tenant ?? "tenant"}.json`;
    writeFileSync(tenantFile, `${JSON.stringify(plan, null, 2)}\n`);
    try {
      const code = await applyTenant(tenant, tenantFile, { target, planDigest: planned.planDigest });
      if (code !== 0) failed.push(tenant);
    } catch (e) {
      if (e instanceof WavePlanMoved) {
        log(`${tenant}: its plan moved since the wave was decided, so it was not applied. ${e.message}`);
        moved.push(tenant);
      } else {
        log(`${tenant}: ${e instanceof Error ? e.message : String(e)}`);
        failed.push(tenant);
      }
    }
  }
  const applied = planned.tenants.length - moved.length - failed.length;
  log(`${target}: ${String(applied)} of ${String(planned.tenants.length)} tenants applied${moved.length > 0 ? `; moved, not applied: ${moved.join(", ")}` : ""}${failed.length > 0 ? `; failed: ${failed.join(", ")}` : ""}`);
  return failed.length > 0 ? 1 : moved.length > 0 ? EXIT_REFUSED : 0;
}

// ── What yodel plan and yodel approve show ───────────────────────────────────

/** One tenant, as `yodel approve` reads it: its status, and the wave plan its run would write. */
export interface TenantView {
  target: string;
  report: StatusReport;
  /** Absent when apply would refuse the tenant (`report.refusal`). */
  plan?: Awaited<ReturnType<typeof viewWavePlan>> | undefined;
}

/** Every tenant of `set` now, each against its own history. */
export async function viewTenants(project: Project, set: string, ordered: readonly Migration[], options: { allowOutOfOrder?: boolean } = {}): Promise<TenantView[]> {
  const out: TenantView[] = [];
  for (const t of (await listTenants(project, set)) ?? []) {
    const env = resolveEnvironment(project, tenantTarget(set, t));
    const venv = await openVersioned(project, env);
    try {
      const report = await statusReport(venv, ordered, { allowOutOfOrder: options.allowOutOfOrder === true, sync: false });
      out.push({ target: env.name, report, ...(report.refusal ? {} : { plan: await viewWavePlan(project, venv, ordered, options) }) });
    } finally {
      await closeVersioned(venv);
    }
  }
  return out;
}

/** A tenant set's wave as the deciding job will decide it. */
export interface TenantSetWaveView {
  /** 1-based, in yodel.config.ts `waves`. */
  wave: number;
  gate: WaveGate;
  base: string;
  baseSource: string;
  /** The wave's runs: a tenant each, or the slots of a set read at run time. */
  runs: Array<{ target: string; tenants: string[]; planDigest: string; destructive: boolean; empty: boolean }>;
  /** The set digest the wave's gate binds; absent while a tenant is refused. */
  digest?: string | undefined;
  /** The tenants apply refuses: the wave fails until they are fixed. */
  refused: string[];
  /** A pending migration has not run where a tenant requires it first. */
  blocked: string[];
  /** Under the gate at the base, the wave waits for an approval of `digest`. */
  waits: boolean;
  /** `yodel approve <set> --plan <digest>`, with `--sign` when the wave is sealed: what a person runs (#202). */
  approve?: string | undefined;
  /** `chant approve yodel-apply yodel-apply-wave-<k> --plan <digest>`, the same approval, for scripts. */
  chantApprove?: string | undefined;
  /** Which approvals count (#48), as the base commit has the wave; absent, `ledger`. */
  approval?: ApprovalMode | undefined;
}

/**
 * `set`'s wave over `tenants`, when yodel.config.ts `waves` names it: the
 * runs the deciding job plans, their digests, and the set digest over them,
 * which is what one approval binds. The `before` steps are not run here.
 */
export async function viewTenantSetWave(project: Project, set: string, tenants: ReadonlyArray<Pick<TenantView, "target" | "plan">>): Promise<TenantSetWaveView | undefined> {
  const waves = project.yodel?.config.waves ?? [];
  const k = waves.findIndex((w) => w.env === set) + 1;
  if (k === 0) return undefined;
  const { gate, at } = await gateAtBase(project, set);
  const refused = tenants.filter((t) => !t.plan).map((t) => t.target);
  const blocked = tenants.filter((t) => t.plan?.blocked).map((t) => t.target);
  const planned = tenants.flatMap((t) => (t.plan ? [{ target: t.target, plan: t.plan }] : []));
  const runs: TenantSetWaveView["runs"] = [];
  if (readAtRunTime(tenantSetOf(project, set))) {
    const n = Math.max(1, waves[k - 1]?.shares ?? 1);
    for (let i = 1; i <= n; i++) {
      const target = slotTarget(set, i, n);
      const mine = planned.filter((t) => slotIndex(splitTarget(t.target).tenant ?? "", n) === i).sort((a, b) => (a.target < b.target ? -1 : 1));
      runs.push({
        target,
        tenants: mine.map((t) => t.target),
        planDigest: await slotDigest(target, mine.map((t) => ({ target: t.target, planDigest: t.plan.planDigest }))),
        destructive: mine.some((t) => t.plan.destructive),
        empty: mine.every((t) => t.plan.empty),
      });
    }
  } else {
    for (const t of planned) runs.push({ target: t.target, tenants: [t.target], planDigest: t.plan.planDigest, destructive: t.plan.destructive, empty: t.plan.empty });
  }
  const view: TenantSetWaveView = { wave: k, gate, base: at.sha, baseSource: at.base.source, runs, refused, blocked, waits: false };
  if (refused.length > 0) return view;
  const { waveSetDigest, waveGateName } = await import("@intentius/chant/gated-waves");
  const { opWaveNeedsApproval } = await import("@intentius/chant/op");
  const members = runs.map((r) => ({ member: r.target, planDigest: r.planDigest, op: "", ...(r.destructive ? { destructive: true } : {}), ...(r.empty ? { empty: true } : {}) }));
  view.digest = waveSetDigest(members);
  view.waits = blocked.length === 0 && opWaveNeedsApproval(gate, members);
  const approval = waveApproval(at.config, set);
  view.approve = approveCommand(set, view.digest, approval);
  view.chantApprove = `chant approve ${WAVES_PIPELINE} ${waveGateName(WAVES_PIPELINE, k)} --plan ${view.digest}${signFlag(approval)}`;
  if (approval !== "ledger") view.approval = approval;
  return view;
}

/** The tenants of a set grouped by what is pending on them (the same migrations), in the order first seen. */
export function groupTenants<T>(tenants: readonly T[], key: (t: T) => string): Array<{ key: string; members: T[] }> {
  const groups = new Map<string, T[]>();
  for (const t of tenants) groups.set(key(t), [...(groups.get(key(t)) ?? []), t]);
  return [...groups].map(([k, members]) => ({ key: k, members }));
}

/** Up to `max` names, then how many more. */
export function someNames(names: readonly string[], code: (s: string) => string = (s) => s, max = 30): string {
  const shown = names.slice(0, max).map(code).join(", ");
  return names.length > max ? `${shown} and ${String(names.length - max)} more` : shown;
}

/** One line on a tenant set's wave, for text and markdown. */
export function describeTenantSetWave(w: TenantSetWaveView, count: number, code: (s: string) => string = (s) => s): string {
  const at = `gate ${code(w.gate)} at ${code(w.base.slice(0, 12))}`;
  const tenants = `${String(count)} tenant${count === 1 ? "" : "s"}`;
  if (w.refused.length > 0) return `The apply pipeline fails wave ${String(w.wave)} until yodel apply stops refusing ${someNames(w.refused, code)} (${at}).`;
  if (w.blocked.length > 0) return `The apply pipeline refuses wave ${String(w.wave)} until what is pending on ${someNames(w.blocked, code)} has run where ${w.blocked.length === 1 ? "it requires" : "they require"} first; approve it then (${at}).`;
  if (!w.waits) return `The apply pipeline applies this to ${tenants} in wave ${String(w.wave)} with no approval (${at}).`;
  return `The apply pipeline waits in wave ${String(w.wave)} for one approval of ${code(w.digest ?? "")}, for all ${tenants} (${at}).${w.approval && w.approval !== "ledger" ? ` ${describeApprovalMode(w.approval, code)}` : ""}`;
}
