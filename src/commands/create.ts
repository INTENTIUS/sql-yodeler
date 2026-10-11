import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Command, Io } from "../command.js";
import { guarded } from "../env-args.js";
import { YodelError, type SqlDialect } from "../project.js";
import { runChant, type ChantResult, type RunChantOptions } from "../chant/process.js";
import { version } from "../version.js";

/** The repository the templates are released from, tagged `v<version>`. */
export const TEMPLATE_REPO = "INTENTIUS/sql-yodeler";

/** What a template's package name must look like (the templates' chant.template.json). */
const PACKAGE_NAME = /^[a-z0-9][a-z0-9._-]*$/;

const usage = "usage: yodel create <dir> --clickhouse | --postgres [--database <name> | --schema <name>] [--history <name>] [--name <package>]";

const help = `${usage}

Makes a new project in <dir> from SQL Yodeler's template for the dialect:
the declared schema in src/, the environments (dev and prod) in
chant.config.ts and yodel.config.ts, the migrations Ops, the pipelines for
GitHub, GitLab and Forgejo, and a justfile. The template is the one released
with this yodel (${TEMPLATE_REPO}@v<version>#templates/<dialect>), so
it always matches the yodel that made it. Then it prints the next steps.

Before a project exists, run it with npx:

  npx @intentius/sql-yodeler create my-schema --clickhouse --database events

Refuses a <dir> that holds anything but .git (a fresh clone of an empty
repository is fine). chant copies the template underneath (chant init
--from); its output is printed as it runs.

Options:
  --clickhouse        a ClickHouse project
  --postgres          a Postgres project
  --database <name>   ClickHouse: the database the schema lives in (default:
                      app)
  --schema <name>     Postgres: the schema the declared objects live in
                      (default: app)
  --history <name>    the database (ClickHouse) or schema (Postgres) for yodel's
                      history table, apart from the project's (default:
                      yodeler)
  --name <package>    the package name in package.json (default: <dir>'s
                      name)
  --from <source>     for developing yodel: the template repository to copy,
                      a <repo>@<ref> or a clone's directory; the member
                      #templates/<dialect> is added unless <source> names one

Exit codes:
  0  the project was made
  1  anything else: a missing or doubled dialect flag, a <dir> that is not
     empty, a template chant could not copy (chant says why)
`;

export interface CreateArgs {
  dir: string;
  dialect: SqlDialect;
  name: string;
  /** `--database` (ClickHouse) or `--schema` (Postgres), when given. */
  database?: string;
  schema?: string;
  /** `--history`: the history's database (ClickHouse) or schema (Postgres). */
  history?: string;
  from?: string;
}

/** Parses `yodel create`'s arguments, naming the flag that is wrong. */
export function parseCreateArgs(args: string[]): CreateArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        clickhouse: { type: "boolean" },
        postgres: { type: "boolean" },
        database: { type: "string" },
        schema: { type: "string" },
        history: { type: "string" },
        name: { type: "string" },
        from: { type: "string" },
      },
    });
  } catch (e) {
    throw new YodelError(`${e instanceof Error ? e.message : String(e)}\n${usage}`);
  }
  const { values, positionals } = parsed;
  const [dir, ...rest] = positionals;
  if (dir === undefined) throw new YodelError(`name the directory to make the project in\n${usage}`);
  if (rest.length > 0) throw new YodelError(`one directory, got ${String(positionals.length)}: ${positionals.join(" ")}\n${usage}`);
  if (values.clickhouse === true && values.postgres === true) throw new YodelError(`--clickhouse and --postgres: pick one dialect\n${usage}`);
  if (values.clickhouse !== true && values.postgres !== true) throw new YodelError(`--clickhouse or --postgres: name the dialect\n${usage}`);
  const dialect: SqlDialect = values.clickhouse === true ? "clickhouse" : "postgres";
  if (dialect === "clickhouse" && values.schema !== undefined) throw new YodelError(`--schema is for a Postgres project; a ClickHouse project takes --database\n${usage}`);
  if (dialect === "postgres" && values.database !== undefined) throw new YodelError(`--database is for a ClickHouse project; a Postgres project takes --schema\n${usage}`);
  const name = typeof values.name === "string" ? values.name : basename(resolve(dir));
  if (!PACKAGE_NAME.test(name)) {
    throw new YodelError(
      typeof values.name === "string"
        ? `--name ${name} is not a package name (lowercase letters, digits, ".", "_" and "-", starting with a letter or digit)`
        : `the directory's name, ${name}, is not a package name (lowercase letters, digits, ".", "_" and "-"); give one with --name`,
    );
  }
  return {
    dir,
    dialect,
    name,
    ...(typeof values.database === "string" ? { database: values.database } : {}),
    ...(typeof values.schema === "string" ? { schema: values.schema } : {}),
    ...(typeof values.history === "string" ? { history: values.history } : {}),
    ...(typeof values.from === "string" ? { from: values.from } : {}),
  };
}

/** The template chant copies: this yodel's release, or `--from`'s source with the dialect's member added. */
export function templateSource(dialect: SqlDialect, from?: string, yodelVersion: string = version()): string {
  const member = `templates/${dialect}`;
  if (from === undefined) return `${TEMPLATE_REPO}@v${yodelVersion}#${member}`;
  return from.includes("#") ? from : `${from}#${member}`;
}

/** The `chant init` arguments that make the project `a` describes. */
export function chantInitArgs(a: CreateArgs, yodelVersion: string = version()): string[] {
  const params: Array<[string, string | undefined]> = [
    ["name", a.name],
    ["database", a.database],
    ["schema", a.schema],
    [a.dialect === "clickhouse" ? "history_database" : "history_schema", a.history],
  ];
  return [
    "init",
    "--from",
    templateSource(a.dialect, a.from, yodelVersion),
    ...params.flatMap(([k, v]) => (v === undefined ? [] : ["--param", `${k}=${v}`])),
    a.dir,
  ];
}

/** Why `dir` cannot take a new project, or undefined when it can: it does not exist, or holds nothing but `.git`. */
export function occupied(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  if (!statSync(dir).isDirectory()) return `${dir} exists and is not a directory`;
  const entries = readdirSync(dir).filter((e) => e !== ".git");
  return entries.length === 0 ? undefined : `${dir} exists and is not empty (${String(entries.length)} entr${entries.length === 1 ? "y" : "ies"}); name a new directory or an empty one`;
}

/** What to do once the project exists. */
export function nextSteps(dir: string): string {
  const cd = relative(process.cwd(), resolve(dir)) || ".";
  return [
    "",
    "Next:",
    `  cd ${cd}`,
    "  npm install",
    "  git init && git add -A && git commit -m init",
    "  npx yodel emulator up        # a local ClickHouse and Postgres, in Docker",
    "",
    "Then follow Your first migration: https://intentius.io/sql-yodeler/getting-started/",
    "",
  ].join("\n");
}

type Runner = (args: readonly string[], options: RunChantOptions) => Promise<ChantResult>;

/** `yodel create`, running chant with `run` (tests pass their own). */
export function createCommand(run: Runner = runChant): Command {
  return {
    name: "create",
    summary: "make a new project from SQL Yodeler's template",
    implemented: true,
    run: (args, io: Io) =>
      guarded("create", io, args, help, async () => {
        const a = parseCreateArgs(args);
        const why = occupied(resolve(a.dir));
        if (why) throw new YodelError(`refused: ${why}; nothing was made`);
        const ran = await run(chantInitArgs(a), { cwd: process.cwd(), onStdout: io.out, onStderr: io.err });
        if (ran.code !== 0) throw new YodelError(`chant init --from ${templateSource(a.dialect, a.from)} failed (exit ${String(ran.code)}; chant says why above); nothing was made`);
        io.out(nextSteps(a.dir));
        return 0;
      }),
  };
}

export const create = createCommand();
