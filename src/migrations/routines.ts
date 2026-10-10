/**
 * Postgres functions, procedures and triggers in a migration (#44).
 *
 * chant's `diffStatements` classifies a trigger created on a table that
 * already exists as SQLPG283 (metadata: SHARE ROW EXCLUSIVE on the table),
 * but labels the `CREATE TRIGGER` statement it writes for it SQLPG200
 * create, as if the table were new. A plan policy or a reviewer reading
 * `create` would take it for a statement that blocks nobody, so `yodel new`
 * gives those statements the change's rule and class.
 */

import type { SchemaStatements } from "@intentius/chant-lexicon-sql/migration-statements";
import { PG_CLASSIFIER_RULES } from "@intentius/chant-lexicon-sql/postgres/plan/rules";
import { pgSchemaFromBuildOutput } from "@intentius/chant-lexicon-sql/postgres/plan/schema";
import type { BuildOutput } from "../chant/build.js";

export const PG_TRIGGER = "Postgres::Trigger";

/** A Postgres build's objects as chant's plan reads them: kind, schema-qualified names, a trigger's table and function. */
export interface PgObject {
  export: string;
  kind: string;
  /** `schema.name`. */
  qualified: string;
  /** A routine's parameter types, `(bigint,integer)`. */
  signature?: string;
  fields: Record<string, unknown>;
}

/** The objects of a Postgres build, canonical; `[]` for a build the lexicon cannot read (lint reports that on its own). */
export function pgObjects(build: BuildOutput, defaultSchema = "public"): PgObject[] {
  if (build.dialect !== "postgres" || !Array.isArray(build.objects)) return [];
  try {
    return pgSchemaFromBuildOutput(JSON.stringify(build), defaultSchema).map((o) => {
      const c = o.canonical;
      return {
        export: c.exportName ?? o.key,
        kind: c.kind,
        qualified: c.schema ? `${c.schema}.${c.name}` : c.name,
        ...(c.kind === "function" || c.kind === "procedure" ? { signature: c.signature ?? "()" } : {}),
        fields: c.fields,
      };
    });
  } catch {
    return [];
  }
}

/**
 * The statements with each `CREATE TRIGGER` on a table `before` already
 * declares (and its `COMMENT ON TRIGGER`) labelled SQLPG283, the rule the
 * diff gave the change, in place of SQLPG200 create.
 */
export function relabelTriggerCreates(statements: SchemaStatements, before: BuildOutput, after: BuildOutput): SchemaStatements {
  if (statements.dialect !== "postgres") return statements;
  const schema = statements.defaultSchema ?? "public";
  const tables = new Set(pgObjects(before, schema).filter((o) => o.kind === "table").map((o) => o.qualified));
  if (tables.size === 0) return statements;
  const onExisting = new Set(
    pgObjects(after, schema)
      .filter((o) => o.kind === "trigger" && tables.has(String(o.fields.table)))
      .map((o) => o.export),
  );
  if (onExisting.size === 0) return statements;
  const rule = PG_CLASSIFIER_RULES.SQLPG283;
  const steps = statements.steps.map((s) =>
    s.kind === "statement" && s.type === PG_TRIGGER && s.rule === "SQLPG200" && s.class === "create" && onExisting.has(s.object) ? { ...s, rule: rule.id, class: rule.class } : s,
  );
  return { ...statements, steps };
}
