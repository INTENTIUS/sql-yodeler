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
 * does not carry over. Where the profile sets `access`, the reader also
 * returns the policies on the tables in scope, each table's row-level
 * security and the declared roles.
 *
 * The privileges are read here, whatever `access` says (#397): the ACL of
 * every table, view, materialized view, sequence, function and procedure the
 * reader returned, of each schema in scope, and the default privileges set
 * in those schemas, one `Postgres::Privilege` entry per object. A null ACL
 * is the owner's defaults (`acldefault`), so a grant and the revoke that
 * undoes it leave the fingerprint where it was. A project that manages
 * access elsewhere then re-approves after a grant changes on the server,
 * which is the safe way to be wrong.
 */

import { createHash } from "node:crypto";
import type { PgClient } from "../../history/postgres/index.js";

export interface PgLiveScope {
  /** The schemas in scope; every schema but the server's own when undefined. */
  schemas: string[] | undefined;
  /** Left out of the fingerprint. */
  historySchema: string;
  /** `sql.profiles.<env>.access`: the reader returns policies, row-level security and the declared roles. Privileges are read either way. */
  access?: boolean;
  /** The roles the schema declares, read when {@link access} is on. */
  roles?: readonly string[];
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

/** The live objects {@link readPgCatalog} reads; chant's `readLiveSchema`, or a fake in the tests. */
export type PgLiveReader = (client: PgClient, scope: { schemas?: string[]; access?: boolean; roles?: readonly string[] }) => Promise<Array<{ type: string; schema?: string; name: string; oid: string; statement: string; comment?: string }>>;

const chantReader: PgLiveReader = async (client, scope) => {
  const { readLiveSchema } = await import("@intentius/chant-lexicon-sql/postgres/live/catalog");
  return readLiveSchema(client as Parameters<typeof readLiveSchema>[0], scope);
};

/** The entry type of an object's privileges. */
export const PRIVILEGE_TYPE = "Postgres::Privilege";

const RELATION_TYPES = new Set(["Postgres::Table", "Postgres::View", "Postgres::MaterializedView", "Postgres::Sequence", "Postgres::ForeignTable"]);
const ROUTINE_TYPES = new Set(["Postgres::Function", "Postgres::Procedure", "Postgres::Aggregate"]);

/**
 * One ACL item per row, for the objects whose oids it is given: $1
 * relations, $2 routines, $3 schemas (their own ACL and the default
 * privileges set in them), and `public` too when $4 is true. A null ACL
 * reads as `acldefault`.
 */
export const PRIVILEGES_SQL = `WITH acl AS (
  SELECT CASE c.relkind WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END AS kind, n.nspname AS schema, c.relname AS name,
         pg_catalog.quote_ident(n.nspname) || '.' || pg_catalog.quote_ident(c.relname) AS target, NULL::text AS role,
         COALESCE(c.relacl, pg_catalog.acldefault(CASE c.relkind WHEN 'S' THEN 's' ELSE 'r' END::"char", c.relowner)) AS items
    FROM pg_catalog.pg_class c, pg_catalog.pg_namespace n WHERE n.oid = c.relnamespace AND c.oid = ANY($1::oid[])
  UNION ALL
  SELECT CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END, n.nspname, p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')',
         pg_catalog.quote_ident(n.nspname) || '.' || pg_catalog.quote_ident(p.proname) || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')', NULL,
         COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
    FROM pg_catalog.pg_proc p, pg_catalog.pg_namespace n WHERE n.oid = p.pronamespace AND p.oid = ANY($2::oid[])
  UNION ALL
  SELECT 'SCHEMA', n.nspname, n.nspname, pg_catalog.quote_ident(n.nspname), NULL, COALESCE(n.nspacl, pg_catalog.acldefault('n', n.nspowner))
    FROM pg_catalog.pg_namespace n WHERE n.oid = ANY($3::oid[]) OR ($4::boolean AND n.nspname = 'public')
  UNION ALL
  SELECT 'DEFAULT', n.nspname,
         CASE d.defaclobjtype WHEN 'r' THEN 'TABLES' WHEN 'S' THEN 'SEQUENCES' WHEN 'f' THEN 'FUNCTIONS' WHEN 'T' THEN 'TYPES' WHEN 'n' THEN 'SCHEMAS' ELSE d.defaclobjtype::text END,
         pg_catalog.quote_ident(n.nspname), pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(d.defaclrole)), d.defaclacl
    FROM pg_catalog.pg_default_acl d, pg_catalog.pg_namespace n WHERE n.oid = d.defaclnamespace AND (n.oid = ANY($3::oid[]) OR ($4::boolean AND n.nspname = 'public'))
)
SELECT acl.kind, acl.schema, acl.name, acl.target, acl.role,
       CASE WHEN a.grantor = 0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantor)) END AS grantor,
       CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END AS grantee,
       a.privilege_type AS privilege, a.is_grantable AS grantable
  FROM acl, LATERAL pg_catalog.aclexplode(acl.items) a`;

/** A row of {@link PRIVILEGES_SQL}. */
export interface PgAclRow {
  /** `TABLE`, `SEQUENCE`, `FUNCTION`, `PROCEDURE`, `SCHEMA`, or `DEFAULT` for a schema's default privileges. */
  kind: string;
  schema: string;
  /** The object's name (a routine's with its argument types); for `DEFAULT`, the kind of object (`TABLES`). */
  name: string;
  /** The object as a statement names it; for `DEFAULT`, the schema. */
  target: string;
  /** For `DEFAULT`, the role whose new objects the privileges apply to. */
  role: string | null;
  grantor: string;
  grantee: string;
  privilege: string;
  grantable: boolean;
}

/** One {@link PRIVILEGE_TYPE} entry per object, each ACL item a canonical statement, in byte order. */
export function privilegeEntries(rows: readonly PgAclRow[]): PgCatalogEntry[] {
  const byObject = new Map<string, { schema: string; name: string; lines: string[] }>();
  for (const r of rows) {
    const option = r.grantable ? " WITH GRANT OPTION" : "";
    const isDefault = r.kind === "DEFAULT";
    const name = isDefault ? `DEFAULT PRIVILEGES FOR ROLE ${String(r.role)} ON ${r.name}` : `${r.kind} ${r.name}`;
    const line = isDefault
      ? `ALTER DEFAULT PRIVILEGES FOR ROLE ${String(r.role)} IN SCHEMA ${r.target} GRANT ${r.privilege} ON ${r.name} TO ${r.grantee}${option}`
      : `GRANT ${r.privilege} ON ${r.kind} ${r.target} TO ${r.grantee}${option} GRANTED BY ${r.grantor}`;
    const key = `${r.schema}\0${name}`;
    const entry = byObject.get(key) ?? { schema: r.schema, name, lines: [] };
    entry.lines.push(line);
    byObject.set(key, entry);
  }
  return [...byObject.values()].map((e) => ({ type: PRIVILEGE_TYPE, schema: e.schema, name: e.name, statement: [...new Set(e.lines)].sort(cmp).join(";\n"), comment: "" }));
}

/** Reads what the fingerprint covers, in a stable order. */
export async function readPgCatalog(client: PgClient, scope: PgLiveScope, read: PgLiveReader = chantReader): Promise<PgCatalogEntry[]> {
  const schemas = scope.schemas?.filter((s) => s !== scope.historySchema);
  const objects = (
    await read(client, {
      ...(schemas ? { schemas } : {}),
      ...(scope.access === true ? { access: true, ...(scope.roles && scope.roles.length > 0 ? { roles: [...scope.roles] } : {}) } : {}),
    })
  ).filter((o) => o.schema !== scope.historySchema && !(o.type === "Postgres::Schema" && o.name === scope.historySchema));
  const entries: PgCatalogEntry[] = objects.map((o) => ({ type: o.type, schema: o.schema ?? "", name: o.name, statement: o.statement, comment: o.comment ?? "" }));

  // The privileges of what the reader returned, so the scope and the objects it skips are the reader's.
  const relations = objects.filter((o) => RELATION_TYPES.has(o.type)).map((o) => o.oid);
  const routines = objects.filter((o) => ROUTINE_TYPES.has(o.type)).map((o) => o.oid);
  const namespaces = objects.filter((o) => o.type === "Postgres::Schema").map((o) => o.oid);
  // The reader leaves `public` out of its schemas but reads the objects in it when it is in scope.
  const withPublic = scope.historySchema !== "public" && (schemas === undefined || schemas.includes("public"));
  if (relations.length + routines.length + namespaces.length > 0 || withPublic) {
    const rows = await client.query<PgAclRow>(PRIVILEGES_SQL, [relations, routines, namespaces, withPublic]);
    entries.push(...privilegeEntries(rows.filter((r) => r.schema !== scope.historySchema)));
  }
  return entries.sort((a, b) => cmp(a.type, b.type) || cmp(a.schema, b.schema) || cmp(a.name, b.name));
}

/** `sha256:<hex>` over the catalog's canonical JSON. */
export function pgCatalogFingerprint(entries: readonly PgCatalogEntry[]): string {
  const canonical = entries.map((e) => [e.type, e.schema, e.name, e.statement, e.comment]);
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex")}`;
}
