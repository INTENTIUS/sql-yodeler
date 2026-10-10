/**
 * Postgres functions, procedures and triggers in a migration (#44): the
 * objects of a Postgres build as chant's plan reads them, for lint.
 *
 * chant labels a trigger created on a table that already exists SQLPG283
 * (metadata: SHARE ROW EXCLUSIVE on the table) itself, and one created
 * with its table SQLPG200 create.
 */

import { pgSchemaFromBuildOutput } from "@intentius/chant-lexicon-sql/postgres/plan/schema";
import type { BuildOutput } from "../chant/build.js";

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
