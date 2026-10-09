import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Command, Io } from "../command.js";
import { guarded } from "../env-args.js";
import { loadProject, YodelError } from "../project.js";
import { buildSchema } from "../chant/build.js";
import {
  createMigration,
  migrationId,
  MIGRATIONS_DIR,
  newestMigration,
  readMigrations,
  refusedSteps,
  verifyChecksum,
  writeMigration,
  type CreatedMigration,
} from "../migrations/index.js";
import { asBackfill, BACKFILL_FILE, backfillTemplate, loadBackfill, TEMPLATE_MARK } from "../steps/index.js";

const usage = "usage: yodel new <name> [--backfill <file>] [--json] [--dir <project>]";

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

Options:
  --backfill <file>  end the migration with a backfill step running <file>
  --json           print what was written as JSON
  -C, --dir <dir>  the project directory (default: the working directory)

Exit codes:
  0  a migration was written, or the declared schema has no change from the
     newest recorded schema (then nothing is written)
  1  no migration could be made: a bad config, a declaration chant cannot
     build, a migrations directory that is not one chain (a fork, a missing
     parent), a migration of that id already there
`;

function parseNewArgs(args: string[]): { name: string; json: boolean; dir: string; backfill: string | undefined } {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: { json: { type: "boolean" }, dir: { type: "string", short: "C" }, backfill: { type: "string" } },
    });
  } catch (e) {
    throw new YodelError(`${e instanceof Error ? e.message : String(e)}\n${usage}`);
  }
  const [name, ...rest] = parsed.positionals;
  if (name === undefined || rest.length > 0) throw new YodelError(usage);
  migrationId(name, new Date()); // a bad name fails before anything is built
  return {
    name,
    json: parsed.values.json === true,
    dir: typeof parsed.values.dir === "string" ? parsed.values.dir : process.cwd(),
    backfill: typeof parsed.values.backfill === "string" ? parsed.values.backfill : undefined,
  };
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
      const { name, json, dir, backfill: backfillArg } = parseNewArgs(args);
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
      const previous = newestMigration(readMigrations(migrationsDir));
      if (previous && !verifyChecksum(previous).ok) {
        io.err(`yodel new: warning: ${previous.id}'s files no longer match its recorded checksum; the new migration follows it as recorded\n`);
      }
      const build = await buildSchema(project);
      let made: ReturnType<typeof createMigration>;
      try {
        made = createMigration({ name, build: build.output, previous, ...(backfill ? { backfill } : {}) });
      } finally {
        build.dispose();
      }
      if (made.id === undefined) {
        const from = previous ? `the newest migration's recorded schema (${previous.id})` : "an empty schema (the declared schema declares nothing)";
        if (json) io.out(`${JSON.stringify({ written: false, parent: previous?.id ?? null, dialect: project.dialect, hints: made.statements.hints }, null, 2)}\n`);
        else io.out(`No changes: the declared schema matches ${from}. Nothing written.\n`);
        return 0;
      }
      const path = writeMigration(migrationsDir, made);
      report(io, json, made, path, project.dir);
      return 0;
    }),
};
