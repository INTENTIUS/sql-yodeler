/**
 * What one migration directory holds, and how its `migration.json` is
 * written so that the same migration always serializes to the same bytes.
 *
 *   migrations/<id>/migration.sql   the statements, each after a comment naming
 *                                   its object, rule and class (chant's
 *                                   `renderStatements`); an Op or manual step
 *                                   is a comment only
 *   migrations/<id>/migration.json  a {@link MigrationDocument}
 *   migrations/<id>/<other files>   only when a step names one, such as a
 *                                   backfill step's `backfill.ts`
 *
 * `<id>` is `<UTC timestamp YYYYMMDDTHHMM>-<name>`, e.g.
 * `20261009T1412-add-country`. The timestamp is for people reading a
 * directory listing; the order migrations run in is the chain of parent ids,
 * never the ids' sort order (see `./directory.ts`).
 */

import type { MigrationStep, SchemaStatements } from "@intentius/chant-lexicon-sql/migration-statements";
import type { BuildOutput } from "../chant/build.js";

export type { MigrationStep, SchemaStatements };

export const MIGRATION_SQL = "migration.sql";
export const MIGRATION_JSON = "migration.json";

/** The version of the `migration.json` layout. Bumped only on a change older readers cannot read. */
export const MIGRATION_FORMAT = 1;

/**
 * `migration.json`. Every value is plain JSON. Keys are written in the
 * order listed here, and every nested object (a step, the schema) with its
 * keys sorted, except that a step starts with `kind, object, type, name`.
 */
export interface MigrationDocument {
  /** {@link MIGRATION_FORMAT}. */
  format: number;
  /** The directory's name: `<YYYYMMDDTHHMM>-<name>`. */
  id: string;
  /** The id of the migration this one follows, or `null` for the first. */
  parent: string | null;
  /** `sha256:<hex>` over this migration's own files; see `./checksum.ts`. */
  checksum: string;
  /** When `yodel new` wrote it, ISO 8601 in UTC, to the second. */
  createdAt?: string;
  dialect: SchemaStatements["dialect"];
  /** ClickHouse: the database a bare name in the statements means. */
  defaultDatabase?: string;
  /** Postgres: the schema a bare name means; an applier sets `search_path` to it. */
  defaultSchema?: string;
  /** Postgres: the major the changes were classified for. */
  major?: number;
  /** ClickHouse: unset (or `single`): yodel writes migrations topology-neutral and renders them per environment at apply time. */
  topology?: string;
  /** True when a step is an Op or a manual step: the migration is more than its SQL. */
  refused: boolean;
  /** What the diff pointed out besides the changes, e.g. a likely rename written as a drop and an add. */
  hints: string[];
  /** In the order they run. An Op step carries the Op's declaration; it has no SQL. */
  steps: MigrationStep[];
  /** The recorded schema: the `chant build` output after this migration. The next `yodel new` diffs from it. */
  schema: BuildOutput;
}

/** A migration's files as text, before or after they are on disk. */
export interface MigrationFiles {
  /** `migration.sql`. */
  sql: string;
  /** `migration.json`. */
  json: string;
  /**
   * The migration's other files, by path relative to its directory with `/`
   * separators: a backfill step's module, for one. Absent or empty for a
   * migration that has only the two. They count in the checksum.
   */
  extra?: Record<string, string>;
}

const STEP_HEAD = ["kind", "object", "type", "name"];

const DOCUMENT_ORDER: readonly (keyof MigrationDocument)[] = [
  "format",
  "id",
  "parent",
  "checksum",
  "createdAt",
  "dialect",
  "defaultDatabase",
  "defaultSchema",
  "major",
  "topology",
  "refused",
  "hints",
  "steps",
  "schema",
];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `value` with every object's keys sorted, `head` first in that order; `undefined` members dropped. */
export function sortKeys(value: unknown, head: readonly string[] = []): unknown {
  if (Array.isArray(value)) return value.map((v) => sortKeys(v));
  if (!isRecord(value)) return value;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined);
  const first = head.filter((k) => keys.includes(k));
  const rest = keys.filter((k) => !head.includes(k)).sort();
  return Object.fromEntries([...first, ...rest].map((k) => [k, sortKeys(value[k])]));
}

/**
 * The document in its written key order. Keys outside
 * {@link MigrationDocument} (a newer yodel's) are kept, sorted, after `hints`
 * and before `steps`, so a rewrite never drops them.
 */
export function orderDocument(doc: Record<string, unknown>): Record<string, unknown> {
  const known = new Set<string>(DOCUMENT_ORDER);
  const out: Record<string, unknown> = {};
  const put = (k: string) => {
    const v = doc[k];
    if (v === undefined) return;
    if (k === "steps" && Array.isArray(v)) out[k] = v.map((s) => sortKeys(s, STEP_HEAD));
    else out[k] = sortKeys(v);
  };
  for (const k of DOCUMENT_ORDER) {
    if (k === "steps") for (const extra of Object.keys(doc).filter((x) => !known.has(x)).sort()) put(extra);
    put(k);
  }
  return out;
}

/** `migration.json` as written: two-space indent, the key order above, `\n` line endings and a trailing newline. */
export function serializeDocument(doc: MigrationDocument | Record<string, unknown>): string {
  return `${JSON.stringify(orderDocument(doc as Record<string, unknown>), null, 2)}\n`;
}

/** Line endings as `\n`: CRLF and lone CR both become LF. */
export const normalizeLineEndings = (text: string): string => text.replace(/\r\n?/g, "\n");
