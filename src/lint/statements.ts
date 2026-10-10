/**
 * The statement rules: each step of a migration against the class chant's
 * classifier gave it (`migration.json` records the rule and class of every
 * statement, and the changes an Op or manual step makes). Pure.
 *
 * - `destructive`: a statement marked destructive (a table or column drop),
 *   or an Op step one of whose changes is.
 * - `pg-access`: a Postgres statement that takes access away (#45): a
 *   privilege revoked (SQLPG297), a policy dropped (SQLPG292), row-level
 *   security turned off or no longer forced (SQLPG293). A revoke on an
 *   object the same migration creates (`REVOKE EXECUTE ... FROM PUBLIC` on
 *   a new function) takes nothing from anyone and is left out.
 * - `ch-mutation`: a ClickHouse statement of class `rewrite`, or one that
 *   waits for its mutation (a column type or TTL change).
 * - `ch-rebuild`: a `ClickHouseRebuildOp` step.
 * - `ch-access`: a ClickHouse statement that takes access away (#46): a
 *   privilege or role revoked (SQLCH274). ClickHouse takes no `REVOKE`
 *   declaration, so each one revokes what a grantee holds and no
 *   declaration grants any more.
 * - `pg-rewrite`: a Postgres statement of class `rewrite` (ACCESS EXCLUSIVE
 *   for a rewrite or a full scan).
 * - `pg-lock`: a Postgres statement that blocks writes for a whole build or
 *   scan: an index created or dropped on an existing table without
 *   `CONCURRENTLY` (SQLPG240 to SQLPG243), a primary key or unique
 *   constraint built in place rather than `USING INDEX` (SQLPG221), a
 *   foreign key or domain constraint validated in place rather than added
 *   `NOT VALID` (SQLPG219, SQLPG262).
 *
 * - `data-dependent`: a Postgres statement chant marks as able to fail on
 *   the rows already there (its `precheck`: a unique index over
 *   duplicates, SET NOT NULL over NULLs, a check or foreign key a row
 *   breaks). The finding shows the pre-check, which yodel apply runs before
 *   the migration's first statement and refuses on when it is not 0.
 *
 * `COMMENT ON` statements are skipped: chant writes one after a `CREATE`
 * with the same rule, and a comment is catalog only.
 *
 * A statement whose rule is not one of the lexicon's, or a step of a kind
 * it does not know, is `unreadable-object`: lint cannot tell what it does,
 * and never passes what it cannot read.
 */

import type { MigrationStep } from "@intentius/chant-lexicon-sql/migration-statements";
import { CLASSIFIER_RULES } from "@intentius/chant-lexicon-sql/clickhouse/plan/rules";
import { PG_CLASSIFIER_RULES } from "@intentius/chant-lexicon-sql/postgres/plan/rules";
import { planStep, REBUILD_OP } from "../steps/kinds.js";
import { takesAccessAway } from "../chant/access.js";

export type Dialect = "clickhouse" | "postgres";

export interface StepFinding {
  rule: string;
  message: string;
}

interface CatalogRule {
  id: string;
  class: string;
  title: string;
  restriction: string;
}

const catalog = (dialect: Dialect): Readonly<Record<string, CatalogRule>> => (dialect === "clickhouse" ? CLASSIFIER_RULES : PG_CLASSIFIER_RULES);

/** The classifier rule's id and title, e.g. `SQLCH202 Drop a column`. */
function titled(dialect: Dialect, rule: string): string {
  const r = catalog(dialect)[rule];
  return r ? `${rule} ${r.title}` : rule;
}

const COMMENT = /^\s*COMMENT\s+ON\b/i;
const INDEX_DDL = /^\s*(?:CREATE\s+(?:UNIQUE\s+)?INDEX|DROP\s+INDEX|REINDEX)\b/i;
const CONCURRENTLY = /\bCONCURRENTLY\b/i;
const NOT_VALID = /\bNOT\s+VALID\b/i;
const USING_INDEX = /\bUSING\s+INDEX\b/i;
const ALTER_TABLE = /^\s*ALTER\s+TABLE\b/i;

/** Why a Postgres statement blocks writes for a whole build or scan, or `undefined`. */
function pgLock(step: Extract<MigrationStep, { kind: "statement" }>): string | undefined {
  const sql = step.sql;
  if (step.class === "create") return undefined; // an index on a table created in the same migration blocks nobody
  if (["SQLPG221", "SQLPG240", "SQLPG241", "SQLPG242", "SQLPG243"].includes(step.rule) && INDEX_DDL.test(sql) && !CONCURRENTLY.test(sql)) {
    return /^\s*DROP/i.test(sql)
      ? "drops an index without CONCURRENTLY: ACCESS EXCLUSIVE on the table, blocking reads and writes behind it; use DROP INDEX CONCURRENTLY"
      : "builds an index without CONCURRENTLY: SHARE on the table, blocking every write until the build ends; declare the index CONCURRENTLY";
  }
  if (step.rule === "SQLPG221" && ALTER_TABLE.test(sql) && !USING_INDEX.test(sql)) {
    return "builds the constraint's index under ACCESS EXCLUSIVE; build a unique index CONCURRENTLY first, then ADD CONSTRAINT ... USING INDEX";
  }
  if (step.rule === "SQLPG219" && !NOT_VALID.test(sql)) {
    return "reads every row under SHARE ROW EXCLUSIVE on both tables, blocking writes to them for the scan; add it NOT VALID and validate it in a later migration";
  }
  if (step.rule === "SQLPG262" && !NOT_VALID.test(sql)) {
    return "checks every column of the domain's type in every table while it holds its lock; add it NOT VALID and validate it later";
  }
  return undefined;
}

/** What lint cannot read in a step, or `undefined`. */
export function unreadableStep(dialect: Dialect, step: MigrationStep): string | undefined {
  const kind = (step as { kind?: unknown }).kind;
  if (kind !== "statement" && kind !== "op" && kind !== "manual") return `a step of kind ${JSON.stringify(kind)}, which is not statement, op or manual`;
  if (step.kind === "statement") {
    if (typeof step.sql !== "string" || step.sql.trim() === "") return "a statement step with no SQL";
    const known = catalog(dialect)[step.rule];
    return known ? undefined : `a statement whose rule ${JSON.stringify(step.rule)} is not one of the ${dialect} classifier's, so what it does cannot be checked`;
  }
  for (const c of step.changes) {
    if (!catalog(dialect)[c.rule]) return `a ${step.kind} step whose change ${JSON.stringify(c.rule)} is not one of the ${dialect} classifier's rules`;
  }
  return undefined;
}

/** What a step is read with: the names of the objects its migration creates (`schema.table`, `schema.fn(args)`), from {@link createdObjects}. */
export interface StepContext {
  created?: ReadonlySet<string>;
}

const CREATE = /^\s*CREATE\b/i;
const REVOKE_ON = /\bON\s+(?:TABLE|SEQUENCE|FUNCTION|PROCEDURE|ROUTINE|SCHEMA)\s+(.+?)\s+FROM\b/is;

/** The objects a migration's statements create, by the name each step carries. */
export function createdObjects(steps: readonly MigrationStep[]): Set<string> {
  return new Set(steps.flatMap((s) => (s.kind === "statement" && s.class === "create" && CREATE.test(s.sql) ? [s.name.replace(/\s+/g, "")] : [])));
}

/** A REVOKE on an object `created` holds: nobody had the privilege before the migration. */
function revokesOnNew(step: Extract<MigrationStep, { kind: "statement" }>, created: ReadonlySet<string> | undefined): boolean {
  if (step.rule !== "SQLPG297" || !created || created.size === 0) return false;
  const on = REVOKE_ON.exec(step.sql)?.[1];
  return on !== undefined && on.split(",").every((n) => created.has(n.replace(/\s+/g, "")));
}

/** The statement-rule findings for one step, before levels and silences. */
export function stepFindings(dialect: Dialect, step: MigrationStep, context: StepContext = {}): StepFinding[] {
  const out: StepFinding[] = [];
  if (step.kind === "statement") {
    if (COMMENT.test(step.sql)) return out;
    const what = `${titled(dialect, step.rule)} on ${step.name}`;
    if (step.destructive) out.push({ rule: "destructive", message: `${what}: removes data that cannot be recovered` });
    if (dialect === "clickhouse" && (step.class === "rewrite" || step.waitsForMutation === true)) {
      out.push({ rule: "ch-mutation", message: `${what}: a mutation that rewrites existing parts in the background, with no rollback` });
    }
    if (dialect === "clickhouse") {
      const away = takesAccessAway(step);
      if (away) out.push({ rule: "ch-access", message: `${what}: ${away}, which changes what a user or role can do: ${step.sql.split("\n")[0] ?? ""}` });
    }
    if (dialect === "postgres") {
      if (step.class === "rewrite") {
        const r = catalog(dialect)[step.rule];
        out.push({ rule: "pg-rewrite", message: `${what}: blocks reads and writes on the table while it runs${r ? ` (${r.restriction})` : ""}` });
      }
      const lock = pgLock(step);
      if (lock) out.push({ rule: "pg-lock", message: `${what}: ${lock}` });
      if (step.precheck) out.push({ rule: "data-dependent", message: `${what}: can fail on the rows already there (${step.precheck.detail}); yodel apply runs this pre-check before the migration's first statement and refuses when it is not 0: ${step.precheck.sql}` });
      const away = takesAccessAway(step);
      if (away && !revokesOnNew(step, context.created)) out.push({ rule: "pg-access", message: `${what}: ${away}, which changes what a role can do: ${step.sql.split("\n")[0] ?? ""}` });
    }
    return out;
  }
  if (step.kind === "op") {
    const destructive = step.changes.filter((c) => c.destructive);
    if (destructive.length > 0) {
      out.push({ rule: "destructive", message: `${step.op} for ${step.name} removes data that cannot be recovered: ${destructive.map((c) => `${titled(dialect, c.rule)} (${c.field})`).join(", ")}` });
    }
    if (step.op === REBUILD_OP) {
      const why = step.changes.filter((c) => c.class === "rebuild").map((c) => `${titled(dialect, c.rule)} (${c.field})`);
      out.push({ rule: "ch-rebuild", message: `${REBUILD_OP} rebuilds ${step.name}: every row is copied into a new table and swapped in${why.length > 0 ? `, for ${why.join(", ")}` : ""}` });
    }
  }
  return out;
}

/** Why yodel apply refuses a step, or `undefined` for one it runs. */
export function refusedStep(step: MigrationStep): string | undefined {
  const plan = planStep(step);
  return plan.run === "refused" ? plan.reason : undefined;
}
