/**
 * Objects a live database holds that chant's sql lexicon cannot declare
 * (#251). chant's import reads only the kinds the lexicon declares, so an
 * object of any other kind would be left out of the adopted schema without a
 * word, and drift would never report it. `yodel init --from` refuses when it
 * finds one; `yodel drift` lists them as unmanaged.
 *
 * Postgres, in the profile's schemas: composite and range types,
 * aggregates, collations, operators, operator classes and families, text
 * search configurations and dictionaries, conversions, foreign tables,
 * extended statistics and rules. In the database: casts, event triggers,
 * foreign-data wrappers, foreign servers, publications and subscriptions.
 * An object an extension owns is the extension's, and is left out.
 *
 * ClickHouse, when the environment manages access: settings profiles and
 * quotas made with SQL (the lexicon declares users, roles, row policies and
 * grants). Everything else in the profile's databases is a kind it declares.
 *
 * One query per kind, so this module is the one place to change when chant's
 * own import refuses these (INTENTIUS/chant#3911).
 */

import { YodelError, type Environment, type Project } from "../project.js";
import { accessManaged } from "./live.js";

/** One object of a kind the lexicon cannot declare. */
export interface Unsupported {
  kind: string;
  name: string;
}

export const describeUnsupported = (u: Unsupported): string => `${u.kind} ${u.name}`;

/** Not an object an extension owns, or one Postgres made as part of another (a range type's multirange cast), in catalog `catalog` with oid column `oid`. */
const notDependent = (catalog: string, oid: string): string =>
  `NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend dep WHERE dep.classid = 'pg_catalog.${catalog}'::pg_catalog.regclass AND dep.objid = ${oid} AND dep.deptype IN ('e', 'i'))`;

/** The first oid a user object gets; lower ones are the server's own. */
const FIRST_USER_OID = 16384;

/** A schema-scoped name: `schema.name`, quoted where it needs to be. */
const qualified = (nsp: string, name: string): string => `pg_catalog.quote_ident(${nsp}) || '.' || pg_catalog.quote_ident(${name})`;

/**
 * The Postgres queries, each returning `name` rows for one kind. `$1` is the
 * profile's schemas; a query with `scoped: false` reads the whole database.
 */
export const POSTGRES_KINDS: ReadonlyArray<{ kind: string; scoped: boolean; sql: string }> = [
  {
    kind: "composite type",
    scoped: true,
    sql: `SELECT ${qualified("n.nspname", "t.typname")} AS name FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace JOIN pg_catalog.pg_class c ON c.oid = t.typrelid
          WHERE t.typtype = 'c' AND c.relkind = 'c' AND n.nspname = ANY($1::text[]) AND ${notDependent("pg_type", "t.oid")}`,
  },
  {
    kind: "range type",
    scoped: true,
    sql: `SELECT ${qualified("n.nspname", "t.typname")} AS name FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
          WHERE t.typtype = 'r' AND n.nspname = ANY($1::text[]) AND ${notDependent("pg_type", "t.oid")}`,
  },
  {
    kind: "aggregate",
    scoped: true,
    sql: `SELECT ${qualified("n.nspname", "p.proname")} || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' AS name FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
          WHERE p.prokind = 'a' AND n.nspname = ANY($1::text[]) AND ${notDependent("pg_proc", "p.oid")}`,
  },
  {
    kind: "collation",
    scoped: true,
    sql: `SELECT ${qualified("n.nspname", "c.collname")} AS name FROM pg_catalog.pg_collation c JOIN pg_catalog.pg_namespace n ON n.oid = c.collnamespace
          WHERE n.nspname = ANY($1::text[]) AND ${notDependent("pg_collation", "c.oid")}`,
  },
  {
    kind: "operator",
    scoped: true,
    sql: `SELECT pg_catalog.quote_ident(n.nspname) || '.' || o.oprname || '(' || COALESCE(pg_catalog.format_type(o.oprleft, NULL), 'NONE') || ', ' || COALESCE(pg_catalog.format_type(o.oprright, NULL), 'NONE') || ')' AS name
          FROM pg_catalog.pg_operator o JOIN pg_catalog.pg_namespace n ON n.oid = o.oprnamespace
          WHERE n.nspname = ANY($1::text[]) AND ${notDependent("pg_operator", "o.oid")}`,
  },
  {
    kind: "operator class",
    scoped: true,
    sql: `SELECT ${qualified("n.nspname", "c.opcname")} AS name FROM pg_catalog.pg_opclass c JOIN pg_catalog.pg_namespace n ON n.oid = c.opcnamespace
          WHERE n.nspname = ANY($1::text[]) AND ${notDependent("pg_opclass", "c.oid")}`,
  },
  {
    kind: "operator family",
    scoped: true,
    sql: `SELECT ${qualified("n.nspname", "f.opfname")} AS name FROM pg_catalog.pg_opfamily f JOIN pg_catalog.pg_namespace n ON n.oid = f.opfnamespace
          WHERE n.nspname = ANY($1::text[]) AND ${notDependent("pg_opfamily", "f.oid")}`,
  },
  {
    kind: "text search configuration",
    scoped: true,
    sql: `SELECT ${qualified("n.nspname", "c.cfgname")} AS name FROM pg_catalog.pg_ts_config c JOIN pg_catalog.pg_namespace n ON n.oid = c.cfgnamespace
          WHERE n.nspname = ANY($1::text[]) AND ${notDependent("pg_ts_config", "c.oid")}`,
  },
  {
    kind: "text search dictionary",
    scoped: true,
    sql: `SELECT ${qualified("n.nspname", "d.dictname")} AS name FROM pg_catalog.pg_ts_dict d JOIN pg_catalog.pg_namespace n ON n.oid = d.dictnamespace
          WHERE n.nspname = ANY($1::text[]) AND ${notDependent("pg_ts_dict", "d.oid")}`,
  },
  {
    kind: "conversion",
    scoped: true,
    sql: `SELECT ${qualified("n.nspname", "c.conname")} AS name FROM pg_catalog.pg_conversion c JOIN pg_catalog.pg_namespace n ON n.oid = c.connamespace
          WHERE n.nspname = ANY($1::text[]) AND ${notDependent("pg_conversion", "c.oid")}`,
  },
  {
    kind: "foreign table",
    scoped: true,
    sql: `SELECT ${qualified("n.nspname", "c.relname")} AS name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind = 'f' AND n.nspname = ANY($1::text[]) AND ${notDependent("pg_class", "c.oid")}`,
  },
  {
    kind: "statistics",
    scoped: true,
    sql: `SELECT ${qualified("n.nspname", "s.stxname")} AS name FROM pg_catalog.pg_statistic_ext s JOIN pg_catalog.pg_namespace n ON n.oid = s.stxnamespace
          WHERE n.nspname = ANY($1::text[]) AND ${notDependent("pg_statistic_ext", "s.oid")}`,
  },
  {
    kind: "rule",
    scoped: true,
    sql: `SELECT ${qualified("n.nspname", "c.relname")} || ' ' || pg_catalog.quote_ident(r.rulename) AS name FROM pg_catalog.pg_rewrite r JOIN pg_catalog.pg_class c ON c.oid = r.ev_class JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE r.rulename <> '_RETURN' AND n.nspname = ANY($1::text[]) AND ${notDependent("pg_rewrite", "r.oid")}`,
  },
  {
    kind: "cast",
    scoped: false,
    sql: `SELECT '(' || pg_catalog.format_type(c.castsource, NULL) || ' AS ' || pg_catalog.format_type(c.casttarget, NULL) || ')' AS name FROM pg_catalog.pg_cast c
          WHERE c.oid >= ${String(FIRST_USER_OID)} AND ${notDependent("pg_cast", "c.oid")}`,
  },
  {
    kind: "event trigger",
    scoped: false,
    sql: `SELECT pg_catalog.quote_ident(e.evtname) AS name FROM pg_catalog.pg_event_trigger e WHERE ${notDependent("pg_event_trigger", "e.oid")}`,
  },
  {
    kind: "foreign-data wrapper",
    scoped: false,
    sql: `SELECT pg_catalog.quote_ident(w.fdwname) AS name FROM pg_catalog.pg_foreign_data_wrapper w WHERE ${notDependent("pg_foreign_data_wrapper", "w.oid")}`,
  },
  {
    kind: "foreign server",
    scoped: false,
    sql: `SELECT pg_catalog.quote_ident(s.srvname) AS name FROM pg_catalog.pg_foreign_server s WHERE ${notDependent("pg_foreign_server", "s.oid")}`,
  },
  {
    kind: "publication",
    scoped: false,
    sql: `SELECT pg_catalog.quote_ident(p.pubname) AS name FROM pg_catalog.pg_publication p WHERE ${notDependent("pg_publication", "p.oid")}`,
  },
  {
    kind: "subscription",
    scoped: false,
    sql: `SELECT pg_catalog.quote_ident(s.subname) AS name FROM pg_catalog.pg_subscription s WHERE s.subdbid = (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database())`,
  },
];

/** The ClickHouse queries, each returning `name` rows for one kind. They run only when the environment manages access. */
export const CLICKHOUSE_ACCESS_KINDS: ReadonlyArray<{ kind: string; sql: string }> = [
  { kind: "settings profile", sql: "SELECT name FROM system.settings_profiles WHERE storage <> 'users_xml' ORDER BY name" },
  { kind: "quota", sql: "SELECT name FROM system.quotas WHERE storage <> 'users_xml' ORDER BY name" },
];

/** The objects `env` holds that the lexicon cannot declare, by kind then name. */
export async function findUnsupported(project: Project, env: Environment, processEnv: NodeJS.ProcessEnv = process.env): Promise<Unsupported[]> {
  const found = project.dialect === "postgres" ? await postgresUnsupported(project, env, processEnv) : await clickhouseUnsupported(project, env, processEnv);
  return found.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

async function postgresUnsupported(project: Project, env: Environment, processEnv: NodeJS.ProcessEnv): Promise<Unsupported[]> {
  const { resolvePostgresTarget, isUnresolvedTarget } = await import("@intentius/chant-lexicon-sql/postgres/live/bind");
  const target = resolvePostgresTarget({ environment: env.name, config: project.config, env: processEnv });
  if (isUnresolvedTarget(target)) throw new YodelError(`${env.name}: ${target.detail}`);
  const schemas = env.profile.schemas ?? target.schemas ?? [];
  const { connectPostgres } = await import("@intentius/chant-lexicon-sql/postgres/live/client");
  const client = await connectPostgres(target.endpoint, { applicationName: "yodel init" });
  try {
    const found: Unsupported[] = [];
    for (const k of POSTGRES_KINDS) {
      const rows = await client.query<{ name: string }>(k.sql, k.scoped ? [schemas] : []);
      for (const r of rows) found.push({ kind: k.kind, name: r.name });
    }
    return found;
  } finally {
    await client.end();
  }
}

async function clickhouseUnsupported(project: Project, env: Environment, processEnv: NodeJS.ProcessEnv): Promise<Unsupported[]> {
  if (!accessManaged(project, env.name)) return [];
  const { bindClickHouse } = await import("@intentius/chant-lexicon-sql/clickhouse/live/bind");
  const { clickhouseQuery } = await import("@intentius/chant-lexicon-sql/clickhouse/http");
  const target = await bindClickHouse({ environment: env.name, config: project.config, cwd: project.dir, env: processEnv });
  const found: Unsupported[] = [];
  for (const k of CLICKHOUSE_ACCESS_KINDS) {
    for (const r of await clickhouseQuery<{ name: string }>(target.endpoint, k.sql)) found.push({ kind: k.kind, name: r.name });
  }
  return found;
}
