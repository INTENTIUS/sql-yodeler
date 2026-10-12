/**
 * The sql lexicon's schema checks (#51) inside `yodel lint`: the post-synth
 * checks `chant lint` runs over a build (a table with no primary key, a
 * foreign key with no index, a column type to avoid, an engine or setting
 * the pinned server does not have), run here on each migration's recorded
 * schema, so a project has one lint command and one configuration.
 *
 * A finding is reported in the migration whose recorded schema first has
 * it: the parent's schema is checked too, and what it already had is not
 * reported again. It is put at the migration's first step on the object it
 * names, so a `-- yodel:allow <id> <reason>` line above that step silences
 * it, as for a statement rule.
 *
 * Levels: each check's rule id (`SQLPG101`, `SQLCH113`) is a lint rule.
 * `yodel.config.ts` `lint.rules` sets it first; else `chant.config.ts`
 * `lint.rules`, which `chant lint` reads; else the level the check gives
 * the finding (an `info` finding is a warning here).
 *
 * The checks read the objects as `chant build` serializes them (their
 * columns, keys and engine besides the DDL); an object recorded with its
 * DDL only is not checked.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { postSynthChecks } from "@intentius/chant-lexicon-sql/lint/post-synth";
import type { BuildOutput } from "../chant/build.js";
import type { Migration } from "../migrations/index.js";
import type { LevelSetting, LintLevel, LintRule } from "./rules.js";

export type Dialect = "clickhouse" | "postgres";

const dialectOf = (id: string): Dialect | undefined => (id.startsWith("SQLCH") ? "clickhouse" : id.startsWith("SQLPG") ? "postgres" : undefined);

/** Every schema check the lexicon ships, as a lint rule: silenceable, its level set in config. */
export const SCHEMA_RULES: Readonly<Record<string, LintRule>> = Object.fromEntries(
  postSynthChecks.map((c: PostSynthCheck) => {
    const dialect = dialectOf(c.id);
    return [c.id, { id: c.id, summary: `schema check: ${c.description}`, level: "warning", silenceable: true, configurable: true, schema: true, ...(dialect ? { dialect } : {}) } satisfies LintRule];
  }),
);

export const isSchemaRule = (id: string): boolean => Object.hasOwn(SCHEMA_RULES, id);

/** One schema check's finding in a recorded schema. */
export interface SchemaDiagnostic {
  rule: string;
  /** The level the check gave it. */
  level: LintLevel;
  message: string;
  /** The export it names, when it names one. */
  entity?: string;
}

/** Objects as `chant build` writes them carry their name besides the DDL; one with the DDL alone is left out. */
const serialized = (o: unknown): boolean => typeof (o as { name?: unknown }).name === "string";

/**
 * Runs every schema check over one recorded schema, then the project's own
 * `policies` (#227), with `env` as the context's environment. A check that
 * throws is reported as a finding of its own.
 */
export function schemaDiagnostics(schema: BuildOutput, options: { policies?: readonly PostSynthCheck[]; env?: string | undefined } = {}): SchemaDiagnostic[] {
  if (!Array.isArray(schema.objects)) return [];
  const value = { ...schema, objects: schema.objects.filter(serialized) };
  if (value.objects.length === 0) return [];
  const outputs = new Map([["sql", JSON.stringify(value)]]);
  const ctx: PostSynthContext = {
    outputs,
    entities: new Map(),
    docs: [{ lexicon: "sql", index: 0, format: "json", value }],
    buildResult: { outputs, entities: new Map(), warnings: [], errors: [], sourceFileCount: 0 },
    ...(options.env !== undefined ? { env: options.env } : {}),
  };
  const out: SchemaDiagnostic[] = [];
  for (const check of [...postSynthChecks, ...(options.policies ?? [])]) {
    const dialect = dialectOf(check.id);
    if (dialect !== undefined && dialect !== schema.dialect) continue;
    let found: PostSynthDiagnostic[];
    try {
      found = check.check(ctx);
    } catch (e) {
      out.push({ rule: check.id, level: "error", message: `${check.id} could not run on the recorded schema: ${(e instanceof Error ? e.message : String(e)).split("\n")[0] ?? ""}` });
      continue;
    }
    for (const d of found) {
      out.push({ rule: d.checkId, level: d.severity === "error" ? "error" : "warning", message: d.message, ...(d.entity !== undefined ? { entity: d.entity } : {}) });
    }
  }
  return out;
}

/** A level from `chant.config.ts` `lint.rules`: a severity string, or `[severity, options]`. */
export function chantLevel(value: unknown): LevelSetting | undefined {
  const s = Array.isArray(value) ? (value[0] as unknown) : value;
  if (s === "off") return "off";
  if (s === "error") return "error";
  if (s === "warning" || s === "info") return "warning";
  return undefined;
}

/** A schema finding before its silence is applied: where it is, and its level unless `yodel.config.ts` sets the rule's. */
export interface SchemaFinding {
  rule: string;
  migration: string;
  message: string;
  step?: number;
  object?: string;
  /** Undefined when `yodel.config.ts` sets the rule's level, which then applies. */
  level?: LintLevel;
}

const keyOf = (d: SchemaDiagnostic) => `${d.rule}\u0000${d.entity ?? ""}\u0000${d.message}`;

/**
 * The schema findings of every migration: each check's findings on its
 * recorded schema that its parent's recorded schema does not have.
 * `configured` are the rule ids `yodel.config.ts` sets; `chantRules` is
 * `chant.config.ts`'s `lint.rules`; `policies` are the project's own checks
 * (./policies.ts), run with the schema checks.
 */
export function schemaFindings(
  migrations: readonly Migration[],
  options: { dialect?: Dialect | undefined; configured: ReadonlySet<string>; chantRules?: Record<string, unknown> | undefined; policies?: readonly PostSynthCheck[]; env?: string | undefined },
): SchemaFinding[] {
  const byId = new Map(migrations.map((m) => [m.id, m]));
  const cache = new Map<string, SchemaDiagnostic[]>();
  const diagnostics = (m: Migration): SchemaDiagnostic[] => {
    let d = cache.get(m.id);
    if (!d) {
      const schema = m.document.schema;
      d = (schema.dialect as unknown) === "clickhouse" || (schema.dialect as unknown) === "postgres" ? schemaDiagnostics(schema, { ...(options.policies ? { policies: options.policies } : {}), env: options.env }) : [];
      cache.set(m.id, d);
    }
    return d;
  };
  const out: SchemaFinding[] = [];
  for (const m of migrations) {
    const d = m.document.dialect as unknown;
    if (d !== "clickhouse" && d !== "postgres") continue;
    if (options.dialect !== undefined && d !== options.dialect) continue;
    const parent = m.parent === null ? undefined : byId.get(m.parent);
    const before = new Set((parent ? diagnostics(parent) : []).map(keyOf));
    for (const diag of diagnostics(m)) {
      if (before.has(keyOf(diag))) continue;
      let level: LintLevel | undefined;
      if (!options.configured.has(diag.rule)) {
        const set = chantLevel(options.chantRules?.[diag.rule]);
        if (set === "off") continue;
        level = set ?? diag.level;
      }
      const step = diag.entity === undefined ? -1 : m.document.steps.findIndex((s) => s.object === diag.entity);
      out.push({
        rule: diag.rule,
        migration: m.id,
        message: `${step >= 0 ? `step ${String(step)}: ` : ""}${diag.message}`,
        ...(step >= 0 ? { step } : {}),
        ...(step >= 0 ? { object: m.document.steps[step]?.name ?? diag.entity } : diag.entity !== undefined ? { object: diag.entity } : {}),
        ...(level !== undefined ? { level } : {}),
      });
    }
  }
  return out;
}
