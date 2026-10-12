import { parseArgs } from "node:util";
import type { Command, Io } from "../command.js";
import { guarded } from "../env-args.js";
import { loadProject, resolveEnvironment, YodelError, type Project } from "../project.js";
import { migrationId } from "../migrations/index.js";
import { adopt, BASELINE_NAME, planBaseline, projectBaseline, type Adopted } from "../init/index.js";
import { GATED, gatedCommands } from "../chant/apply.js";
import { migrationsApprovalAtBase } from "../approval-mode/index.js";
import { runnable, runnableAsWriter } from "../chant/runnable.js";
import { permissionRefusal, readerRefusal } from "../credentials.js";
import { EXIT_REFUSED } from "../exit.js";
import { isApplied } from "../history/index.js";
import { closeVersioned, findMigrateOp, inspect, openVersioned, readChain, runMigrateOp } from "../versioned/index.js";

const usage = "usage: yodel init --from <env> [--json] [--dir <project>] [--force] [--skip-unsupported] [--name <name>]\n       yodel init --baseline <env> [--json] [--dir <project>] [--op <name>]";

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

--baseline <env>: another environment that already holds the schema
(staging, prod), in a project that has its baseline. Plans the schema the
baseline (the project's first migration) records against <env>'s live
database, offline from migration.json: every object must be there as the
baseline declares it, and nothing else in the profile's databases or
schemas. A difference refuses (exit 4), naming each object and what
differs, and nothing is recorded. When they match, records the baseline
applied in <env>'s history, without running it, through <env>'s migrations
Op, as yodel apply does: its Plan step compares again and prints the
record's digest (the baseline, the empty history and the live schema), its
gate binds the approval to that digest, and its Apply step compares again
under the lock, refuses if the digest moved, and appends the row. A run
that stops at the gate prints the yodel approve command; approve, then run
yodel init --baseline <env> again. Then yodel plan <env> shows the
migrations after the baseline pending, as in every other environment.

Options:
  --from <env>     the environment to adopt
  --baseline <env> record the project's baseline in <env>, which holds its schema
  --op <name>      (--baseline) the Op to run, when more than one applies <env>
  --name <name>    the baseline migration's name (default ${BASELINE_NAME})
  --force          overwrite declaration files the source directory already has
  --skip-unsupported
                   adopt the rest when the database holds objects of a kind
                   yodel cannot declare, and record those in the baseline's note
  --json           print what was done as JSON
  -C, --dir <dir>  the project directory (default: the working directory)

Exit codes:
  0  adopted: declarations and the baseline written, the baseline recorded
     applied (--baseline: the baseline recorded applied in <env>)
  3  (--baseline) stopped at the gate, waiting for approval of the record
  4  refused, nothing written: the source directory already declares a
     schema (without --force), the project already has migrations, the
     history already records migrations, the environment holds nothing or
     an object of a kind yodel cannot declare (without --skip-unsupported), or
     a ClickHouse profile with no databases or with the history's database;
     --baseline: the project has no migrations, <env>'s history records
     any, or <env>'s live schema is not the baseline's; or the run holds
     <env>'s reader (YODEL_CREDENTIALS is not writer or writer:<env>), or
     the server refused the user a privilege
  5  another apply holds the lock; nothing recorded, nothing kept
  1  anything else failed, and nothing was kept: a bad config, a server it
     cannot read, a build or a plan that is not clean after the import
`;

interface InitArgs {
  from: string | undefined;
  baseline: string | undefined;
  op: string | undefined;
  json: boolean;
  dir: string;
  force: boolean;
  skipUnsupported: boolean;
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
        baseline: { type: "string" },
        op: { type: "string" },
        json: { type: "boolean" },
        dir: { type: "string", short: "C" },
        force: { type: "boolean" },
        "skip-unsupported": { type: "boolean" },
        name: { type: "string" },
      },
    });
  } catch (e) {
    throw new YodelError(`${e instanceof Error ? e.message : String(e)}\n${usage}`);
  }
  const { values } = parsed;
  const str = (k: string) => (typeof values[k] === "string" && values[k] !== "" ? values[k] : undefined);
  const from = str("from");
  const baseline = str("baseline");
  if ((from === undefined) === (baseline === undefined)) throw new YodelError(`one of --from <env> and --baseline <env> is required\n${usage}`);
  if (baseline !== undefined && (values.force === true || values.name !== undefined || values["skip-unsupported"] === true)) throw new YodelError(`--force, --skip-unsupported and --name go with --from; --baseline records the baseline the project has\n${usage}`);
  if (from !== undefined && values.op !== undefined) throw new YodelError(`--op goes with --baseline\n${usage}`);
  const name = typeof values.name === "string" ? values.name : BASELINE_NAME;
  migrationId(name, new Date()); // a bad name fails before anything is read
  return {
    from,
    baseline,
    op: str("op"),
    json: values.json === true,
    dir: typeof values.dir === "string" ? values.dir : process.cwd(),
    force: values.force === true,
    skipUnsupported: values["skip-unsupported"] === true,
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
    unsupported: a.unsupported,
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
  if (a.unsupported.length > 0) lines.push("", `Not adopted, of kinds yodel cannot declare (--skip-unsupported): ${String(a.unsupported.length)}`, ...a.unsupported.map((u) => `  ${u}`));
  for (const w of a.warnings) lines.push(`warning: ${w}`);
  io.out(`${lines.join("\n")}\n`);
}

/** `yodel init --baseline <env> --json` (schemas/init.schema.json, its second form). */
export function baselineJson(input: { environment: string; dialect: string; baseline: { id: string; checksum: string }; planDigest: string; outcome: Record<string, unknown> }): Record<string, unknown> {
  return { environment: input.environment, dialect: input.dialect, migration: input.baseline, planDigest: input.planDigest, ...input.outcome };
}

/** `yodel init --baseline <env>` (#115): compares, then records the baseline through the migrations Op. */
async function recordIn(project: Project, name: string, a: InitArgs, io: Io): Promise<number> {
  const env = resolveEnvironment(project, name);
  const ordered = readChain(project);
  const baseline = projectBaseline(ordered);
  const venv = await openVersioned(project, env);
  try {
    const planDigest = await planBaseline(project, env, venv, baseline);
    const emit = (outcome: Record<string, unknown>, code: number) => {
      if (a.json) io.out(`${JSON.stringify(baselineJson({ environment: env.name, dialect: project.dialect, baseline: { id: baseline.id, checksum: baseline.checksum }, planDigest, outcome }), null, 2)}\n`);
      return code;
    };
    const op = await findMigrateOp(project, env, a.op);
    if (!a.json) io.out(`${env.name}'s live schema is the schema ${baseline.id} records, and its history records nothing.\nPlan digest: ${planDigest}\n\nRunning ${op.name} (${op.filePath}) to record ${baseline.id} applied in ${env.name}\n`);
    const ran = await runMigrateOp(project, op, { allowOutOfOrder: false, baseline: baseline.id, onOutput: (t) => { io.err(t); } });
    if (ran.status === "gated") {
      const commands = gatedCommands(ran, env.name, (await migrationsApprovalAtBase(project, env.name)).mode);
      if (!a.json) {
        io.out(`\n${op.name} is waiting at gate "${op.gate}" for approval of this record${ran.planDigest ? ` (${ran.planDigest})` : ""}.\n`);
        if (commands.approve) io.out(`Approve it at a terminal with:\n  ${runnable(commands.approve, project.dir)}\nthen run ${runnableAsWriter(`yodel init --baseline ${env.name}`, project.dir, env.profile)} again.\n`);
      }
      return emit({ status: "gated", op: op.name, gate: op.gate, ...commands, ...(ran.planDigest ? { gatePlanDigest: ran.planDigest } : {}) }, GATED);
    }
    if (ran.status === "failed") {
      const code = ran.stepExit !== undefined && ran.stepExit !== 0 ? ran.stepExit : 1;
      if (!a.json) io.err(`yodel init: chant run ${op.name} failed (exit ${String(ran.code)})${ran.stepExit ? `: its Apply step exited ${String(ran.stepExit)}` : ""}\n`);
      return emit({ status: "failed", op: op.name, exitCode: code }, code);
    }
    const { state } = await inspect(venv, ordered);
    if (!isApplied(state.byId.get(baseline.id))) {
      if (!a.json) io.err(`yodel init: ${op.name} completed, but ${env.name}'s history does not record ${baseline.id} applied\n`);
      return emit({ status: "failed", op: op.name, exitCode: 1 }, 1);
    }
    if (!a.json) io.out(`\nRecorded ${baseline.id} applied in ${env.name} (${venv.location.database}.history) as a baseline; none of its statements was run.\nyodel status ${env.name} lists it applied, and yodel plan ${env.name} the migrations after it.\n`);
    return emit({ status: "recorded", op: op.name, history: venv.location.database }, 0);
  } finally {
    await closeVersioned(venv);
  }
}

/** `yodel init --from <env>`; the exit codes are in `help`. */
export const init: Command = {
  name: "init",
  summary: "adopt a live database, or record its baseline in another env",
  implemented: true,
  run: (args, io) =>
    guarded("init", io, args, help, async () => {
      const a = parseInitArgs(args);
      const project = await loadProject(a.dir);
      const env = resolveEnvironment(project, a.baseline ?? a.from ?? "");
      // init writes the history (#159): the reader refuses before anything is read, naming the variable that picks the writer.
      const command = runnable(a.baseline !== undefined ? `yodel init --baseline ${env.name}` : `yodel init --from ${env.name}${a.force ? " --force" : ""}`, project.dir);
      const asReader = readerRefusal(env.profile, command);
      if (asReader) throw new YodelError(asReader, EXIT_REFUSED);
      try {
        if (a.baseline !== undefined) return await recordIn(project, a.baseline, a, io);
        const adopted = await adopt(project, env, { force: a.force, skipUnsupported: a.skipUnsupported, name: a.name, log: (l) => { io.err(`${l}\n`); } });
        report(io, a.json, adopted);
        return 0;
      } catch (e) {
        const denied = permissionRefusal(e, env.profile, command);
        if (denied) throw new YodelError(denied, EXIT_REFUSED);
        throw e;
      }
    }),
};
