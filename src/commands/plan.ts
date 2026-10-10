import { parseArgs } from "node:util";
import type { Command, Io } from "../command.js";
import { guarded } from "../env-args.js";
import { loadProject, resolveEnvironment, YodelError, type Environment, type Project } from "../project.js";
import { declarativeTopologyRefusal, describeSettingsTopology, environmentSettings } from "../config/settings.js";
import { buildSchema } from "../chant/build.js";
import { planEnvironment, planExitCode, planJson, renderPlan } from "../chant/plan.js";
import { hasMigrations } from "../versioned/index.js";
import { describeServer, probeServer } from "../server.js";
import { decodeSubject } from "../versioned/explain.js";
import { collectVersionedPlan } from "../pr/model.js";
import { commentMarker, planJsonVersioned, renderPlanMarkdown, renderPlanText, subjectIn } from "../pr/render.js";
import { resolveForgeTarget, type ForgeFlags } from "../pr/forge.js";
import { commentClient, findComment, upsertComment } from "../pr/comment.js";

const usage =
  "usage: yodel plan <env> [--json] [--dir <project>] [--format text|markdown|json] [--allow-out-of-order] [--op <name>]\n" +
  "                        [--comment [--forge github|gitlab|forgejo] [--repo <repo>] [--pr <n>] [--api-url <url>] [--token-env <VAR>]]";

const help = `${usage}

Declarative project (no migrations/ directory): shows the classified change
from the environment's live database (sql.profiles.<env>) to the declared
schema, as chant sql plan reports it.

Versioned project (a migrations/ directory): shows the pending migrations,
each step with its rule and class (an Op step with the Op that makes it, a
manual step with what it needs), integrity problems (directory problems,
checksum mismatches, out-of-order migrations), and the plan digest yodel
apply asks approval for, with the chant approve command that approves it.
When chant's gate ledger holds an approval of the migrations Op's gate for
another digest, it says what moved since. Reads only.

Options:
  --json               print the plan as JSON (the same as --format json)
  --format <f>         text (default), markdown (the pull request comment), json
  --allow-out-of-order versioned: the plan yodel apply --allow-out-of-order would run
  --op <name>          versioned: the migrations Op, when more than one applies <env>
  --comment            versioned: post the markdown as one comment on the pull
                       (merge) request, updating the one posted before; prints
                       the text plan. The forge, repository, request and API
                       come from the CI job's environment (GitHub Actions,
                       GitLab CI, Forgejo Actions) unless given:
    --forge <f>        github, gitlab or forgejo
    --repo <repo>      owner/name (GitHub, Forgejo) or the project id (GitLab)
    --pr <n>           the pull request number or merge request iid
    --api-url <url>    the REST API base (https://api.github.com,
                       https://gitlab.example/api/v4, https://forgejo.example/api/v1)
    --token-env <VAR>  the variable holding the token (default GITHUB_TOKEN;
                       GITLAB_TOKEN; FORGEJO_TOKEN, else GITHUB_TOKEN)
  -C, --dir <dir>      the project directory (default: the working directory)

Exit codes:
  0  every change can be made in place, or there is none; versioned: apply
     would run (or has nothing to do)
  2  a change needs its own Op: a ClickHouse rebuild, a Postgres expand and
     contract (declarative); versioned: a pending migration has an Op or
     manual step apply does not run yet
  4  versioned: apply would refuse: a checksum mismatch, an applied migration
     gone from the directory, an out-of-order migration
  1  no plan could be made: a bad config, an unknown environment, a declaration
     chant cannot build, a malformed migrations directory, a server it cannot
     read, a comment the forge refused
`;

interface PlanArgs {
  env: string;
  dir: string;
  format: "text" | "markdown" | "json";
  comment: boolean;
  allowOutOfOrder: boolean;
  op: string | undefined;
  forge: ForgeFlags;
  versionedOnly: string[];
}

function parsePlanArgs(args: string[]): PlanArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: "boolean" },
        dir: { type: "string", short: "C" },
        format: { type: "string" },
        comment: { type: "boolean" },
        "allow-out-of-order": { type: "boolean" },
        op: { type: "string" },
        forge: { type: "string" },
        repo: { type: "string" },
        pr: { type: "string" },
        "api-url": { type: "string" },
        "token-env": { type: "string" },
      },
    });
  } catch (e) {
    throw new YodelError(`${e instanceof Error ? e.message : String(e)}\n${usage}`);
  }
  const { values: v, positionals } = parsed;
  const [env, ...rest] = positionals;
  if (env === undefined || rest.length > 0) throw new YodelError(usage);
  const str = (k: string) => (typeof v[k] === "string" ? v[k] : undefined);
  const format = str("format") ?? (v.json === true ? "json" : "text");
  if (format !== "text" && format !== "markdown" && format !== "json") throw new YodelError(`--format must be text, markdown or json, got ${JSON.stringify(format)}\n${usage}`);
  if (v.json === true && format !== "json") throw new YodelError(`--json and --format ${format} cannot be combined\n${usage}`);
  const forgeFlags = ["forge", "repo", "pr", "api-url", "token-env"].filter((k) => str(k) !== undefined);
  if (forgeFlags.length > 0 && v.comment !== true) throw new YodelError(`--${forgeFlags.join(", --")} ${forgeFlags.length === 1 ? "goes" : "go"} with --comment\n${usage}`);
  const forge: ForgeFlags = { forge: str("forge"), repo: str("repo"), pr: str("pr"), apiUrl: str("api-url"), tokenEnv: str("token-env") };
  return {
    env,
    dir: str("dir") ?? process.cwd(),
    format,
    comment: v.comment === true,
    allowOutOfOrder: v["allow-out-of-order"] === true,
    op: str("op"),
    forge,
    versionedOnly: [
      ...(format === "markdown" ? ["--format markdown"] : []),
      ...(v.comment === true ? ["--comment"] : []),
      ...(v["allow-out-of-order"] === true ? ["--allow-out-of-order"] : []),
      ...(str("op") !== undefined ? ["--op"] : []),
    ],
  };
}

/** `yodel plan <env>`; the exit codes are in `help`. */
export const plan: Command = {
  name: "plan",
  summary: "show what apply would change in an environment",
  implemented: true,
  run: (args, io) =>
    guarded("plan", io, args, help, async () => {
      const a = parsePlanArgs(args);
      const project = await loadProject(a.dir);
      const env = resolveEnvironment(project, a.env);
      if (hasMigrations(project)) return versionedPlan(project, env, a, io);
      if (a.versionedOnly.length > 0) throw new YodelError(`${a.versionedOnly.join(", ")} ${a.versionedOnly.length === 1 ? "is" : "are"} for versioned migrations, and ${project.dir} has no migrations/ directory with a migration`);
      return declarativePlan(project, env, a.format === "json", io);
    }),
};

async function declarativePlan(project: Project, env: Environment, json: boolean, io: Io): Promise<number> {
  const refusal = project.dialect === "clickhouse" ? declarativeTopologyRefusal(project, env.name) : undefined;
  if (refusal) throw refusal;
  const topology = project.dialect === "clickhouse" ? `, topology ${describeSettingsTopology(environmentSettings(project, env.name))}` : "";
  const build = await buildSchema(project);
  try {
    const result = await planEnvironment(project, env, build);
    const server = await probeServer(project, env);
    if (json) io.out(`${JSON.stringify({ ...planJson(result), ...(server ? { server } : {}) }, null, 2)}\n`);
    else io.out(`${await renderPlan(result, `Plan for ${env.name} (${server ? describeServer(server) : project.dialect}, sql.profiles.${env.name}${topology})`)}\n`);
    return planExitCode(result);
  } finally {
    build.dispose();
  }
}

async function versionedPlan(project: Project, env: Environment, a: PlanArgs, io: Io): Promise<number> {
  const marker = commentMarker(env.name);
  // Resolve the forge first: a job missing its token fails before it reads the server.
  const target = a.comment ? resolveForgeTarget(a.forge, process.env) : undefined;
  const client = target ? commentClient(target) : undefined;
  const existing = client ? await findComment(client, marker) : undefined;
  const carried = existing ? subjectIn(existing.body) : undefined;
  const previous = carried ? decodeSubject(carried) : undefined;

  const result = await collectVersionedPlan(project, env, { allowOutOfOrder: a.allowOutOfOrder, opName: a.op, previous });
  const code = result.refusal?.exitCode ?? 0;

  if (client && target) {
    const posted = await upsertComment(client, marker, renderPlanMarkdown(result), existing);
    io.err(`yodel plan: ${posted.action} the plan comment on ${target.forge} ${target.repo}#${String(target.pr)}${posted.comment.url ? ` (${posted.comment.url})` : ` (comment ${String(posted.comment.id)})`}\n`);
  }
  if (a.format === "json") io.out(`${JSON.stringify(planJsonVersioned(result), null, 2)}\n`);
  else if (a.format === "markdown") io.out(renderPlanMarkdown(result));
  else io.out(renderPlanText(result));
  return code;
}
