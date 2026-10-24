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
 *
 * What else a record carries (#277), each only when it is known:
 *
 * - `approver` and `admission` (`{ op, gate, resolvedAt }`, chant#4020), for
 *   an apply a gate approved, both from chant's `admissionOf`. An apply no
 *   approval let through writes neither.
 * - `releaseDigest` (chant#4043), for an apply made from a chant release
 *   (`_releases/<releaseDigest>.json`): `yodel apply <env> --release <ref>`,
 *   which hands it to the Op's Apply step in `YODEL_RELEASE`. chant writes it
 *   only when the caller names a release, never inferred, and so does yodel.
 *
 * Records already on the ledger are never rewritten; a reader takes every
 * field above as optional (chant's `reference/workspace-read-contract`).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ReleaseAdmission } from "@intentius/chant/lifecycle/release-ledger";
import type { BuildOutput } from "../chant/build.js";
import type { Migration } from "../migrations/index.js";
import { schemaSha } from "../migrations/checkpoint.js";
import { YodelError, type Environment, type Project } from "../project.js";
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

/** What a release record says beyond the schema: who approved it, the gate resolution that admitted it, and the chant release it was made from. */
export interface ReleaseFacts {
  approver?: string | undefined;
  admission?: ReleaseAdmission | undefined;
  releaseDigest?: string | undefined;
}

/** The environment variable `yodel apply --release` hands the Op's Apply step the release digest in. */
export const RELEASE_ENV = "YODEL_RELEASE";

/**
 * The digest of the chant release `ref` names (a digest or a cut's label),
 * when this checkout is at the commit the release was cut at. Refuses a ref
 * no release on the `chant/lifecycle` branch answers to, and a checkout at
 * another commit, since the apply would then not be made from the release.
 */
export async function releaseToApply(cwd: string, ref: string): Promise<string> {
  const { resolveRelease } = await import("@intentius/chant/lifecycle/release-store");
  const { getHeadCommit } = await import("@intentius/chant/lifecycle/git");
  const found = await resolveRelease(ref, { cwd });
  if (!found) throw new YodelError(`--release ${ref}: no chant release on the chant/lifecycle branch has that digest or label (chant release cut makes one); nothing was applied`);
  let head: string | undefined;
  try {
    head = await getHeadCommit({ cwd });
  } catch {
    head = undefined;
  }
  if (head !== found.release.commit) {
    throw new YodelError(
      `--release ${ref}: release ${found.release.releaseDigest} was cut at ${found.release.commit.slice(0, 12)}, and ${cwd} is at ${head ? head.slice(0, 12) : "no commit"}; check out the release's commit to apply from it. Nothing was applied.`,
    );
  }
  return found.release.releaseDigest;
}

/**
 * Appends a release record of `schema` for `env` to chant's release ledger
 * and pushes it. Writes nothing when the project is not in a git
 * repository, or when the ledger branch could not be fetched or has forked
 * from the remote's (appending there would drop one side's records).
 */
export async function recordRelease(project: Project, env: Environment, schema: BuildOutput, options: ReleaseFacts = {}): Promise<ReleaseOutcome> {
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
      ...(options.admission ? { admission: options.admission } : {}),
      ...(options.releaseDigest ? { releaseDigest: options.releaseDigest } : {}),
    },
    { cwd },
  );
  const push = await pushLifecycleReport({ cwd });
  return { recorded: true, component, env: ledgerEnv, digest, pushed: push.pushed, ...(push.pushWarning ? { warning: push.pushWarning } : {}) };
}

/** {@link recordRelease}, told in one line (two when the push did not land); a failure to record is a line too, never thrown. */
export async function recordReleaseLines(project: Project, env: Environment, schema: BuildOutput | undefined, options: ReleaseFacts = {}): Promise<string[]> {
  if (!schema) return [`release: not recorded; ${env.name}'s schema is none a migration recorded (nothing applied, or an out-of-order gap)`];
  try {
    const r = await recordRelease(project, env, schema, options);
    if (!r.recorded) return [`release: not recorded; ${r.reason}`];
    return [`release: ${r.component} in ${r.env} at ${r.digest}, on chant/lifecycle`, ...(r.warning ? [`release: ${r.warning}`] : [])];
  } catch (e) {
    return [`release: not recorded; ${e instanceof Error ? e.message : String(e)}`];
  }
}
