/** `yodel lint`'s output: text for people, JSON for a CI job, and the exit code. */

import type { Finding, LintReport } from "./check.js";
import { EXIT_FAILED } from "../exit.js";


export const lintExitCode = (report: LintReport): number => (report.errors > 0 ? EXIT_FAILED : 0);

const plural = (n: number, one: string, many = `${one}s`) => `${String(n)} ${n === 1 ? one : many}`;

function line(f: Finding): string[] {
  const head = f.silenced !== undefined ? "silenced" : f.level;
  const out = [`  ${head.padEnd(8)} ${f.rule}: ${f.message}`];
  if (f.silenced !== undefined) out.push(`           reason: ${f.silenced}`);
  return out;
}

export function renderLint(report: LintReport): string {
  const where = report.environment ? `, against ${report.environment}'s history` : "";
  const out: string[] = [];
  const groups = new Map<string, Finding[]>();
  for (const f of report.findings) {
    const key = f.migration ?? "";
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  for (const [id, list] of groups) {
    out.push(id === "" ? "migrations/" : id);
    for (const f of list) out.push(...line(f));
    out.push("");
  }
  if (report.declarative) {
    // No migration.sql holds a yodel:allow line on this path: lint.rules lowers a rule, a policy override answers a denial.
    out.push(`${report.environment ? `The declared schema and the plan for ${report.environment}` : "The declared schema"}: ${[plural(report.errors, "error"), plural(report.warnings, "warning")].join(", ")}.`);
    return `${out.join("\n")}\n`;
  }
  const silenceHint = report.findings.some((f) => f.silenced === undefined && f.level === "error" && ["destructive", "pg-rewrite", "pg-lock", "pg-signature", "ch-mutation", "ch-rebuild"].includes(f.rule));
  if (silenceHint) {
    out.push("A statement rule can be silenced for one statement, with a reason the history records when it applies:", "  a line `-- yodel:allow <rule> <reason>` above the statement in migration.sql", "");
  }
  const counts = [plural(report.errors, "error"), plural(report.warnings, "warning"), `${String(report.silenced)} silenced`].join(", ");
  out.push(`${plural(report.migrations.length, "migration")}${where}: ${counts}.`);
  return `${out.join("\n")}\n`;
}

export function lintJson(report: LintReport): Record<string, unknown> {
  return {
    status: report.errors > 0 ? "failed" : "passed",
    ...(report.declarative ? { declarative: true } : {}),
    ...(report.environment ? { environment: report.environment } : {}),
    dialect: report.dialect ?? null,
    migrations: report.migrations,
    errors: report.errors,
    warnings: report.warnings,
    silenced: report.silenced,
    findings: report.findings,
    silences: report.silences,
  };
}
