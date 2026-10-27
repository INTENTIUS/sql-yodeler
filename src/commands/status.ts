import type { Command } from "../command.js";
import { guarded, parseEnvArgs, usage } from "../env-args.js";
import { loadProject, resolveEnvironment, type Project } from "../project.js";
import type { Migration } from "../migrations/index.js";
import { listTenants, tenantTarget } from "../tenants/index.js";
import { closeVersioned, openVersioned, readChain, renderStatus, statusJson, statusReport, type StatusReport } from "../versioned/index.js";
import { EXIT_WAITING } from "../exit.js";


const help = `${usage("status")}

Lists the environment's migrations against its history table
(yodel.config.ts history.database, else YODEL_HISTORY_DATABASE, default
yodeler) and its topology: applied, pending, out of order (pending, but
before an applied migration in the chain), failed part way (with the
statement it resumes at), and checksum mismatches (an applied migration
whose files changed, or that is gone from the directory). When yodel apply
would run, prints the plan digest it would ask approval for. Reads only;
takes no lock.

An environment with a tenant set (yodel.config.ts environments.<env>.tenants)
is listed tenant by tenant, each against its own history, then a line of how
many tenants are up to date; <env>/<tenant> names one tenant.

Options:
  --json           print the status as JSON
  -C, --dir <dir>  the project directory (default: the working directory)

Exit codes:
  0  every migration is applied
  3  migrations are pending (failed part way included), and nothing is
     wrong; or a pending migration has a manual step or an Op step yodel
     apply does not run
  1  a checksum mismatch, an applied migration gone from the directory, an
     out-of-order migration (apply refuses it without --allow-out-of-order),
     or a fork or another problem in the migrations directory; or the status
     could not be read: a bad config, a server that does not answer
`;

/** `yodel status <env>`; the exit codes are in `help`. */
export const status: Command = {
  name: "status",
  summary: "list applied, pending and out-of-order migrations",
  implemented: true,
  run: (args, io) =>
    guarded("status", io, args, help, async () => {
      const { env: name, json, dir } = parseEnvArgs("status", args);
      const project = await loadProject(dir);
      const env = resolveEnvironment(project, name);
      const ordered = readChain(project);
      const tenants = env.tenant ? undefined : await listTenants(project, env.name);
      if (tenants) return tenantsStatus(project, env.name, tenants, ordered, json, io);
      const report = await readStatus(project, env.name, ordered);
      if (json) io.out(`${JSON.stringify(statusJson(report), null, 2)}\n`);
      // The sections already say what is wrong; the refusal's wording is apply's.
      else io.out(renderStatus({ ...report, refusal: undefined }));
      return exitOf(report);
    }),
};

async function readStatus(project: Project, name: string, ordered: readonly Migration[]): Promise<StatusReport> {
  const venv = await openVersioned(project, resolveEnvironment(project, name));
  return statusReport(venv, ordered, { sync: false }).finally(() => closeVersioned(venv));
}

const exitOf = (report: StatusReport): number => report.refusal?.exitCode ?? (report.status.pending.length > 0 ? EXIT_WAITING : 0);

/** A tenant set's status (#56): each tenant's, then how many are up to date. The exit code is the worst tenant's: a refusal, then pending. */
async function tenantsStatus(project: Project, env: string, tenants: readonly string[], ordered: readonly Migration[], json: boolean, io: Parameters<Command["run"]>[1]): Promise<number> {
  const reports: StatusReport[] = [];
  for (const t of tenants) {
    const report = await readStatus(project, tenantTarget(env, t), ordered);
    reports.push(report);
    if (!json) io.out(`${renderStatus({ ...report, refusal: undefined })}\n`);
  }
  const upToDate = reports.filter((r) => !r.refusal && r.status.pending.length === 0).length;
  if (json) io.out(`${JSON.stringify({ environment: env, tenants: reports.map((r) => statusJson(r)), upToDate, total: reports.length }, null, 2)}\n`);
  else io.out(`${env}: ${String(upToDate)} of ${String(reports.length)} tenants up to date${upToDate < reports.length ? `; behind: ${reports.filter((r) => r.refusal || r.status.pending.length > 0).map((r) => r.environment).join(", ")}` : ""}\n`);
  const codes = reports.map(exitOf);
  return codes.find((c) => c !== 0 && c !== EXIT_WAITING) ?? (codes.includes(EXIT_WAITING) ? EXIT_WAITING : 0);
}
