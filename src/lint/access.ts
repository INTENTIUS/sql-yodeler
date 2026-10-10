/**
 * `pg-rls-not-forced` (#45): a migration that turns row-level security on
 * for a table its recorded schema does not also force it on. Postgres does
 * not apply a table's policies to the table's owner unless the table has
 * `FORCE ROW LEVEL SECURITY`, and the owner is usually the role that
 * applies the migrations, so a query run as that role sees every row.
 *
 * Read from the migration's steps and its recorded schema, no server. Each
 * table is reported once, at the step that enables its row-level security.
 */

import type { MigrationStep } from "@intentius/chant-lexicon-sql/migration-statements";
import type { MigrationDocument } from "../migrations/index.js";
import { pgObjects } from "../migrations/routines.js";

export interface AccessFinding {
  rule: "pg-rls-not-forced";
  step: number;
  message: string;
}

const ENABLE = /\bENABLE\s+ROW\s+LEVEL\s+SECURITY\b/i;

/** The row-level-security findings of one Postgres migration. */
export function accessFindings(doc: Pick<MigrationDocument, "steps" | "schema" | "defaultSchema">): AccessFinding[] {
  const out: AccessFinding[] = [];
  let tables: Map<string, Record<string, unknown>> | undefined;
  const seen = new Set<string>();
  doc.steps.forEach((s: MigrationStep, i) => {
    if (s.kind !== "statement" || s.type !== "Postgres::Table" || !ENABLE.test(s.sql) || seen.has(s.name)) return;
    seen.add(s.name);
    tables ??= new Map(pgObjects(doc.schema, doc.defaultSchema).filter((o) => o.kind === "table").map((o) => [o.qualified, o.fields]));
    const fields = tables.get(s.name);
    if (fields === undefined || fields.forceRowSecurity === true) return;
    out.push({
      rule: "pg-rls-not-forced",
      step: i,
      message: `step ${String(i)}: ${s.name} has row-level security enabled but not forced, so its owner (often the role that applies) is not held to its policies; add ALTER TABLE ... FORCE ROW LEVEL SECURITY to its declaration`,
    });
  });
  return out;
}
