import { parseArgs } from "node:util";
import type { Command } from "../command.js";
import { guarded } from "../env-args.js";
import { loadProject, resolveEnvironment, YodelError } from "../project.js";
import { readMigrations } from "../migrations/index.js";
import { runChant } from "../chant/process.js";
import { runnable } from "../chant/runnable.js";
import { closeVersioned, findMigrateOp, hasMigrations, migrationsDir, openVersioned, renderStatus, statusReport, ALLOW_OUT_OF_ORDER_ENV } from "../versioned/index.js";

/** Exit code: nothing was approved (no one to ask, a wrong answer, a plan apply would refuse, a plan that moved). */
export const NOT_APPROVED = 4;

const usage = "usage: yodel approve <env> [--dir <project>] [--op <name>] [--allow-out-of-order]";

const help = `${usage}

For a person at a terminal. Approves the plan yodel apply <env> would run,
without the Op and gate names or the digest: shows the pending migrations
and the plan digest, asks you to type the environment's name, then records
the approval with chant approve <op> <gate> --plan <digest>. It is the same
approval chant approve gives, bound to the same digest: if anything the
digest covers changes before the apply, the gate asks again. Then run
yodel apply <env>.

It never approves on its own. With no terminal to ask (a script, CI, an
agent) it approves nothing and exits 4, and no flag skips the question.
Versioned projects only (a migrations/ directory); for a declarative
project, yodel apply prints the chant approve command.

Options:
  --op <name>           the migrations Op, when more than one applies <env>
  --allow-out-of-order  approve the plan yodel apply --allow-out-of-order runs
  -C, --dir <dir>       the project directory (default: the working directory)

Exit codes:
  0  approved, or nothing is pending
  4  nothing approved: no terminal to ask, an answer that was not the
     environment's name, a plan apply would refuse, or a plan that moved
     while you were asked
  2  a pending migration has a step yodel apply does not run
  1  anything else: a bad config, a server that does not answer, chant
     approve failed
`;

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
          options: { dir: { type: "string", short: "C" }, op: { type: "string" }, "allow-out-of-order": { type: "boolean" } },
        });
      } catch (e) {
        throw new YodelError(`${e instanceof Error ? e.message : String(e)}\n${usage}`);
      }
      const { values, positionals } = parsed;
      const [name, ...rest] = positionals;
      if (name === undefined || rest.length > 0) throw new YodelError(usage);
      const allowOutOfOrder = values["allow-out-of-order"] === true || process.env[ALLOW_OUT_OF_ORDER_ENV] === "1";
      const project = await loadProject(typeof values.dir === "string" ? values.dir : process.cwd());
      const env = resolveEnvironment(project, name);
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
        const op = await findMigrateOp(project, env, typeof values.op === "string" ? values.op : undefined);
        io.out(renderStatus(report));
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
        const ran = await runChant(["approve", op.name, op.gate, "--plan", report.digest], { cwd: project.dir, onStdout: io.err, onStderr: io.err });
        if (ran.code !== 0) throw new YodelError(`chant approve ${op.name} ${op.gate} failed (exit ${String(ran.code)}); nothing was approved`);
        io.out(`\nApproved ${report.digest} for ${op.name} / ${op.gate}. Apply it with:\n  ${runnable(`yodel apply ${env.name}`, project.dir)}\n`);
        return 0;
      } finally {
        await closeVersioned(venv);
      }
    }),
};
