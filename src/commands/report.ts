import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Command } from "../command.js";
import { guarded } from "../env-args.js";
import { loadProject, resolveEnvironment, YodelError } from "../project.js";
import { hasMigrations, readChain } from "../versioned/index.js";
import type { AuditEntry } from "../report/audit.js";
import { appendAudit, compareAudit, describeEntry, readAuditFile } from "../report/jsonl.js";
import { collectReport, type Report } from "../report/model.js";
import { renderReportHtml, renderReportText } from "../report/render.js";

/** Exit code: a gap in the sources, or an audit file entry they no longer give. */
export const REPORT_GAPS = 4;

const usage = "usage: yodel report [<env>...] [--json] [--html <file>] [--audit <file> [--check]] [--dir <project>]";

const help = `${usage}

Every environment's migrations side by side (default: every environment in
chant.config.ts's sql.profiles, in that order), and the audit log derived
from each environment's history table and chant's gate ledger (the
chant/lifecycle branch): approval requested, approved, override, silenced,
applied, refused, failed, repaired, reverted. Nothing in the log is written
by hand, so it cannot disagree with what ran. Reads only; takes no lock.

It also names the gaps the sources show: a history row missing (seqs run
from 1 with no hole), and a migration applied under a plan digest the ledger
holds no approval of. Fetch the chant/lifecycle branch first in CI, so the
ledger is there to read.

Options:
  --json           print the report as JSON
  --html <file>    write the run view, a self-contained HTML page: one row
                   per migration, one column per environment, then the audit
                   log
  --audit <file>   append the entries the sources hold that the file does
                   not (audit.jsonl, one entry per line, only ever appended)
  --check          with --audit: append nothing, and name every entry of the
                   file the sources no longer give (a ledger line or history
                   row removed since it was written)
  -C, --dir <dir>  the project directory (default: the working directory)

Exit codes:
  0  read, no gaps
  4  a gap: a history row missing, an applied migration with no approval on
     the ledger, or (with --audit) an entry of the file no longer in the
     sources
  1  an environment could not be read, or a bad config
`;

interface ReportArgs {
  envs: string[];
  json: boolean;
  html: string | undefined;
  audit: string | undefined;
  check: boolean;
  dir: string;
}

function parseReportArgs(args: string[]): ReportArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: "boolean" },
        html: { type: "string" },
        audit: { type: "string" },
        check: { type: "boolean" },
        dir: { type: "string", short: "C" },
      },
    });
  } catch (e) {
    throw new YodelError(`${e instanceof Error ? e.message : String(e)}\n${usage}`);
  }
  const v = parsed.values;
  if (v.check === true && typeof v.audit !== "string") throw new YodelError(`--check checks an audit file: give it with --audit <file>\n${usage}`);
  return {
    envs: parsed.positionals,
    json: v.json === true,
    html: typeof v.html === "string" ? v.html : undefined,
    audit: typeof v.audit === "string" ? v.audit : undefined,
    check: v.check === true,
    dir: typeof v.dir === "string" ? v.dir : process.cwd(),
  };
}

/** The JSON `yodel report --json` prints (schemas/report.schema.json). */
export function reportJson(r: Report, auditFile?: { path: string; appended: number; missing: AuditEntry[] }): Record<string, unknown> {
  return { ...r, ...(auditFile ? { auditFile } : {}) };
}

/** `yodel report [<env>...]`; the exit codes are in `help`. */
export const report: Command = {
  name: "report",
  summary: "each environment's migrations side by side, and the audit log",
  implemented: true,
  run: (args, io) =>
    guarded("report", io, args, help, async () => {
      const a = parseReportArgs(args);
      const project = await loadProject(a.dir);
      if (!hasMigrations(project)) throw new YodelError(`yodel report reads versioned migrations' history, and ${project.dir} has no migrations/ directory with a migration`);
      const names = a.envs.length > 0 ? a.envs : Object.keys(project.config.sql?.profiles ?? {});
      for (const n of names) resolveEnvironment(project, n);
      const r = await collectReport(project, readChain(project), names);

      let auditFile: { path: string; appended: number; missing: AuditEntry[] } | undefined;
      if (a.audit) {
        const path = resolve(a.audit);
        const file = readAuditFile(path);
        const read = r.environments.filter((e) => !e.error).map((e) => e.name);
        const { missing, added } = compareAudit(file, r.audit, read);
        if (!a.check) appendAudit(path, added);
        auditFile = { path: a.audit, appended: a.check ? 0 : added.length, missing };
      }
      if (a.html) writeFileSync(resolve(a.html), renderReportHtml(r));

      if (a.json) io.out(`${JSON.stringify(reportJson(r, auditFile), null, 2)}\n`);
      else io.out(renderReportText(r, auditFile ? { check: { file: auditFile.path, missing: auditFile.missing.map(describeEntry), appended: auditFile.appended } } : {}));
      if (a.html && !a.json) io.err(`yodel report: wrote the run view to ${a.html}\n`);

      if (r.gaps.length > 0 || (auditFile?.missing.length ?? 0) > 0) return REPORT_GAPS;
      return r.environments.some((e) => e.error) ? 1 : 0;
    }),
};
