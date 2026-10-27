import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Command, Io } from "../command.js";
import { guarded } from "../env-args.js";
import { loadProject, resolveEnvironment, YodelError } from "../project.js";
import { MIGRATION_JSON, scanMigrations, serializeDocument, verifyChecksum, type Migration } from "../migrations/index.js";
import { appliedBy, newRunContext, withLock } from "../history/index.js";
import { closeVersioned, migrationsDir, openVersioned, type VersionedEnv } from "../versioned/index.js";
import { checkRepair, repairRow } from "../rebase/repair.js";

/** A migration directory's name: `<YYYYMMDDTHHMM>-<name>`. */
const MIGRATION_ID = /^\d{8}T\d{4}-/;

const usage = 'usage: yodel repair <env> <id> --reason "<text>" [--json] [--dir <project>]\n       (or yodel repair <id> --reason "<text>" <env>)';

const help = `${usage}

Records an intended edit to a migration that is already applied in <env>:
appends a row to the environment's history table (yodel.config.ts
history.database, else YODEL_HISTORY_DATABASE, default yodeler; on
Postgres the schema of that name) with the checksum the migration's files
have now and the reason, under the apply lock. After it, yodel status and
yodel apply compare the files with the new checksum. Nothing is run on the server: the edit is
recorded, not applied. Repair each environment the migration ran in.

When migration.json's own checksum field is stale too (it is not part of
what the checksum covers), it is written again to match.

Options:
  --reason <text>  why the files changed; required, and kept in the history
  --json           print the repair as JSON
  -C, --dir <dir>  the project directory (default: the working directory)

Exit codes:
  0  the new checksum is recorded
  5  another apply holds the lock
  1  refused, nothing written: the migration is not applied in <env> (not
     run, or part way), its files already match the history, or it is gone
     from the directory; or anything else: no --reason, a bad config, a
     server that does not answer
`;

function parseRepairArgs(args: string[]): { id: string; env: string; reason: string; json: boolean; dir: string } {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: { reason: { type: "string" }, json: { type: "boolean" }, dir: { type: "string", short: "C" } },
    });
  } catch (e) {
    throw new YodelError(`${e instanceof Error ? e.message : String(e)}\n${usage}`);
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 2) throw new YodelError(usage);
  // <env> <id>, as every other command takes the environment first, or <id> ... <env> (#19): the id is the one shaped like one.
  const [first = "", second = ""] = positionals;
  const [id, env] = MIGRATION_ID.test(first) && !MIGRATION_ID.test(second) ? [first, second] : [second, first];
  const reason = typeof values.reason === "string" ? values.reason.trim() : "";
  if (reason === "") throw new YodelError(`a repair needs a reason: --reason "<why the files changed>"\n${usage}`);
  return { id, env, reason, json: values.json === true, dir: typeof values.dir === "string" ? values.dir : process.cwd() };
}

/** Writes migration.json again with its checksum field matching its files, when it does not. Returns whether it wrote. */
function syncRecordedChecksum(m: Migration): boolean {
  const check = verifyChecksum(m);
  if (check.ok) return false;
  const path = join(m.dir, MIGRATION_JSON);
  const tmp = join(m.dir, `.${MIGRATION_JSON}.repairing`);
  writeFileSync(tmp, serializeDocument({ ...(JSON.parse(m.files.json) as Record<string, unknown>), checksum: check.actual }));
  renameSync(tmp, path);
  return true;
}

/** `yodel repair <id> --reason ... <env>`; the exit codes are in `help`. */
export const repair: Command = {
  name: "repair",
  summary: "record a new checksum for an applied migration, with a reason",
  implemented: true,
  run: (args, io) =>
    guarded("repair", io, args, help, async () => {
      const { id, env: name, reason, json, dir } = parseRepairArgs(args);
      const project = await loadProject(dir);
      const env = resolveEnvironment(project, name);
      const m = scanMigrations(migrationsDir(project)).migrations.find((x) => x.id === id);
      const venv = await openVersioned(project, env);
      try {
        return await repairWith(venv, m, { id, envName: env.name, reason, json, io });
      } finally {
        await closeVersioned(venv);
      }
    }),
};

/** `yodel repair --json` (schemas/repair.schema.json). */
export function repairJson(r: { id: string; environment: string; oldChecksum: string; newChecksum: string; reason: string; seq: number; runId: string; migrationJsonUpdated: boolean }): Record<string, unknown> {
  return { repaired: true, ...r };
}

async function repairWith(venv: VersionedEnv, m: Migration | undefined, { id, envName, reason, json, io }: { id: string; envName: string; reason: string; json: boolean; io: Io }): Promise<number> {
  checkRepair(m, id, await venv.store.state(), envName); // refuse before taking the lock

  const lock = await venv.driver.acquireLock(appliedBy());
  if (lock.notice && !json) io.err(`lock: ${lock.notice}\n`);
  const row = await withLock(lock, venv.lockTtlMs, async () => {
    const state = await venv.store.state();
    const check = checkRepair(m, id, state, envName);
    const r = repairRow({ migration: m as Migration, check, reason, run: newRunContext(check.record.planDigest), seq: state.maxSeq + 1 });
    await venv.store.append([r]);
    return { r, check };
  });
  const synced = syncRecordedChecksum(m as Migration);

  if (json) {
    io.out(
      `${JSON.stringify(repairJson({ id, environment: envName, oldChecksum: row.check.oldChecksum, newChecksum: row.check.newChecksum, reason, seq: row.r.seq, runId: row.r.run_id, migrationJsonUpdated: synced }), null, 2)}\n`,
    );
  } else {
    io.out(
      [
        `Repaired ${id} in ${envName}'s history (${venv.location.database}).`,
        `  old checksum: ${row.check.oldChecksum}`,
        `  new checksum: ${row.check.newChecksum}`,
        `  reason: ${reason}`,
        ...(synced ? [`  ${MIGRATION_JSON}'s checksum field updated to match`] : []),
        "",
      ].join("\n"),
    );
  }
  return 0;

}
