/**
 * The applied schema on chant's release ledger (#208).
 *
 * After a run changes an environment's schema (an apply, a revert, a
 * baseline), yodel appends one release record to `<env>/releases.jsonl` on
 * the `chant/lifecycle` branch, keyed by the digest of the schema the
 * environment now holds: {@link schemaSha} of the recorded schema of the
 * newest migration it has applied, or of the declared schema after a
 * declarative apply. Every environment that applied the same migrations
 * records the same digest, so `chant components status prod --compare-to
 * staging` answers whether prod holds the schema staging tested.
 *
 * The history table stays the record of what ran; the release record only
 * says which schema an environment reached, when, from which commit and run.
 * The schema is applied by the time the record is written, so a record that
 * cannot be written is a warning, never the run's failure.
 *
 * A tenant (#56) is recorded on its environment's ledger as the component
 * `<component>/<tenant>`, so a tenant compares with the same tenant of
 * another environment.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BuildOutput } from "../chant/build.js";
import type { Migration } from "../migrations/index.js";
import { schemaSha } from "../migrations/checkpoint.js";
import type { Environment, Project } from "../project.js";
import type { VersionedStatus } from "../versioned/state.js";

/** What {@link recordRelease} did: the record it appended, or why it appended none. */
export type ReleaseOutcome =
  | { recorded: true; component: string; env: string; digest: string; pushed: boolean; warning?: string }
  | { recorded: false; reason: string };

/**
 * The component a project's records are under: its directory in its git
 * repository, or `schema` for a project at the root.
 */
export async function releaseComponent(dir: string): Promise<string | undefined> {
  try {
    const { stdout } = await promisify(execFile)("git", ["rev-parse", "--show-prefix"], { cwd: dir });
    return stdout.trim().replace(/\/+$/, "") || "schema";
  } catch {
    return undefined;
  }
}

/**
 * The migration whose recorded schema an environment holds: the newest one
 * it applied, when every migration before it in the chain is applied too (or
 * left out by the checkpoint it starts from). Undefined when it has applied
 * none, or when an out-of-order apply left a gap, since the schema is then
 * none a migration recorded.
 */
export function appliedHead(ordered: readonly Migration[], status: Pick<VersionedStatus, "applied" | "skipped">): Migration | undefined {
  const applied = new Set(status.applied.map((a) => a.id));
  const skipped = new Set((status.skipped ?? []).map((s) => s.id));
  let head: Migration | undefined;
  let gap = false;
  for (const m of ordered) {
    if (skipped.has(m.id)) continue;
    if (!applied.has(m.id)) {
      gap = true;
      continue;
    }
    if (gap) return undefined;
    head = m;
  }
  return head;
}

/**
 * Appends a release record of `schema` for `env` to chant's release ledger
 * and pushes it. Writes nothing when the project is not in a git
 * repository, or when the ledger branch could not be fetched or has forked
 * from the remote's (appending there would drop one side's records).
 */
export async function recordRelease(project: Project, env: Environment, schema: BuildOutput, options: { approver?: string } = {}): Promise<ReleaseOutcome> {
  const cwd = project.dir;
  const base = await releaseComponent(cwd);
  if (base === undefined) return { recorded: false, reason: `${cwd} is not in a git repository` };
  const { appendReleaseRecord, resolveRunId } = await import("@intentius/chant/lifecycle/release-ledger");
  const { fetchLifecycleStatus, getHeadCommit, pushLifecycleReport } = await import("@intentius/chant/lifecycle/git");
  const fetched = await fetchLifecycleStatus({ cwd });
  if (fetched.status === "diverged" || fetched.status === "unreachable") {
    return { recorded: false, reason: `the chant/lifecycle branch is ${fetched.status} from ${fetched.remote}${fetched.stderr ? ` (${fetched.stderr.split("\n")[0] ?? ""})` : ""}` };
  }
  let gitSha: string;
  try {
    gitSha = await getHeadCommit({ cwd });
  } catch {
    return { recorded: false, reason: `${cwd} has no commit` };
  }
  const actor = process.env.GITHUB_ACTOR ?? process.env.GITLAB_USER_LOGIN ?? process.env.USER;
  if (!actor) return { recorded: false, reason: "no actor: none of GITHUB_ACTOR, GITLAB_USER_LOGIN or USER is set" };
  const component = env.tenant ? `${base}/${env.tenant.name}` : base;
  const ledgerEnv = env.tenant ? env.tenant.env : env.name;
  const digest = schemaSha(schema);
  const { runId, runOrigin } = resolveRunId();
  await appendReleaseRecord(
    {
      component,
      env: ledgerEnv,
      digest,
      gitSha,
      runId,
      ...(runOrigin ? { runOrigin } : {}),
      timestamp: new Date().toISOString(),
      actor,
      ...(options.approver ? { approver: options.approver } : {}),
    },
    { cwd },
  );
  const push = await pushLifecycleReport({ cwd });
  return { recorded: true, component, env: ledgerEnv, digest, pushed: push.pushed, ...(push.pushWarning ? { warning: push.pushWarning } : {}) };
}

/** {@link recordRelease}, told in one line (two when the push did not land); a failure to record is a line too, never thrown. */
export async function recordReleaseLines(project: Project, env: Environment, schema: BuildOutput | undefined, options: { approver?: string } = {}): Promise<string[]> {
  if (!schema) return [`release: not recorded; ${env.name}'s schema is none a migration recorded (nothing applied, or an out-of-order gap)`];
  try {
    const r = await recordRelease(project, env, schema, options);
    if (!r.recorded) return [`release: not recorded; ${r.reason}`];
    return [`release: ${r.component} in ${r.env} at ${r.digest}, on chant/lifecycle`, ...(r.warning ? [`release: ${r.warning}`] : [])];
  } catch (e) {
    return [`release: not recorded; ${e instanceof Error ? e.message : String(e)}`];
  }
}
