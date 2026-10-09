/**
 * A migration's checksum: covers that migration's own files and nothing
 * else, so editing, adding or removing another migration never changes it.
 *
 * Exactly:
 *
 *   sql  = migration.sql, with CRLF and lone CR turned into LF
 *   json = migration.json parsed, its top-level "checksum" removed, then
 *          written as JSON with every object's keys sorted and no whitespace
 *   checksum = "sha256:" + lowercase hex of SHA-256 over the UTF-8 bytes of
 *          "yodel-migration-checksum-v1\n"
 *          + "migration.sql " + byteLength(sql) + "\n" + sql
 *          + "migration.json " + byteLength(json) + "\n" + json
 *          + for each other file in the migration's directory, by path:
 *            path + " " + byteLength(text) + "\n" + text
 *
 * The other files are a migration's own besides the two, such as a backfill
 * step's module (`backfill.ts`, see `../steps/backfill.ts`): every regular
 * file under its directory, at any depth, except `migration.sql`,
 * `migration.json` and anything whose name starts with `.`. `path` is
 * relative to the directory with `/` separators; paths are taken in code
 * point order, and each file's text has its line endings normalized as
 * migration.sql's are. A migration with no other files hashes exactly as it
 * did before they counted, so no existing checksum changes.
 *
 * The lengths frame each file, so no text can move from one file into the
 * other and keep the hash. Because migration.json is hashed as parsed JSON,
 * its whitespace, key order and line endings do not count; every value in it
 * does, the parent id and the recorded schema included. Whitespace in
 * migration.sql counts, except line endings.
 */

import { createHash } from "node:crypto";
import { MIGRATION_JSON, MIGRATION_SQL, normalizeLineEndings, sortKeys, type MigrationDocument, type MigrationFiles } from "./document.js";

export const CHECKSUM_PREFIX = "sha256:";
const DOMAIN = "yodel-migration-checksum-v1\n";

/** The canonical JSON of a migration document, without its checksum: what the checksum hashes for `migration.json`. */
export function canonicalDocument(doc: MigrationDocument | Record<string, unknown>): string {
  const rest: Record<string, unknown> = { ...(doc as Record<string, unknown>) };
  delete rest.checksum;
  return JSON.stringify(sortKeys(rest));
}

/**
 * The checksum of a migration's files. `json` may be the file's text or the
 * document already parsed; whatever `checksum` it holds is ignored. `extra`
 * is the migration's other files, by path (see above).
 */
export function computeChecksum(files: { sql: string; json: string | MigrationDocument | Record<string, unknown>; extra?: Readonly<Record<string, string>> | undefined }): string {
  const sql = normalizeLineEndings(files.sql);
  const doc = typeof files.json === "string" ? (JSON.parse(files.json) as Record<string, unknown>) : files.json;
  const json = canonicalDocument(doc);
  const hash = createHash("sha256");
  hash.update(DOMAIN, "utf8");
  hash.update(`${MIGRATION_SQL} ${String(Buffer.byteLength(sql, "utf8"))}\n`, "utf8");
  hash.update(sql, "utf8");
  hash.update(`${MIGRATION_JSON} ${String(Buffer.byteLength(json, "utf8"))}\n`, "utf8");
  hash.update(json, "utf8");
  for (const path of Object.keys(files.extra ?? {}).sort()) {
    const text = normalizeLineEndings(files.extra?.[path] ?? "");
    hash.update(`${path} ${String(Buffer.byteLength(text, "utf8"))}\n`, "utf8");
    hash.update(text, "utf8");
  }
  return `${CHECKSUM_PREFIX}${hash.digest("hex")}`;
}

export interface ChecksumCheck {
  ok: boolean;
  /** The checksum `migration.json` records. */
  recorded: string;
  /** The checksum of the files as they are. */
  actual: string;
}

/** Whether a migration's files still hash to the checksum its `migration.json` records. */
export function verifyChecksum(m: { files: MigrationFiles } | MigrationFiles): ChecksumCheck {
  const files = "files" in m ? m.files : m;
  const doc = JSON.parse(files.json) as { checksum?: unknown };
  const recorded = typeof doc.checksum === "string" ? doc.checksum : "";
  const actual = computeChecksum(files);
  return { ok: recorded === actual, recorded, actual };
}
