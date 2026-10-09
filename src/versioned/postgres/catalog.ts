/**
 * The live-schema fingerprint a Postgres plan digest covers: every object
 * chant's catalog reader sees in the environment's schemas
 * (`sql.profiles.<env>.schemas`; every schema but the server's own when it
 * names none), by its type, schema, name, the statements that create it as
 * the server prints them, and its comment. The history schema is left out,
 * so recording a run does not move the digest, and so are chant's own
 * working objects (a migration's new column, its receipts), which the reader
 * skips.
 *
 * It is the same reader `chant sql plan` and the applier diff against, so a
 * change the plan would see (a column added out of band, an index dropped, a
 * default changed) is a new fingerprint, and an approval given before it
 * does not carry over.
 */

import { createHash } from "node:crypto";
import type { PgClient } from "../../history/postgres/index.js";

export interface PgLiveScope {
  /** The schemas in scope; every schema but the server's own when undefined. */
  schemas: string[] | undefined;
  /** Left out of the fingerprint. */
  historySchema: string;
}

export interface PgCatalogEntry {
  type: string;
  schema: string;
  name: string;
  statement: string;
  comment: string;
}

/** Byte order, so the order never depends on the machine's locale. */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Reads what the fingerprint covers, in a stable order. */
export async function readPgCatalog(client: PgClient, scope: PgLiveScope): Promise<PgCatalogEntry[]> {
  const { readLiveSchema } = await import("@intentius/chant-lexicon-sql/postgres/live/catalog");
  const schemas = scope.schemas?.filter((s) => s !== scope.historySchema);
  const objects = await readLiveSchema(client as Parameters<typeof readLiveSchema>[0], schemas ? { schemas } : {});
  return objects
    .filter((o) => o.schema !== scope.historySchema && !(o.type === "Postgres::Schema" && o.name === scope.historySchema))
    .map((o) => ({ type: o.type, schema: o.schema ?? "", name: o.name, statement: o.statement, comment: o.comment ?? "" }))
    .sort((a, b) => cmp(a.type, b.type) || cmp(a.schema, b.schema) || cmp(a.name, b.name));
}

/** `sha256:<hex>` over the catalog's canonical JSON. */
export function pgCatalogFingerprint(entries: readonly PgCatalogEntry[]): string {
  const canonical = entries.map((e) => [e.type, e.schema, e.name, e.statement, e.comment]);
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex")}`;
}
