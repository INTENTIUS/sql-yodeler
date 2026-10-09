/**
 * `yodel rebase` (#15): move a migration onto another parent, so two
 * branches that each added one can both merge.
 *
 * Two pull requests that each ran `yodel new` from the same newest
 * migration give it two children: a fork, which `readMigrations` refuses.
 * Rebasing moves one of them (the newer, unless named) and every migration
 * that follows it onto the end of the other branch, and rewrites each one's
 * `migration.json` and `migration.sql`:
 *
 * - its change is its recorded schema minus its old parent's recorded
 *   schema, object by object (keyed by export name, as chant's diff keys
 *   them);
 * - its new recorded schema is the new parent's recorded schema with that
 *   change applied: a three-way merge, base the old parent, ours the
 *   migration, theirs the new parent. For the usual case, two branches that
 *   change different objects, that is the schema the declared build has
 *   once both are merged;
 * - its statements are diffed again, from the new parent's recorded schema
 *   to the new recorded schema, and its checksum recomputed; a backfill
 *   step (#12) is kept at the end, and its module (one of the migration's
 *   own files, unchanged) counts in the new checksum.
 *
 * When both sides change the same object (by export name, or by the name it
 * has on the server) and do not make the same change, the rebase refuses
 * and names the object: no merge of two changes to one table is safe to
 * guess. The author resolves it by hand: delete the migration and run
 * `yodel new` again on top of the other branch.
 *
 * Ids are kept. The order is the chain of parent ids, never the ids'
 * timestamps, so a rebased migration whose timestamp is older than its new
 * parent's is in order; renaming it would change nothing about when it
 * runs and would break whatever already names it (a review, a branch,
 * another migration's parent).
 *
 * Pure apart from {@link writeRebase}: migrations in, the rewritten ones
 * out.
 */

import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { diffStatements, type SchemaStatements } from "@intentius/chant-lexicon-sql/migration-statements";
import { YodelError } from "../project.js";
import type { BuildOutput, BuiltObject } from "../chant/build.js";
import {
  computeChecksum,
  emptyBuild,
  MIGRATION_ID,
  MIGRATION_JSON,
  MIGRATION_SQL,
  normalizeLineEndings,
  renderMigrationSql,
  serializeDocument,
  sortKeys,
  verifyChecksum,
  type Migration,
  type MigrationDocument,
  type MigrationFiles,
} from "../migrations/index.js";
import { asBackfill } from "../steps/kinds.js";

/** Exit code: the rebase is refused (a conflict, hand edits, or a migration a history records). Nothing was written. */
export const REBASE_REFUSED = 4;

export interface RebaseOptions {
  /** The migration to move. Default: the newer child of the directory's one fork. */
  id?: string | undefined;
  /** Its new parent. Default: the end of the other branch of its fork. */
  onto?: string | undefined;
}

/** One migration as the rebase rewrites it. */
export interface RebasedMigration {
  id: string;
  dir: string;
  oldParent: string | null;
  parent: string;
  oldChecksum: string;
  checksum: string;
  document: MigrationDocument;
  files: MigrationFiles;
  statements: SchemaStatements;
  /** Its files differed from what yodel writes for it (an edit by hand, or a checksum that no longer matches): the rewrite drops that edit. */
  handEdited: boolean;
}

export interface RebasePlan {
  /** The migration moved; the ones after it in {@link rewritten} follow it, and move with it. */
  moved: string;
  from: string | null;
  onto: string;
  /** In chain order, the moved migration first. */
  rewritten: RebasedMigration[];
}

/** Nothing to rebase: the directory has no fork and no migration was named. */
export interface NothingToRebase {
  moved: undefined;
}

/** Two sides change one object differently. */
export class RebaseConflict extends YodelError {
  constructor(
    readonly migration: string,
    readonly objects: string[],
    message: string,
  ) {
    super(message, REBASE_REFUSED);
    this.name = "RebaseConflict";
  }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(sortKeys(a) ?? null) === JSON.stringify(sortKeys(b) ?? null);

/** Sorts migrations oldest first: by the id's timestamp, then `createdAt`, then id. */
function byAge(a: Migration, b: Migration): number {
  const stamp = (m: Migration) => MIGRATION_ID.exec(m.id)?.[1] ?? "";
  return stamp(a).localeCompare(stamp(b)) || (a.document.createdAt ?? "").localeCompare(b.document.createdAt ?? "") || a.id.localeCompare(b.id);
}

/**
 * The three-way merge of one migration's change onto a new base: `base1`
 * with every object `ours` changed from `base0` changed the same way.
 * Throws a {@link RebaseConflict} when `base1` (theirs) changed one of
 * those objects too, differently.
 */
export function mergeChange(base0: BuildOutput, ours: BuildOutput, base1: BuildOutput, label: { migration: string; theirs: string }): BuildOutput {
  if (ours.dialect !== base1.dialect) {
    throw new YodelError(`${label.migration} is ${ours.dialect}, but ${label.theirs} is ${base1.dialect}; a rebase stays in one dialect`);
  }
  const index = (b: BuildOutput) => new Map(b.objects.map((o) => [o.export, o]));
  const m0 = index(base0);
  const mo = index(ours);
  const m1 = index(base1);
  const changedFrom = (m: Map<string, BuiltObject>) => [...new Set([...m0.keys(), ...m.keys()])].filter((k) => !same(m0.get(k), m.get(k)));
  const ourChanged = changedFrom(mo);
  const theirChanged = new Set(changedFrom(m1));

  const conflicts = new Set(ourChanged.filter((k) => theirChanged.has(k) && !same(mo.get(k), m1.get(k))));
  // The same object under two export names: compare the names the diff gives each side's steps on the server.
  const touched = (to: BuildOutput) => {
    try {
      return diffStatements(base0, to).steps;
    } catch (e) {
      throw new YodelError(`${label.migration}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const theirNames = new Map(touched(base1).map((s) => [s.name, s.object]));
  for (const s of touched(ours)) {
    const theirs = theirNames.get(s.name);
    if (theirs !== undefined && theirs !== s.object) conflicts.add(`${s.object} / ${theirs}`);
  }

  const keys = [...new Set([...Object.keys(base0), ...Object.keys(ours)])].filter((k) => k !== "objects");
  for (const k of keys) {
    if (!same(base0[k], ours[k]) && !same(base0[k], base1[k]) && !same(ours[k], base1[k])) conflicts.add(`the build's ${k}`);
  }

  if (conflicts.size > 0) {
    const names = [...conflicts];
    throw new RebaseConflict(
      label.migration,
      names,
      `refused: ${label.migration} and ${label.theirs} both change ${names.join(", ")}, differently; rebase does not merge two changes to one object. ` +
        `Nothing was written. Resolve it by hand: delete ${label.migration}'s directory, then run yodel new from a declared schema that makes both changes.`,
    );
  }

  const objects = [...base1.objects];
  for (const k of ourChanged) {
    const o = mo.get(k);
    const at = objects.findIndex((x) => x.export === k);
    if (o === undefined) {
      if (at >= 0) objects.splice(at, 1);
    } else if (at >= 0) objects[at] = o;
    else objects.push(o);
  }
  const top = Object.fromEntries(
    [...new Set([...Object.keys(base1), ...keys])]
      .filter((k) => k !== "objects")
      .map((k) => [k, same(base0[k], ours[k]) ? base1[k] : ours[k]] as const)
      .filter(([, v]) => v !== undefined),
  );
  return { ...top, dialect: base1.dialect, objects };
}

/** A migration document's steps as chant's `SchemaStatements`, to render them again. */
export function statementsOf(doc: MigrationDocument): SchemaStatements {
  return {
    dialect: doc.dialect,
    ...(doc.defaultDatabase !== undefined ? { defaultDatabase: doc.defaultDatabase } : {}),
    ...(doc.defaultSchema !== undefined ? { defaultSchema: doc.defaultSchema } : {}),
    ...(doc.major !== undefined ? { major: doc.major } : {}),
    steps: doc.steps,
    refused: doc.refused,
    hints: doc.hints,
  };
}

/** Whether a migration's files are what yodel writes for its document: its SQL rendered from its steps, and its checksum matching. */
export function asWritten(m: Migration): boolean {
  return verifyChecksum(m).ok && normalizeLineEndings(m.files.sql) === renderMigrationSql(m.document, statementsOf(m.document));
}

/** Rewrites one migration onto a new parent whose recorded schema is `base1`. */
function rebaseOne(m: Migration, base0: BuildOutput, newParent: string, base1: BuildOutput, theirs: string): RebasedMigration {
  if (m.document.topology !== undefined && m.document.topology !== "single") {
    throw new YodelError(`${m.id} was rendered for ClickHouse topology ${m.document.topology}; yodel writes migrations for a single node and renders them per environment when applied, so it cannot rebase one written for a topology`);
  }
  const schema = mergeChange(base0, m.document.schema, base1, { migration: m.id, theirs });
  let statements: SchemaStatements;
  try {
    statements = diffStatements(base1, schema, {
      ...(m.document.defaultDatabase !== undefined ? { defaultDatabase: m.document.defaultDatabase } : {}),
      ...(m.document.defaultSchema !== undefined ? { defaultSchema: m.document.defaultSchema } : {}),
    });
  } catch (e) {
    throw new YodelError(`${m.id}: ${e instanceof Error ? e.message : String(e)}`);
  }
  // A backfill step (#12) is the author's, not the diff's: it keeps its place at the end, with its module.
  const kept = m.document.steps.filter((s) => asBackfill(s) !== undefined);
  if (kept.length > 0) statements = { ...statements, refused: true, steps: [...statements.steps, ...kept] };
  if (statements.steps.length === 0) {
    throw new YodelError(`${m.id} makes no change on top of ${newParent}: ${theirs} already makes it. Nothing was written; delete ${m.id}'s directory instead.`, REBASE_REFUSED);
  }
  const dropped = new Set(["defaultDatabase", "defaultSchema", "major", "topology"]);
  const rest = Object.fromEntries(Object.entries(m.document).filter(([k]) => !dropped.has(k)));
  const unsigned = {
    ...rest,
    parent: newParent,
    checksum: "",
    dialect: statements.dialect,
    ...(statements.defaultDatabase !== undefined ? { defaultDatabase: statements.defaultDatabase } : {}),
    ...(statements.defaultSchema !== undefined ? { defaultSchema: statements.defaultSchema } : {}),
    ...(statements.major !== undefined ? { major: statements.major } : {}),
    refused: statements.refused,
    hints: statements.hints,
    steps: statements.steps,
    schema,
  } as MigrationDocument;
  const sql = renderMigrationSql(unsigned, statements);
  const document: MigrationDocument = { ...unsigned, checksum: computeChecksum({ sql, json: unsigned, extra: m.files.extra }) };
  return {
    id: m.id,
    dir: m.dir,
    oldParent: m.parent,
    parent: newParent,
    oldChecksum: m.checksum,
    checksum: document.checksum,
    document,
    files: { sql, json: serializeDocument(document), ...(m.files.extra ? { extra: m.files.extra } : {}) },
    statements,
    handEdited: !asWritten(m),
  };
}

/**
 * What a rebase would write. `migrations` is every migration in the
 * directory (`scanMigrations(dir).migrations`: a fork is what this is for,
 * so `readMigrations` would refuse it). Throws a YodelError when the
 * migration or its new parent cannot be chosen, and a
 * {@link RebaseConflict} when one rewritten migration's change meets a
 * different change to the same object.
 */
export function planRebase(migrations: readonly Migration[], options: RebaseOptions = {}): RebasePlan | NothingToRebase {
  const byId = new Map(migrations.map((m) => [m.id, m]));
  const children = new Map<string | null, Migration[]>();
  for (const m of migrations) children.set(m.parent, [...(children.get(m.parent) ?? []), m]);
  const kids = (id: string | null) => [...(children.get(id) ?? [])].sort(byAge);
  const cycle = (id: string) => new YodelError(`${id} follows itself through its parents (a cycle); fix the parent ids by hand`);
  const get = (id: string, what: string): Migration => {
    const m = byId.get(id);
    if (!m) throw new YodelError(`${what} ${id} is not in the migrations directory`);
    return m;
  };

  /** The end of the branch that starts at `m`. */
  const tip = (m: Migration): Migration => {
    let at = m;
    const seen = new Set<string>();
    for (;;) {
      if (seen.has(at.id)) throw cycle(at.id);
      seen.add(at.id);
      const next = kids(at.id);
      if (next.length === 0) return at;
      if (next.length > 1) throw new YodelError(`the branch from ${m.id} forks again at ${at.id} (${next.map((n) => n.id).join(" and ")}); rebase that fork first, or name the new parent with --onto`);
      at = next[0] as Migration;
    }
  };

  let moved: Migration;
  if (options.id !== undefined) moved = get(options.id, "migration");
  else {
    const forks = [...children.entries()].filter(([, list]) => list.length > 1);
    if (forks.length === 0) return { moved: undefined };
    if (forks.length > 1) {
      throw new YodelError(
        `the migrations directory forks in more than one place; name the migration to move:\n${forks.map(([p, list]) => `  ${list.map((l) => l.id).join(" and ")} follow ${p ?? "nothing (each is a first migration)"}`).join("\n")}`,
      );
    }
    moved = (kids(forks[0]?.[0] ?? null).at(-1)) as Migration;
  }

  // The moved migration and every one after it: they move together.
  const chain: Migration[] = [moved];
  for (let next = kids(moved.id); next.length > 0; next = kids((chain.at(-1) as Migration).id)) {
    if (chain.some((c) => c.id === next[0]?.id)) throw cycle(moved.id);
    if (next.length > 1) throw new YodelError(`${(chain.at(-1) as Migration).id} has two children (${next.map((n) => n.id).join(" and ")}); rebase that fork first`);
    chain.push(next[0] as Migration);
  }
  const inChain = new Set(chain.map((m) => m.id));

  let onto: Migration;
  if (options.onto !== undefined) onto = get(options.onto, "--onto");
  else {
    const siblings = kids(moved.parent).filter((s) => s.id !== moved.id);
    if (siblings.length === 0) {
      throw new YodelError(`${moved.id} is not in a fork (nothing else follows ${moved.parent ?? "nothing"}); name its new parent with --onto <id>`);
    }
    onto = tip(siblings[0] as Migration);
  }
  if (inChain.has(onto.id)) throw new YodelError(`${moved.id} cannot be rebased onto ${onto.id}: ${onto.id === moved.id ? "itself" : "it follows " + moved.id}`);
  if (onto.id === moved.parent) throw new YodelError(`${moved.id} already follows ${onto.id}; nothing to rebase`);
  const ontoKids = kids(onto.id);
  if (ontoKids.length > 0) {
    throw new YodelError(`${ontoKids.map((k) => k.id).join(" and ")} already follow${ontoKids.length === 1 ? "s" : ""} ${onto.id}, so rebasing onto it would fork again; rebase onto the end of that branch, ${tip(onto).id}`);
  }

  const schemaOf = (id: string | null): BuildOutput => (id === null ? emptyBuild(moved.document.schema) : get(id, "parent").document.schema);
  const rewritten: RebasedMigration[] = [];
  const theirs = moved.parent === null ? `the chain ending at ${onto.id}` : `the migrations after ${moved.parent} up to ${onto.id}`;
  for (const m of chain) {
    const prev = rewritten.at(-1);
    const base1 = prev ? prev.document.schema : onto.document.schema;
    rewritten.push(rebaseOne(m, schemaOf(m.parent), prev ? prev.id : onto.id, base1, theirs));
  }
  return { moved: moved.id, from: moved.parent, onto: onto.id, rewritten };
}

/** Writes each rewritten migration over its files, each file through a temporary one renamed into place. */
export function writeRebase(plan: RebasePlan): void {
  for (const m of plan.rewritten) {
    for (const [name, text] of [
      [MIGRATION_SQL, m.files.sql],
      [MIGRATION_JSON, m.files.json],
    ] as const) {
      const path = join(m.dir, name);
      const tmp = join(m.dir, `.${name}.rebasing`);
      writeFileSync(tmp, text);
      renameSync(tmp, path);
    }
  }
}
