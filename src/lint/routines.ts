/**
 * Postgres functions, procedures and triggers in a migration (#44), each
 * read with the migration's other steps and its recorded schema:
 *
 * - `pg-signature`: a function or procedure dropped and created with a
 *   changed signature. chant's SQLPG281 (the parameter types, the result,
 *   an output parameter, an input parameter's name or a removed default,
 *   which CREATE OR REPLACE refuses), or a routine dropped and another of the
 *   same name created in the same migration. A caller written for the old
 *   signature fails, or calls another overload, once it runs.
 * - `pg-routine-in-use`: a function dropped while a trigger the migration's
 *   recorded schema declares still executes it. The DROP fails on the
 *   server (the trigger depends on it), and if the trigger is dropped by
 *   hand first, writes to its table stop firing it.
 *
 * Pure: what the step and the migration hold, no server.
 */

import type { MigrationStep } from "@intentius/chant-lexicon-sql/migration-statements";
import type { MigrationDocument } from "../migrations/index.js";
import { pgObjects } from "../migrations/routines.js";

export interface RoutineFinding {
  rule: "pg-signature" | "pg-routine-in-use";
  /** The step it is about. */
  step: number;
  message: string;
}

const PG_FUNCTION = "Postgres::Function";
const ROUTINE = new Set([PG_FUNCTION, "Postgres::Procedure"]);

type Statement = Extract<MigrationStep, { kind: "statement" }>;

const isStatement = (s: MigrationStep): s is Statement => s.kind === "statement";

/** `schema.name(types)` without its parameter list. */
const bare = (name: string): string => name.replace(/\(.*\)\s*$/, "");

/** `schema.name(types)`'s parameter list, `()` when it has none. */
const params = (name: string): string => /\(.*\)\s*$/.exec(name)?.[0] ?? "()";

const isDrop = (s: Statement): boolean => /^\s*DROP\s+(FUNCTION|PROCEDURE)\b/i.test(s.sql);
const isCreate = (s: Statement): boolean => /^\s*CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE)\b/i.test(s.sql);

/** The routine findings of one Postgres migration. */
export function routineFindings(doc: Pick<MigrationDocument, "steps" | "schema" | "defaultSchema">): RoutineFinding[] {
  const out: RoutineFinding[] = [];
  const steps = doc.steps;
  let triggers: ReturnType<typeof pgObjects> | undefined;

  steps.forEach((s, i) => {
    if (!isStatement(s) || !ROUTINE.has(s.type) || !isDrop(s)) return;
    const kind = s.type === PG_FUNCTION ? "function" : "procedure";

    if (s.rule === "SQLPG281") {
      const was = /^\s*DROP\s+(?:FUNCTION|PROCEDURE)\s+(.+?)\s*;?\s*$/is.exec(s.sql)?.[1] ?? s.name;
      out.push({ rule: "pg-signature", step: i, message: `step ${String(i)}: SQLPG281 drops ${kind} ${was} and creates it as ${s.name}: its signature or result changes, which CREATE OR REPLACE refuses; a caller written for the old one fails once this runs` });
    } else if (s.rule === "SQLPG270") {
      const dropped = s.name;
      const recreated = steps.find((o): o is Statement => isStatement(o) && o.type === s.type && isCreate(o) && bare(o.name) === bare(dropped) && params(o.name) !== params(dropped));
      if (recreated) {
        out.push({ rule: "pg-signature", step: i, message: `step ${String(i)}: drops ${kind} ${dropped} and creates ${recreated.name}: the signature changes, and a caller written for ${params(dropped)} fails once this runs` });
      }
    }

    // A trigger function takes no declared parameters.
    if (s.type !== PG_FUNCTION || params(s.name).replace(/\s/g, "") !== "()") return;
    if (s.rule === "SQLPG281") return; // created again in the same transaction
    const fn = bare(s.name);
    triggers ??= pgObjects(doc.schema, doc.defaultSchema).filter((o) => o.kind === "trigger");
    for (const t of triggers.filter((o) => o.fields.function === fn)) {
      out.push({
        rule: "pg-routine-in-use",
        step: i,
        message: `step ${String(i)}: drops function ${s.name}, which trigger ${t.export} (${t.qualified.split(".").pop() ?? t.qualified} ON ${String(t.fields.table)}) still executes; the DROP fails while the trigger depends on it. Declare the function again, or drop the trigger in the same migration`,
      });
    }
  });
  return out;
}
