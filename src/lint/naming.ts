/**
 * `naming` (#51): names a migration gives that break the project's naming
 * rules, set per kind of object in `yodel.config.ts`:
 *
 * ```ts
 * export default defineConfig({
 *   lint: { naming: { table: "snake_case", column: "snake_case", index: "[a-z_]+_idx", constraint: "[a-z_]+_(pkey|key|fkey|check)" } },
 * });
 * ```
 *
 * A rule is a preset (`snake_case`, `camelCase`, `PascalCase`) or a regular
 * expression the whole name must match. Only the names a migration adds are
 * checked: a table, column, index or named constraint in its recorded schema
 * that its parent's does not have. A name already there is not reported
 * again, so turning a rule on does not fail the migrations already written.
 * An unnamed constraint (the server names it) is not checked.
 *
 * Read from the recorded schemas with the lexicon's own parser: the names
 * are the server's (Postgres folds an unquoted name to lower case). Each
 * finding is at the migration's first step on the object, so a
 * `-- yodel:allow naming <reason>` line above it silences it.
 */

import { schemaFromBuildOutput } from "@intentius/chant-lexicon-sql/clickhouse/plan/schema";
import { pgSchemaFromBuildOutput } from "@intentius/chant-lexicon-sql/postgres/plan/schema";
import type { BuildOutput } from "../chant/build.js";
import { YodelError } from "../project.js";
import type { Migration } from "../migrations/index.js";

export const NAMING_KINDS = ["table", "column", "index", "constraint"] as const;
export type NamingKind = (typeof NAMING_KINDS)[number];

export const NAMING_PRESETS: Readonly<Record<string, string>> = {
  snake_case: "[a-z][a-z0-9]*(_[a-z0-9]+)*",
  camelCase: "[a-z][a-zA-Z0-9]*",
  PascalCase: "[A-Z][a-zA-Z0-9]*",
};

/** One kind's rule, as `yodel.config.ts` gives it and compiled. */
export interface NamingRule {
  /** As written: a preset name or a regular expression. */
  rule: string;
  pattern: RegExp;
}

export type NamingSettings = Partial<Record<NamingKind, NamingRule>>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Reads `lint.naming`; a key that is not a kind, or a rule that is not a preset or a valid expression, is an error naming `where`. */
export function namingSettings(raw: unknown, where = "yodel.config.ts"): NamingSettings {
  if (raw === undefined) return {};
  if (!isRecord(raw)) throw new YodelError(`${where}: lint.naming: expected an object of ${NAMING_KINDS.join(", ")}: a preset (${Object.keys(NAMING_PRESETS).join(", ")}) or a regular expression`);
  const out: NamingSettings = {};
  for (const [kind, rule] of Object.entries(raw)) {
    if (!(NAMING_KINDS as readonly string[]).includes(kind)) throw new YodelError(`${where}: lint.naming.${kind}: not a kind of object (the kinds: ${NAMING_KINDS.join(", ")})`);
    if (typeof rule !== "string" || rule === "") throw new YodelError(`${where}: lint.naming.${kind}: expected a preset (${Object.keys(NAMING_PRESETS).join(", ")}) or a regular expression`);
    const source = NAMING_PRESETS[rule] ?? rule;
    let pattern: RegExp;
    try {
      pattern = new RegExp(`^(?:${source})$`, "u");
    } catch (e) {
      throw new YodelError(`${where}: lint.naming.${kind}: ${JSON.stringify(rule)} is not a preset or a valid regular expression: ${e instanceof Error ? e.message : String(e)}`);
    }
    out[kind as NamingKind] = { rule, pattern };
  }
  return out;
}

/** A name a recorded schema gives. */
interface Named {
  kind: NamingKind;
  /** Unique within the schema: the object, and for a column, index or constraint its table. */
  key: string;
  name: string;
  /** The declaration's export, which a step on the object names. */
  export: string;
  /** How a message names it: `table shop.orders`, `column note of shop.orders`. */
  label: string;
}

/** The names of a recorded schema, by kind; `[]` for one the lexicon cannot read (lint reports that on its own). */
export function schemaNames(build: BuildOutput, options: { defaultDatabase?: string | undefined; defaultSchema?: string | undefined } = {}): Named[] {
  if (!Array.isArray(build.objects)) return [];
  const out: Named[] = [];
  try {
    if (build.dialect === "postgres") {
      for (const o of pgSchemaFromBuildOutput(JSON.stringify(build), options.defaultSchema ?? "public")) {
        const c = o.canonical;
        const qualified = c.schema ? `${c.schema}.${c.name}` : c.name;
        const exp = c.exportName ?? o.key;
        if (c.kind === "table") {
          out.push({ kind: "table", key: qualified, name: c.name, export: exp, label: `table ${qualified}` });
          for (const col of c.columns) out.push({ kind: "column", key: `${qualified}.${col.name}`, name: col.name, export: exp, label: `column ${col.name} of ${qualified}` });
          for (const k of c.constraints) if (k.name) out.push({ kind: "constraint", key: `${qualified}.${k.name}`, name: k.name, export: exp, label: `constraint ${k.name} on ${qualified}` });
        } else if (c.kind === "index") {
          out.push({ kind: "index", key: qualified, name: c.name, export: exp, label: `index ${qualified}` });
        }
      }
    } else {
      for (const o of schemaFromBuildOutput(JSON.stringify(build), options.defaultDatabase ?? "default")) {
        const c = o.canonical;
        if (c.kind !== "table") continue;
        const qualified = c.database ? `${c.database}.${c.name}` : c.name;
        out.push({ kind: "table", key: qualified, name: c.name, export: o.key, label: `table ${qualified}` });
        for (const col of c.columns) out.push({ kind: "column", key: `${qualified}.${col.name}`, name: col.name, export: o.key, label: `column ${col.name} of ${qualified}` });
        for (const name of Object.keys(c.indexes)) out.push({ kind: "index", key: `${qualified}.${name}`, name, export: o.key, label: `index ${name} on ${qualified}` });
        for (const name of Object.keys(c.constraints)) out.push({ kind: "constraint", key: `${qualified}.${name}`, name, export: o.key, label: `constraint ${name} on ${qualified}` });
      }
    }
  } catch {
    return [];
  }
  return out;
}

export interface NamingFinding {
  rule: "naming";
  migration: string;
  step?: number;
  object?: string;
  message: string;
}

const PLURAL: Record<NamingKind, string> = { table: "tables", column: "columns", index: "indexes", constraint: "constraints" };

/** The names each migration adds that break `settings`. */
export function namingFindings(migrations: readonly Migration[], settings: NamingSettings): NamingFinding[] {
  if (Object.keys(settings).length === 0) return [];
  const byId = new Map(migrations.map((m) => [m.id, m]));
  const cache = new Map<string, Named[]>();
  const names = (m: Migration): Named[] => {
    let n = cache.get(m.id);
    if (!n) {
      n = schemaNames(m.document.schema, { defaultDatabase: m.document.defaultDatabase, defaultSchema: m.document.defaultSchema });
      cache.set(m.id, n);
    }
    return n;
  };
  const out: NamingFinding[] = [];
  for (const m of migrations) {
    const parent = m.parent === null ? undefined : byId.get(m.parent);
    const had = new Set((parent ? names(parent) : []).map((n) => `${n.kind}\u0000${n.key}`));
    for (const n of names(m)) {
      const rule = settings[n.kind];
      if (!rule || had.has(`${n.kind}\u0000${n.key}`) || rule.pattern.test(n.name)) continue;
      const step = m.document.steps.findIndex((s) => s.object === n.export);
      const at = step >= 0 ? m.document.steps[step] : undefined;
      out.push({
        rule: "naming",
        migration: m.id,
        message: `${step >= 0 ? `step ${String(step)}: ` : ""}${n.label}: ${JSON.stringify(n.name)} does not match the naming rule for ${PLURAL[n.kind]} (${NAMING_PRESETS[rule.rule] ? `${rule.rule}, ` : ""}${NAMING_PRESETS[rule.rule] ?? rule.rule})`,
        ...(step >= 0 ? { step } : {}),
        ...(at ? { object: at.name } : {}),
      });
    }
  }
  return out;
}
