import { execFileSync } from "node:child_process";
import { accessSteps, describeAccessSteps } from "../chant/access.js";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Command, Io } from "../command.js";
import { guarded } from "../env-args.js";
import { loadProject, resolveEnvironment, YodelError, type Project, yodelRefusal } from "../project.js";
import { DEFAULT_CI_NEW_NAME } from "../config/define.js";
import { closeVersioned, inspect, openVersioned } from "../versioned/index.js";
import type { Migration } from "../migrations/index.js";
import { buildSchema } from "../chant/build.js";
import { refreshSqlTypes } from "../chant/sql-types.js";
import {
  checksProblem,
  createHandWritten,
  createMigration,
  describeExpect,
  isHandWritten,
  migrationChecks,
  parseCheckArg,
  migrationId,
  MIGRATIONS_DIR,
  newestMigration,
  readMigrations,
  refusedSteps,
  verifyChecksum,
  writeMigration,
  type CreatedMigration,
  type MigrationCheck,
} from "../migrations/index.js";
import { asBackfill, asForm, BACKFILL_FILE, backfillTemplate, describeForm, describeFormSql, formPath, formProblems, formTemplate, loadBackfill, PG_MIGRATION_OP, REBUILD_OP, TEMPLATE_MARK, type BackfillForm } from "../steps/index.js";

const usage = "usage: yodel new [<name>] [--sql | --backfill [<file>]] [--retain <duration>] [--check <sql>]... [--replace | --replace-own] [--env <env>]... [--if-changed] [--json] [--dir <project>]";

const help = `${usage}

Writes the next migration, migrations/<YYYYMMDDTHHMM>-<name>/, by diffing
the newest migration's recorded schema (an empty schema for the first)
against the current build of the declared schema. Offline: no database,
dev or otherwise, is read. The name is lowercase letters and digits, words
joined by - or _. The timestamp is UTC. With no name, it is yodel.config.ts
ci.new.name with {pr} the pull request's number from CHANT_COMMIT_PR, which
chant's commit job sets (default pr-{pr}); without CHANT_COMMIT_PR a name is
needed.

The migration holds migration.sql (each statement after a comment naming its
object, rule and class) and migration.json (id, parent, checksum, the
recorded schema, the steps). A change no statement makes in place, such as a
ClickHouse sort-key change or a Postgres column rename, is an Op step:
written to migration.json with its declaration, and to migration.sql as a
comment only.

--sql writes a migration you write yourself: migration.sql holds a header
and no statements. Write them, each ending with ;, then run
yodel lint --update-checksum <id>, which records them in migration.json.
From then on it goes through the chain, plan, approval, apply, history and
resume like any other. It is for data a migration carries (reference rows,
a data fix) and statements yodel would not write. A statement that changes
the schema needs the change declared in src/ as well: the migration
records the current build as the schema after it, and yodel lint --replay
shows the statements give that schema. A migration of data statements only
records its parent's schema. No build and no server are read.

A data backfill is a step too. --backfill ends the migration with a
backfill step written from ${formPath("<name>")}, a form of four fields:

  { "table": "shop.orders", "key": "id", "batchSize": 10000,
    "sql": "UPDATE shop.orders SET country = 'NL' WHERE id >= {from} AND id < {to}" }

Each range of the integer key, batchSize wide, is one batch: {from} and {to}
in the SQL are its bounds (from inclusive, to exclusive), read from the
table's smallest and largest key when the step runs. "batches": [...] in
place of key and batchSize lists the batches instead, {batch} in the SQL.
"sql" may be a list of statements, and "settings" sets query settings for
each (ClickHouse: { "mutations_sync": "2" }). The form is written into the
step in migration.json, so it counts in the checksum and the plan shows it.
yodel apply runs the batches after the statements before the step, each
with its own receipt, and a run that fails or is stopped part way resumes
at the first batch without one. Make a batch safe to run twice (on
Postgres each batch is one transaction with its receipt, so it is).

When the form does not exist yet, a template is written there and no
migration: fill it in, then run the same command again. With --backfill a
migration is written even when the declared schema has not changed.
--backfill <file> reads the form from <file> (relative to the project
directory) instead; a <file> that is not .json is a module exporting a
chant Op of effect() batches, for a backfill the form cannot say
(docs/steps.md), copied into the migration's directory as ${BACKFILL_FILE}.

--retain <duration> (7d, 12h, 0s) is how long a Postgres column rename or
type change keeps the old column after the switch, or a ClickHouse rebuild
the old table after the swap: written into each such step's options.
Without it a Postgres step drops the old column in the same apply, right
after the switch, and a rebuild keeps the old table for 7 days. To add it
to a migration you just wrote, run yodel new <name> --replace --retain 7d.

--check <sql> adds a pre-migration check to migration.json: a read-only
query that must return no rows. yodel apply runs it against the environment
before the gate and again under the lock just before the migration's first
statement; a check that fails refuses the run (exit 1) and names it.
Written "<name>: <sql>" it is named <name>, else check-1, check-2 and so on.
For "returns true" or a count within bounds, edit its "expect" in
migration.json (docs/migrations.md); the checks count in the checksum and
the plan digest.

--replace redoes the newest migration when it is named <name>: it is written
again from its parent's recorded schema and the current build, under a new
id, and the old one is removed. It is for a migration you just wrote and
have not applied: refused when the migration is applied in an environment
--env names (each one is read), and it says so when git already tracks it.

--replace-own is how chant's commit job runs it (/yodel new): it redoes the
newest migration when it is this pull request's own, and otherwise writes
a new one after it, so asking twice gives one migration. The newest is its
own when it is named <name> (the default name holds the pull request's
number) and holds only what yodel new writes from the schema: not
hand-written, no backfill step, no --check and no --retain. A history
--env names that records it applied refuses the run, exit 1, and nothing
is written.

--if-changed compares the build with the newest migration's recorded
schema first, and writes nothing (exit 0) when they are the same, so
--replace and --replace-own do not write a migration again for a schema it
already records. Without either, yodel new already writes nothing then.

Options:
  --sql                a hand-written migration: an empty migration.sql to
                       write, recorded with yodel lint --update-checksum <id>
  --backfill [<file>]  end the migration with a backfill step written from
                       ${formPath("<name>")} (or <file>)
  --retain <duration>  how long a column rename or a rebuild keeps the old
                       column or table
  --check <sql>        a pre-migration check that must return no rows
                       (repeatable; "<name>: <sql>" names it)
  --replace            redo the newest migration, named <name>
  --replace-own        redo the newest migration when it is this pull
                       request's own, else write a new one
  --env <env>          with --replace or --replace-own: refuse if it is
                       applied in <env> (repeatable)
  --if-changed         write nothing when the build is the newest
                       migration's recorded schema
  --json               print what was written as JSON
  -C, --dir <dir>      the project directory (default: the working directory)

Exit codes:
  0  a migration was written, or the declared schema has no change from the
     newest recorded schema (then nothing is written)
  1  no migration could be made: a bad config, a declaration chant cannot
     build, a migrations directory that is not one chain (a fork, a missing
     parent), a migration of that id already there, no name and no
     CHANT_COMMIT_PR; or --replace or --replace-own refused, nothing
     written: the newest migration is not named <name> (--replace), or it
     is applied in an environment --env names
`;

interface NewArgs {
  /** Undefined: ci.new.name, from CHANT_COMMIT_PR. */
  name: string | undefined;
  json: boolean;
  dir: string;
  /** The file --backfill names; "" for the default form. */
  backfill: string | undefined;
  retain: string | undefined;
  replace: boolean;
  replaceOwn: boolean;
  ifChanged: boolean;
  envs: string[];
  checks: MigrationCheck[];
  sql: boolean;
}

/** A bare --backfill (last, or followed by another option) as --backfill="", the default form. */
const bareBackfill = (args: string[]): string[] => args.map((a, i) => (a === "--backfill" && (i === args.length - 1 || (args[i + 1] ?? "").startsWith("-")) ? "--backfill=" : a));

/** A duration chant takes: whole numbers of ms, s, m, h or d, as 7d or 1d12h. */
const DURATION = /^(\d+(ms|s|m|h|d))+$/;

function parseNewArgs(args: string[]): NewArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: bareBackfill(args),
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: "boolean" },
        dir: { type: "string", short: "C" },
        sql: { type: "boolean" },
        backfill: { type: "string" },
        retain: { type: "string" },
        replace: { type: "boolean" },
        "replace-own": { type: "boolean" },
        "if-changed": { type: "boolean" },
        env: { type: "string", multiple: true },
        check: { type: "string", multiple: true },
      },
    });
  } catch (e) {
    throw new YodelError(`${e instanceof Error ? e.message : String(e)}\n${usage}`);
  }
  const [name, ...rest] = parsed.positionals;
  if (rest.length > 0) throw new YodelError(usage);
  const replace = parsed.values.replace === true;
  const replaceOwn = parsed.values["replace-own"] === true;
  const ifChanged = parsed.values["if-changed"] === true;
  if (replace && replaceOwn) throw new YodelError(`--replace and --replace-own: give one of them\n${usage}`);
  if (parsed.values.env !== undefined && !replace && !replaceOwn) throw new YodelError(`--env goes with --replace or --replace-own\n${usage}`);
  if (name !== undefined) migrationId(name, new Date()); // a bad name fails before anything is built
  const retain = typeof parsed.values.retain === "string" ? parsed.values.retain : undefined;
  const sql = parsed.values.sql === true;
  if (sql && (parsed.values.backfill !== undefined || parsed.values.retain !== undefined || parsed.values.check !== undefined || replace || replaceOwn || ifChanged)) {
    throw new YodelError(`--sql writes a migration you write yourself, so it takes no --backfill, --retain, --check, --replace, --replace-own or --if-changed\n${usage}`);
  }
  if (parsed.values.backfill !== undefined && (replaceOwn || ifChanged)) {
    throw new YodelError(`--backfill writes a migration even when the declared schema has not changed, so it takes no --replace-own or --if-changed\n${usage}`);
  }
  if (retain !== undefined && !DURATION.test(retain)) throw new YodelError(`--retain takes a duration such as 7d, 12h or 0s, got ${JSON.stringify(retain)}\n${usage}`);
  return {
    name,
    json: parsed.values.json === true,
    dir: typeof parsed.values.dir === "string" ? parsed.values.dir : process.cwd(),
    backfill: typeof parsed.values.backfill === "string" ? parsed.values.backfill : undefined,
    retain,
    replace,
    replaceOwn,
    ifChanged,
    envs: Array.isArray(parsed.values.env) ? parsed.values.env.filter((e): e is string => typeof e === "string") : [],
    checks: parseChecks(parsed.values.check),
    sql,
  };
}

function parseChecks(value: unknown): MigrationCheck[] {
  const args = Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  const checks = args.map((a, i) => parseCheckArg(a, i + 1));
  const problem = checksProblem(checks);
  if (problem) throw new YodelError(`--check: ${problem}\n${usage}`);
  return checks;
}

function report(io: Io, json: boolean, made: CreatedMigration, path: string, projectDir: string): void {
  const steps = made.statements.steps;
  const refused = refusedSteps(steps);
  const statementCount = steps.length - refused.length;
  if (json) {
    io.out(
      `${JSON.stringify(
        {
          written: true,
          id: made.id,
          path,
          parent: made.document.parent,
          checksum: made.document.checksum,
          dialect: made.document.dialect,
          statements: statementCount,
          ops: refused.filter((s) => s.kind === "op").map((s) => ({ op: s.op, object: s.object, name: s.name, rules: s.changes.map((c) => c.rule), ...(typeof s.options.retain === "string" ? { retain: s.options.retain } : {}) })),
          manual: refused.filter((s) => s.kind === "manual").map((s) => ({ object: s.object, name: s.name, rules: s.changes.map((c) => c.rule), detail: s.detail })),
          hints: made.document.hints,
          checks: made.document.checks ?? [],
          prechecks: migrationChecks(made.document).flatMap((c) => (c.step ? [{ name: c.name, step: c.step.index, sql: c.sql, detail: c.step.detail }] : [])),
          access: accessSteps(steps).map((a) => ({
            step: a.index,
            object: a.step.object,
            name: a.step.name,
            ...(a.step.kind === "statement" ? { rule: a.step.rule, class: a.step.class } : {}),
            ...(a.away ? { takesAway: a.away } : {}),
          })),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  const where = relative(projectDir, path) || path;
  const parent = made.document.parent ? `follows ${made.document.parent}` : "the first migration";
  const lines = [`Wrote ${where}/ (${String(statementCount)} statement${statementCount === 1 ? "" : "s"}; ${parent})`];
  for (const s of refused) {
    const rules = s.changes.map((c) => c.rule).join(", ");
    const backfill = asBackfill(s);
    const form = backfill ? asForm(backfill.options) : undefined;
    if (form) {
      lines.push(`  This migration ends with a backfill of ${describeForm(form)}. Each batch runs:`);
      lines.push(...describeFormSql(form).split("\n").map((l) => `    ${l}`));
      lines.push(`    yodel apply runs the batches after the statements before it, each with its own receipt, and resumes from them after a failure.`);
    } else if (backfill && "file" in backfill.options) {
      lines.push(`  This migration ends with a backfill step: the Op ${backfill.options.file} exports, copied into the migration's directory.`);
      lines.push(`    yodel apply runs its effect() batches after the statements before it, resuming from their receipts after a failure.`);
    } else if (s.kind === "op") {
      lines.push(`  This migration contains an Op step: ${s.op} for ${s.object} (${s.name}), ${rules}.`);
      lines.push(`    It is not SQL. migration.json holds the Op's declaration:`);
      lines.push(`    ${s.declaration}`);
      lines.push(...retention(s.op, s.options, made.document.id.slice(made.document.id.indexOf("-") + 1)).map((l) => `    ${l}`));
    } else {
      lines.push(`  This migration contains a manual step: ${s.object} (${s.name}), ${rules}. No statement and no Op makes it:`);
      lines.push(`    ${s.detail}`);
    }
  }
  for (const c of migrationChecks(made.document)) {
    if (c.step) lines.push(`  step ${String(c.step.index)} can fail on the rows already there (${c.step.detail}); yodel apply runs its pre-check ${c.name} before the first statement and refuses unless it returns 0: ${c.sql}`);
    else lines.push(`  check ${c.name}: ${c.sql} (${describeExpect(c)}, before the first statement)`);
  }
  for (const l of describeAccessSteps(steps)) lines.push(`  ${l}`);
  for (const h of made.document.hints) lines.push(`  hint: ${h}`);
  io.out(`${lines.join("\n")}\n`);
}

/** What a column migration or a rebuild step keeps after its switch, and for how long. */
function retention(op: string, options: Record<string, unknown>, name: string): string[] {
  const retain = typeof options.retain === "string" ? options.retain : undefined;
  if (op === PG_MIGRATION_OP) {
    return retain !== undefined
      ? [`The old column is kept for ${retain} after the switch (retain), so readers of it keep working until then; yodel cleanup <env> drops it after that date.`]
      : [
          `No retain: the old column is dropped in the same yodel apply, right after the switch, so anything still reading it breaks then.`,
          `To keep it while readers move over: yodel new ${name} --replace --retain 7d`,
        ];
  }
  if (op === REBUILD_OP && retain !== undefined) return [`The old table is kept as ${typeof options.table === "string" ? options.table : "<table>"}__chant_old for ${retain} after the swap (retain).`];
  return [];
}

/** Reads and checks a backfill form; throws naming what is wrong. */
function readForm(path: string, text: string): BackfillForm {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new YodelError(`${path}: not JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const problems = formProblems(parsed);
  const form = problems.length === 0 ? asForm(parsed) : undefined;
  if (!form) throw new YodelError(`${path}: ${problems.join("; ")}`);
  return form;
}

/** `yodel new <name>`; the exit codes are in `help`. */
export const newCommand: Command = {
  name: "new",
  summary: "write the next migration from the declared schema",
  implemented: true,
  run: (args, io) =>
    guarded("new", io, args, help, async () => {
      const { name: given, json, dir, backfill: backfillArg, retain, replace, replaceOwn, ifChanged, envs, checks, sql } = parseNewArgs(args);
      if (given === undefined) pullRequest(); // no name and no pull request fails before anything is loaded
      const project = await loadProject(dir);
      const name = given ?? defaultName(project);
      if (sql) return writeHandWritten(io, project, name, json);
      let backfill: { text: string } | { form: BackfillForm } | undefined;
      if (backfillArg !== undefined) {
        const file = backfillArg === "" ? formPath(name) : backfillArg;
        const isForm = file.endsWith(".json");
        const path = resolve(project.dir, file);
        const again = `yodel new ${name} --backfill${backfillArg === "" ? "" : ` ${backfillArg}`}`;
        if (!existsSync(path)) {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, isForm ? formTemplate(name, project.dialect) : backfillTemplate(name, project.dialect));
          const where = relative(project.dir, path) || path;
          if (json) io.out(`${JSON.stringify({ written: false, template: path }, null, 2)}\n`);
          else if (isForm) {
            io.out(
              `Wrote a backfill form at ${where}: the table, its integer key and how many keys a batch takes, and the SQL of one batch with {from} and {to} (or "batches": [...] and {batch}). ` +
                `Fill it in, then run ${again} again. No migration written.\n`,
            );
          } else io.out(`Wrote a backfill template at ${where}. Write its batches, then run ${again} again. No migration written.\n`);
          return 0;
        }
        const text = readFileSync(path, "utf8");
        if (text.includes(TEMPLATE_MARK)) throw new YodelError(`${path} is still the template; write ${isForm ? "the table, the key and one batch's SQL" : "its batches' SQL"} first`);
        if (isForm) backfill = { form: readForm(path, text) };
        else {
          await loadBackfill(path, text);
          backfill = { text };
        }
      }
      const migrationsDir = join(project.dir, MIGRATIONS_DIR);
      const ordered = readMigrations(migrationsDir);
      const newest = newestMigration(ordered);
      let replaced = replace ? await replaceable(project, ordered, name, envs, io) : undefined;
      // Before the build, after the DDL sources: chant's SQL102 fails a build whose sql-types.d.ts is stale, as a declaration change leaves it (#328).
      const build = await buildSchema(project, { beforeBuild: () => sqlTypes(io, project, json) });
      let made: ReturnType<typeof createMigration>;
      let previous: Migration | undefined;
      try {
        if (ifChanged || replaceOwn) {
          // The newest migration already records the build: nothing to write, whatever --replace or --replace-own would redo.
          const ahead = createMigration({ name, build: build.output, previous: newest });
          if (ahead.id === undefined) {
            const from = newest ? `the newest migration's recorded schema (${newest.id})` : "an empty schema (the declared schema declares nothing)";
            if (json) io.out(`${JSON.stringify({ written: false, parent: newest?.id ?? null, dialect: project.dialect, hints: ahead.statements.hints }, null, 2)}\n`);
            else io.out(`No changes: the declared schema matches ${from}. Nothing written.\n`);
            return 0;
          }
        }
        if (replaceOwn) replaced = await ownMigration(project, ordered, name, envs, io);
        previous = replaced ? ordered[ordered.length - 2] : newest;
        if (previous && !verifyChecksum(previous).ok) {
          io.err(`yodel new: warning: ${previous.id}'s files no longer match its recorded checksum; the new migration follows it as recorded\n`);
        }
        made = createMigration({ name, build: build.output, previous, ...(backfill ? { backfill } : {}), ...(retain !== undefined ? { retain } : {}), ...(checks.length > 0 ? { checks } : {}) });
      } finally {
        build.dispose();
      }
      if (made.id === undefined) {
        if (replaced) {
          const msg = `No changes from ${previous ? `${previous.id}'s recorded schema` : "an empty schema"}: the declared schema is what ${replaced.id} started from. Nothing written; ${replaced.id} is kept (delete it to drop it).`;
          if (json) io.out(`${JSON.stringify({ written: false, replaced: null, kept: replaced.id }, null, 2)}\n`);
          else io.out(`${msg}\n`);
          return 0;
        }
        const from = previous ? `the newest migration's recorded schema (${previous.id})` : "an empty schema (the declared schema declares nothing)";
        if (json) io.out(`${JSON.stringify({ written: false, parent: previous?.id ?? null, dialect: project.dialect, hints: made.statements.hints }, null, 2)}\n`);
        else io.out(`No changes: the declared schema matches ${from}. Nothing written.\n`);
        return 0;
      }
      if (retain !== undefined && !made.statements.steps.some((st) => st.kind === "op" && [PG_MIGRATION_OP, REBUILD_OP].includes(st.op))) {
        io.err(`yodel new: warning: --retain ${retain} is for a Postgres column rename or type change, or a ClickHouse rebuild, and ${made.id} has none\n`);
      }
      if (replaced) {
        // Moved aside first and removed only once the new one is written, so a failure leaves the old one in place.
        const aside = join(migrationsDir, `.replaced-${replaced.id}`);
        renameSync(replaced.dir, aside);
        let path: string;
        try {
          path = writeMigration(migrationsDir, made);
        } catch (e) {
          renameSync(aside, replaced.dir);
          throw e;
        }
        rmSync(aside, { recursive: true, force: true });
        if (!json) io.out(`Replaced ${replaced.id}.\n`);
        report(io, json, made, path, project.dir);
        return 0;
      }
      const path = writeMigration(migrationsDir, made);
      report(io, json, made, path, project.dir);
      return 0;
    }),
};

/**
 * Refreshes src/sql-types.d.ts from src/ (#273) before the build reads it, and says so; under --json only a warning, on stderr.
 * Before the build, since chant's SQL102 fails a build against a stale file (#328).
 */
async function sqlTypes(io: Io, project: Project, json: boolean): Promise<void> {
  // chant's commit job (#312) pushes a change to migrations/ only, and refuses one that touches src/.
  if (process.env.CHANT_COMMIT_PR !== undefined) return;
  const r = await refreshSqlTypes(project);
  if (r.warning) io.err(`yodel new: warning: ${r.warning}\n`);
  else if (r.updated && !json) io.out(`Updated ${r.updated} from the declarations.\n`);
}

/** `yodel new <name> --sql`: the empty hand-written migration after the newest. */
function writeHandWritten(io: Io, project: Project, name: string, json: boolean): number {
  const migrationsDir = join(project.dir, MIGRATIONS_DIR);
  const previous = newestMigration(readMigrations(migrationsDir));
  const made = createHandWritten({
    name,
    dialect: project.dialect,
    previous,
    ...(project.dialect === "clickhouse" ? { defaultDatabase: previous?.document.defaultDatabase ?? "default" } : { defaultSchema: previous?.document.defaultSchema ?? "public" }),
  });
  const path = writeMigration(migrationsDir, made);
  if (json) {
    io.out(`${JSON.stringify({ written: true, id: made.id, path, parent: made.document.parent, checksum: made.document.checksum, dialect: made.document.dialect, source: "sql", statements: 0, ops: [], manual: [], hints: [], checks: [] }, null, 2)}\n`);
    return 0;
  }
  const where = relative(project.dir, path) || path;
  io.out(
    `Wrote ${where}/ (hand-written; ${made.document.parent ? `follows ${made.document.parent}` : "the first migration"}).\n` +
      `  Write its statements in ${where}/migration.sql, each ending with ;, then run yodel lint --update-checksum ${made.id}.\n` +
      `  A statement that changes the schema needs the change declared in src/ too.\n`,
  );
  return 0;
}


/**
 * The name `yodel new` takes with none given (#311): `ci.new.name` (default
 * `pr-{pr}`) with `{pr}` the pull request's number, from `CHANT_COMMIT_PR`,
 * which chant's commit job sets in the command's environment.
 */
export function defaultName(project: Project, env: NodeJS.ProcessEnv = process.env): string {
  return (project.yodel?.config.ci?.new?.name ?? DEFAULT_CI_NEW_NAME).replaceAll("{pr}", pullRequest(env));
}

/** `CHANT_COMMIT_PR`, the pull request's number, or a usage error when it is not set to one. */
function pullRequest(env: NodeJS.ProcessEnv = process.env): string {
  const pr = env.CHANT_COMMIT_PR ?? "";
  if (!/^[1-9][0-9]*$/.test(pr)) {
    throw new YodelError(
      `yodel new needs a name: give one, or run it in chant's commit job, which sets CHANT_COMMIT_PR to the pull request's number for yodel.config.ts ci.new.name (default ${DEFAULT_CI_NEW_NAME})` +
        `${pr === "" ? "" : `; CHANT_COMMIT_PR is ${JSON.stringify(pr)}, not a number`}\n${usage}`,
    );
  }
  return pr;
}

/** What a migration holds that `yodel new <name>` alone does not write from the schema, or undefined when it holds none. */
function notPlain(m: Migration): string | undefined {
  if (isHandWritten(m.document)) return "hand-written statements";
  if (m.document.steps.some((st) => asBackfill(st) !== undefined)) return "a backfill step";
  if ((m.document.checks ?? []).length > 0) return "pre-migration checks";
  if (m.document.steps.some((st) => st.kind === "op" && typeof st.options.retain === "string")) return "a retain";
  if (m.files.extra && Object.keys(m.files.extra).length > 0) return "files of its own";
  return undefined;
}

/**
 * The newest migration, when --replace-own redoes it: named `name`, holding
 * only what yodel new writes, and applied or run in none of `envs`. Else
 * undefined, and the new migration follows it. A history that records it
 * refuses the run.
 */
async function ownMigration(project: Project, ordered: readonly Migration[], name: string, envs: readonly string[], io: Io): Promise<Migration | undefined> {
  const newest = newestMigration(ordered);
  if (!newest || newest.id.slice(newest.id.indexOf("-") + 1) !== name) return undefined;
  const extra = notPlain(newest);
  if (extra) {
    io.err(`yodel new: ${newest.id} holds ${extra}, which --replace-own does not write again, so it is kept and the new migration follows it\n`);
    return undefined;
  }
  for (const envName of envs) {
    const env = resolveEnvironment(project, envName);
    const venv = await openVersioned(project, env);
    try {
      const { status } = await inspect(venv, ordered, { sync: false });
      if (status.applied.some((a) => a.id === newest.id)) {
        throw yodelRefusal(`refused: ${newest.id} is applied in ${env.name}, so it is not replaced; write the change as a new migration (yodel new <name>). Nothing written.`);
      }
      const ran = status.pending.find((p) => p.id === newest.id && p.partWay !== undefined);
      if (ran?.partWay) {
        throw yodelRefusal(`refused: ${newest.id} ran part way in ${env.name} (${ran.partWay.status}), so it is not replaced; resume it with yodel apply ${env.name}, then write the change as a new migration. Nothing written.`);
      }
    } finally {
      await closeVersioned(venv);
    }
  }
  if (envs.length === 0) io.err(`yodel new: --replace-own checked no environment's history; with --env <env>, it refuses a migration applied there\n`);
  return newest;
}

/** The newest migration, when --replace may redo it: named `name`, and applied in none of `envs`. */
async function replaceable(project: Project, ordered: readonly Migration[], name: string, envs: readonly string[], io: Io): Promise<Migration> {
  const newest = newestMigration(ordered);
  if (!newest) throw yodelRefusal(`--replace redoes the newest migration, and there is none yet; run yodel new ${name}`);
  if (newest.id.slice(newest.id.indexOf("-") + 1) !== name) {
    throw yodelRefusal(`--replace redoes the newest migration, ${newest.id}, which is not named ${name}; nothing written`);
  }
  for (const envName of envs) {
    const env = resolveEnvironment(project, envName);
    const venv = await openVersioned(project, env);
    try {
      const { status } = await inspect(venv, ordered, { sync: false });
      if (status.applied.some((a) => a.id === newest.id)) {
        throw yodelRefusal(`refused: ${newest.id} is applied in ${env.name}, so it is not redone; write the change as a new migration (yodel new <name>). Nothing written.`);
      }
    } finally {
      await closeVersioned(venv);
    }
  }
  if (envs.length === 0) io.err(`yodel new: --replace checked no environment; with --env <env>, it refuses a migration applied there\n`);
  if (tracked(project.dir, newest.dir)) io.err(`yodel new: warning: git already tracks ${newest.id}; anyone who has that commit has the old one\n`);
  return newest;
}

/** Whether git tracks anything under `path`. */
function tracked(cwd: string, path: string): boolean {
  try {
    return execFileSync("git", ["ls-files", "--", path], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() !== "";
  } catch {
    return false;
  }
}
