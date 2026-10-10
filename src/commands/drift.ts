import { execFile } from "node:child_process";
import { parseArgs } from "node:util";
import { promisify } from "node:util";
import type { Command } from "../command.js";
import { eventFromDrift, sendEvent } from "../notify/index.js";
import { guarded } from "../env-args.js";
import { loadProject, resolveEnvironment, YodelError } from "../project.js";
import { declarativeAccessRefusal, declarativeTopologyRefusal } from "../config/settings.js";
import {
  declaredColumns,
  driftExitCode,
  driftFingerprint,
  readDrift,
  renderDrift,
  renderDriftMarkdown,
  writeRecordedSource,
  type Drift,
  type DriftAgainst,
} from "../chant/drift.js";
import { buildSchema, type BuildOutput } from "../chant/build.js";
import { probeServer, softly, type ServerInfo } from "../server.js";
import type { Environment, Project, SqlDialect } from "../project.js";
import { describeHolders, describeMs, isLockTimeout, lockHolders, lockTimeoutOptions } from "../versioned/postgres/waits.js";
import { DEFAULT_PG_TIMEOUTS } from "../versioned/postgres/executor.js";
import { closeVersioned, hasMigrations, inspect, openVersioned, readChain } from "../versioned/index.js";
import { isApplied } from "../history/index.js";
import { resolveForgeRepo, type ForgeFlags, type ForgeRepo } from "../pr/forge.js";
import { driftIssueMarker, issueClient, trackDrift, type DriftOutcome, type IssueAction } from "../pr/issue.js";
import type { PostgresEndpoint } from "@intentius/chant-lexicon-sql/postgres/live/client";

interface PgLockSettings {
  endpoint: PostgresEndpoint;
  schemas: string[] | undefined;
  lockTimeoutMs: number;
}

/** The profile's lock timeout (#18), which chant's read runs under, and where to look for the lock when it passes. */
async function postgresLockSettings(project: Project, env: Environment): Promise<PgLockSettings | undefined> {
  const { resolvePostgresTarget, isUnresolvedTarget } = await import("@intentius/chant-lexicon-sql/postgres/live/bind");
  const target = resolvePostgresTarget({ environment: env.name, config: project.config, env: process.env });
  if (isUnresolvedTarget(target)) return undefined;
  return { endpoint: target.endpoint, schemas: target.schemas, lockTimeoutMs: target.timeouts?.lockTimeoutMs ?? DEFAULT_PG_TIMEOUTS.lockTimeoutMs };
}

/** What the read waited on: `waited 5s for a lock on shop.orders (held by pid 123, psql)`. */
async function lockWait(pg: PgLockSettings): Promise<string> {
  const { connectPostgres } = await import("@intentius/chant-lexicon-sql/postgres/live/client");
  const holders = await softly(async () => {
    const client = await connectPostgres(pg.endpoint, { applicationName: "yodel" });
    try {
      return await lockHolders(client, pg.schemas);
    } finally {
      await client.end();
    }
  });
  return `waited ${describeMs(pg.lockTimeoutMs)} (lockTimeoutMs) for ${describeHolders(holders ?? [])}; run yodel drift again once it is released`;
}

/**
 * The schema the environment's history says it has: the recorded schema
 * of the newest migration, in chain order, that the history records as
 * applied. `undefined` when none is applied yet.
 */
export async function recordedSchema(project: Project, env: Environment): Promise<{ migration: string; schema: BuildOutput } | undefined> {
  const ordered = readChain(project);
  const venv = await openVersioned(project, env);
  try {
    const { state } = await inspect(venv, ordered);
    const newest = [...ordered].reverse().find((m) => isApplied(state.byId.get(m.id)));
    if (newest) return { migration: newest.id, schema: newest.document.schema };
    const gone = state.migrations.filter((r) => isApplied(r)).map((r) => r.id);
    if (gone.length > 0) throw new YodelError(`the history records ${gone.join(", ")} applied, and the migrations directory has none of them, so there is no recorded schema to compare with; pass --against src`);
    return undefined;
  } finally {
    await closeVersioned(venv);
  }
}

/** The project's directory in its git repository (`.` at the root), which keys its tracking issue. */
async function projectPath(dir: string): Promise<string> {
  try {
    const { stdout } = await promisify(execFile)("git", ["rev-parse", "--show-prefix"], { cwd: dir });
    return stdout.trim().replace(/\/+$/, "") || ".";
  } catch {
    return ".";
  }
}

/** The CI run, for the issue to link: GitHub and Forgejo Actions, GitLab CI. */
function runUrl(env: NodeJS.ProcessEnv): string | undefined {
  if (env.CI_JOB_URL) return env.CI_JOB_URL;
  if (env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID) return `${env.GITHUB_SERVER_URL.replace(/\/+$/, "")}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  return undefined;
}

const usage =
  "usage: yodel drift <env> [--json] [--dir <project>] [--against history|src]\n" +
  "                         [--issue [--forge github|gitlab|forgejo] [--repo <repo>] [--api-url <url>] [--token-env <VAR>]]";

const help = `${usage}

Reports the declared objects changed out of band or gone from the
environment, from chant lifecycle diff <env> --live. Objects the project does
not declare are never reported.

What the server is compared with:

- history (the default when the project has migrations): the schema recorded
  by the newest migration the environment's history records as applied. A
  migration merged but not applied yet (waiting at its gate, or refused) is
  not drift.
- src (the default without migrations): the declared schema in src/.

Options:
  --against <what>      history or src, as above
  --json                print the drift as JSON, with a fingerprint of it
  --issue               keep one tracking issue for this project and
                        environment on the forge: opened when drift is found,
                        updated while it changes, closed when it is gone. A run
                        that cannot read a declared object leaves the issue as
                        it is, and says so. The forge, repository and token
                        come from the CI job's environment, as for yodel plan
                        --comment (GITHUB_TOKEN, GITLAB_TOKEN, FORGEJO_TOKEN):
    --forge <f>         github, gitlab or forgejo
    --repo <repo>       owner/name (GitHub, Forgejo), or the project id or path (GitLab)
    --api-url <url>     the REST API base
    --token-env <VAR>   the variable holding the token
  -C, --dir <dir>       the project directory (default: the working directory)

Exit codes:
  0  no drift
  2  a declared object changed out of band, or is gone
  1  the drift could not be read, or there is none but a declared object
     could not be read (its state is unknown, not clean), or the tracking
     issue could not be written
`;

interface DriftArgs {
  env: string;
  json: boolean;
  dir: string;
  against: "history" | "src" | undefined;
  issue: boolean;
  forge: Omit<ForgeFlags, "pr">;
}

function parseDriftArgs(args: string[]): DriftArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: "boolean" },
        dir: { type: "string", short: "C" },
        against: { type: "string" },
        issue: { type: "boolean" },
        forge: { type: "string" },
        repo: { type: "string" },
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
  const against = str("against");
  if (against !== undefined && against !== "history" && against !== "src") throw new YodelError(`--against must be history or src, got ${JSON.stringify(against)}\n${usage}`);
  const forgeFlags = ["forge", "repo", "api-url", "token-env"].filter((k) => str(k) !== undefined);
  if (forgeFlags.length > 0 && v.issue !== true) throw new YodelError(`--${forgeFlags.join(", --")} ${forgeFlags.length === 1 ? "goes" : "go"} with --issue\n${usage}`);
  return {
    env,
    json: v.json === true,
    dir: str("dir") ?? process.cwd(),
    against,
    issue: v.issue === true,
    forge: { forge: str("forge"), repo: str("repo"), apiUrl: str("api-url"), tokenEnv: str("token-env") },
  };
}

/** What the tracking issue should do with a run's result. */
function outcomeOf(drift: Drift, code: number, body: string): DriftOutcome {
  if (code === 2) {
    const names = [...drift.changed.map((e) => e.name), ...drift.missing];
    const shown = names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${String(names.length - 3)} more` : names.join(", ");
    return { kind: "drift", title: `Drift in ${drift.environment}: ${shown}`, body, fingerprint: driftFingerprint(drift) };
  }
  if (code === 0) return { kind: "clean", comment: `No drift in ${drift.environment} now: every declared object matches the server. Closed by yodel drift.` };
  return { kind: "unknown", why: `${String(drift.unobserved.length)} declared object(s) could not be read, so whether ${drift.environment} drifted is unknown` };
}

function describeAction(a: IssueAction, target: ForgeRepo): string {
  const where = `${target.forge} ${target.repo}`;
  if (a.action === "none") return `no drift, and no tracking issue open on ${where}`;
  const issue = "issue" in a ? `#${String(a.issue.number)}${a.issue.url ? ` (${a.issue.url})` : ""}` : "";
  if (a.action === "left") return `left the tracking issue${issue ? ` ${issue}` : ""} on ${where} as it is: ${a.why}`;
  return `${a.action} the tracking issue ${issue} on ${where}`;
}

/** The document `yodel drift --json` prints (schemas/drift.schema.json): the drift, and what the run made of it. */
export function driftJson(
  result: Drift,
  parts: { dialect: SqlDialect; server?: ServerInfo | undefined; drifted: boolean; fingerprint: string; issue?: IssueAction | undefined; issueError?: string | undefined },
): Record<string, unknown> {
  const action = parts.issue;
  const issue = action && "issue" in action ? { action: action.action, number: action.issue.number, ...(action.issue.url ? { url: action.issue.url } : {}) } : action ? { action: action.action } : undefined;
  return {
    ...result,
    dialect: parts.dialect,
    ...(parts.server ? { server: parts.server } : {}),
    drifted: parts.drifted,
    fingerprint: parts.fingerprint,
    ...(issue ? { issue } : {}),
    ...(parts.issueError ? { issueError: parts.issueError } : {}),
  };
}

/** `yodel drift <env>`; the exit codes are in `help`. */
export const drift: Command = {
  name: "drift",
  summary: "report declared objects changed out of band or gone",
  implemented: true,
  run: (args, io) =>
    guarded("drift", io, args, help, async () => {
      const a = parseDriftArgs(args);
      const project = await loadProject(a.dir);
      const env = resolveEnvironment(project, a.env);
      // chant renders the declaration for sql.profiles.<env>.topology alone; a different one in yodel.config.ts would show every replicated engine as drift.
      const refusal = project.dialect === "clickhouse" ? declarativeTopologyRefusal(project, env.name) : declarativeAccessRefusal(project, env.name);
      if (refusal) throw refusal;
      const versioned = hasMigrations(project);
      const source = a.against ?? (versioned ? "history" : "src");
      if (source === "history" && !versioned) throw new YodelError(`--against history compares with the schema the newest applied migration records, and ${project.dir} has no migrations/ directory with a migration`);
      // The forge first: a job missing its token fails before it reads the server.
      const target = a.issue ? resolveForgeRepo(a.forge, process.env) : undefined;
      const track = async (outcome: DriftOutcome): Promise<IssueAction | undefined> => {
        if (!target) return undefined;
        const action = await trackDrift(issueClient(target), driftIssueMarker(await projectPath(project.dir), env.name), outcome);
        io.err(`yodel drift: ${describeAction(action, target)}\n`);
        return action;
      };

      let result: Drift;
      let recorded: BuildOutput | undefined;
      try {
        const server = await probeServer(project, env);
        const pg = project.dialect === "postgres" ? await postgresLockSettings(project, env) : undefined;
        const chantEnv = pg ? { env: { ...process.env, PGOPTIONS: lockTimeoutOptions(pg.lockTimeoutMs, process.env.PGOPTIONS) } } : {};
        let against: DriftAgainst = { source: "src" };
        if (source === "history") {
          const newest = await recordedSchema(project, env);
          against = { source: "history", migration: newest?.migration ?? null };
          recorded = newest?.schema;
        }
        if (source === "history" && !recorded) {
          // Nothing applied yet: the history records no schema, so nothing declared can have drifted from it.
          result = { environment: env.name, changed: [], missing: [], unobserved: [] };
        } else if (recorded) {
          const src = await writeRecordedSource(project.dir, recorded);
          try {
            result = await readDrift(project, env, { ...chantEnv, src: src.dir });
          } finally {
            src.dispose();
          }
        } else {
          result = await readDrift(project, env, chantEnv);
        }
        result.against = against;
        if (pg && result.unobserved.some((u) => isLockTimeout(u.detail) || isLockTimeout(u.reason))) result.lockWait = await lockWait(pg);
        const ofRecorded = recorded;
        const build = ofRecorded ? () => Promise.resolve({ output: ofRecorded, dispose: () => undefined }) : () => buildSchema(project);
        const columns = await declaredColumns(project, result, build).catch(() => ({}));
        if (Object.keys(columns).length > 0) result.columns = columns;
        const code = driftExitCode(result);
        const fingerprint = driftFingerprint(result);
        const run = runUrl(process.env);
        let action: IssueAction | undefined;
        let issueError: string | undefined;
        try {
          action = await track(outcomeOf(result, code, renderDriftMarkdown(result, server, { fingerprint, ...(run ? { run } : {}) })));
        } catch (e) {
          issueError = e instanceof Error ? e.message : String(e);
          io.err(`yodel drift: the tracking issue could not be written: ${issueError}\n`);
        }
        if (a.json) io.out(`${JSON.stringify(driftJson(result, { dialect: project.dialect, server, drifted: code === 2, fingerprint, issue: action, issueError }), null, 2)}\n`);
        else io.out(renderDrift(result, server));
        // The watch runs yodel drift on a schedule: drift found goes to the webhook yodel.config.ts notify names (#61), with the fingerprint so a receiver can tell a repeat.
        await sendEvent(project.yodel?.config.notify, eventFromDrift({ ...result, drifted: code === 2, fingerprint }), { io, verb: "drift" });
        return issueError && code !== 2 ? 1 : code;
      } catch (e) {
        // The drift could not be read: the tracking issue stays as it is.
        await track({ kind: "unknown", why: `the drift could not be read (${e instanceof Error ? (e.message.split("\n")[0] ?? "") : String(e)})` }).catch(() => undefined);
        throw e;
      }
    }),
};
