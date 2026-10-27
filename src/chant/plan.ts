/**
 * The plan: the classified change from an environment's live database to the
 * declared schema. This is `chant sql plan <env> <build>`, called as the
 * library functions that command runs (`planAgainstServer` for ClickHouse,
 * `planPgAgainstServer` for Postgres) rather than through the CLI.
 */

import type { SchemaDiff } from "@intentius/chant-lexicon-sql/clickhouse/plan/diff";
import type { PgSchemaDiff } from "@intentius/chant-lexicon-sql/postgres/plan/diff";
import type { ClassifiedChange } from "@intentius/chant-lexicon-sql/core/classifier";
import { YodelError, type Environment, type Project, type SqlDialect } from "../project.js";
import type { Build } from "./build.js";
import { EXIT_WAITING, EXIT_FAILED } from "../exit.js";

/** A plan for one environment, in either dialect. */
export interface Plan {
  environment: string;
  dialect: SqlDialect;
  /** chant's own diff, as `chant sql plan --json` prints it. */
  diff: SchemaDiff | PgSchemaDiff;
  /**
   * The changes the plan refuses to make in place, each of which needs its
   * own Op: a ClickHouse rebuild (`rebuilds`, run as `ClickHouseRebuildOp`)
   * or a Postgres expand-and-contract change (`refused`, run as
   * `PostgresMigrationOp`).
   */
  refused: ClassifiedChange[];
}


/**
 * `1` when a live object in the declared databases could not be read
 * (chant's `unreadable`, an object whose definition does not parse, #46): a
 * plan that cannot say what it would do to it is not one to apply. `3` when
 * any change needs its own Op, which a person runs. `0` otherwise.
 */
export function planExitCode(plan: Plan): number {
  if (unreadableOf(plan).length > 0) return EXIT_FAILED;
  return plan.refused.length > 0 ? EXIT_WAITING : 0;
}

/** The live objects a ClickHouse plan could not read, as chant names them. */
export const unreadableOf = (plan: Plan): Array<{ object: string; type: string; reason: string }> => (plan.dialect === "clickhouse" ? ((plan.diff as SchemaDiff).unreadable ?? []) : []);

/**
 * The changes to objects the build declares. A plan also lists live objects
 * the project does not declare, as drops; an ApplyOp never touches those
 * (it only prunes objects carrying chant's marker), so they are not work
 * left for apply. chant labels a declared object `<export> (<name>)` and an
 * undeclared one by its name alone. A privilege change (#45) is labelled by
 * its ACL entry (`relation app.t TO reader`); chant plans one only where the
 * environment manages access, always on a declared object, and the apply
 * makes it, so it is work too. So is a ClickHouse grantee's grants (#46),
 * labelled `grants <grantee>`: chant reads only the grantees the build
 * declares a grant to.
 */
export function declaredChanges(plan: Plan, build: Build): ClassifiedChange[] {
  const exports = new Set(build.output.objects.map((o) => o.export));
  return plan.diff.changes.filter((c) => {
    if (PRIVILEGE_RULES.has(c.rule)) return true;
    if (plan.dialect === "clickhouse" && c.object.startsWith("grants ")) return true;
    const at = c.object.indexOf(" (");
    return at > 0 && c.object.endsWith(")") && exports.has(c.object.slice(0, at));
  });
}

/** chant's rules for a privilege granted, revoked, or a default privilege changed. */
const PRIVILEGE_RULES = new Set(["SQLPG296", "SQLPG297", "SQLPG298"]);

/** The plan as `yodel plan --json` prints it: chant's diff, with the environment and dialect it is of. */
export function planJson(plan: Plan): Record<string, unknown> {
  return { environment: plan.environment, dialect: plan.dialect, ...plan.diff };
}

function bindError(e: unknown): YodelError {
  return new YodelError(e instanceof Error ? e.message : String(e));
}

/** Plans `build` against the server `sql.profiles.<env>` binds. */
export async function planEnvironment(project: Project, env: Environment, build: Build, options: { env?: NodeJS.ProcessEnv } = {}): Promise<Plan> {
  const bind = { config: project.config as never, cwd: project.dir, ...(options.env ? { env: options.env } : {}) };
  try {
    if (project.dialect === "postgres") {
      const { planPgAgainstServer } = await import("@intentius/chant-lexicon-sql/postgres/plan/commands");
      const diff = await planPgAgainstServer(env.name, build.path, bind);
      return { environment: env.name, dialect: "postgres", diff, refused: diff.refused };
    }
    const { planAgainstServer } = await import("@intentius/chant-lexicon-sql/clickhouse/plan/commands");
    const diff = await planAgainstServer(env.name, build.path, bind);
    return { environment: env.name, dialect: "clickhouse", diff, refused: diff.rebuilds };
  } catch (e) {
    throw bindError(e);
  }
}

/** The plan as text, chant's own report for the dialect. */
export async function renderPlan(plan: Plan, title: string): Promise<string> {
  if (plan.dialect === "postgres") {
    const { renderPgDiff } = await import("@intentius/chant-lexicon-sql/postgres/plan/report");
    return renderPgDiff(plan.diff as PgSchemaDiff, { title });
  }
  const { renderDiff } = await import("@intentius/chant-lexicon-sql/clickhouse/plan/report");
  return renderDiff(plan.diff as SchemaDiff, { title });
}
