import { parseArgs } from "node:util";
import type { Command, Io } from "../command.js";
import { environmentSettings } from "../config/settings.js";
import { CONFIG_FILE } from "../config/load.js";
import { credentialsOf, describePassword, roleOf, roleSetting, ROLE_VAR, ROLES, type Credentials, type Role } from "../credentials.js";
import { guarded } from "../env-args.js";
import { EXIT_FAILED } from "../exit.js";
import { writeProbe, type ProbeResult } from "../probe.js";
import { loadProject, resolveEnvironment, YodelError, type Project } from "../project.js";
import { serverAddress } from "../server.js";

const USAGE = "usage: yodel config check [<env>...] [--write-probe] [--dir <project>]";

const help = `${USAGE}

Prints each environment's settings and where each came from: the server,
the role this process connects as (YODEL_ROLE), the reader's and the
writer's user and password (the variable each is read from and whether it
is set here, or the token source that mints it), the history's database,
the topology, and the lock's TTL and wait. Every environment, or the ones
named. Never prints a password.

A profile made with credentials() in chant.config.ts carries a reader and a
writer. Every yodel command refuses the project, exit 1, when an
environment's reader and writer read their user or password from the same
variable, or their users are the same name.

Options:
  --write-probe    try a write in each environment with the credentials this
                   process holds, and exit 1 when the server lets one
                   through: run in a pull request job, it shows the job
                   holds no writer. The write is rolled back (Postgres) or
                   dropped at once (ClickHouse).
  -C, --dir <dir>  the project directory (default: the working directory)

Exit codes:
  0  printed; with --write-probe, no environment let the write through
  1  refused: an environment's reader and writer are one identity, or with
     --write-probe, a write went through; or an error: a bad config, an
     unknown environment, a server that does not answer, or a probe that
     could not tell
`;

interface RoleView {
  user: { variable: string; set: boolean; value?: string };
  password: { source: string; set?: boolean };
}

interface EnvView {
  environment: string;
  server: string;
  role: Role;
  roleSource: string;
  /** Both roles when the profile is made with credentials(); else the one user and password every job uses. */
  credentials: { split: true; reader: RoleView; writer: RoleView } | { split: false; user?: string; password?: string };
  history: { database: string; source: string };
  topology?: { value: string; source: string };
  lockTtlSeconds: number;
  lockWaitSeconds: number;
  probe?: ProbeResult;
}

const isEnvRef = (v: unknown): v is { env: string } => typeof v === "object" && v !== null && typeof (v as { env?: unknown }).env === "string";

function roleView(c: Credentials, role: Role, env: NodeJS.ProcessEnv): RoleView {
  const r = c[role];
  const value = env[r.user.env];
  const set = value !== undefined && value !== "";
  return {
    user: { variable: r.user.env, set, ...(set ? { value } : {}) },
    password: isEnvRef(r.password) ? { source: r.password.env, set: (env[r.password.env] ?? "") !== "" } : { source: describePassword(r.password) },
  };
}

function view(project: Project, name: string, env: NodeJS.ProcessEnv): EnvView {
  const e = resolveEnvironment(project, name);
  const profile = e.profile as unknown as Record<string, unknown>;
  const c = credentialsOf(profile);
  const settings = environmentSettings(project, name, env);
  const own = project.yodel?.config.environments?.[name];
  const historySource = own?.history?.database !== undefined ? CONFIG_FILE : env.YODEL_HISTORY_DATABASE ? "YODEL_HISTORY_DATABASE" : "default";
  const set = roleSetting(env);
  const user = profile.user;
  const password = profile.password as Parameters<typeof describePassword>[0] | undefined;
  return {
    environment: name,
    server: serverAddress(project.dialect, String(profile.url)),
    role: roleOf(name, set?.value),
    roleSource: set ? `${set.name}=${set.value}` : `${ROLE_VAR} unset`,
    credentials: c
      ? { split: true, reader: roleView(c, "reader", env), writer: roleView(c, "writer", env) }
      : { split: false, ...(isEnvRef(user) ? { user: user.env } : {}), ...(password ? { password: describePassword(password) } : {}) },
    history: { database: settings.historyDatabase, source: historySource },
    ...(project.dialect === "clickhouse" ? { topology: { value: describeTopology(settings.topology), source: settings.topologySource } } : {}),
    lockTtlSeconds: settings.lockTtlMs / 1000,
    lockWaitSeconds: settings.lockWaitMs / 1000,
  };
}

const describeTopology = (t: { kind: string; cluster?: string }): string => (t.cluster ? `${t.kind}:${t.cluster}` : t.kind);

function render(v: EnvView): string {
  const lines = [`${v.environment} (${v.server})`, `  connects as   ${v.role} (${v.roleSource})`];
  const c = v.credentials;
  if (c.split) {
    for (const role of ROLES) {
      const r = c[role];
      const user = `${r.user.variable} (${r.user.set ? `set: ${r.user.value ?? ""}` : "not set here"})`;
      const password = r.password.set === undefined ? r.password.source : `${r.password.source} (${r.password.set ? "set" : "not set here"})`;
      lines.push(`  ${role.padEnd(13)} user ${user}, password ${password}`);
    }
  } else {
    lines.push(
      `  credentials   user ${c.user ?? "none"}, password ${c.password ?? "none"}: one set for every job; credentials() in chant.config.ts gives a reader and a writer`,
    );
  }
  lines.push(`  history       ${v.history.database} (${v.history.source})`);
  if (v.topology) lines.push(`  topology      ${v.topology.value} (${v.topology.source})`);
  lines.push(`  lock          ttl ${String(v.lockTtlSeconds)}s, wait ${String(v.lockWaitSeconds)}s`);
  if (v.probe) lines.push(`  write probe   ${v.probe.wrote ? "WROTE" : "cannot write"}: ${v.probe.detail}`);
  return `${lines.join("\n")}\n`;
}

async function check(args: string[], io: Io): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true, options: { "write-probe": { type: "boolean" }, dir: { type: "string", short: "C" } } });
  } catch (e) {
    throw new YodelError(`${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  const project = await loadProject(typeof values.dir === "string" ? values.dir : process.cwd());
  const names = positionals.length > 0 ? positionals : Object.keys(project.config.sql?.profiles ?? {});
  const views: EnvView[] = [];
  for (const name of names) {
    const v = view(project, name, process.env);
    if (values["write-probe"] === true) v.probe = await writeProbe(project, resolveEnvironment(project, name));
    views.push(v);
  }
  io.out(views.map(render).join("\n"));
  const wrote = views.filter((v) => v.probe?.wrote);
  if (wrote.length === 0) return 0;
  for (const v of wrote) {
    io.err(`yodel config: refused: ${v.environment}: the credentials this process holds can write (${v.probe?.detail ?? ""}). A pull request job must hold the reader only: check which secrets it maps, and the reader's grants.\n`);
  }
  return EXIT_FAILED;
}

/** `yodel config check`; the exit codes are in `help`. */
export const config: Command = {
  name: "config",
  summary: "print each environment's settings, and prove a job cannot write",
  implemented: true,
  run: (args, io) =>
    guarded("config", io, args, help, async () => {
      const [sub, ...rest] = args;
      if (sub !== "check") throw new YodelError(USAGE);
      return check(rest, io);
    }),
};
