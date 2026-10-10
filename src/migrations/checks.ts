/**
 * Pre-migration checks (#52): what `checks` in `migration.json` may hold,
 * and whether a query's rows pass one. Pure; `../versioned/checks.ts` runs
 * them against a server.
 *
 * A check is part of `migration.json`, so of the migration's checksum and of
 * the plan digest: editing, adding or removing one moves the digest, and an
 * approval given before does not carry over.
 */

import type { MigrationCheck } from "./document.js";

export type { MigrationCheck };

const NAME = /^[a-z0-9][a-z0-9_-]*$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** What is wrong with a `checks` value read from `migration.json`, or `undefined` when it is well formed. */
export function checksProblem(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return "checks is not an array";
  const seen = new Set<string>();
  for (const [i, c] of value.entries()) {
    const at = `checks[${String(i)}]`;
    if (!isRecord(c)) return `${at} is not an object`;
    if (typeof c.name !== "string" || !NAME.test(c.name)) return `${at}.name must be lowercase letters, digits, - and _, got ${JSON.stringify(c.name)}`;
    if (seen.has(c.name)) return `two checks are named ${c.name}`;
    seen.add(c.name);
    if (typeof c.sql !== "string" || c.sql.trim() === "") return `${at} (${c.name}) has no sql`;
    const e = c.expect;
    if (e === undefined || e === "empty" || e === "true") continue;
    if (!isRecord(e)) return `${at} (${c.name}): expect must be "empty", "true" or { "min"?: n, "max"?: n }, got ${JSON.stringify(e)}`;
    const extra = Object.keys(e).filter((k) => k !== "min" && k !== "max");
    if (extra.length > 0 || (e.min === undefined && e.max === undefined)) return `${at} (${c.name}): expect { "min"?: n, "max"?: n } takes min, max or both, got ${JSON.stringify(e)}`;
    for (const k of ["min", "max"] as const) {
      if (e[k] !== undefined && (typeof e[k] !== "number" || !Number.isFinite(e[k]))) return `${at} (${c.name}): expect.${k} must be a number, got ${JSON.stringify(e[k])}`;
    }
  }
  return undefined;
}

/** What a check expects, in words. */
export function describeExpect(check: MigrationCheck): string {
  const e = check.expect ?? "empty";
  if (e === "empty") return "returns no rows";
  if (e === "true") return "returns true";
  if (e.min !== undefined && e.max !== undefined) return `returns a number from ${String(e.min)} to ${String(e.max)}`;
  return e.min !== undefined ? `returns a number of at least ${String(e.min)}` : `returns a number of at most ${String(e.max ?? 0)}`;
}

export interface CheckOutcome {
  name: string;
  passed: boolean;
  /** What the query returned, in a few words. */
  detail: string;
}

const firstValue = (row: Record<string, unknown> | undefined): unknown => (row ? Object.values(row)[0] : undefined);

const asNumber = (v: unknown): number | undefined => {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};

const shown = (v: unknown): string => (v === undefined ? "nothing" : typeof v === "bigint" ? v.toString() : JSON.stringify(v));

/** Whether `rows`, what the check's query returned, pass it. */
export function judgeCheck(check: MigrationCheck, rows: ReadonlyArray<Record<string, unknown>>): CheckOutcome {
  const e = check.expect ?? "empty";
  const n = rows.length;
  const count = `${String(n)} row${n === 1 ? "" : "s"}`;
  if (e === "empty") {
    return { name: check.name, passed: n === 0, detail: n === 0 ? "no rows" : `${count}, the first ${JSON.stringify(rows[0])}` };
  }
  if (n !== 1) return { name: check.name, passed: false, detail: `${count}, not one` };
  const v = firstValue(rows[0]);
  if (e === "true") {
    const passed = v === true || v === 1 || v === "1" || v === "true" || v === "t";
    return { name: check.name, passed, detail: shown(v) };
  }
  const x = asNumber(v);
  if (x === undefined) return { name: check.name, passed: false, detail: `${shown(v)}, not a number` };
  const passed = (e.min === undefined || x >= e.min) && (e.max === undefined || x <= e.max);
  return { name: check.name, passed, detail: String(x) };
}

/**
 * A `--check` argument: `<sql>`, or `<name>: <sql>`; the name defaults to
 * `check-<n>`, n counting from 1. The check expects no rows.
 */
export function parseCheckArg(arg: string, n: number): MigrationCheck {
  const named = /^([a-z0-9][a-z0-9_-]*):\s+([\s\S]+)$/.exec(arg.trim());
  const check: MigrationCheck = named ? { name: named[1] ?? "", sql: (named[2] ?? "").trim() } : { name: `check-${String(n)}`, sql: arg.trim() };
  return check;
}
