/**
 * The declarative path's review (#249): what a project with no
 * `migrations/` gets on a pull request, the same review the versioned
 * path has where it can apply.
 *
 * - Lint over the plan: each change chant plans from the live database to
 *   the declared schema, against the statement rules that read a change's
 *   rule and class (`destructive`, `pg-rewrite`, `pg-access`,
 *   `ch-mutation`, `ch-rebuild`, `ch-access`), and `refused-step` for a
 *   change that needs its own Op. The plan carries no statement, so the
 *   rules that read one (`pg-lock`, `data-dependent`, `pg-signature`) run
 *   on the versioned path only. There is no `migration.sql` to hold a
 *   `-- yodel:allow` line, so nothing is silenced: `lint.rules` lowers a
 *   rule, and a policy override answers a denial.
 * - Lint over the declared schema, offline: the lexicon's schema checks,
 *   the project's own checks and `lint.naming`, over the build of `src/`.
 * - The policy (`yodel.config.ts` `policy`, at the base commit): the plan
 *   a rule sees is one entry of `pending`, `declared`, its steps the
 *   planned changes, and `declarative` says so. An override binds the
 *   digest {@link declarativeDigest} takes over the declared changes, under
 *   the ApplyOp's name.
 *
 * The ApplyOp's own gate binds chant's digest of the plan it runs; that
 * one is known only once `yodel apply` stops at the gate, so the comment
 * says how to approve, not which digest.
 */

import type { ClassifiedChange } from "@intentius/chant-lexicon-sql/core/classifier";
import type { PolicyPlan, PolicyStep } from "../config/define.js";
import type { BuildOutput } from "../chant/build.js";
import type { Project, SqlDialect } from "../project.js";
import { takesAccessAway } from "../chant/access.js";
import { CLASSIFIER_RULES } from "@intentius/chant-lexicon-sql/clickhouse/plan/rules";
import { PG_CLASSIFIER_RULES } from "@intentius/chant-lexicon-sql/postgres/plan/rules";
import { levelOf, type LintSettings } from "../lint/config.js";
import { LINT_RULES, type LintLevel, type LintRule } from "../lint/rules.js";
import { SCHEMA_RULES, schemaDiagnostics, chantLevel } from "../lint/schema-checks.js";
import { schemaNames, NAMING_PRESETS, type NamingKind } from "../lint/naming.js";
import { policyRules } from "../lint/policies.js";
import type { Finding, LintReport } from "../lint/check.js";
import type { PostSynthCheck } from "@intentius/chant/lint/post-synth";

/** The id of the one entry a declarative plan has in a policy rule's `pending`. */
export const DECLARED = "declared";

/** chant's plan digest kind for the declared changes an override binds. */
const DIGEST_KIND = "yodel-declarative";

const titled = (dialect: SqlDialect, rule: string): string => {
  const r = (dialect === "clickhouse" ? CLASSIFIER_RULES : PG_CLASSIFIER_RULES)[rule as never] as { title?: string } | undefined;
  return r?.title ? `${rule} ${r.title}` : rule;
};

/** How a change is named in a finding: `events (app.events) orderBy`. */
const changeName = (c: ClassifiedChange): string => `${c.object} ${c.field}`;

/** A finding before its level: the rule, and what it says. */
interface RawChangeFinding {
  rule: string;
  object: string;
  message: string;
}

/** The statement-rule findings for the planned changes; `refused` are the ones that need their own Op. */
export function changeFindings(dialect: SqlDialect, changes: readonly ClassifiedChange[], refused: readonly ClassifiedChange[] = []): RawChangeFinding[] {
  const out: RawChangeFinding[] = [];
  const isRefused = new Set(refused.map((c) => `${c.object}\u0000${c.field}\u0000${c.rule}`));
  for (const c of changes) {
    const what = `${titled(dialect, c.rule)} on ${changeName(c)}`;
    const at = { object: c.object };
    if (c.destructive) out.push({ rule: "destructive", ...at, message: `${what}: removes data that cannot be recovered` });
    if (dialect === "clickhouse" && c.class === "rewrite") out.push({ rule: "ch-mutation", ...at, message: `${what}: a mutation that rewrites existing parts in the background, with no rollback` });
    if (dialect === "clickhouse" && c.class === "rebuild") out.push({ rule: "ch-rebuild", ...at, message: `${what}: a rebuild, every row copied into a new table and swapped in (ClickHouseRebuildOp)` });
    if (dialect === "postgres" && c.class === "rewrite") out.push({ rule: "pg-rewrite", ...at, message: `${what}: blocks reads and writes on the table while it runs` });
    const away = takesAccessAway({ rule: c.rule });
    if (away) out.push({ rule: dialect === "clickhouse" ? "ch-access" : "pg-access", ...at, message: `${what}: ${away}, which changes what a ${dialect === "clickhouse" ? "user or role" : "role"} can do` });
    if (isRefused.has(`${c.object}\u0000${c.field}\u0000${c.rule}`)) {
      out.push({ rule: "refused-step", ...at, message: `${what}: yodel apply refuses it in place; it needs its own Op (${dialect === "clickhouse" ? "ClickHouseRebuildOp" : "PostgresMigrationOp"}), or a versioned migration that runs one` });
    }
  }
  return out;
}

/** The schema findings over the declared schema: the lexicon's checks, the project's own, and `lint.naming`. */
export function declaredSchemaFindings(
  build: BuildOutput,
  options: { settings?: LintSettings | undefined; chantRules?: Record<string, unknown> | undefined; policies?: readonly PostSynthCheck[]; env?: string | undefined },
): Array<RawChangeFinding & { level?: LintLevel }> {
  const out: Array<RawChangeFinding & { level?: LintLevel }> = [];
  const configured = new Set(Object.keys(options.settings?.levels ?? {}));
  for (const d of schemaDiagnostics(build, { ...(options.policies ? { policies: options.policies } : {}), env: options.env })) {
    let level: LintLevel | undefined;
    if (!configured.has(d.rule)) {
      const set = chantLevel(options.chantRules?.[d.rule]);
      if (set === "off") continue;
      level = set ?? d.level;
    }
    out.push({ rule: d.rule, object: d.entity ?? "", message: d.message, ...(level !== undefined ? { level } : {}) });
  }
  const naming = options.settings?.naming ?? {};
  if (Object.keys(naming).length > 0) {
    for (const n of schemaNames(build)) {
      const rule = naming[n.kind];
      if (!rule || rule.pattern.test(n.name)) continue;
      out.push({ rule: "naming", object: n.export, message: `${n.label}: ${JSON.stringify(n.name)} does not match the naming rule for ${PLURAL[n.kind]} (${NAMING_PRESETS[rule.rule] ? `${rule.rule}, ` : ""}${NAMING_PRESETS[rule.rule] ?? rule.rule})` });
    }
  }
  return out;
}

const PLURAL: Record<NamingKind, string> = { table: "tables", column: "columns", index: "indexes", constraint: "constraints" };

/** Every rule a declarative finding can name, for levels. */
const rulesFor = (policies: readonly PostSynthCheck[]): Record<string, LintRule> => ({ ...LINT_RULES, ...SCHEMA_RULES, ...policyRules(policies) });

/**
 * The lint report of a declarative project: the declared schema's findings
 * (`src/`), and with `plan` the planned changes' (`the plan for <env>`),
 * each at the level `lint.rules` gives it. Nothing is silenced.
 */
export function declarativeLint(input: {
  project: Pick<Project, "dir" | "dialect">;
  settings?: LintSettings | undefined;
  schema: Array<RawChangeFinding & { level?: LintLevel }>;
  plan?: { environment: string; findings: RawChangeFinding[] } | undefined;
  policies?: readonly PostSynthCheck[];
}): LintReport {
  const rules = rulesFor(input.policies ?? []);
  const findings: Finding[] = [];
  const add = (where: string, f: RawChangeFinding & { level?: LintLevel }) => {
    const rule = rules[f.rule];
    const setting = rule ? levelOf(rule, input.settings) : "error";
    if (setting === "off") return;
    if (rule?.dialect !== undefined && rule.dialect !== input.project.dialect) return;
    findings.push({ rule: f.rule, level: f.level ?? setting, message: f.object && !f.message.includes(f.object) ? `${f.object}: ${f.message}` : f.message, migration: where, ...(f.object ? { object: f.object } : {}) });
  };
  for (const f of input.schema) add(DECLARED_SCHEMA, f);
  if (input.plan) for (const f of input.plan.findings) add(planScope(input.plan.environment), f);
  return {
    dir: input.project.dir,
    dialect: input.project.dialect,
    environment: input.plan?.environment,
    migrations: [],
    findings,
    silences: {},
    errors: findings.filter((f) => f.level === "error").length,
    warnings: findings.filter((f) => f.level === "warning").length,
    silenced: 0,
    declarative: true,
  };
}

/** Where a declarative finding is, as `yodel lint` groups it. */
export const DECLARED_SCHEMA = "src/ (the declared schema)";
export const planScope = (environment: string): string => `the plan for ${environment}`;

/** The plan a policy rule sees for a declarative apply. */
export function declarativePolicyPlan(environment: string, dialect: SqlDialect, changes: readonly ClassifiedChange[], digest: string, now: Date = new Date()): PolicyPlan {
  return {
    environment,
    dialect,
    now: now.toISOString(),
    declarative: true,
    pending: [
      {
        id: DECLARED,
        checksum: digest,
        outOfOrder: false,
        steps: changes.map((c, index): PolicyStep => ({ index, kind: "statement", object: c.object, name: changeName(c), classes: [c.class], destructive: c.destructive === true, rules: [c.rule] })),
        silences: [],
      },
    ],
  };
}

/** The digest an override of a declarative plan binds: chant's plan digest over the environment, dialect and declared changes. */
export async function declarativeDigest(environment: string, dialect: SqlDialect, changes: readonly ClassifiedChange[]): Promise<string> {
  const { computePlanDigest } = await import("@intentius/chant/lifecycle/plan-digest");
  const key = (c: ClassifiedChange) => `${c.object}\u0000${c.field}\u0000${c.rule}`;
  const sorted = [...changes]
    .sort((a, b) => key(a).localeCompare(key(b)))
    .map((c) => ({ object: c.object, field: c.field, rule: c.rule, class: c.class, destructive: c.destructive === true, ...(c.before !== undefined ? { before: c.before } : {}), ...(c.after !== undefined ? { after: c.after } : {}) }));
  return computePlanDigest(DIGEST_KIND, { environment, dialect, changes: sorted });
}
