/**
 * The plan comment's warning that an environment's drift watch stopped
 * running (chant#4289). A scheduled job can stop with no error anywhere:
 * GitHub turns a scheduled workflow off after 60 days with no activity in
 * the repository, and on GitLab the job runs only from a pipeline schedule
 * someone created. The watch cannot report its own absence, so `yodel plan
 * --comment` asks the forge when the environment's WatchOp job last ran and
 * warns when its cron has fired at least twice since.
 *
 * chant decides (`overdueVerdict` in `op/schedule-overdue.ts`); yodel says
 * which Op and which file. The Op is the WatchOp whose `Env` label is the
 * environment (chant's `WatchOp` sets `Watch` and `Env`,
 * `op/composites/watch-op.ts:80` in chant 0.124.46). The file is the one
 * `yodel ci` renders for it: `.github/workflows/<op>.yml` or
 * `.forgejo/workflows/<op>.yml`, and on GitLab {@link GITLAB_WATCH} when its
 * rules select the Op. chant's own `checkOverdueOps` reads only root
 * `*.gitlab-ci.yml` files, so yodel asks the forge itself.
 *
 * Nothing here fails the plan. A forge that does not answer is a line in
 * the job log and no warning.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { OpConfig } from "@intentius/chant/op/types";
import type { OverdueOp } from "@intentius/chant/op/schedule-overdue";
import type { PrForge } from "@intentius/chant/pr-forge";

/** The GitLab file `yodel ci` renders the watches into (`GITLAB_WATCH_FILE` in ../ci/render.ts). */
export const GITLAB_WATCH = ".gitlab/yodel-watch.gitlab-ci.yml";

/** The environment's scheduled WatchOps, by name. */
export async function envWatches(ops: Iterable<OpConfig>, env: string): Promise<{ op: string; cron: string }[]> {
  const { scheduledWatches } = await import("@intentius/chant/op/schedule-overdue");
  return scheduledWatches([...ops].filter((o) => o.labels?.Watch === "true" && o.labels.Env === env));
}

/** The file `yodel ci` rendered for `op` on `forge`, relative to the project, when the project has it. */
export function watchPipelineFile(dir: string, forge: PrForge["kind"], op: string): string | undefined {
  if (forge === "gitlab") {
    try {
      return readFileSync(join(dir, GITLAB_WATCH), "utf8").includes(`$CHANT_SCHEDULED_OP == "${op}"`) ? GITLAB_WATCH : undefined;
    } catch {
      return undefined;
    }
  }
  const path = `.${forge}/workflows/${op}.yml`;
  return existsSync(join(dir, path)) ? path : undefined;
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
  const { forge } = input;
  if (!forge.scheduledRuns) return [];
  const { fileAdded, overdueVerdict } = await import("@intentius/chant/op/schedule-overdue");
  const out: OverdueOp[] = [];
  for (const watch of await envWatches(input.ops, input.env)) {
    const file = watchPipelineFile(input.dir, forge.kind, watch.op);
    if (!file) continue;
    let runs: Awaited<ReturnType<NonNullable<PrForge["scheduledRuns"]>>>;
    try {
      runs = await forge.scheduledRuns({ op: watch.op, workflow: file.split("/").pop() ?? file });
    } catch (e) {
      input.log(`yodel plan: ${forge.kind} did not say when ${watch.op} last ran, so it is not checked: ${(e instanceof Error ? e.message : String(e)).split("\n")[0] ?? ""}`);
      continue;
    }
    const found = overdueVerdict(watch, forge.kind, runs, runs.last ? undefined : fileAdded(input.dir, file), input.now);
    if (found) {
      input.log(`yodel plan: Warning: ${found.message}`);
      out.push(found);
    }
  }
  return out;
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
