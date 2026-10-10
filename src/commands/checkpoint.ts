import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import type { Command } from "../command.js";
import { guarded } from "../env-args.js";
import { EXIT_REFUSED } from "../exit.js";
import { loadProject, YodelError } from "../project.js";
import { createCheckpoint, isCheckpoint, MIGRATIONS_DIR, migrationId, newestMigration, readMigrations, verifyChecksum, writeMigration } from "../migrations/index.js";

const usage = "usage: yodel checkpoint <name> [--json] [--dir <project>]";

const help = `${usage}

Writes a checkpoint after the newest migration: a migration whose
statements create the newest migration's recorded schema from nothing, in
migrations/<YYYYMMDDTHHMM>-<name>/. Offline: no database is read, and the
declared schema is not built; the recorded schema is the source.

yodel apply on an environment whose history is empty starts at the newest
checkpoint and never runs the migrations before it. An environment that
already ran them skips the checkpoint. yodel status lists both kinds of
skipped migration.

The checkpoint's migration.json marks it with the SHA-256 of the recorded
schema it was written from, and that recorded schema is its own: yodel lint
(rule checkpoint) fails one whose recorded schema is no longer its parent's,
and yodel lint --replay <env> runs its statements into an empty database
and compares the result with that schema. The checksum covers both, as for
any migration.

Options:
  --json           print what was written as JSON
  -C, --dir <dir>  the project directory (default: the working directory)

Exit codes:
  0  the checkpoint was written
  1  no checkpoint could be made: a bad config, a migrations directory that
     is not one chain, no migration yet, a recorded schema that declares
     nothing or that statements alone cannot create
  4  refused, nothing written: the newest migration is a checkpoint already
`;

/** `yodel checkpoint <name>`; the exit codes are in `help`. */
export const checkpoint: Command = {
  name: "checkpoint",
  summary: "write a checkpoint: the newest recorded schema from nothing",
  implemented: true,
  run: (args, io) =>
    guarded("checkpoint", io, args, help, async () => {
      let parsed: ReturnType<typeof parseArgs>;
      try {
        parsed = parseArgs({ args, allowPositionals: true, strict: true, options: { json: { type: "boolean" }, dir: { type: "string", short: "C" } } });
      } catch (e) {
        throw new YodelError(`${e instanceof Error ? e.message : String(e)}\n${usage}`);
      }
      const [name, ...rest] = parsed.positionals;
      if (name === undefined || rest.length > 0) throw new YodelError(usage);
      migrationId(name, new Date()); // a bad name fails before anything is read
      const json = parsed.values.json === true;
      const project = await loadProject(typeof parsed.values.dir === "string" ? parsed.values.dir : process.cwd());
      const dir = join(project.dir, MIGRATIONS_DIR);
      const parent = newestMigration(readMigrations(dir));
      if (!parent) throw new YodelError(`no migration yet in ${dir}; a checkpoint creates the newest migration's recorded schema (yodel new <name> first)`);
      if (isCheckpoint(parent)) throw new YodelError(`refused: the newest migration, ${parent.id}, is a checkpoint already. Nothing written.`, EXIT_REFUSED);
      if (!verifyChecksum(parent).ok) io.err(`yodel checkpoint: warning: ${parent.id}'s files no longer match its recorded checksum; the checkpoint creates its recorded schema as it stands\n`);
      const made = createCheckpoint({ name, parent });
      const path = writeMigration(dir, made);
      const statements = made.document.steps.length;
      if (json) {
        io.out(
          `${JSON.stringify(
            { written: true, id: made.id, path, parent: parent.id, checksum: made.document.checksum, dialect: made.document.dialect, statements, schema: made.document.checkpoint?.schema ?? "" },
            null,
            2,
          )}\n`,
        );
      } else {
        io.out(
          `Wrote ${relative(project.dir, path) || path}/ (a checkpoint: ${String(statements)} statement${statements === 1 ? "" : "s"} creating ${parent.id}'s recorded schema from nothing)\n` +
            `  An environment whose history is empty starts here; one that ran the migrations before it skips it.\n`,
        );
      }
      return 0;
    }),
};
