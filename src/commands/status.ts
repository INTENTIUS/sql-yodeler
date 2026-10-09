import type { Command } from "../command.js";
import { guarded, parseEnvArgs, usage } from "../env-args.js";
import { loadProject, resolveEnvironment } from "../project.js";
import { readMigrations } from "../migrations/index.js";
import { migrationsDir, openVersioned, renderStatus, statusJson, statusReport } from "../versioned/index.js";

/** Exit code: migrations are pending, and nothing is wrong. */
export const STATUS_PENDING = 3;
/** Exit code: a checksum mismatch, an applied migration gone from the directory, or an out-of-order migration. */
export const STATUS_REFUSED = 4;

const help = `${usage("status")}

Lists the environment's migrations against its history table
(YODEL_HISTORY_DATABASE, default yodeler): applied, pending, out of order
(pending, but before an applied migration in the chain), failed part way
(with the statement it resumes at), and checksum mismatches (an applied
migration whose files changed, or that is gone from the directory). When
yodel apply would run, prints the plan digest it would ask approval for.
Reads only; takes no lock.

Options:
  --json           print the status as JSON
  -C, --dir <dir>  the project directory (default: the working directory)

Exit codes:
  0  every migration is applied
  3  migrations are pending (failed part way included), and nothing is wrong
  4  a checksum mismatch, an applied migration gone from the directory, or an
     out-of-order migration (apply refuses it without --allow-out-of-order)
  2  a pending migration has a manual step or an Op step yodel apply does not run
  1  the status could not be read: a bad config, a malformed migrations
     directory, a server that does not answer
`;

/** `yodel status <env>`; the exit codes are in `help`. */
export const status: Command = {
  name: "status",
  summary: "list applied, pending and out-of-order migrations",
  implemented: true,
  run: (args, io) =>
    guarded("status", io, args, help, async () => {
      const { env: name, json, dir } = parseEnvArgs("status", args);
      const project = await loadProject(dir);
      const env = resolveEnvironment(project, name);
      const ordered = readMigrations(migrationsDir(project));
      const venv = await openVersioned(project, env);
      const report = await statusReport(venv, ordered, { sync: false });
      if (json) io.out(`${JSON.stringify(statusJson(report), null, 2)}\n`);
      // The sections already say what is wrong; the refusal's wording is apply's.
      else io.out(renderStatus({ ...report, refusal: undefined }));
      if (report.refusal) return report.refusal.exitCode;
      return report.status.pending.length > 0 ? STATUS_PENDING : 0;
    }),
};
