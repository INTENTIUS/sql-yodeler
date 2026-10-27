/**
 * The plan note through chant's note renderer (#290, chant#4550): with a
 * chant whose `@intentius/chant/ci-product` renders a note yodel can sign
 * its name to, `yodel plan <env> --comment` posts chant's `renderPrNote` in
 * yodel's words (../ci-words.ts) in place of yodel's own layout, so every
 * product's note reads the same.
 *
 * chant gives the heading, the environment table with its counts, the
 * digest, the approval line and the change-set summary. The SQL rows chant's
 * table does not carry (each statement with its rule and class, checks,
 * Op and manual steps, the promotion columns, each policy rule's outcome
 * with its override line, what moved since the last note, the wave) go in
 * the member detail section of chant#4573 (`PrMemberDetail`, the shape a
 * lexicon's `prNoteDetail` returns), rendered from yodel's plan, which holds
 * more than the change-set part does.
 *
 * The note keeps yodel's marker, `<!-- yodel:plan env=<env> -->`, on its
 * first line, so `--comment` updates the note it posted before the switch
 * and an open pull request keeps one note. The digest's subject stays at the
 * end, hidden, as before.
 *
 * chant's note is used only when it names the environment in its approve
 * line (`{target}`) and, under per-wave words, says the waves apply on
 * merge; {@link chantNote} renders a probe to tell. Until a chant does both,
 * yodel posts its own note (./render.ts), as it does on a published chant.
 */

import { execFileSync } from "node:child_process";
import { chantProduct, YODEL_WORDS, type ChantProduct } from "../ci-words.js";
import { describeMove, encodeSubject } from "../versioned/explain.js";
import { describeWave } from "../waves/index.js";
import { WAVES_PIPELINE } from "../waves/record.js";
import type { VersionedPlan } from "./model.js";
import { cell, commentMarker, COMMENT_LIMIT, fence, pendingMarkdown, policyMarkdown, ranOn } from "./render.js";
import { planPart } from "./part.js";
import type { TenantSetPlan } from "./tenants.js";

/** What the note needs of chant beyond yodel's words: the renderer and the change-set composer. */
export interface ChantNote {
  product: ChantProduct;
  words: unknown;
  renderPrNote: (report: unknown, options: { words: unknown; limit?: number }) => string;
  composeChangeSet: (parts: unknown[]) => { members: Array<{ member: string }>; summary: { byMember: Record<string, Record<string, number> | undefined> } };
}

let loaded: Promise<ChantNote | undefined> | undefined;

/**
 * chant's renderer without the probe: undefined only when the installed
 * chant has none. For a test that reads chant's layout before chant's note
 * fits yodel.
 */
export async function chantRenderer(): Promise<ChantNote | undefined> {
  const product = await chantProduct();
  if (!product) return undefined;
  const specifier = "@intentius/chant/ci-product";
  const m = (await import(specifier)) as { renderPrNote?: ChantNote["renderPrNote"] };
  const cs = (await import("@intentius/chant/change-set")) as unknown as { composeChangeSet?: ChantNote["composeChangeSet"] };
  if (typeof m.renderPrNote !== "function" || typeof cs.composeChangeSet !== "function") return undefined;
  return { product, words: product.assertProductWords(YODEL_WORDS), renderPrNote: m.renderPrNote, composeChangeSet: cs.composeChangeSet };
}

/** The probe's environment and digest, which a note that names the target prints in its approve line. */
const PROBE_ENV = "yodel-probe-env";
const PROBE_DIGEST = "jcs1-sha256:probe";

/**
 * chant's renderer, once, when the installed chant has one whose note fits
 * yodel: its approve line names the environment, and it does not tell a
 * per-wave product that a release deploys the merge. Undefined otherwise.
 */
export function chantNote(): Promise<ChantNote | undefined> {
  loaded ??= (async () => {
    const note = await chantRenderer();
    if (!note) return undefined;
    try {
      const probe = note.renderPrNote(report(note, [{ environment: PROBE_ENV, digest: PROBE_DIGEST, pending: 1, refused: false }], { env: PROBE_ENV, op: WAVES_PIPELINE, gate: `${WAVES_PIPELINE}-wave-1`, digest: PROBE_DIGEST, head: "0".repeat(40), base: "0".repeat(40), approval: { status: "pending" }, details: [] }), { words: note.words });
      if (!probe.includes(`yodel approve ${PROBE_ENV} --plan ${PROBE_DIGEST}`) || probe.includes("a release deploys it")) return undefined;
    } catch {
      return undefined;
    }
    return note;
  })();
  return loaded;
}

/** One environment of the note: its name, its digest, how many migrations are pending and whether apply would refuse. */
interface NoteMember {
  environment: string;
  digest: string | undefined;
  pending: number;
  refused: boolean;
  part?: unknown;
}

/** What the report carries beyond its members. */
interface NoteFrame {
  env: string;
  op: string;
  gate: string;
  digest: string;
  head: string;
  base: string;
  approval: { status: "approved" | "changed" | "pending"; approvedBy?: string[]; approved?: string };
  details: Array<{ member: string; title?: string; lines: string[] }>;
  message?: string;
}

/** chant's pull request report for the note: one member per environment (or tenant), at the plan stage. */
function report(note: ChantNote, members: readonly NoteMember[], frame: NoteFrame): Record<string, unknown> {
  const parts = members.map((m) => m.part ?? { member: { member: m.environment, lexicon: "sql", planner: "sql", scope: m.environment, status: m.refused ? "failed" : "planned", planDigest: m.digest ?? null, holes: [] }, entries: [] });
  const changeSet = note.composeChangeSet(parts);
  const count = (member: string, action: string) => changeSet.summary.byMember[member]?.[action] ?? 0;
  const failed = members.some((m) => m.refused);
  return {
    ...frame,
    stage: "plan",
    pr: null,
    status: failed ? "plan-failed" : "planned",
    members: members.map((m) => ({
      member: m.environment,
      component: `${String(m.pending)} pending`,
      planDigest: m.refused ? null : (m.digest ?? null),
      status: m.refused ? "plan-failed" : "planned",
      counts: { create: count(m.environment, "create"), update: count(m.environment, "update"), replace: count(m.environment, "replace"), delete: count(m.environment, "delete") },
    })),
    changeSet,
    selection: { changed: members.map((m) => m.environment), dependents: [], unclaimed: [], indeterminate: [], waves: [members.map((m) => m.environment)] },
  };
}

/** The commit the job runs at, and the base it measures from; empty outside a git checkout. */
function commits(dir: string, base: string | undefined): { head: string; base: string } {
  const sha = (ref: string): string => {
    try {
      return execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "";
    }
  };
  return { head: sha("HEAD"), base: base ? sha(base) || base : "" };
}

/** The approval of the environment's digest, as chant's note reads it. */
function approvalOf(plan: VersionedPlan): NoteFrame["approval"] {
  const latest = plan.approval?.kind === "op" ? plan.approval.latest : undefined;
  if (!latest || !plan.digest) return { status: "pending" };
  if (latest.holds) return { status: "approved", approvedBy: [latest.by] };
  if (latest.digest && !latest.sameDigest) return { status: "changed", approved: latest.digest };
  return { status: "pending" };
}

/** The SQL rows of one environment's plan: the member detail section (chant#4573). */
export function planDetailLines(plan: VersionedPlan, withSql: boolean): string[] {
  const out: string[] = [];
  for (const n of plan.notes) out.push(`> ${n}`, "");
  if (plan.history) out.push(`History \`${plan.history}\`: ${String(plan.appliedCount)} applied, ${String(plan.pending.length)} pending.`);
  for (const p of plan.pending) out.push("", ...pendingMarkdown(p, withSql));
  if (plan.pending.length === 0 && !plan.refusal) out.push("", "Nothing pending: every migration is applied.");
  if (plan.problems.length > 0) out.push("", `#### Integrity problems (${String(plan.problems.length)})`, "", ...plan.problems.map((p) => `- ${cell(p)}`));
  if (plan.refusal) out.push("", `**\`yodel apply\` would refuse (exit ${String(plan.refusal.exitCode)})**, and applies nothing:`, "", fence(plan.refusal.message, "text"));
  if (plan.policy && plan.policy.length > 0) out.push("", ...policyMarkdown(plan.policy, plan.environment));
  if (plan.sinceLast) out.push("", `Since the previous version of this note (\`${plan.sinceLast.approved}\`): ${describeMove(plan.sinceLast)}.`);
  if (plan.wave) {
    const promotions = plan.wave.promotions;
    if (promotions.length > 0) {
      out.push("", `| Migration | ${promotions.map((p) => `\`${cell(p.env)}\``).join(" | ")} |`, `|---|${promotions.map(() => "---|").join("")}`);
      for (const m of plan.pending) out.push(`| \`${m.id}\` | ${promotions.map((p) => ranOn(p, m.id)).join(" | ")} |`);
    }
    out.push("", describeWave(plan.wave, (c) => `\`${c}\``));
  }
  if (!withSql) out.push("", "_The statements are left out: the note would be too long. `yodel plan` prints them._");
  return out;
}

/** Wave `k`'s gate on the ledger: `yodel-apply-wave-<k>`, the words' pattern. */
const waveGate = (k: number): string => YODEL_WORDS.gateName.replace("{k}", String(k));

/** The op, gate and digest the note's approve line binds: the wave's, else the migrations Op's. */
function gateOf(plan: Pick<VersionedPlan, "wave" | "approval" | "digest">): { op: string; gate: string; digest: string } {
  if (plan.wave) return { op: WAVES_PIPELINE, gate: waveGate(plan.wave.wave), digest: plan.wave.digest };
  if (plan.approval?.kind === "op") return { op: plan.approval.op, gate: plan.approval.gate, digest: plan.digest ?? "" };
  return { op: "", gate: "", digest: plan.digest ?? "" };
}

/** Yodel's marker first, chant's note, the subject last: what `--comment` posts. */
function framed(env: string, body: string, subject: string | undefined): string {
  return `${commentMarker(env)}\n${body.replace(/\n*$/, "\n")}${subject ? `\n<!-- yodel:subject ${subject} -->\n` : ""}`;
}

/** One environment's note through chant, or undefined when the installed chant's note does not fit yodel. */
export async function renderPlanNote(plan: VersionedPlan, options: { dir: string; base?: string; note?: ChantNote }): Promise<string | undefined> {
  const note = options.note ?? (await chantNote());
  if (!note) return undefined;
  const { op, gate, digest } = gateOf(plan);
  const subject = plan.subject ? encodeSubject(plan.subject) : undefined;
  const render = (withSql: boolean) =>
    framed(
      plan.environment,
      note.renderPrNote(
        report(note, [{ environment: plan.environment, digest: plan.digest, pending: plan.pending.length, refused: plan.refusal !== undefined, part: planPart(plan, plan.environment) }], {
          env: plan.environment,
          op,
          gate,
          digest,
          ...commits(options.dir, options.base),
          approval: approvalOf(plan),
          details: [{ member: plan.environment, title: `The SQL plan for \`${plan.environment}\``, lines: planDetailLines(plan, withSql) }],
          ...(plan.refusal ? { message: plan.refusal.message } : {}),
        }),
        { words: note.words, limit: COMMENT_LIMIT },
      ),
      subject,
    );
  const body = render(true);
  return body.length > COMMENT_LIMIT ? render(false) : body;
}

/** A tenant set's note through chant (#56): a member per tenant, a detail section per group of tenants with one plan. */
export async function renderTenantSetNote(plan: TenantSetPlan, options: { dir: string; base?: string; note?: ChantNote }): Promise<string | undefined> {
  const note = options.note ?? (await chantNote());
  if (!note) return undefined;
  const members = plan.tenants.map((t) => ({ environment: t.environment, digest: t.digest, pending: t.pending.length, refused: t.refusal !== undefined, part: planPart(t, t.environment) }));
  const wave = plan.wave;
  const render = (withSql: boolean) =>
    framed(
      plan.environment,
      note.renderPrNote(
        report(note, members, {
          env: plan.environment,
          op: wave ? WAVES_PIPELINE : "",
          gate: wave ? waveGate(wave.wave) : "",
          digest: wave?.digest ?? "",
          ...commits(options.dir, options.base),
          approval: { status: "pending" },
          details: plan.tenants.map((t) => ({ member: t.environment, lines: planDetailLines(t, withSql) })),
        }),
        { words: note.words, limit: COMMENT_LIMIT },
      ),
      undefined,
    );
  const body = render(true);
  return body.length > COMMENT_LIMIT ? render(false) : body;
}
