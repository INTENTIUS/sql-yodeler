/**
 * Making the next migration, offline: the newest migration's recorded
 * schema (or an empty schema, for the first) diffed against the current
 * build with chant's `diffStatements`. No server is read. The statements
 * are written for a single node and the migration records no topology: it
 * is rendered for each environment's topology when it is applied (#9). Pure: nothing
 * here touches the disk; `yodel new` writes what it returns with
 * `writeMigration`.
 */

import { diffStatements, renderStatements, type DiffStatementsOptions, type SchemaStatements } from "@intentius/chant-lexicon-sql/migration-statements";
import { YodelError } from "../project.js";
import type { BuildOutput } from "../chant/build.js";
import { computeChecksum } from "./checksum.js";
import { MIGRATION_FORMAT, serializeDocument, type MigrationCheck, type MigrationDocument, type MigrationFiles, type MigrationStep } from "./document.js";
import { MIGRATION_NAME, type Migration } from "./directory.js";
import { asBackfill, BACKFILL_FILE } from "../steps/kinds.js";
import { backfillStep } from "../steps/backfill.js";

export interface CreateMigrationOptions {
  /** The migration's name, the part of its id after the timestamp. */
  name: string;
  /** The current `chant build` output: the schema after the migration. */
  build: BuildOutput;
  /** The newest migration, which the new one follows; `undefined` for the first. */
  previous?: Migration | undefined;
  /** When it is made. Default: now. Its UTC minute is the id's timestamp. */
  now?: Date;
  /** The ownership marker each `CREATE` carries. Default: chant's, `managed-by=chant`. */
  marker?: DiffStatementsOptions["marker"];
  /** ClickHouse: the database a bare name means. Default: chant's, `default`. */
  defaultDatabase?: string;
  /** Postgres: the schema a bare name means. Default: chant's, `public`. */
  defaultSchema?: string;
  /**
   * A backfill step to end the migration with (#12): the module's text,
   * written into the migration's directory as `file` (default `backfill.ts`)
   * and counted in its checksum. With one, a migration is made even when the
   * build has no schema change.
   */
  backfill?: { text: string; file?: string };
  /** Pre-migration checks (#52), written to `migration.json`. */
  checks?: MigrationCheck[];
}

export interface CreatedMigration {
  id: string;
  document: MigrationDocument;
  files: MigrationFiles;
  statements: SchemaStatements;
}

/** What {@link createMigration} returns when the build has no change from the recorded schema. */
export interface NoChange {
  id: undefined;
  statements: SchemaStatements;
}

/** `YYYYMMDDTHHMM` in UTC. */
export function migrationTimestamp(now: Date): string {
  const iso = now.toISOString(); // 2026-10-09T14:12:34.567Z
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}`;
}

/** `<YYYYMMDDTHHMM>-<name>`, or an error for a name that is not lowercase words joined by `-` or `_`. */
export function migrationId(name: string, now: Date): string {
  if (!MIGRATION_NAME.test(name)) {
    throw new YodelError(`migration name "${name}": use lowercase letters and digits, words joined by - or _ (e.g. add-country)`);
  }
  return `${migrationTimestamp(now)}-${name}`;
}

/**
 * The schema before the first migration: a build of the same dialect with no
 * objects. `diffStatements` takes two build outputs and has no form for
 * "nothing", so this is one. A Postgres build's `postgresMajor` is kept, so
 * both sides classify for the same major.
 */
export function emptyBuild(like: BuildOutput): BuildOutput {
  return {
    dialect: like.dialect,
    objects: [],
    ...(typeof like.postgresMajor === "number" ? { postgresMajor: like.postgresMajor } : {}),
  };
}

/** The steps that are not statements: each Op or manual step, which a person has to act on. */
export const refusedSteps = (steps: readonly MigrationStep[]): Exclude<MigrationStep, { kind: "statement" }>[] =>
  steps.filter((s): s is Exclude<MigrationStep, { kind: "statement" }> => s.kind !== "statement");

function describeRefused(s: Exclude<MigrationStep, { kind: "statement" }>): string {
  const backfill = asBackfill(s);
  if (backfill) return `a backfill: the Op ${backfill.options.file} exports, its effect() batches resumable from their receipts`;
  const rules = s.changes.map((c) => c.rule).join(", ");
  return s.kind === "op"
    ? `${s.op} for ${s.object} (${s.name}), ${rules}: not SQL; migration.json holds its declaration`
    : `a manual step for ${s.object} (${s.name}), ${rules}: no statement and no Op makes it`;
}

/** `migration.sql`: a header naming the migration, its parent, any Op or manual step and the diff's hints, then chant's rendered statements. */
export function renderMigrationSql(doc: Pick<MigrationDocument, "id" | "parent" | "hints">, statements: SchemaStatements): string {
  const head = [`-- yodel migration ${doc.id}`, `-- parent: ${doc.parent ?? "none (the first migration)"}`];
  const refused = refusedSteps(statements.steps);
  if (refused.length > 0) {
    head.push(`-- This migration contains ${refused.some((s) => s.kind === "op") ? "an Op step" : "a manual step"}, not only SQL:`);
    for (const s of refused) head.push(`--   ${describeRefused(s)}`);
  }
  for (const h of doc.hints) head.push(`-- hint: ${h.replace(/\r?\n/g, " ")}`);
  const body = statements.steps
    .map((s) => {
      const backfill = asBackfill(s);
      return backfill ? `-- ${backfill.object} (${backfill.name}): made by the Op ${backfill.options.file} exports, not a statement\n` : renderStatements({ ...statements, steps: [s] });
    })
    .join("\n")
    .replace(/\n+$/, "");
  return `${head.join("\n")}\n\n${body}\n`;
}

/**
 * The next migration, or a {@link NoChange} when the build declares the
 * schema the previous migration recorded. Throws a YodelError when the
 * recorded schema and the build are different dialects.
 */
export function createMigration(options: CreateMigrationOptions): CreatedMigration | NoChange {
  const now = options.now ?? new Date();
  const id = migrationId(options.name, now);
  const before = options.previous?.document.schema ?? emptyBuild(options.build);
  let statements: SchemaStatements;
  try {
    statements = diffStatements(before, options.build, {
      ...(options.marker ? { marker: options.marker } : {}),
      ...(options.defaultDatabase !== undefined ? { defaultDatabase: options.defaultDatabase } : {}),
      ...(options.defaultSchema !== undefined ? { defaultSchema: options.defaultSchema } : {}),
    });
  } catch (e) {
    throw new YodelError(e instanceof Error ? e.message : String(e));
  }
  if (options.backfill) {
    const file = options.backfill.file ?? BACKFILL_FILE;
    statements = { ...statements, refused: true, steps: [...statements.steps, backfillStep(options.name, file) as unknown as MigrationStep] };
  }
  if (statements.steps.length === 0) return { id: undefined, statements };

  const unsigned: MigrationDocument = {
    format: MIGRATION_FORMAT,
    id,
    parent: options.previous?.id ?? null,
    checksum: "",
    createdAt: `${now.toISOString().slice(0, 19)}Z`,
    dialect: statements.dialect,
    ...(statements.defaultDatabase !== undefined ? { defaultDatabase: statements.defaultDatabase } : {}),
    ...(statements.defaultSchema !== undefined ? { defaultSchema: statements.defaultSchema } : {}),
    ...(statements.major !== undefined ? { major: statements.major } : {}),
    refused: statements.refused,
    hints: statements.hints,
    ...(options.checks && options.checks.length > 0 ? { checks: options.checks } : {}),
    steps: statements.steps,
    schema: options.build,
  };
  const sql = renderMigrationSql(unsigned, statements);
  const extra = options.backfill ? { [options.backfill.file ?? BACKFILL_FILE]: options.backfill.text } : undefined;
  const document: MigrationDocument = { ...unsigned, checksum: computeChecksum({ sql, json: unsigned, extra }) };
  return { id, document, files: { sql, json: serializeDocument(document), ...(extra ? { extra } : {}) }, statements };
}
