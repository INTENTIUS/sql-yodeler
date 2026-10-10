/**
 * A file of DDL, as an ORM prints it (Prisma's `migrate diff --script`,
 * Drizzle's `generate`, Django's `sqlmigrate`, SQLAlchemy's `CreateTable`),
 * read by the sql lexicon's public `.sql` file API and written out as
 * declarations: one TypeScript file of `table`, `index`, `view`, ...
 * templates, the same file `chant import` writes. The build then treats
 * them like any other declaration in `src/`.
 *
 * What is read is what chant reads from a `.sql` file in `src/`
 * (`sqlFileDeclarations`): CREATE statements, on Postgres also GRANT, REVOKE
 * and ALTER DEFAULT PRIVILEGES, with `COMMENT ON`,
 * `ALTER TABLE ... ROW LEVEL SECURITY` and `ALTER TABLE <t> ADD <table
 * constraint>` (the form ORMs print foreign keys in) folded into the object
 * they finish. `BEGIN` and `COMMIT` are skipped. Any other statement is an
 * error naming it: a statement left out would be a schema yodel does not
 * manage, silently.
 *
 * `schema` (a Postgres schema, a ClickHouse database) qualifies the names
 * the DDL leaves unqualified, as an ORM does when the schema comes from its
 * connection.
 */

import { YodelError, type SqlDialect } from "../project.js";

export interface DdlOptions {
  /** Qualifies unqualified names (a Postgres schema, a ClickHouse database). */
  schema?: string | undefined;
  /** Comment lines at the top of the generated file. */
  header?: string | undefined;
  /** Names the DDL in errors. */
  origin: string;
}

/** One object the DDL creates. */
export interface DdlObject {
  /** The export it is declared as. */
  export: string;
  /** Its entity type, `Postgres::Table`. */
  type: string;
  /** `schema.name` (Postgres), `database.name` (ClickHouse). */
  name: string;
}

export interface Declarations {
  /** The TypeScript file's content. */
  content: string;
  objects: DdlObject[];
}

/** The lexicon, loaded when a source is read: a project without sources does not pay for it. */
const lexicon = () => import("@intentius/chant-lexicon-sql");

const readOptions = (options: DdlOptions) => ({ origin: options.origin, ...(options.schema !== undefined ? { schema: options.schema } : {}) });

/** chant's error for a statement it cannot declare, as yodel's, with what a DDL source holds. */
async function ddlError(e: unknown): Promise<unknown> {
  if (!(e instanceof (await lexicon()).SqlFileError)) return e;
  return new YodelError(`${e.message}\nA DDL source holds what chant reads from a .sql file: CREATE statements, and on Postgres the COMMENT ON and ALTER TABLE ... ADD that finish them.`);
}

/** Turns a file of DDL into declarations. */
export async function ddlToDeclarations(dialect: SqlDialect, ddl: string, options: DdlOptions): Promise<Declarations> {
  const { sqlFileDeclarations } = await lexicon();
  try {
    const { content, objects } = sqlFileDeclarations(dialect, ddl, { ...readOptions(options), ...(options.header !== undefined ? { header: options.header } : {}) });
    return { content, objects: objects.map((o) => ({ export: o.export, type: o.type, name: o.name })) };
  } catch (e) {
    throw await ddlError(e);
  }
}

/** The objects a file of DDL creates, without writing declarations. */
export async function ddlObjects(dialect: SqlDialect, ddl: string, options: DdlOptions): Promise<DdlObject[]> {
  const { readSqlFile } = await lexicon();
  try {
    return readSqlFile(dialect, ddl, readOptions(options)).map((o) => ({ export: o.export, type: o.type, name: o.name }));
  } catch (e) {
    throw await ddlError(e);
  }
}
