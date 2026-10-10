import { parseArgs } from "node:util";
import type { Command } from "../command.js";
import { guarded } from "../env-args.js";
import { loadProject, resolveEnvironment, YodelError } from "../project.js";
import { EXIT_REFUSED } from "../exit.js";
import { runChant } from "../chant/process.js";
import { runnable } from "../chant/runnable.js";
import { closeVersioned, findMigrateOp, hasMigrations, judgePlan, openVersioned, overrideGate, readChain, statusReport, ALLOW_OUT_OF_ORDER_ENV } from "../versioned/index.js";

const usage = "usage: yodel override <env> --rule <id> --reason <text> [--by <name>] [--dir <project>] [--op <name>] [--allow-out-of-order]";

const help = `${usage}

Records an override of a policy rule (yodel.config.ts policy.rules) for the
plan yodel apply <env> would run now: a person's decision, with a reason, to
apply a plan the rule denies. It is written to chant's gate ledger (the
chant/lifecycle branch) with chant approve <op> override-<rule> --plan
<digest> --note <reason>, bound to the environment's migrations Op and the
plan digest. It counts only for exactly that digest: once the plan moves
(a migration added or edited, the live schema changed), the rule denies
again and needs a new override. It counts only when policy.overriders
lists the name it is recorded under (--by, else chant's: the CI actor or
your user). yodel apply records the overrides it relied on in the history.

Refused when the rule does not deny the current plan: an override answers
one denial, it is not a standing exception.

Options:
  --rule <id>           the rule to override (repeatable)
  --reason <text>       why; required
  --by <name>           who is overriding (chant approve --approver)
  --op <name>           the migrations Op, when more than one applies <env>
  --allow-out-of-order  the plan yodel apply --allow-out-of-order runs
  -C, --dir <dir>       the project directory (default: the working directory)

Exit codes:
  0  recorded
  4  nothing recorded: the plan has nothing to apply or apply would refuse
     it, a rule that does not deny it, a name policy.overriders does not list
  1  anything else: a bad config, a server that does not answer, chant
     approve failed
`;

/** `yodel override <env> --rule <id> --reason <text>`; the exit codes are in `help`. */
export const override: Command = {
  name: "override",
  summary: "override a policy rule for the current plan, with a reason",
  implemented: true,
  run: (args, io) =>
    guarded("override", io, args, help, async () => {
      let parsed: ReturnType<typeof parseArgs>;
      try {
        parsed = parseArgs({
          args,
          allowPositionals: true,
          strict: true,
          options: {
            rule: { type: "string", multiple: true },
            reason: { type: "string" },
            by: { type: "string" },
            dir: { type: "string", short: "C" },
            op: { type: "string" },
            "allow-out-of-order": { type: "boolean" },
          },
        });
      } catch (e) {
        throw new YodelError(`${e instanceof Error ? e.message : String(e)}\n${usage}`);
      }
      const { values, positionals } = parsed;
      const [name, ...rest] = positionals;
      if (name === undefined || rest.length > 0) throw new YodelError(usage);
      const rules = Array.isArray(values.rule) ? values.rule.filter((r): r is string => typeof r === "string") : [];
      const reason = typeof values.reason === "string" ? values.reason.trim() : "";
      const by = typeof values.by === "string" ? values.by : undefined;
      const allowOutOfOrder = values["allow-out-of-order"] === true || process.env[ALLOW_OUT_OF_ORDER_ENV] === "1";

      const project = await loadProject(typeof values.dir === "string" ? values.dir : process.cwd());
      const env = resolveEnvironment(project, name);
      if (rules.length === 0 || reason === "") throw new YodelError(`--rule and --reason are required: an override names the rule and says why\n${usage}`);
      if (!hasMigrations(project)) throw new YodelError(`${project.dir} has no migrations/ directory with a migration; policy is for versioned migrations`);
      const policy = project.yodel?.config.policy;
      if (!policy) throw new YodelError(`yodel.config.ts declares no policy, so there is nothing to override`, EXIT_REFUSED);
      const unknown = rules.filter((r) => !policy.rules.some((x) => x.id === r));
      if (unknown.length > 0) throw new YodelError(`no policy rule ${unknown.join(", ")} (policy.rules: ${policy.rules.map((r) => r.id).join(", ")}); nothing recorded`, EXIT_REFUSED);
      if (by !== undefined && !(policy.overriders ?? []).includes(by)) {
        throw new YodelError(`${by} is not in policy.overriders (${(policy.overriders ?? []).join(", ") || "none"}), so an override by them would not count; nothing recorded`, EXIT_REFUSED);
      }

      const ordered = readChain(project);
      const venv = await openVersioned(project, env);
      try {
        const report = await statusReport(venv, ordered, { allowOutOfOrder });
        if (report.refusal) throw new YodelError(`yodel apply would refuse this plan before any policy: ${report.refusal.message}\nNothing recorded.`, EXIT_REFUSED);
        if (!report.digest) throw new YodelError(`${env.name} has nothing pending: there is no plan to override; nothing recorded`, EXIT_REFUSED);
        const results = await judgePlan({ policy, environment: env.name, dialect: project.dialect, toApply: report.status.pending, digest: undefined, ledger: () => Promise.resolve(undefined) });
        const notDenying = rules.filter((r) => results.find((x) => x.id === r)?.outcome !== "denied");
        if (notDenying.length > 0) {
          throw new YodelError(`${notDenying.join(", ")} ${notDenying.length === 1 ? "does" : "do"} not deny the plan for ${env.name} (${report.digest}); an override answers a denial. Nothing recorded.`, EXIT_REFUSED);
        }
        const op = await findMigrateOp(project, env, typeof values.op === "string" ? values.op : undefined);
        for (const rule of rules) {
          const denial = results.find((x) => x.id === rule);
          io.out(`${rule} denies ${report.digest}:\n${(denial?.reasons ?? []).map((x) => `  ${x}`).join("\n")}\n`);
          const ran = await runChant(["approve", op.name, overrideGate(rule), "--plan", report.digest, "--note", reason, ...(by ? ["--approver", by] : [])], { cwd: project.dir, onStdout: io.err, onStderr: io.err });
          if (ran.code !== 0) throw new YodelError(`chant approve ${op.name} ${overrideGate(rule)} failed (exit ${String(ran.code)}); the override of ${rule} was not recorded`);
          io.out(`Recorded an override of ${rule} for ${report.digest}${by ? ` by ${by}` : ""}: ${reason}\n`);
        }
        io.out(`It counts for this plan only. Apply it with:\n  ${runnable(`yodel apply ${env.name}`, project.dir)}\n`);
        return 0;
      } finally {
        await closeVersioned(venv);
      }
    }),
};
