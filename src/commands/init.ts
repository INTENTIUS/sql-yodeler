import { parseArgs } from "node:util";
import type { Command, Io } from "../command.js";
import { guarded } from "../env-args.js";
import { loadProject, resolveEnvironment, YodelError } from "../project.js";
import { migrationId } from "../migrations/index.js";
import { adopt, BASELINE_NAME, type Adopted } from "../init/index.js";

const usage = "usage: yodel init --from <env> [--json] [--dir <project>] [--force] [--name <name>]";

const help = `${usage}

Adopts an existing database. Reads the live database sql.profiles.<env>
binds, with chant's import (what chant import --from <env> runs), writes
its declarations to the source directory (sourceDir, else src/), builds
them and plans them against the same database, which must show no change.
Then writes the baseline migration, migrations/<YYYYMMDDTHHMM>-baseline/,
the first migration (no parent), whose statements create everything, and
records it applied in the history table (yodel.config.ts history.database,
else YODEL_HISTORY_DATABASE, default yodeler) without running any of them.
From there, yodel plan <env> shows no change, yodel status <env> lists the
baseline applied with nothing pending, and yodel new writes the next
migration after the baseline.

The live database is only read. The one write to the server is the
baseline's history row (and the history's database and table, when they
are not there yet). If any step fails, every file init wrote is taken back.

What must exist first: a project directory with a chant.config.ts that has
lexicons: ["sql"], sql.dialect and sql.profiles.<env> (credentials by env
var), and a package.json from which chant and @intentius/chant-lexicon-sql
resolve, since chant builds the declarations. For ClickHouse the profile
must list the project's databases (sql.profiles.<env>.databases), for
Postgres its schemas (sql.profiles.<env>.schemas), and the history's
database (schema) must not be one of them. init does not write
chant.config.ts.

Postgres: the same, the history being <history database>.history in a
schema of that name (default yodeler.history), and the profile listing the
project's schemas (sql.profiles.<env>.schemas), the history's not among them.

Ownership: chant's import strips chant's ownership marker from comments,
and the plan compares declared definitions without it, so objects made by
hand (no marker) plan clean. init does not stamp the marker on them: they
stay unmarked, so chant never prunes them, until a declarative apply
restamps their comments.

Options:
  --from <env>     the environment to adopt (required)
  --name <name>    the baseline migration's name (default ${BASELINE_NAME})
  --force          overwrite declaration files the source directory already has
  --json           print what was done as JSON
  -C, --dir <dir>  the project directory (default: the working directory)

Exit codes:
  0  adopted: declarations and the baseline written, the baseline recorded applied
  4  refused, nothing written: the source directory already declares a
     schema (without --force), the project already has migrations, the
     history already records migrations, the environment holds nothing, or
     a ClickHouse profile with no databases or with the history's database
  5  another apply holds the lock; nothing recorded, nothing kept
  1  anything else failed, and nothing was kept: a bad config, a server it
     cannot read, a build or a plan that is not clean after the import
`;

interface InitArgs {
  from: string;
  json: boolean;
  dir: string;
  force: boolean;
  name: string;
}

function parseInitArgs(args: string[]): InitArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: false,
      strict: true,
      options: {
        from: { type: "string" },
        json: { type: "boolean" },
        dir: { type: "string", short: "C" },
        force: { type: "boolean" },
        name: { type: "string" },
      },
    });
  } catch (e) {
    throw new YodelError(`${e instanceof Error ? e.message : String(e)}\n${usage}`);
  }
  const { values } = parsed;
  if (typeof values.from !== "string" || values.from === "") throw new YodelError(`--from <env> is required\n${usage}`);
  const name = typeof values.name === "string" ? values.name : BASELINE_NAME;
  migrationId(name, new Date()); // a bad name fails before anything is read
  return {
    from: values.from,
    json: values.json === true,
    dir: typeof values.dir === "string" ? values.dir : process.cwd(),
    force: values.force === true,
    name,
  };
}

/** `yodel init --json` (schemas/init.schema.json). */
export function initJson(a: Adopted): Record<string, unknown> {
  return {
    environment: a.environment,
    dialect: a.dialect,
    status: "adopted",
    objects: a.objects,
    schemaFiles: a.schemaFiles,
    migration: { path: a.migrationPath, ...a.baseline },
    recorded: { history: a.recorded.database, seq: a.recorded.row.seq, note: a.recorded.row.note, appliedBy: a.recorded.row.applied_by },
    warnings: a.warnings,
  };
}

function report(io: Io, json: boolean, a: Adopted): void {
  if (json) {
    io.out(`${JSON.stringify(initJson(a), null, 2)}\n`);
    return;
  }
  const lines = [
    `Adopted ${a.environment} (${a.dialect}): ${String(a.objects.length)} object${a.objects.length === 1 ? "" : "s"}`,
    ...a.objects.map((o) => `  ${o}`),
    "",
    `Declarations: ${a.schemaFiles.join(", ")}`,
    `Baseline:     ${a.migrationPath}/ (${String(a.baseline.statements)} statement${a.baseline.statements === 1 ? "" : "s"}, ${a.baseline.checksum})`,
    `Recorded:     applied in ${a.recorded.database}.history as a baseline; none of its statements was run`,
    "",
    `yodel plan ${a.environment} shows no change, and yodel status ${a.environment} lists the baseline applied.`,
  ];
  for (const w of a.warnings) lines.push(`warning: ${w}`);
  io.out(`${lines.join("\n")}\n`);
}

/** `yodel init --from <env>`; the exit codes are in `help`. */
export const init: Command = {
  name: "init",
  summary: "adopt a live database: declarations and an applied baseline",
  implemented: true,
  run: (args, io) =>
    guarded("init", io, args, help, async () => {
      const a = parseInitArgs(args);
      const project = await loadProject(a.dir);
      const env = resolveEnvironment(project, a.from);
      const adopted = await adopt(project, env, { force: a.force, name: a.name, log: (l) => { io.err(`${l}\n`); } });
      report(io, a.json, adopted);
      return 0;
    }),
};
