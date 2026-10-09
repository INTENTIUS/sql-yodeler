/**
 * The plan digest a versioned apply is approved under.
 *
 * It covers what the run would do and the state it would start from:
 *
 * - the migrations it would apply, in order, each with its files' checksum
 *   and the statements of it that already succeeded (a part-way one resumes);
 * - the history it starts from: every applied migration and its checksum;
 * - the topology the statements are rendered for (#9): an approval given
 *   for a single node never applies on a cluster;
 * - the live schema: a fingerprint of the server's catalog in the
 *   environment's databases (every table, view and dictionary there, by its
 *   `create_table_query`, and each database's engine). The history database
 *   is left out, so recording a run does not move the digest.
 *
 * It is chant's plan digest (`computePlanDigest`, kind `yodel-migrations`),
 * so `chant approve <op> <gate> --plan <digest>` takes it. A change to any of
 * it after approval (a new pending migration, an edited one, a table changed
 * out of band, another run applying first) is a new digest, and the
 * approval does not carry over.
 */

import { createHash } from "node:crypto";
import type { ClickHousePort } from "../history/index.js";
import { literal } from "../history/index.js";
import type { AppliedMigration, PendingMigration } from "./state.js";
import type { Topology } from "../topology/render.js";

export const DIGEST_KIND = "yodel-migrations";

/** The databases the server keeps for itself, never part of an environment's schema. */
const SYSTEM_DATABASES = ["system", "information_schema", "INFORMATION_SCHEMA"];

export interface LiveScope {
  /** `sql.profiles.<env>.databases`; every database but the server's own when undefined. */
  databases: string[] | undefined;
  /** Left out of the fingerprint. */
  historyDatabase: string;
}

export interface LiveCatalog {
  databases: Array<{ name: string; engine: string }>;
  tables: Array<{ database: string; name: string; engine: string; create: string }>;
}

/** Reads the catalog the fingerprint covers. */
export async function readLiveCatalog(port: ClickHousePort, scope: LiveScope): Promise<LiveCatalog> {
  const where = scope.databases
    ? `name IN (${scope.databases.filter((d) => d !== scope.historyDatabase).map(literal).join(", ") || "''"})`
    : `name NOT IN (${[...SYSTEM_DATABASES, scope.historyDatabase].map(literal).join(", ")})`;
  const databases = await port.query<{ name: string; engine: string }>(`SELECT name, engine FROM system.databases WHERE ${where} ORDER BY name`);
  const names = databases.map((d) => d.name);
  const tables =
    names.length === 0
      ? []
      : await port.query<{ database: string; name: string; engine: string; create: string }>(
          `SELECT database, name, engine, create_table_query AS create FROM system.tables WHERE database IN (${names.map(literal).join(", ")}) AND NOT is_temporary ORDER BY database, name`,
        );
  return { databases, tables };
}

/** `sha256:<hex>` over the catalog's canonical JSON. */
export function catalogFingerprint(catalog: LiveCatalog): string {
  const canonical = {
    databases: [...catalog.databases].sort((a, b) => a.name.localeCompare(b.name)).map((d) => [d.name, d.engine]),
    tables: [...catalog.tables]
      .sort((a, b) => a.database.localeCompare(b.database) || a.name.localeCompare(b.name))
      .map((t) => [t.database, t.name, t.engine, t.create]),
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex")}`;
}

/** What the digest is taken over. */
export interface DigestSubject {
  environment: string;
  historyDatabase: string;
  /** The environment's topology, with a cluster's Keeper path and replica name when it sets them. Always set by {@link digestSubject}; absent in a subject carried from before #9. */
  topology?: Topology;
  applied: Array<{ id: string; checksum: string }>;
  pending: Array<{ id: string; checksum: string; done: number[] }>;
  live: string;
}

export function digestSubject(input: {
  environment: string;
  historyDatabase: string;
  /** Default: a single node. */
  topology?: Topology | undefined;
  applied: readonly AppliedMigration[];
  toApply: readonly PendingMigration[];
  live: string;
}): DigestSubject {
  return {
    environment: input.environment,
    historyDatabase: input.historyDatabase,
    topology: input.topology ?? { kind: "single" },
    applied: input.applied.map((a) => ({ id: a.id, checksum: a.checksum })),
    pending: input.toApply.map((p) => ({ id: p.id, checksum: p.checksum, done: p.partWay?.done ?? [] })),
    live: input.live,
  };
}

/** The plan digest of a subject, as chant computes and compares them. */
export async function planDigest(subject: DigestSubject): Promise<string> {
  const { computePlanDigest } = await import("@intentius/chant/lifecycle/plan-digest");
  return computePlanDigest(DIGEST_KIND, subject);
}

/** Whether two digests name the same plan, by chant's rule. */
export async function sameDigest(a: string | undefined, b: string | undefined): Promise<boolean> {
  const { samePlanDigest } = await import("@intentius/chant/lifecycle/plan-digest");
  return samePlanDigest(a, b);
}
