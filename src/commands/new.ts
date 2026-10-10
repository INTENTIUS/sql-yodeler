import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Command, Io } from "../command.js";
import { guarded } from "../env-args.js";
import { loadProject, resolveEnvironment, YodelError, type Project } from "../project.js";
import { closeVersioned, inspect, openVersioned } from "../versioned/index.js";
import type { Migration } from "../migrations/index.js";
import { buildSchema } from "../chant/build.js";
import {
  checksProblem,
  createMigration,
  describeExpect,
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
import { asBackfill, BACKFILL_FILE, backfillTemplate, loadBackfill, TEMPLATE_MARK } from "../steps/index.js";

const usage = "usage: yodel new <name> [--backfill <file>] [--check <sql>]... [--replace [--env <env>]...] [--json] [--dir <project>]";

const help = `${usage}

Writes the next migration, migrations/<YYYYMMDDTHHMM>-<name>/, by diffing
the newest migration's recorded schema (an empty schema for the first)
against the current build of the declared schema. Offline: no database,
dev or otherwise, is read. The name is lowercase letters and digits, words
joined by - or _. The timestamp is UTC.

The migration holds migration.sql (each statement after a comment naming its
object, rule and class) and migration.json (id, parent, checksum, the
recorded schema, the steps). A change no statement makes in place, such as a
ClickHouse sort-key change or a Postgres column rename, is an Op step:
written to migration.json with its declaration, and to migration.sql as a
comment only.

A data backfill is a step too. --backfill <file> ends the migration with a
backfill step: <file> (relative to the project directory) is a module
exporting a chant Op whose every step is an effect() batch with its own
receipt, running SQL with activity("yodelSql", { sql }). It is copied into
the migration's directory as ${BACKFILL_FILE} and counts in its checksum.
yodel apply runs it after the statements before it, and a run that fails or
is stopped part way resumes at the first batch without a receipt. When
<file> does not exist yet, a template is written there and no migration:
write the batches, then run the same command again. With --backfill a
migration is written even when the declared schema has not changed.

--check <sql> adds a pre-migration check to migration.json: a read-only
query that must return no rows. yodel apply runs it against the environment
before the gate and again under the lock just before the migration's first
statement; a check that fails refuses the run (exit 4) and names it.
Written "<name>: <sql>" it is named <name>, else check-1, check-2 and so on.
For "returns true" or a count within bounds, edit its "expect" in
migration.json (docs/migrations.md); the checks count in the checksum and
the plan digest.

--replace redoes the newest migration when it is named <name>: it is written
again from its parent's recorded schema and the current build, under a new
id, and the old one is removed. It is for a migration you just wrote and
have not applied: refused when the migration is applied in an environment
--env names (each one is read), and it says so when git already tracks it.

Options:
  --backfill <file>  end the migration with a backfill step running <file>
  --check <sql>      a pre-migration check that must return no rows
                     (repeatable; "<name>: <sql>" names it)
  --replace          redo the newest migration, named <name>
  --env <env>        with --replace: refuse if it is applied in <env>
                     (repeatable)
  --json             print what was written as JSON
  -C, --dir <dir>    the project directory (default: the working directory)

Exit codes:
  0  a migration was written, or the declared schema has no change from the
     newest recorded schema (then nothing is written)
  1  no migration could be made: a bad config, a declaration chant cannot
     build, a migrations directory that is not one chain (a fork, a missing
     parent), a migration of that id already there
  4  --replace refused, nothing written: the newest migration is not named
     <name>, or it is applied in an environment --env names
`;

interface NewArgs {
  name: string;
  json: boolean;
  dir: string;
  backfill: string | undefined;
  replace: boolean;
  envs: string[];
  checks: MigrationCheck[];
}

function parseNewArgs(args: string[]): NewArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: { json: { type: "boolean" }, dir: { type: "string", short: "C" }, backfill: { type: "string" }, replace: { type: "boolean" }, env: { type: "string", multiple: true }, check: { type: "string", multiple: true } },
    });
  } catch (e) {
    throw new YodelError(`${e instanceof Error ? e.message : String(e)}\n${usage}`);
  }
  const [name, ...rest] = parsed.positionals;
  if (name === undefined || rest.length > 0) throw new YodelError(usage);
  if (parsed.values.env !== undefined && parsed.values.replace !== true) throw new YodelError(`--env goes with --replace\n${usage}`);
  migrationId(name, new Date()); // a bad name fails before anything is built
  return {
    name,
    json: parsed.values.json === true,
    dir: typeof parsed.values.dir === "string" ? parsed.values.dir : process.cwd(),
    backfill: typeof parsed.values.backfill === "string" ? parsed.values.backfill : undefined,
    replace: parsed.values.replace === true,
    envs: Array.isArray(parsed.values.env) ? parsed.values.env.filter((e): e is string => typeof e === "string") : [],
    checks: parseChecks(parsed.values.check),
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
          ops: refused.filter((s) => s.kind === "op").map((s) => ({ op: s.op, object: s.object, name: s.name, rules: s.changes.map((c) => c.rule) })),
          manual: refused.filter((s) => s.kind === "manual").map((s) => ({ object: s.object, name: s.name, rules: s.changes.map((c) => c.rule), detail: s.detail })),
          hints: made.document.hints,
          checks: made.document.checks ?? [],
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
    if (backfill) {
      lines.push(`  This migration ends with a backfill step: the Op ${backfill.options.file} exports, copied into the migration's directory.`);
      lines.push(`    yodel apply runs its effect() batches after the statements before it, resuming from their receipts after a failure.`);
    } else if (s.kind === "op") {
      lines.push(`  This migration contains an Op step: ${s.op} for ${s.object} (${s.name}), ${rules}.`);
      lines.push(`    It is not SQL. migration.json holds the Op's declaration:`);
      lines.push(`    ${s.declaration}`);
    } else {
      lines.push(`  This migration contains a manual step: ${s.object} (${s.name}), ${rules}. No statement and no Op makes it:`);
      lines.push(`    ${s.detail}`);
    }
  }
  for (const c of made.document.checks ?? []) lines.push(`  check ${c.name}: ${c.sql} (${describeExpect(c)}, before the first statement)`);
  for (const h of made.document.hints) lines.push(`  hint: ${h}`);
  io.out(`${lines.join("\n")}\n`);
}

/** `yodel new <name>`; the exit codes are in `help`. */
export const newCommand: Command = {
  name: "new",
  summary: "write the next migration from the declared schema",
  implemented: true,
  run: (args, io) =>
    guarded("new", io, args, help, async () => {
      const { name, json, dir, backfill: backfillArg, replace, envs, checks } = parseNewArgs(args);
      const project = await loadProject(dir);
      let backfill: { text: string } | undefined;
      if (backfillArg !== undefined) {
        const path = resolve(project.dir, backfillArg);
        if (!existsSync(path)) {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, backfillTemplate(name, project.dialect));
          const where = relative(project.dir, path) || path;
          if (json) io.out(`${JSON.stringify({ written: false, template: path }, null, 2)}\n`);
          else io.out(`Wrote a backfill template at ${where}. Write its batches, then run yodel new ${name} --backfill ${backfillArg} again. No migration written.\n`);
          return 0;
        }
        const text = readFileSync(path, "utf8");
        if (text.includes(TEMPLATE_MARK)) throw new YodelError(`${path} is still the template; write its batches' SQL first`);
        await loadBackfill(path, text);
        backfill = { text };
      }
      const migrationsDir = join(project.dir, MIGRATIONS_DIR);
      const ordered = readMigrations(migrationsDir);
      const replaced = replace ? await replaceable(project, ordered, name, envs, io) : undefined;
      const previous = replaced ? ordered[ordered.length - 2] : newestMigration(ordered);
      if (previous && !verifyChecksum(previous).ok) {
        io.err(`yodel new: warning: ${previous.id}'s files no longer match its recorded checksum; the new migration follows it as recorded\n`);
      }
      const build = await buildSchema(project);
      let made: ReturnType<typeof createMigration>;
      try {
        made = createMigration({ name, build: build.output, previous, ...(backfill ? { backfill } : {}), ...(checks.length > 0 ? { checks } : {}) });
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

/** Exit code: --replace refused; nothing written. */
export const REPLACE_REFUSED = 4;

/** The newest migration, when --replace may redo it: named `name`, and applied in none of `envs`. */
async function replaceable(project: Project, ordered: readonly Migration[], name: string, envs: readonly string[], io: Io): Promise<Migration> {
  const newest = newestMigration(ordered);
  if (!newest) throw new YodelError(`--check <sql> adds a pre-migration check to migration.json: a read-only
query that must return no rows. yodel apply runs it against the environment
before the gate and again under the lock just before the migration's first
statement; a check that fails refuses the run (exit 4) and names it.
Written "<name>: <sql>" it is named <name>, else check-1, check-2 and so on.
For "returns true" or a count within bounds, edit its "expect" in
migration.json (docs/migrations.md); the checks count in the checksum and
the plan digest.

--replace redoes the newest migration, and there is none yet; run yodel new ${name}`, REPLACE_REFUSED);
  if (newest.id.slice(newest.id.indexOf("-") + 1) !== name) {
    throw new YodelError(`--check <sql> adds a pre-migration check to migration.json: a read-only
query that must return no rows. yodel apply runs it against the environment
before the gate and again under the lock just before the migration's first
statement; a check that fails refuses the run (exit 4) and names it.
Written "<name>: <sql>" it is named <name>, else check-1, check-2 and so on.
For "returns true" or a count within bounds, edit its "expect" in
migration.json (docs/migrations.md); the checks count in the checksum and
the plan digest.

--replace redoes the newest migration, ${newest.id}, which is not named ${name}; nothing written`, REPLACE_REFUSED);
  }
  for (const envName of envs) {
    const env = resolveEnvironment(project, envName);
    const venv = await openVersioned(project, env);
    try {
      const { status } = await inspect(venv, ordered, { sync: false });
      if (status.applied.some((a) => a.id === newest.id)) {
        throw new YodelError(`refused: ${newest.id} is applied in ${env.name}, so it is not redone; write the change as a new migration (yodel new <name>). Nothing written.`, REPLACE_REFUSED);
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
