/**
 * Checkpoints (#63): a migration that creates its parent's recorded schema
 * from nothing, so a new environment starts there instead of running the
 * whole chain.
 *
 * `yodel checkpoint <name>` writes one after the newest migration. Its
 * steps are the diff from an empty schema to the parent's recorded schema
 * (what `yodel new` writes for a first migration), its recorded schema is
 * the parent's, and `migration.json` marks it with
 * `checkpoint: { schema: <sha256 of that recorded schema> }`. The mark and
 * the recorded schema are in its checksum like every other value.
 *
 * How an environment treats one is `../versioned/state.ts`'s: an
 * environment whose history is empty starts at the newest checkpoint and
 * never runs the migrations before it; one that already ran the chain skips
 * the checkpoint. `yodel lint` checks that a checkpoint's recorded schema
 * is still its parent's (rule `checkpoint`, offline), and `--replay` that
 * its statements, run into an empty database, give that schema.
 */

import { createHash } from "node:crypto";
import { diffStatements, type SchemaStatements } from "@intentius/chant-lexicon-sql/migration-statements";
import { YodelError } from "../project.js";
import type { BuildOutput } from "../chant/build.js";
import { computeChecksum } from "./checksum.js";
import { emptyBuild, migrationId, refusedSteps, renderMigrationSql } from "./create.js";
import { MIGRATION_FORMAT, serializeDocument, sortKeys, type MigrationDocument, type MigrationFiles } from "./document.js";
import type { Migration } from "./directory.js";

/** `sha256:<hex>` of a recorded schema, over its JSON with every object's keys sorted. */
export function schemaSha(schema: BuildOutput): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(sortKeys(schema)), "utf8").digest("hex")}`;
}

/** Whether a migration is a checkpoint. */
export const isCheckpoint = (m: Pick<Migration, "document">): boolean => m.document.checkpoint !== undefined;

export interface CreatedCheckpoint {
  id: string;
  document: MigrationDocument;
  files: MigrationFiles;
  statements: SchemaStatements;
}

/**
 * The checkpoint that follows `parent`: statements that create `parent`'s
 * recorded schema in an empty database. Throws a YodelError when that
 * schema is empty, or when making it takes a step that is not a statement.
 */
export function createCheckpoint(options: { name: string; parent: Migration; now?: Date }): CreatedCheckpoint {
  const { parent } = options;
  const now = options.now ?? new Date();
  const id = migrationId(options.name, now);
  const schema = parent.document.schema;
  if (!Array.isArray(schema.objects) || schema.objects.length === 0) {
    throw new YodelError(`${parent.id}'s recorded schema declares nothing; there is nothing for a checkpoint to create`);
  }
  const before = emptyBuild(schema);
  let statements: SchemaStatements;
  try {
    statements = diffStatements(before, schema, {
      ...(parent.document.defaultDatabase !== undefined ? { defaultDatabase: parent.document.defaultDatabase } : {}),
      ...(parent.document.defaultSchema !== undefined ? { defaultSchema: parent.document.defaultSchema } : {}),
    });
  } catch (e) {
    throw new YodelError(e instanceof Error ? e.message : String(e));
  }
  const refused = refusedSteps(statements.steps);
  if (refused.length > 0) {
    throw new YodelError(`${parent.id}'s recorded schema cannot be created by statements alone (${refused.map((s) => `${s.object}: ${s.kind} step`).join(", ")}); a checkpoint holds statements only`);
  }

  const unsigned: MigrationDocument = {
    format: MIGRATION_FORMAT,
    id,
    parent: parent.id,
    checksum: "",
    createdAt: `${now.toISOString().slice(0, 19)}Z`,
    dialect: statements.dialect,
    ...(statements.defaultDatabase !== undefined ? { defaultDatabase: statements.defaultDatabase } : {}),
    ...(statements.defaultSchema !== undefined ? { defaultSchema: statements.defaultSchema } : {}),
    ...(statements.major !== undefined ? { major: statements.major } : {}),
    checkpoint: { schema: schemaSha(schema) },
    refused: false,
    hints: [],
    steps: statements.steps,
    schema,
  };
  const sql = renderMigrationSql(unsigned, statements).replace(
    /^-- yodel migration .*\n-- parent: .*\n/,
    `-- yodel checkpoint ${id}\n-- parent: ${parent.id}\n` +
      `-- Creates ${parent.id}'s recorded schema from nothing. An environment whose history is empty\n` +
      `-- starts here and never runs the migrations before it; one that already ran them skips this.\n`,
  );
  const document: MigrationDocument = { ...unsigned, checksum: computeChecksum({ sql, json: unsigned }) };
  return { id, document, files: { sql, json: serializeDocument(document) }, statements };
}

/** What is wrong with a checkpoint, as `yodel lint` reports it (rule `checkpoint`): `[]` for a sound one, or for a migration that is not one. */
export function checkpointProblems(m: Migration, byId: ReadonlyMap<string, Migration>): string[] {
  const mark = m.document.checkpoint as unknown;
  if (mark === undefined) return [];
  if (typeof mark !== "object" || mark === null || typeof (mark as { schema?: unknown }).schema !== "string") {
    return [`${m.id}: its checkpoint mark is not { "schema": "sha256:..." }`];
  }
  const recorded = (mark as { schema: string }).schema;
  const out: string[] = [];
  if (m.parent === null) out.push(`${m.id} is a checkpoint with no parent; a checkpoint follows the migration whose recorded schema it creates`);
  const own = schemaSha(m.document.schema);
  if (own !== recorded) out.push(`${m.id}: its recorded schema hashes to ${own}, but its checkpoint mark records ${recorded}; the checkpoint was edited after yodel checkpoint wrote it`);
  const parent = m.parent === null ? undefined : byId.get(m.parent);
  if (parent) {
    const theirs = schemaSha(parent.document.schema);
    if (theirs !== recorded) out.push(`${m.id}: it was written from a recorded schema hashing to ${recorded}, but its parent ${parent.id}'s recorded schema now hashes to ${theirs}; write the checkpoint again (delete it, then yodel checkpoint)`);
  }
  const steps = m.document.steps.filter((s) => s.kind !== "statement");
  if (steps.length > 0) out.push(`${m.id}: a checkpoint holds statements only, and it has ${String(steps.length)} other step${steps.length === 1 ? "" : "s"}`);
  return out;
}
