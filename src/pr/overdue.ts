/**
 * The plan comment's warning that an environment's drift watch stopped
 * running (chant#4289). A scheduled job can stop with no error anywhere:
 * GitHub turns a scheduled workflow off after 60 days with no activity in
 * the repository, and on GitLab the job runs only from a pipeline schedule
 * someone created. The watch cannot report its own absence, so `yodel plan
 * --comment` asks the forge when the environment's WatchOp job last ran and
 * warns when its cron has fired at least twice since.
 *
 * chant decides and finds the file (`checkOverdueOps` in
 * `op/schedule-overdue.ts`, chant issue 4789): it reads every workflow and
 * pipeline file, `.gitlab/yodel-watch.gitlab-ci.yml` included, so yodel says
 * only which Ops. The Op is the WatchOp whose `Env` label is the environment
 * (chant's `WatchOp` sets `Watch` and `Env`).
 *
 * Nothing here fails the plan. A forge that does not answer is a line in
 * the job log and no warning.
 */

import type { OpConfig } from "@intentius/chant/op/types";
import type { OverdueOp } from "@intentius/chant/op/schedule-overdue";
import type { PrForge } from "@intentius/chant/pr-forge";

/** The environment's scheduled WatchOps, by name. */
export async function envWatches(ops: Iterable<OpConfig>, env: string): Promise<{ op: string; cron: string }[]> {
  const { scheduledWatches } = await import("@intentius/chant/op/schedule-overdue");
  return scheduledWatches([...ops].filter((o) => o.labels?.Watch === "true" && o.labels.Env === env));
}

/**
 * The environment's overdue watches, each logged with `log`. `ops` are the
 * project's discovered Op configs; `dir` is the project, where `yodel ci`
 * writes its files.
 */
export async function overdueWatches(input: {
  ops: Iterable<OpConfig>;
  env: string;
  dir: string;
  forge: Pick<PrForge, "kind" | "scheduledRuns">;
  now: Date;
  log: (line: string) => void;
}): Promise<OverdueOp[]> {
  const { checkOverdueOps } = await import("@intentius/chant/op/schedule-overdue");
  return checkOverdueOps({ watches: await envWatches(input.ops, input.env), forge: input.forge, repoRoot: input.dir, now: input.now, log: (line) => { input.log(`yodel plan: ${line}`); } });
}

/** The notes `yodel plan --comment` adds for the environment's overdue watches: discovers the Ops, never throws. */
export async function overdueNotes(dir: string, env: string, forge: Pick<PrForge, "kind" | "scheduledRuns">, log: (line: string) => void, now = new Date()): Promise<string[]> {
  try {
    const { discoverOps } = await import("@intentius/chant/op/discover");
    const found = await discoverOps({ cwd: dir });
    const overdue = await overdueWatches({ ops: [...found.ops.values()].map((o) => o.config), env, dir, forge, now, log });
    return overdue.map((o) => `Warning: ${o.message}`);
  } catch (e) {
    log(`yodel plan: the watch schedule was not checked: ${(e instanceof Error ? e.message : String(e)).split("\n")[0] ?? ""}`);
    return [];
  }
}
