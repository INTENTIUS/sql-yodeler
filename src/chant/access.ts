/**
 * Postgres access control under review (#45): row-level security, policies,
 * the roles a schema declares, grants and default privileges, as chant's sql
 * lexicon plans and applies them where `sql.profiles.<env>.access` is on
 * (yodel.config.ts's `environments.<env>.access` sets it per environment).
 *
 * The plan already lists each access change with its rule and class. This
 * module picks them out so `yodel plan`, `yodel new`, lint and the pull
 * request comment can show them together, and names the changes that take
 * access away: a privilege revoked (SQLPG297), a policy dropped (SQLPG292),
 * row-level security turned off or no longer forced (SQLPG293). A revoke no
 * `REVOKE` declaration asks for takes away a privilege granted by hand (or
 * one whose declaration was deleted) from the role that holds it, so it is
 * called out on its own.
 */

import type { ClassifiedChange } from "@intentius/chant-lexicon-sql/core/classifier";
import type { MigrationStep } from "@intentius/chant-lexicon-sql/migration-statements";
import type { BuildOutput } from "./build.js";
import { environmentAccess } from "../config/settings.js";
import type { Project } from "../project.js";

/** chant's access rules: policies, row-level security, roles, grants, revokes, default privileges. */
export const ACCESS_RULES: ReadonlySet<string> = new Set(["SQLPG290", "SQLPG291", "SQLPG292", "SQLPG293", "SQLPG294", "SQLPG296", "SQLPG297", "SQLPG298"]);

/** The entity types of access declarations. */
export const ACCESS_TYPES: ReadonlySet<string> = new Set(["Postgres::Policy", "Postgres::Role", "Postgres::Grant", "Postgres::DefaultPrivileges"]);

/** The `field` chant gives a created policy or role in a plan. */
const ACCESS_FIELDS = new Set(["policy", "role"]);

/** A plan change that is about access control. */
export const isAccessChange = (c: Pick<ClassifiedChange, "rule" | "field">): boolean => ACCESS_RULES.has(c.rule) || (c.rule === "SQLPG200" && ACCESS_FIELDS.has(c.field));

/** A migration step that is about access control. */
export function isAccessStep(s: MigrationStep): boolean {
  // chant's ownership comment after a CREATE is not a change anyone reviews.
  if (s.kind === "statement") return !/^\s*COMMENT\s+ON\b/i.test(s.sql) && (ACCESS_TYPES.has(s.type) || ACCESS_RULES.has(s.rule) || /\bROW\s+LEVEL\s+SECURITY\b/i.test(s.sql));
  return s.changes.some((c) => ACCESS_RULES.has(c.rule));
}

const OFF = /\b(?:DISABLE|NO\s+FORCE)\s+ROW\s+LEVEL\s+SECURITY\b/i;

/** Why a statement takes access away, or `undefined`. */
export function takesAccessAway(s: { rule: string; sql?: string }): string | undefined {
  if (s.rule === "SQLPG297") return "revokes a privilege";
  if (s.rule === "SQLPG292") return "drops a policy";
  if (s.rule === "SQLPG293" && s.sql !== undefined && OFF.test(s.sql)) return /NO\s+FORCE/i.test(s.sql) ? "stops forcing row-level security on the table's owner" : "turns row-level security off";
  return undefined;
}

/** One access change in a declarative plan. */
export interface AccessItem {
  object: string;
  rule: string;
  class: string;
  field: string;
  before?: unknown;
  after?: unknown;
  /** A revoke no declaration asks for: the server holds a privilege nothing declares (granted by hand, or its declaration deleted), and the apply takes it away. */
  byHand?: true;
}

/** What `yodel plan --json` adds on Postgres: whether access is managed here, and the access changes. */
export interface AccessReview {
  managed: boolean;
  /** Where {@link managed} came from: `yodel.config.ts`, `sql.profiles.<env>.access` or `default`. */
  source: string;
  changes: AccessItem[];
}

/** The ACL entries the build's declarations decide, as chant keys them (`relation app.t TO reader`), with the declarations behind each. */
async function declaredEntries(build: BuildOutput): Promise<ReadonlyMap<string, string[]>> {
  const { pgSchemaFromBuildOutput } = await import("@intentius/chant-lexicon-sql/postgres/plan/schema");
  const { declaredAccess } = await import("@intentius/chant-lexicon-sql/postgres/access/acl");
  const objects = pgSchemaFromBuildOutput(JSON.stringify(build));
  const major = typeof build.postgresMajor === "number" ? build.postgresMajor : 18;
  return declaredAccess(objects, { major }).exportsOf;
}

/** The access changes of a Postgres plan, a revoke of what nothing declares marked {@link AccessItem.byHand}. */
export async function accessItems(changes: readonly ClassifiedChange[], build: BuildOutput): Promise<AccessItem[]> {
  const access = changes.filter(isAccessChange);
  if (access.length === 0) return [];
  const declared = access.some((c) => c.rule === "SQLPG297") ? await declaredEntries(build) : new Map<string, string[]>();
  // A revoke the declarations ask for is theirs; any other takes away what a grant made by hand (or a deleted declaration) gave.
  const revokes = new Set(build.objects.filter((o) => o.type === "Postgres::Grant" && /^\s*REVOKE\b/i.test(o.ddl)).map((o) => o.export));
  return access.map((c) => ({
    object: c.object,
    rule: c.rule,
    class: c.class,
    field: c.field,
    ...(c.before !== undefined ? { before: c.before } : {}),
    ...(c.after !== undefined ? { after: c.after } : {}),
    ...(c.rule === "SQLPG297" && !(declared.get(c.object) ?? []).some((e) => revokes.has(e)) ? { byHand: true as const } : {}),
  }));
}

/** A Postgres plan's access section: whether access is managed in environment `name` (and where that is set), and the plan's access changes. */
export async function accessReview(project: Pick<Project, "yodel" | "profileAccess">, name: string, changes: readonly ClassifiedChange[], build: BuildOutput): Promise<AccessReview> {
  const chant = project.profileAccess?.[name];
  const { access, source } = environmentAccess(project.yodel?.config.environments?.[name], chant !== undefined ? { access: chant } : undefined, name);
  return { managed: access, source, changes: await accessItems(changes, build) };
}

const list = (v: unknown): string[] => (typeof v === "string" ? v.split(",").map((x) => x.trim()).filter(Boolean) : []);

/** The privileges a revoke takes away: what the role held before and does not after. */
export const removed = (c: Pick<AccessItem, "before" | "after">): string[] => {
  const after = new Set(list(c.after));
  return list(c.before).filter((x) => !after.has(x));
};

const value = (v: unknown): string => (v === undefined || v === null || v === "" ? "nothing" : typeof v === "string" ? v : JSON.stringify(v));

/** The plan's access section, as text: every change with its rule and class, then the revokes of privileges granted by hand. */
export function renderAccessReview(review: AccessReview, environment: string): string[] {
  const where = review.source === "default" ? "off by default" : `from ${review.source}`;
  if (!review.managed) return review.changes.length > 0 ? [] : [`Access control: not managed in ${environment} (${where}); policies, grants and roles are not planned.`];
  const lines = [`Access control (managed in ${environment}, ${where}): ${review.changes.length === 0 ? "no change" : `${String(review.changes.length)} change${review.changes.length === 1 ? "" : "s"}`}`];
  for (const c of review.changes) lines.push(`  ${c.rule} ${c.class}  ${c.object}  ${c.field}: ${value(c.before)} -> ${value(c.after)}${c.byHand ? "  (granted by hand)" : ""}`);
  const byHand = review.changes.filter((c) => c.byHand);
  if (byHand.length > 0) {
    lines.push(
      "",
      `Revoked by this apply, though no declaration revokes ${byHand.length === 1 ? "it" : "them"}: privileges granted by hand (or whose declaration was deleted). The role loses ${byHand.length === 1 ? "it" : "them"} once the apply runs:`,
      ...byHand.map((c) => `  ${c.object.replace(/ TO /, " FROM ")}: ${removed(c).join(", ")}`),
      `To keep ${byHand.length === 1 ? "it" : "them"}, declare ${byHand.length === 1 ? "it" : "them"} with grant\`...\`.`,
    );
  }
  return lines;
}

/** The access steps of a migration, each with why it takes access away when it does. */
export function accessSteps(steps: readonly MigrationStep[]): Array<{ index: number; step: MigrationStep; away?: string; undeclared?: true }> {
  const out: Array<{ index: number; step: MigrationStep; away?: string; undeclared?: true }> = [];
  steps.forEach((step, index) => {
    if (!isAccessStep(step)) return;
    const away = step.kind === "statement" ? takesAccessAway(step) : undefined;
    // chant files a revoke no declaration is behind under the ACL entry, `acl <entry>`.
    const undeclared = step.kind === "statement" && step.rule === "SQLPG297" && step.object.startsWith("acl ");
    out.push({ index, step, ...(away ? { away } : {}), ...(undeclared ? { undeclared: true as const } : {}) });
  });
  return out;
}

/** A migration's access steps as lines: how many, and each one that takes access away. */
export function describeAccessSteps(steps: readonly MigrationStep[], md = false): string[] {
  const access = accessSteps(steps);
  if (access.length === 0) return [];
  const code = (s: string) => (md ? `\`${s}\`` : s);
  const away = access.filter((a) => a.away);
  const lines = [`Access control: ${String(access.length)} step${access.length === 1 ? "" : "s"} (${[...new Set(access.map((a) => (a.step.kind === "statement" ? `${a.step.rule} ${a.step.class}` : a.step.kind)))].join(", ")})${away.length > 0 ? `, ${String(away.length)} taking access away:` : ""}`];
  for (const a of away) lines.push(`${md ? "- " : "  "}step ${String(a.index)} ${a.away ?? ""}${a.undeclared ? " that no declaration grants any more" : ""}: ${code(a.step.kind === "statement" ? a.step.sql.split("\n")[0] ?? "" : a.step.name)}`);
  return lines;
}
