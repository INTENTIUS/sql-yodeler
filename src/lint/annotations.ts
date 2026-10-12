/**
 * `yodel lint`'s findings where a forge shows them to reviewers (#129):
 *
 *   workflowCommands(report, root)   GitHub and Forgejo Actions: one
 *                                    `::error file=...,line=...::` line per
 *                                    finding, which the forge shows on the file
 *   codeQuality(report, root)        GitLab: the code quality report, kept as
 *                                    the job's `artifacts:reports:codequality`
 *
 * A finding in a migration points at its migration.sql, on the statement's
 * line when the rule knows it (line 1 otherwise); a finding about the whole
 * directory points at no file. Paths are relative to `root`, the
 * repository's checkout (GITHUB_WORKSPACE, CI_PROJECT_DIR), with `/`.
 */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { MIGRATION_SQL } from "../migrations/index.js";
import type { Finding, LintReport } from "./check.js";

/** The formats `yodel lint --format` prints. */
export const LINT_FORMATS = ["text", "json", "github", "gitlab"] as const;
export type LintFormat = (typeof LINT_FORMATS)[number];

/** Where `yodel lint --format gitlab` writes the code quality report, unless --output says otherwise. */
export const CODE_QUALITY_FILE = "gl-code-quality-report.json";

/** `p` with its symbolic links resolved, so a checkout reached through one (macOS's /var, /tmp) still contains the project; `p` itself when it does not exist. */
function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** `to` relative to `root`, with `/`. */
const fromRoot = (root: string, to: string): string => relative(real(root), real(to)).split(sep).join("/");

/** The file a finding is about, relative to `root`; undefined for one about the directory as a whole. */
export function findingPath(report: Pick<LintReport, "dir">, f: Pick<Finding, "migration" | "file">, root: string): string | undefined {
  if (f.file !== undefined) return fromRoot(root, join(report.dir, f.file));
  if (f.migration === undefined) return undefined;
  return `${fromRoot(root, join(report.dir, f.migration))}/${MIGRATION_SQL}`;
}

// A workflow command's message and properties are escaped as the runner unescapes them.
const escapeData = (s: string): string => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escapeProperty = (s: string): string => escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

/**
 * One workflow command per finding: `error` and `warning` at the finding's
 * level, `notice` for a silenced one (it fails nothing, but a reviewer sees
 * the reason beside the statement).
 */
export function workflowCommands(report: LintReport, root: string): string {
  const lines = report.findings.map((f) => {
    const command = f.silenced !== undefined ? "notice" : f.level;
    const file = findingPath(report, f, root);
    const props = [
      ...(file !== undefined ? [`file=${escapeProperty(file)}`, `line=${String(f.line ?? 1)}`] : []),
      `title=${escapeProperty(`yodel lint ${f.rule}`)}`,
    ];
    const message = f.silenced !== undefined ? `${f.message} (silenced: ${f.silenced})` : f.message;
    return `::${command} ${props.join(",")}::${escapeData(message)}`;
  });
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/** One entry of GitLab's code quality report. */
export interface CodeQualityIssue {
  description: string;
  check_name: string;
  fingerprint: string;
  severity: "info" | "minor" | "major" | "critical" | "blocker";
  location: { path: string; lines: { begin: number } };
}

/**
 * GitLab's code quality report: an error is `major`, a warning `minor` and
 * a silenced finding `info`. A finding about the directory as a whole is
 * placed on the migrations directory. The fingerprint is the rule, the
 * place and the message, so the same finding on two pipelines is one issue
 * to GitLab and a fixed one shows as resolved.
 */
export function codeQuality(report: LintReport, root: string): CodeQualityIssue[] {
  return report.findings.map((f) => {
    const path = findingPath(report, f, root) ?? fromRoot(root, report.dir);
    const begin = f.line ?? 1;
    const severity = f.silenced !== undefined ? "info" : f.level === "error" ? "major" : "minor";
    return {
      description: f.silenced !== undefined ? `${f.message} (silenced: ${f.silenced})` : f.message,
      check_name: f.rule,
      fingerprint: createHash("sha256").update(`${f.rule}\0${path}\0${String(begin)}\0${f.message}`).digest("hex"),
      severity,
      location: { path, lines: { begin } },
    };
  });
}
