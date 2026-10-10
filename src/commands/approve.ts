import { parseArgs } from "node:util";
import type { Command } from "../command.js";
import { guarded } from "../env-args.js";
import { loadProject, resolveEnvironment, YodelError } from "../project.js";
import { readMigrations } from "../migrations/index.js";
import { runChant } from "../chant/process.js";
import { runnable } from "../chant/runnable.js";
import { describeWave, WAVES_PIPELINE, waveView } from "../waves/index.js";
import { EXIT_OUTSTANDING } from "../exit.js";
import { gitLedger } from "../versioned/approval.js";
import { closeVersioned, findMigrateOp, hasMigrations, migrationsDir, openVersioned, renderStatus, statusReport, ALLOW_OUT_OF_ORDER_ENV } from "../versioned/index.js";

/** Exit code: nothing was approved (no one to ask, a wrong answer, a plan apply would refuse, a plan that moved). */
export const NOT_APPROVED = 4;

const usage = "usage: yodel approve <env> [--plan <digest>] [--no-resume] [--dir <project>] [--op <name>] [--allow-out-of-order]";

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
agent) it approves nothing and exits 4, and no flag skips the question.
Versioned projects only (a migrations/ directory); for a declarative
project, yodel apply prints the chant approve command.

When yodel.config.ts waves names <env>, the apply pipeline's wave waits on
its own gate, so that is what is approved: chant approve ${WAVES_PIPELINE}
${WAVES_PIPELINE}-wave-<k> --plan <digest>, bound to the wave's set digest
(the plan, the gate policy at the base commit, and what the environments
before it applied), and the wave's job is the one resumed. A wave whose
policy needs no approval for this plan has nothing to approve.

Options:
  --plan <digest>       the digest you mean to approve (from the pull request
                        comment or the waiting job); refused, naming the one
                        that waits, when it is not the plan's
  --no-resume           record the approval only; start no job
  --op <name>           the migrations Op, when more than one applies <env>
  --allow-out-of-order  approve the plan yodel apply --allow-out-of-order runs
  -C, --dir <dir>       the project directory (default: the working directory)

Exit codes:
  0  approved (and the waiting job resumed, or none waits), or nothing is
     pending
  3  approved, but the waiting job was not resumed (no token, a token the
     forge refused, a push that did not land): chant says why; push
     chant/lifecycle and run chant run resume --op <op>, or run the job again
  4  nothing approved: no terminal to ask, an answer that was not the
     environment's name, a --plan that is not the plan's, a plan apply would
     refuse, or a plan that moved while you were asked
  2  a pending migration has a step yodel apply does not run
  1  anything else: a bad config, a server that does not answer, chant
     approve failed
`;

/**
 * The chant command that records an approval of `gate` on `op` for `digest`
 * and, with `resume`, pushes it and starts the job waiting at the gate
 * again. Which forge API that calls, and with which token, chant reads from
 * the job's pending fact on chant/lifecycle (#47).
 */
export function chantApproveArgs(op: string, gate: string, digest: string, resume: boolean): string[] {
  return ["approve", op, gate, "--plan", digest, ...(resume ? ["--resume"] : [])];
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
): Promise<number> {
  const since = new Date(Date.now() - 1000).toISOString();
  const ran = await runChant(chantApproveArgs(op, gate, digest, resume), { cwd: dir, onStdout: io.err, onStderr: io.err });
  if (ran.code !== 0) {
    if (resume && (await approvalRecorded(dir, op, gate, digest, since).catch(() => false))) {
      io.err(
        `\nApproved ${digest} for ${op} / ${gate}, but the waiting job was not resumed (chant says why above). ` +
          `Push chant/lifecycle and run ${runnable(`chant run resume --op ${op}`, dir)}, or run the job again.\n`,
      );
      return EXIT_OUTSTANDING;
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
      /** --no-resume, or a repository with no remote, records the approval only. */
      const resuming = async (dir: string): Promise<boolean> => {
        if (values["no-resume"] === true) return false;
        if (await hasRemote(dir)) return true;
        io.err("This repository has no remote, so no CI job can be waiting: the approval is recorded here and nothing is resumed.\n");
        return false;
      };
      const project = await loadProject(typeof values.dir === "string" ? values.dir : process.cwd());
      const env = resolveEnvironment(project, name);
      const set = env.tenant?.env ?? (project.yodel?.config.environments?.[env.name]?.tenants ? env.name : undefined);
      if (set !== undefined) {
        throw new YodelError(`${set} is a tenant set: its wave is approved once for every tenant, with the chant approve command its deciding job printed (yodel apply <tenant> --wave-plan prints it too); nothing was approved`);
      }
      // Asked before anything is read: no terminal is no one to ask, whatever the plan.
      const ask = io.ask;
      if (!ask) {
        io.err(
          `yodel approve: there is no terminal to ask, so nothing was approved. An approval is a person's decision: ` +
            `run yodel approve ${env.name} yourself at a terminal.\n`,
        );
        return NOT_APPROVED;
      }
      if (!hasMigrations(project)) {
        throw new YodelError(`${project.dir} has no migrations/ directory with a migration; yodel approve is for versioned migrations. For a declarative project, run yodel apply ${env.name}: it prints the chant approve command`);
      }
      const ordered = readMigrations(migrationsDir(project));
      const venv = await openVersioned(project, env);
      try {
        const report = await statusReport(venv, ordered, { allowOutOfOrder });
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
              return NOT_APPROVED;
            }
            io.out(renderStatus(report));
            io.out(`${describeWave(view)}\n`);
            if (!view.waits) return 0;
            if (expected !== undefined && expected !== view.digest) {
              io.err(`yodel approve: --plan ${expected} is not the plan waiting for ${env.name}, which is ${view.digest}. Nothing was approved.\n`);
              return NOT_APPROVED;
            }
            const answer = (await ask(`\nApprove wave ${String(view.wave)} for ${env.name}, ${view.digest}? Type ${env.name} to approve: `)).trim();
            if (answer !== env.name) {
              io.err(`Not approved: the answer was not ${env.name}.\n`);
              return NOT_APPROVED;
            }
            const again = await statusReport(venv, ordered, { allowOutOfOrder });
            const now = again.digest ? await waveView(project, env.name, ordered, again.status.pending, again.digest) : undefined;
            if (now?.digest !== view.digest) {
              io.err(`Not approved: the plan moved while you were asked (now ${now?.digest ?? "nothing to apply"}); run yodel approve ${env.name} again.\n`);
              return NOT_APPROVED;
            }
            const { waveGateName } = await import("@intentius/chant/gated-waves");
            const gate = waveGateName(WAVES_PIPELINE, view.wave);
            const resume = await resuming(project.dir);
            return await record(io, project.dir, WAVES_PIPELINE, gate, view.digest, resume, `Run wave ${String(view.wave)}'s job again (push chant/lifecycle first if chant did not).`);
          }
        }
        const op = await findMigrateOp(project, env, typeof values.op === "string" ? values.op : undefined);
        io.out(renderStatus(report));
        if (expected !== undefined && expected !== report.digest) {
          io.err(`yodel approve: --plan ${expected} is not the plan waiting for ${env.name}, which is ${report.digest}. Nothing was approved.\n`);
          return NOT_APPROVED;
        }
        const answer = (await ask(`\nApprove this plan for ${env.name}, ${report.digest}? Type ${env.name} to approve: `)).trim();
        if (answer !== env.name) {
          io.err(`Not approved: the answer was not ${env.name}.\n`);
          return NOT_APPROVED;
        }
        // The plan is read again: what is approved is what the person saw.
        const again = await statusReport(venv, ordered, { allowOutOfOrder });
        if (again.digest !== report.digest) {
          io.err(`Not approved: the plan moved while you were asked (now ${again.digest ?? "nothing to apply"}); run yodel approve ${env.name} again.\n`);
          return NOT_APPROVED;
        }
        return await record(io, project.dir, op.name, op.gate, report.digest, await resuming(project.dir), `Apply it with:\n  ${runnable(`yodel apply ${env.name}`, project.dir)}`, ` Where none waits, apply it with:\n  ${runnable(`yodel apply ${env.name}`, project.dir)}`);
      } finally {
        await closeVersioned(venv);
      }
    }),
};
