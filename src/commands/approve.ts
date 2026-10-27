import { parseArgs } from "node:util";
import type { GateResolutionRecord, PendingGateRecord } from "@intentius/chant/lifecycle/gate-ledger";
import type { Command, Io } from "../command.js";
import { guarded } from "../env-args.js";
import { loadProject, resolveEnvironment, YodelError, type Environment } from "../project.js";
import { buildSchema } from "../chant/build.js";
import { planEnvironment, renderPlan } from "../chant/plan.js";
import { findApplyOp } from "../chant/apply.js";
import { cleanupDigest, cleanupGate, describeRetained, findRetained, retainedServer } from "../cleanup/index.js";
import { gateAtBase } from "../waves/index.js";
import { waveApproval } from "../approval-mode/index.js";
import { baseEnvironment } from "../tenants/target.js";
import type { VersionedEnv } from "../versioned/engine.js";
import type { MigrateOpRef } from "../versioned/op.js";
import { readMigrations } from "../migrations/index.js";
import { runChant } from "../chant/process.js";
import { runnableAsWriter } from "../chant/runnable.js";
import { describeWave, WAVES_PIPELINE, waveView } from "../waves/index.js";
import { EXIT_WAITING, EXIT_DECLINED, EXIT_FAILED, EXIT_MOVED } from "../exit.js";
import { gitLedger } from "../versioned/approval.js";
import { migrationsApprovalAtBase } from "../approval-mode/index.js";
import { closeVersioned, findMigrateOp, hasMigrations, migrationsDir, openVersioned, renderStatus, statusReport, ALLOW_OUT_OF_ORDER_ENV } from "../versioned/index.js";
import { tenantSetOf } from "../tenants/index.js";
import { describeTenantSetWave, groupTenants, someNames, viewTenantSetWave, viewTenants } from "../tenants/wave.js";
import type { Migration } from "../migrations/index.js";
import type { Project } from "../project.js";

const usage = "usage: yodel approve <env> [--plan <digest>] [--sign [--key <file>]] [--actor <name>] [--no-resume] [--dir <project>] [--op <name>] [--allow-out-of-order]";

const help = `${usage}

For a person at a terminal. Approves the plan yodel apply <env> would run,
without the Op and gate names or the digest: shows the pending migrations
and the plan digest, asks you to type the environment's name, then records
the approval with chant approve <op> <gate> --plan <digest> --resume. It is
the same approval chant approve gives, bound to the same digest: if
anything the digest covers changes before the apply, the gate asks again.

chant pushes the approval to chant/lifecycle and starts the CI job that
waits at the gate again through the forge's API (GitHub re-runs the failed
jobs, GitLab retries the job, Forgejo dispatches the workflow), so the
apply goes on without a new push. The token comes from CHANT_FORGE_TOKEN,
else GITHUB_TOKEN or GH_TOKEN (GitHub, Forgejo) or GITLAB_TOKEN (GitLab):
GitHub needs actions: write, GitLab the api scope with the Developer role,
Forgejo write:repository. --no-resume records the approval and starts
nothing; so does a repository with no remote. When no CI job waits (the
gate was reached on a machine, not in CI), there is nothing to resume: run
yodel apply <env>.

It never approves on its own. With no terminal to ask (a script, CI, an
agent) it approves nothing and exits 1, and no flag skips the question.

A declarative project (no migrations/ directory) approves the plan its
ApplyOp's gate waits on: yodel apply <env> stops at the gate and records
that plan's digest on chant/lifecycle; yodel approve <env> shows the plan as
it is now, and approves that digest.

--plan also approves the other plans that wait at a gate of <env>: a revert
(yodel revert) or a baseline record (yodel init --baseline) the migrations
Op stopped for, a wave held by a failed before step, and the drop yodel
cleanup <env> asks for. yodel prints each with the command that approves it.

When yodel.config.ts waves names <env>, the apply pipeline's wave waits on
its own gate, so that is what is approved: chant approve ${WAVES_PIPELINE}
${WAVES_PIPELINE}-wave-<k> --plan <digest>, bound to the wave's set digest
(the plan, the gate policy at the base commit, and what the environments
before it applied), and the wave's job is the one resumed. A wave whose
policy needs no approval for this plan has nothing to approve.

A gate whose approval mode is sealed (yodel.config.ts waves[].approval, or
environments.<env>.approval for the migrations Op, read at the base commit)
counts only an approval sealed with an ssh key that the signers file,
.chant/allowed_signers at the repository's root, lists at the base commit
for the approver: --sign seals it (chant approve --sign), with git's
user.signingkey or --key <file>, and is added on its own under sealed. The
approver is --actor, else the user chant names (GITHUB_ACTOR,
GITLAB_USER_LOGIN or USER); it must be the principal the signers file gives
the key. A key the change being applied adds to that file does not count
for it.

An environment with a tenant set (yodel.config.ts environments.<env>.tenants)
is approved once for every tenant: yodel approve <env> plans each tenant as
the wave's deciding job does, shows what is pending on each, and approves
the wave's set digest over all of them. <env>/<tenant> approves one tenant
for yodel apply <env>/<tenant>, outside the pipeline.

Options:
  --plan <digest>       the digest you mean to approve (from the pull request
                        comment or the waiting job); refused, naming the one
                        that waits, when it is not the plan's
  --sign                seal the approval with an ssh key (on its own when the
                        gate's approval mode is sealed)
  --key <file>          the private key --sign seals with (default: git's
                        user.signingkey, with gpg.format ssh)
  --actor <name>        the approver chant records, the principal the signers
                        file names for the key
  --no-resume           record the approval only; start no job
  --op <name>           the migrations Op, when more than one applies <env>
  --allow-out-of-order  approve the plan yodel apply --allow-out-of-order runs
  -C, --dir <dir>       the project directory (default: the working directory)

Exit codes:
  0  approved (and the waiting job resumed, or none waits), or nothing is
     pending
  3  approved, but the waiting job was not resumed (no token, a token the
     forge refused, a push that did not land): chant says why; once that is
     fixed, push chant/lifecycle and run the job again (or let ci.resume's
     scheduled job start it). Also 3, nothing approved: a pending migration
     the environment it must run on first has not applied, or a step yodel
     apply does not run
  4  nothing approved: the plan moved while you were asked, or --plan is not
     the plan waiting
  8  nothing approved: the answer was not the environment's name
  1  nothing approved: no terminal to ask, nothing waits for --plan, a plan
     apply would refuse; or anything else: a bad config, a server that does
     not answer, chant approve failed
`;

/**
 * The chant command that records an approval of `gate` on `op` for `digest`
 * and, with `resume`, pushes it and starts the job waiting at the gate
 * again. Which forge API that calls, and with which token, chant reads from
 * the job's pending fact on chant/lifecycle (#47).
 */
export function chantApproveArgs(op: string, gate: string, digest: string, resume: boolean, signing: Signing = {}): string[] {
  return [
    "approve", op, gate, "--plan", digest,
    ...(signing.actor !== undefined ? ["--actor", signing.actor] : []),
    ...(signing.sign === true ? ["--sign", ...(signing.key !== undefined ? [signing.key] : [])] : []),
    ...(resume ? ["--resume"] : []),
  ];
}

/** How the approval is sealed (#48): `--sign` with git's signing key or `key`, as `actor`. */
export interface Signing {
  sign?: boolean;
  key?: string;
  actor?: string;
}

/** Whether the project's git repository has a remote: without one there is nothing to push to and no CI job to resume. */
async function hasRemote(dir: string): Promise<boolean> {
  const { execFile } = await import("node:child_process");
  return new Promise((done) => {
    execFile("git", ["remote"], { cwd: dir }, (err, stdout) => {
      done(!err && stdout.trim() !== "");
    });
  });
}

/** Whether chant's gate ledger now holds an approval of `gate` on `op` for `digest`, recorded at or after `since`. */
async function approvalRecorded(dir: string, op: string, gate: string, digest: string, since: string): Promise<boolean> {
  const { latestResolutionForPlan } = await import("@intentius/chant/lifecycle/gate-ledger");
  const ledger = await (await gitLedger(dir)).read(op);
  const found = latestResolutionForPlan(ledger.resolutions, gate, new Date(0).toISOString(), digest).resolution;
  return found !== undefined && found.timestamp >= since;
}

/**
 * Runs chant approve for the gate, resuming its waiting job unless told not
 * to; the exit code is `help`'s. `next` is what to do when nothing was
 * resumed, `afterResume` what to add when it was.
 */
async function record(
  io: Parameters<Command["run"]>[1],
  dir: string,
  op: string,
  gate: string,
  digest: string,
  resume: boolean,
  next: string,
  afterResume = "",
  signing: Signing = {},
  run: typeof runChant = runChant,
): Promise<number> {
  const since = new Date(Date.now() - 1000).toISOString();
  const ran = await run(chantApproveArgs(op, gate, digest, resume, signing), { cwd: dir, onStdout: io.err, onStderr: io.err });
  if (ran.code !== 0) {
    if (resume && (await approvalRecorded(dir, op, gate, digest, since).catch(() => false))) {
      io.err(
        `\nApproved ${digest} for ${op} / ${gate}, but the waiting job was not resumed (chant says why above). ` +
          `Once that is fixed, push chant/lifecycle and run the job again, or let the scheduled resume job (yodel.config.ts ci.resume) start it.\n`,
      );
      return EXIT_WAITING;
    }
    throw new YodelError(`chant approve ${op} ${gate} failed (exit ${String(ran.code)}); nothing was approved`);
  }
  io.out(`\nApproved ${digest} for ${op} / ${gate}. ${resume ? `chant pushed it, and started again the CI job waiting at the gate if one waits (above).${afterResume}` : `Nothing was resumed. ${next}`}\n`);
  return 0;
}

/** `yodel approve <env>`; the exit codes are in `help`. */
export const approve: Command = {
  name: "approve",
  summary: "approve the plan yodel apply would run (a person at a terminal)",
  implemented: true,
  run: (args, io) =>
    guarded("approve", io, args, help, async () => {
      let parsed: ReturnType<typeof parseArgs>;
      try {
        parsed = parseArgs({
          args,
          allowPositionals: true,
          strict: true,
          options: {
            dir: { type: "string", short: "C" },
            op: { type: "string" },
            plan: { type: "string" },
            "no-resume": { type: "boolean" },
            sign: { type: "boolean" },
            key: { type: "string" },
            actor: { type: "string" },
            "allow-out-of-order": { type: "boolean" },
          },
        });
      } catch (e) {
        throw new YodelError(`${e instanceof Error ? e.message : String(e)}\n${usage}`);
      }
      const { values, positionals } = parsed;
      const [name, ...rest] = positionals;
      if (name === undefined || rest.length > 0) throw new YodelError(usage);
      const allowOutOfOrder = values["allow-out-of-order"] === true || process.env[ALLOW_OUT_OF_ORDER_ENV] === "1";
      const expected = typeof values.plan === "string" ? values.plan : undefined;
      if (values.key !== undefined && values.sign !== true) throw new YodelError(`--key is the key --sign seals with; add --sign\n${usage}`);
      /** --sign, or a sealed gate (#48), seals the approval. */
      const signing = (mode: string | undefined): Signing => {
        const sign = values.sign === true || mode === "sealed";
        if (sign && values.sign !== true) io.err(`The gate's approval mode is sealed: the approval is sealed (--sign)${typeof values.key === "string" ? "" : " with git's user.signingkey"}.\n`);
        return { ...(sign ? { sign } : {}), ...(typeof values.key === "string" ? { key: values.key } : {}), ...(typeof values.actor === "string" ? { actor: values.actor } : {}) };
      };
      /** --no-resume, or a repository with no remote, records the approval only. */
      const resuming = async (dir: string): Promise<boolean> => {
        if (values["no-resume"] === true) return false;
        if (await hasRemote(dir)) return true;
        io.err("This repository has no remote, so no CI job can be waiting: the approval is recorded here and nothing is resumed.\n");
        return false;
      };
      const project = await loadProject(typeof values.dir === "string" ? values.dir : process.cwd());
      const env = resolveEnvironment(project, name);
      // A tenant set (#56): its wave, once for every tenant. One tenant is approved as an environment of its own.
      const set = !env.tenant && tenantSetOf(project, env.name) ? env.name : undefined;
      // Asked before anything is read: no terminal is no one to ask, whatever the plan.
      const ask = io.ask;
      if (!ask) {
        io.err(
          `yodel approve: there is no terminal to ask, so nothing was approved. An approval is a person's decision: ` +
            `run yodel approve ${env.name} yourself at a terminal.\n`,
        );
        return EXIT_FAILED;
      }
      const opName = typeof values.op === "string" ? values.op : undefined;
      const ctx: OtherContext = { project, env, expected, ask, io, resuming, signing };
      if (!hasMigrations(project)) return await approveDeclarative(ctx, opName);
      const ordered = readMigrations(migrationsDir(project));
      if (set !== undefined) return await approveTenantSet(project, set, ordered, { allowOutOfOrder, expected, ask, io, resuming, signing, other: () => approveOther(ctx, opName) });
      const venv = await openVersioned(project, env);
      /** With --plan, another plan waiting at one of env's gates (#202), when the apply's is not the one meant. */
      const other = async (): Promise<number | undefined> => (expected === undefined ? undefined : approveOther(ctx, opName, venv));
      try {
        const report = await statusReport(venv, ordered, { allowOutOfOrder });
        if (expected !== undefined && expected !== report.digest && !(project.yodel?.config.waves ?? []).some((w) => w.env === env.name)) {
          const done = await other();
          if (done !== undefined) return done;
        }
        if (report.refusal) {
          io.err(`yodel approve: ${report.refusal.message}\nNothing was approved.\n`);
          return report.refusal.exitCode;
        }
        if (report.status.pending.length === 0 || !report.digest) {
          io.out(`${env.name} is up to date: there is nothing to approve.\n`);
          return 0;
        }
        // A waves project (#87): the apply pipeline's wave waits on its own gate, bound to the wave's set digest.
        if ((project.yodel?.config.waves ?? []).some((w) => w.env === env.name)) {
          const view = await waveView(project, env.name, ordered, report.status.pending, report.digest);
          if (view) {
            if (view.blocked) {
              io.err(`yodel approve: ${describeWave(view)}\nNothing was approved.\n`);
              return EXIT_WAITING;
            }
            if (expected !== undefined && expected !== view.digest) {
              const done = await other();
              if (done !== undefined) return done;
            }
            io.out(renderStatus(report));
            io.out(`${describeWave(view)}\n`);
            if (!view.waits) return 0;
            if (expected !== undefined && expected !== view.digest) {
              io.err(`yodel approve: --plan ${expected} is not the plan waiting for ${env.name}, which is ${view.digest}. Nothing was approved.\n`);
              return EXIT_MOVED;
            }
            const answer = (await ask(`\nApprove wave ${String(view.wave)} for ${env.name}, ${view.digest}? Type ${env.name} to approve: `)).trim();
            if (answer !== env.name) {
              io.err(`Not approved: the answer was not ${env.name}.\n`);
              return EXIT_DECLINED;
            }
            const again = await statusReport(venv, ordered, { allowOutOfOrder });
            const now = again.digest ? await waveView(project, env.name, ordered, again.status.pending, again.digest) : undefined;
            if (now?.digest !== view.digest) {
              io.err(`Not approved: the plan moved while you were asked (now ${now?.digest ?? "nothing to apply"}); run yodel approve ${env.name} again.\n`);
              return EXIT_MOVED;
            }
            const { waveGateName } = await import("@intentius/chant/gated-waves");
            const gate = waveGateName(WAVES_PIPELINE, view.wave);
            const resume = await resuming(project.dir);
            return await record(io, project.dir, WAVES_PIPELINE, gate, view.digest, resume, `Run wave ${String(view.wave)}'s job again (push chant/lifecycle first if chant did not).`, "", signing(view.approval));
          }
        }
        const op = await findMigrateOp(project, env, opName);
        io.out(renderStatus(report));
        if (expected !== undefined && expected !== report.digest) {
          io.err(`yodel approve: --plan ${expected} is not the plan waiting for ${env.name}, which is ${report.digest}. Nothing was approved.\n`);
          return EXIT_MOVED;
        }
        const answer = (await ask(`\nApprove this plan for ${env.name}, ${report.digest}? Type ${env.name} to approve: `)).trim();
        if (answer !== env.name) {
          io.err(`Not approved: the answer was not ${env.name}.\n`);
          return EXIT_DECLINED;
        }
        // The plan is read again: what is approved is what the person saw.
        const again = await statusReport(venv, ordered, { allowOutOfOrder });
        if (again.digest !== report.digest) {
          io.err(`Not approved: the plan moved while you were asked (now ${again.digest ?? "nothing to apply"}); run yodel approve ${env.name} again.\n`);
          return EXIT_MOVED;
        }
        const mode = await migrationsApprovalAtBase(project, env.name);
        if (mode.note) io.err(`${mode.note}\n`);
        return await record(io, project.dir, op.name, op.gate, report.digest, await resuming(project.dir), `Apply it with:\n  ${runnableAsWriter(`yodel apply ${env.name}`, project.dir, env.profile)}`, ` Where none waits, apply it with:\n  ${runnableAsWriter(`yodel apply ${env.name}`, project.dir, env.profile)}`, signing(mode.mode));
      } finally {
        await closeVersioned(venv);
      }
    }),
};

/** `yodel approve <set>` (#56): the tenant set's wave, one approval of its set digest over every tenant's plan. */
async function approveTenantSet(
  project: Project,
  set: string,
  ordered: readonly Migration[],
  o: { allowOutOfOrder: boolean; expected: string | undefined; ask: (q: string) => Promise<string>; io: Parameters<Command["run"]>[1]; resuming: (dir: string) => Promise<boolean>; signing: (mode: string | undefined) => Signing; other: () => Promise<number | undefined> },
): Promise<number> {
  const { io } = o;
  const read = async () => {
    const tenants = await viewTenants(project, set, ordered, { allowOutOfOrder: o.allowOutOfOrder });
    return { tenants, view: await viewTenantSetWave(project, set, tenants) };
  };
  const { tenants, view } = await read();
  if (o.expected !== undefined && o.expected !== view?.digest) {
    const done = await o.other();
    if (done !== undefined) return done;
  }
  if (!view) {
    throw new YodelError(`${set} is a tenant set, and yodel.config.ts waves does not name it, so no wave applies it: approve a tenant with yodel approve ${set}/<tenant>, for yodel apply ${set}/<tenant>; nothing was approved`);
  }
  for (const t of tenants.filter((x) => x.report.refusal)) io.err(`yodel approve: ${t.target}: ${t.report.refusal?.message ?? ""}\n`);
  if (view.refused.length > 0) {
    io.err(`${describeTenantSetWave(view, tenants.length)}\nNothing was approved.\n`);
    return EXIT_FAILED;
  }
  if (tenants.every((t) => t.plan?.empty)) {
    io.out(`Every tenant of ${set} (${String(tenants.length)}) is up to date: there is nothing to approve.\n`);
    return 0;
  }
  io.out(`Tenant set ${set}, ${String(tenants.length)} tenant${tenants.length === 1 ? "" : "s"}:\n`);
  for (const g of groupTenants(tenants, (t) => (t.plan?.pending ?? []).join(" "))) {
    const pending = g.members[0]?.plan?.pending ?? [];
    io.out(`  ${pending.length === 0 ? "up to date" : `${String(pending.length)} pending (${pending.join(", ")})`}: ${someNames(g.members.map((m) => m.target))}\n`);
    const destructive = g.members[0]?.plan?.destructiveSteps ?? [];
    if (destructive.length > 0) io.out(`    destructive: ${destructive.map((d) => `${d.migration} step ${String(d.step)} (${d.why})`).join(", ")}\n`);
  }
  io.out(`${describeTenantSetWave(view, tenants.length)}\n`);
  if (view.blocked.length > 0) {
    io.err("Nothing was approved.\n");
    return EXIT_WAITING;
  }
  if (!view.waits || !view.digest) return 0;
  if (o.expected !== undefined && o.expected !== view.digest) {
    io.err(`yodel approve: --plan ${o.expected} is not the plan waiting for ${set}, which is ${view.digest}. Nothing was approved.\n`);
    return EXIT_MOVED;
  }
  const answer = (await o.ask(`\nApprove wave ${String(view.wave)} for every tenant of ${set}, ${view.digest}? Type ${set} to approve: `)).trim();
  if (answer !== set) {
    io.err(`Not approved: the answer was not ${set}.\n`);
    return EXIT_DECLINED;
  }
  // Every tenant is read again: what is approved is what the person saw.
  const again = await read();
  if (again.view?.digest !== view.digest) {
    io.err(`Not approved: the plan moved while you were asked (now ${again.view?.digest ?? "nothing to approve"}); run yodel approve ${set} again.\n`);
    return EXIT_MOVED;
  }
  const { waveGateName } = await import("@intentius/chant/gated-waves");
  const gate = waveGateName(WAVES_PIPELINE, view.wave);
  return record(io, project.dir, WAVES_PIPELINE, gate, view.digest, await o.resuming(project.dir), `Run wave ${String(view.wave)}'s deciding job again (push chant/lifecycle first if chant did not).`, "", o.signing(view.approval));
}

// ── Plans that wait at a gate yodel approve does not compute (#202) ─────────

/** What approving a plan other than the apply's needs: the person to ask, and how to record. */
export interface OtherContext {
  project: Project;
  env: Environment;
  /** `--plan`: the digest the person means to approve. */
  expected: string | undefined;
  ask: (question: string) => Promise<string>;
  io: Io;
  resuming: (dir: string) => Promise<boolean>;
  signing: (mode: string | undefined) => Signing;
  /** Runs chant (tests pass their own). */
  run?: typeof runChant;
}

/** A gate a run stopped at and recorded on chant/lifecycle, waiting for a person. */
export interface StandingGate {
  op: string;
  gate: string;
  digest: string;
  /** When the run reached the gate. */
  at: string;
  description?: string;
}

/** A gate yodel looks for a waiting plan at, with the approval mode that counts there. */
interface GateRef {
  op: string;
  gate: string;
  mode?: string | undefined;
}

/**
 * The plan `gate` on `op` waits on: the newest pending fact of the gate,
 * while it has not expired, when it binds a plan and no approval of that
 * plan was recorded after it. Pure: takes the ledger as read.
 */
export function standingGate(
  ledger: { pending: readonly PendingGateRecord[]; resolutions: readonly GateResolutionRecord[] },
  op: string,
  gate: string,
  now: string = new Date().toISOString(),
): StandingGate | undefined {
  const facts = ledger.pending.filter((p) => p.gate === gate).sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  const p = facts.at(-1);
  if (!p?.planDigest || p.expiresAt <= now) return undefined;
  const answered = ledger.resolutions.some((r) => r.gate === gate && r.planDigest === p.planDigest && r.timestamp >= p.timestamp);
  if (answered) return undefined;
  return { op, gate, digest: p.planDigest, at: p.timestamp, ...(p.description ? { description: p.description } : {}) };
}

/** The plan waiting at one of `gates` in the project's ledger: the one for `digest`, else (no digest) the only one. */
async function findStanding(dir: string, gates: readonly GateRef[], digest: string | undefined): Promise<{ standing: StandingGate; mode?: string | undefined } | undefined> {
  const ledger = await gitLedger(dir);
  for (const g of gates) {
    const standing = standingGate(await ledger.read(g.op), g.op, g.gate);
    if (standing && (digest === undefined || standing.digest === digest)) return { standing, mode: g.mode };
  }
  return undefined;
}

/** Shows the waiting plan, asks, reads the ledger again and records the approval. */
async function approveStanding(c: OtherContext, found: { standing: StandingGate; mode?: string | undefined }, gates: readonly GateRef[], next: string): Promise<number> {
  const { io, env } = c;
  const s = found.standing;
  io.out(`${s.op} is waiting at gate "${s.gate}" for approval of ${s.digest}, since ${s.at}${s.description ? ` (${s.description})` : ""}.\n`);
  const answer = (await c.ask(`\nApprove ${s.digest} for ${env.name}? Type ${env.name} to approve: `)).trim();
  if (answer !== env.name) {
    io.err(`Not approved: the answer was not ${env.name}.\n`);
    return EXIT_DECLINED;
  }
  // What waits is read again: what is approved is what the person saw.
  const again = await findStanding(c.project.dir, gates.filter((g) => g.op === s.op && g.gate === s.gate), undefined);
  if (again?.standing.digest !== s.digest) {
    io.err(`Not approved: the plan waiting at ${s.gate} moved while you were asked (now ${again?.standing.digest ?? "nothing waits"}); run yodel approve ${env.name} again.\n`);
    return EXIT_MOVED;
  }
  return record(io, c.project.dir, s.op, s.gate, s.digest, await c.resuming(c.project.dir), next, "", c.signing(found.mode), c.run);
}

/**
 * `yodel approve <env> --plan <digest>` for a plan other than the apply's:
 * one a run of the migrations Op or of a wave stopped for (a revert, a
 * baseline record, a wave held by a before step), or the drop yodel
 * cleanup asks for. Undefined when nothing of `env` waits on that digest.
 */
export async function approveOther(c: OtherContext, opName?: string, venv?: VersionedEnv): Promise<number | undefined> {
  const { project, env, expected } = c;
  if (expected === undefined) return undefined;
  const gates: GateRef[] = [];
  let migrate: MigrateOpRef | undefined;
  try {
    migrate = await findMigrateOp(project, env, opName);
  } catch {
    // No migrations Op (a waves project may have none): nothing waits at its gate.
  }
  const mode = migrate ? (await migrationsApprovalAtBase(project, env.name)).mode : undefined;
  if (migrate) gates.push({ op: migrate.name, gate: migrate.gate, mode });
  const base = baseEnvironment(env.name);
  const k = (project.yodel?.config.waves ?? []).findIndex((w) => w.env === base) + 1;
  if (k > 0) {
    const { waveGateName } = await import("@intentius/chant/gated-waves");
    const { at } = await gateAtBase(project, base);
    gates.push({ op: WAVES_PIPELINE, gate: waveGateName(WAVES_PIPELINE, k), mode: waveApproval(at.config, base) });
  }
  const found = await findStanding(project.dir, gates, expected);
  if (found) return approveStanding(c, found, gates, `Run the yodel command that stopped at ${found.standing.gate} again (push chant/lifecycle first if chant did not).`);
  // The drop yodel cleanup asks for: nothing records it waiting, so its digest is worked out again here.
  if (migrate && venv && !env.tenant) {
    const server = retainedServer(venv);
    const { retained } = await findRetained(server);
    if (retained.some((r) => r.due) && (await cleanupDigest(env.name, retained)) === expected) {
      c.io.out(`yodel cleanup ${env.name} drops, once approved:\n${retained.filter((r) => r.due).map((r) => `  ${describeRetained(r)}\n`).join("")}Plan digest: ${expected}\n`);
      const answer = (await c.ask(`\nApprove dropping these in ${env.name}, ${expected}? Type ${env.name} to approve: `)).trim();
      if (answer !== env.name) {
        c.io.err(`Not approved: the answer was not ${env.name}.\n`);
        return EXIT_DECLINED;
      }
      const now = await cleanupDigest(env.name, (await findRetained(server)).retained);
      if (now !== expected) {
        c.io.err(`Not approved: what is due moved while you were asked (now ${now}); run yodel cleanup ${env.name} again.\n`);
        return EXIT_MOVED;
      }
      return record(c.io, project.dir, migrate.name, cleanupGate(migrate.gate), expected, false, `Drop them with:\n  ${runnableAsWriter(`yodel cleanup ${env.name}`, project.dir, env.profile)}`, "", c.signing(mode), c.run);
    }
  }
  return undefined;
}

/** Shows the declarative plan `env` would apply now; tests pass their own. */
export type ShowPlan = (project: Project, env: Environment, io: Io) => Promise<void>;

const showDeclarativePlan: ShowPlan = async (project, env, io) => {
  const build = await buildSchema(project);
  try {
    const plan = await planEnvironment(project, env, build);
    io.out(`${await renderPlan(plan, `Plan for ${env.name} (${project.dialect}, sql.profiles.${env.name})`)}\n`);
  } finally {
    build.dispose();
  }
};

/**
 * `yodel approve <env>` in a declarative project (#202): the plan the
 * ApplyOp's gate waits on, which yodel apply recorded when it stopped there.
 */
export async function approveDeclarative(c: OtherContext, opName?: string, show: ShowPlan = showDeclarativePlan): Promise<number> {
  const { project, env, io, expected } = c;
  const op = await findApplyOp(project, env, opName);
  const gates: GateRef[] = [{ op: op.name, gate: op.gate }];
  const waiting = await findStanding(project.dir, gates, undefined);
  if (!waiting) {
    if (expected !== undefined) {
      io.err(`yodel approve: nothing waits at ${op.name} / ${op.gate} for --plan ${expected}. Nothing was approved; run ${runnableAsWriter(`yodel apply ${env.name}`, project.dir, env.profile)}, which stops at the gate and prints the command that approves its plan.\n`);
      return EXIT_FAILED;
    }
    io.out(`Nothing waits at ${op.name} / ${op.gate}: there is nothing to approve. ${runnableAsWriter(`yodel apply ${env.name}`, project.dir, env.profile)} stops at the gate with a plan to approve.\n`);
    return 0;
  }
  if (expected !== undefined && expected !== waiting.standing.digest) {
    io.err(`yodel approve: --plan ${expected} is not the plan waiting for ${env.name}, which is ${waiting.standing.digest}. Nothing was approved.\n`);
    return EXIT_MOVED;
  }
  await show(project, env, io);
  return approveStanding(c, waiting, gates, `Apply it with:\n  ${runnableAsWriter(`yodel apply ${env.name}`, project.dir, env.profile)}`);
}
