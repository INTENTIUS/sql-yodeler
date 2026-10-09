import { parseArgs } from "node:util";
import type { Command, Io } from "../command.js";
import { guarded } from "../env-args.js";
import { loadProject, resolveEnvironment, YodelError, type Project } from "../project.js";
import { MigrationDirectoryError, refusedSteps, scanMigrations } from "../migrations/index.js";
import { closeVersioned, migrationsDir, openVersioned } from "../versioned/index.js";
import { planRebase, REBASE_REFUSED, writeRebase, type RebasePlan } from "../rebase/index.js";

const usage = "usage: yodel rebase [<id>] [--onto <parent-id>] [--env <env>]... [--force] [--json] [--dir <project>]";

const help = `${usage}

Moves a migration onto another parent and rewrites it, so two branches that
each added a migration can both merge. With no <id>, the directory's one
fork (two migrations that follow the same parent) is resolved: the newer of
the two (by the timestamp in its id) moves onto the end of the other's
branch. Name <id> to move another one, and --onto to choose its new parent.
Migrations that follow the moved one move with it.

Each moved migration's change (its recorded schema against its old
parent's) is applied to its new parent's recorded schema, giving its new
recorded schema; its statements are diffed again from the new parent's, and
its migration.sql, migration.json and checksum are written again. When both
branches change the same object, differently, nothing is written and the
object is named: resolve it by hand (delete the migration, then yodel new).
Offline: no database is read, except the histories --env names.

Ids do not change. The order is the chain of parent ids, not the ids'
timestamps, so a rebased migration runs after its new parent whatever its
timestamp says, and anything that names it still does.

Options:
  --onto <id>      the new parent (default: the end of the other branch)
  --env <env>      refuse if this environment's history records a migration
                   the rebase would rewrite; repeat for more environments.
                   Without it, no history is checked: never rebase a
                   migration that ran somewhere
  --force          rewrite migrations whose files were edited by hand (the
                   edits, such as a -- yodel:allow line, are dropped)
  --json           print what was rewritten as JSON
  -C, --dir <dir>  the project directory (default: the working directory)

Exit codes:
  0  rebased, or no fork to rebase
  4  refused, nothing written: both branches change the same object, a
     migration to rewrite was edited by hand (without --force), a history
     records one of them, or the moved migration adds nothing on its new
     parent
  1  the rebase could not be worked out: no such migration, a fork the
     defaults cannot settle, a bad config, a server that does not answer
`;

interface RebaseArgs {
  id: string | undefined;
  onto: string | undefined;
  envs: string[];
  force: boolean;
  json: boolean;
  dir: string;
}

function parseRebaseArgs(args: string[]): RebaseArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        onto: { type: "string" },
        env: { type: "string", multiple: true },
        force: { type: "boolean" },
        json: { type: "boolean" },
        dir: { type: "string", short: "C" },
      },
    });
  } catch (e) {
    throw new YodelError(`${e instanceof Error ? e.message : String(e)}\n${usage}`);
  }
  const { values, positionals } = parsed;
  if (positionals.length > 1) throw new YodelError(usage);
  const envs = Array.isArray(values.env) ? values.env.filter((e): e is string => typeof e === "string") : [];
  return {
    id: positionals[0],
    onto: typeof values.onto === "string" ? values.onto : undefined,
    envs,
    force: values.force === true,
    json: values.json === true,
    dir: typeof values.dir === "string" ? values.dir : process.cwd(),
  };
}

/** Refuses when an environment's history names a migration the rebase would rewrite. */
async function checkHistories(project: Project, envs: readonly string[], plan: RebasePlan): Promise<void> {
  for (const name of envs) {
    const env = resolveEnvironment(project, name);
    const venv = await openVersioned(project, env);
    const state = await venv.store.state().finally(() => closeVersioned(venv));
    const ran = plan.rewritten.flatMap((m) => {
      const rec = state.byId.get(m.id);
      return rec ? [`${m.id} (${rec.status === "succeeded" ? "applied" : `ran part way, ${rec.status}`})`] : [];
    });
    if (ran.length > 0) {
      throw new YodelError(
        `refused: ${name}'s history records ${ran.join(", ")}. Nothing was written. A migration that ran is never rebased: ` +
          `its statements already ran in that order. Rebase the other branch onto it instead (yodel rebase <the other> --onto <the end of this one>).`,
        REBASE_REFUSED,
      );
    }
  }
}

function report(io: Io, json: boolean, plan: RebasePlan, envs: readonly string[]): void {
  if (json) {
    io.out(
      `${JSON.stringify(
        {
          rebased: true,
          moved: plan.moved,
          from: plan.from,
          onto: plan.onto,
          historiesChecked: envs,
          rewritten: plan.rewritten.map((m) => ({
            id: m.id,
            path: m.dir,
            oldParent: m.oldParent,
            parent: m.parent,
            oldChecksum: m.oldChecksum,
            checksum: m.checksum,
            statements: m.statements.steps.length - refusedSteps(m.statements.steps).length,
            refused: m.statements.refused,
            handEdited: m.handEdited,
          })),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  const lines = [`Rebased ${plan.moved} onto ${plan.onto} (it followed ${plan.from ?? "nothing"}).`];
  for (const m of plan.rewritten) {
    const n = m.statements.steps.length - refusedSteps(m.statements.steps).length;
    lines.push(`  ${m.id}: follows ${m.parent}; ${String(n)} statement${n === 1 ? "" : "s"}${m.statements.refused ? " and an Op or manual step" : ""}; checksum ${m.oldChecksum} -> ${m.checksum}`);
    for (const h of m.statements.hints) lines.push(`    hint: ${h}`);
  }
  lines.push(
    envs.length > 0
      ? `Checked against the history of ${envs.join(", ")}: none of them had run.`
      : "No history was checked (--env): make sure none of these ran anywhere before merging.",
  );
  io.out(`${lines.join("\n")}\n`);
}

/** `yodel rebase`; the exit codes are in `help`. */
export const rebase: Command = {
  name: "rebase",
  summary: "move a migration onto a new parent and recompute its schema",
  implemented: true,
  run: (args, io) =>
    guarded("rebase", io, args, help, async () => {
      const options = parseRebaseArgs(args);
      const project = await loadProject(options.dir);
      const scan = scanMigrations(migrationsDir(project));
      const structural = scan.problems.filter((p) => p.kind === "unreadable" || p.kind === "id-mismatch" || p.kind === "missing-parent");
      if (structural.length > 0) throw new MigrationDirectoryError(scan.dir, structural);

      const plan = planRebase(scan.migrations, { id: options.id, onto: options.onto });
      if (plan.moved === undefined) {
        if (options.json) io.out(`${JSON.stringify({ rebased: false }, null, 2)}\n`);
        else io.out("No fork: every migration follows a different parent. Nothing to rebase.\n");
        return 0;
      }
      const edited = plan.rewritten.filter((m) => m.handEdited);
      if (edited.length > 0 && !options.force) {
        throw new YodelError(
          `refused: ${edited.map((m) => m.id).join(", ")} ${edited.length === 1 ? "has" : "have"} files that differ from what yodel wrote (an edit by hand, or a checksum that no longer matches). ` +
            `Rebasing writes them again from their recorded schema and drops that edit. Nothing was written; pass --force to rebase anyway, then make the edit again.`,
          REBASE_REFUSED,
        );
      }
      await checkHistories(project, options.envs, plan);
      writeRebase(plan);
      report(io, options.json, plan, options.envs);
      return 0;
    }),
};
