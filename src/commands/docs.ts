import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Command } from "../command.js";
import { guarded } from "../env-args.js";
import { loadProject, YodelError, type Project } from "../project.js";
import { buildSchema } from "../chant/build.js";
import { migrationsDir, readChain } from "../versioned/index.js";
import { erdMarkdown, schemaHtml, type DocsInput } from "../schema-docs/render.js";

/** Where `yodel docs` writes, relative to the project, without --out. */
export const DOCS_DIR = "schema-docs";
export const DOCS_HTML = "index.html";
export const DOCS_ERD = "erd.md";

const usage = "usage: yodel docs [--out <dir>] [--migration <id>] [--dir <project>]";

const help = `${usage}

Writes a reference of the schema, offline: no server is read.

  <out>/index.html  every table, view, index and database or schema: its
                    columns, keys, relations, comments, ClickHouse engine,
                    sort key, partition key and TTL, its DDL, and the
                    migrations in migrations/ that changed it. One file
                    with its styles inline and no scripts.
  <out>/erd.md      a Mermaid entity-relationship diagram of the tables and
                    views, which GitHub, GitLab and Forgejo render: foreign
                    keys, what a view reads, the table a materialized view
                    writes to, the table a Distributed table serves.

The schema is the build of the declared schema (chant build), or with
--migration <id> the schema that migration recorded. The same schema gives
the same files, so they can be committed and reviewed in a pull request.

Options:
  --out <dir>       where to write (default: ${DOCS_DIR} in the project)
  --migration <id>  document the schema migration <id> recorded, and its
                    history up to it
  -C, --dir <dir>   the project directory (default: the working directory)

Exit codes:
  0  written
  1  nothing written: a bad config, a declaration chant cannot build, an
     unknown migration id
  4  refused: the migrations directory is not one chain (a fork, a missing
     parent)
`;

interface DocsArgs {
  out: string | undefined;
  migration: string | undefined;
  dir: string;
}

function parseDocsArgs(args: string[]): DocsArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args, strict: true, options: { out: { type: "string" }, migration: { type: "string" }, dir: { type: "string", short: "C" } } });
  } catch (e) {
    throw new YodelError(`${e instanceof Error ? e.message : String(e)}\n${usage}`);
  }
  const s = (v: unknown) => (typeof v === "string" ? v : undefined);
  return { out: s(parsed.values.out), migration: s(parsed.values.migration), dir: s(parsed.values.dir) ?? process.cwd() };
}

/** The project's name for the title: package.json's name, else the directory's. */
function projectTitle(project: Project): string {
  try {
    const pkg = JSON.parse(readFileSync(join(project.dir, "package.json"), "utf8")) as { name?: unknown };
    if (typeof pkg.name === "string" && pkg.name && !pkg.name.includes("{{")) return pkg.name;
  } catch {
    // no package.json: the directory's name
  }
  return basename(project.dir);
}

/** What `yodel docs` documents for the project: the build, or a migration's recorded schema. */
export async function docsInput(project: Project, migration?: string): Promise<DocsInput> {
  const chain = existsSync(migrationsDir(project)) ? readChain(project) : [];
  const steps = chain.map((m) => ({ id: m.id, steps: m.document.steps }));
  const title = projectTitle(project);
  if (migration !== undefined) {
    const at = chain.findIndex((m) => m.id === migration);
    const found = chain[at];
    if (!found) throw new YodelError(`no migration ${migration} in ${relative(process.cwd(), migrationsDir(project)) || migrationsDir(project)}`);
    return { title, output: found.document.schema, source: `the schema migration ${migration} recorded`, migrations: steps.slice(0, at + 1) };
  }
  const build = await buildSchema(project);
  try {
    return { title, output: build.output, source: "chant build of the declared schema", migrations: steps };
  } finally {
    build.dispose();
  }
}

/** `yodel docs`; the exit codes are in `help`. */
export const docs: Command = {
  name: "docs",
  summary: "write an HTML reference and a Mermaid ERD of the schema",
  implemented: true,
  run: (args, io) =>
    guarded("docs", io, args, help, async () => {
      const { out, migration, dir } = parseDocsArgs(args);
      const project = await loadProject(dir);
      const input = await docsInput(project, migration);
      const outDir = resolve(out ?? join(project.dir, DOCS_DIR));
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, DOCS_HTML), schemaHtml(input));
      writeFileSync(join(outDir, DOCS_ERD), erdMarkdown(input));
      const rel = relative(project.dir, outDir);
      const where = rel === "" ? "." : rel.startsWith("..") ? outDir : rel;
      const count = input.output.objects.length;
      io.out(`Wrote ${join(where, DOCS_HTML)} and ${join(where, DOCS_ERD)} (${String(count)} object${count === 1 ? "" : "s"}, from ${input.source})\n`);
      return 0;
    }),
};
