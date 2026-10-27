/**
 * `yodel test`'s outcome for people (text), for tools (`--json`,
 * schemas/test.schema.json) and for CI (`--junit <file>`, JUnit XML: one
 * testsuite per test file, one testcase per case).
 */

import type { CaseResult, TestRun } from "./run.js";
import { EXIT_FAILED } from "../exit.js";


export const testExitCode = (run: TestRun): number => (run.cases.some((c) => c.status !== "passed") ? EXIT_FAILED : 0);

const count = (run: TestRun, status: CaseResult["status"]) => run.cases.filter((c) => c.status === status).length;

export function renderTests(run: TestRun): string {
  const lines = [`yodel test on ${run.environment} (${run.where})${run.reset ? `, ${run.scope.join(", ")} emptied first` : ""}:`];
  for (const c of run.cases) {
    lines.push(`  ${c.status === "passed" ? "pass" : c.status === "failed" ? "FAIL" : "ERROR"}  ${c.file} > ${c.name} (${String(c.ms)} ms)`);
    if (c.error) lines.push(`        ${c.error}`);
    for (const f of c.failures) lines.push(`        ${f}`);
  }
  if (run.cases.length === 0) lines.push("  no case ran");
  lines.push(`${String(count(run, "passed"))} passed, ${String(count(run, "failed"))} failed, ${String(count(run, "error"))} errors`);
  return `${lines.join("\n")}\n`;
}

/** `--json`: schemas/test.schema.json. */
export function testJson(run: TestRun): Record<string, unknown> {
  return {
    environment: run.environment,
    dialect: run.dialect,
    where: run.where,
    scope: run.scope,
    reset: run.reset,
    files: run.files,
    summary: { passed: count(run, "passed"), failed: count(run, "failed"), errors: count(run, "error") },
    cases: run.cases.map((c) => ({
      file: c.file,
      name: c.name,
      status: c.status,
      ms: c.ms,
      failures: c.failures,
      ...(c.error !== undefined ? { error: c.error } : {}),
      before: c.before,
      after: c.after,
    })),
  };
}

const xml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // XML 1.0 has no place for most control characters.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

const secs = (ms: number): string => (ms / 1000).toFixed(3);

/** `--junit <file>`: JUnit XML, one testsuite per test file. */
export function testJunit(run: TestRun): string {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>'];
  const total = run.cases.reduce((n, c) => n + c.ms, 0);
  out.push(`<testsuites name="yodel test" tests="${String(run.cases.length)}" failures="${String(count(run, "failed"))}" errors="${String(count(run, "error"))}" time="${secs(total)}">`);
  for (const file of run.files) {
    const cases = run.cases.filter((c) => c.file === file);
    const failures = cases.filter((c) => c.status === "failed").length;
    const errors = cases.filter((c) => c.status === "error").length;
    out.push(`  <testsuite name="${xml(file)}" tests="${String(cases.length)}" failures="${String(failures)}" errors="${String(errors)}" time="${secs(cases.reduce((n, c) => n + c.ms, 0))}">`);
    for (const c of cases) {
      const open = `    <testcase classname="${xml(file)}" name="${xml(c.name)}" time="${secs(c.ms)}"`;
      if (c.status === "passed") {
        out.push(`${open}/>`);
        continue;
      }
      out.push(`${open}>`);
      if (c.status === "failed") out.push(`      <failure message="${xml(c.failures[0] ?? "")}">${xml(c.failures.join("\n"))}</failure>`);
      else out.push(`      <error message="${xml(c.error ?? "")}">${xml(c.error ?? "")}</error>`);
      out.push("    </testcase>");
    }
    out.push("  </testsuite>");
  }
  out.push("</testsuites>");
  return `${out.join("\n")}\n`;
}
