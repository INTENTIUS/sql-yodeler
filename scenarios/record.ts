/**
 * The claims record: what `npm run claims -- --record FILE` writes.
 *
 *   {
 *     "format": 1,
 *     "recorded": "2026-10-09T12:00:00.000Z",   the last write
 *     "commit": "4267949",                      HEAD at the last write
 *     "dirty": false,                           tracked files differed from HEAD then
 *     "rows": [
 *       {
 *         "claim": "lint-ci",
 *         "dialect": "ch",
 *         "says": "yodel lint, offline, fails ...",
 *         "needs": null,                        the issue a pending claim waits on
 *         "plain": "pass",                      pass | fail | pending
 *         "break": "caught",                    caught | fail | pending
 *         "seconds": { "plain": 4, "break": 5 },
 *         "recorded": "2026-10-09T12:00:00.000Z",   when this row was run
 *         "commit": "4267949",                      HEAD when this row was run
 *         "dirty": false
 *       }
 *     ]
 *   }
 *
 * One row per claim and dialect, in the order of scenarios/claims/index.ts
 * and each claim's dialects. Every row is run both ways (--record refuses
 * --plain, --break and BREAK), so a row always has both verdicts.
 *
 * When FILE exists, a run replaces the rows it ran and keeps the others,
 * each with its own recorded, commit and dirty, so a record merged from
 * several runs says when and at what commit each row was last seen. A run
 * of every claim replaces every row. Rows whose claim or dialect is no
 * longer in the list are dropped.
 */

import { existsSync, readFileSync } from "node:fs";
import type { Dialect } from "./lib/claim.js";

export const recordFormat = 1;

export interface Stamp {
  recorded: string;
  commit: string | null;
  dirty: boolean;
}

export interface RecordRow extends Stamp {
  claim: string;
  dialect: Dialect;
  says: string;
  needs: string | null;
  plain: string | null;
  break: string | null;
  seconds: { plain: number | null; break: number | null };
}

export interface ClaimsRecord extends Stamp {
  format: typeof recordFormat;
  rows: RecordRow[];
}

/** The record in `file`, or undefined when there is none; throws when the file is not one. */
export function readRecord(file: string): ClaimsRecord | undefined {
  if (!existsSync(file)) return undefined;
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file} is not JSON (${e instanceof Error ? e.message : String(e)})`, { cause: e });
  }
  const d = doc as { format?: unknown; rows?: unknown } | null;
  const ok =
    d !== null &&
    typeof d === "object" &&
    d.format === recordFormat &&
    Array.isArray(d.rows) &&
    (d.rows as Array<Record<string, unknown> | null>).every((r) => r !== null && typeof r.claim === "string" && (r.dialect === "ch" || r.dialect === "pg") && typeof r.recorded === "string");
  if (!ok) throw new Error(`${file} is not a claims record of format ${String(recordFormat)}; move it aside or name another file`);
  return d as ClaimsRecord;
}

/**
 * The record after a run: `fresh` rows replace the same claim and dialect
 * in `old`, the rest of `old` is kept, and rows are put in `order` (each
 * claim's name and dialects), dropping any `order` does not list.
 */
export function mergeRecord(old: ClaimsRecord | undefined, fresh: RecordRow[], order: ReadonlyArray<{ name: string; dialects: readonly Dialect[] }>, stamp: Stamp): ClaimsRecord {
  const byKey = new Map<string, RecordRow>();
  const k = (r: { claim: string; dialect: string }) => `${r.claim}:${r.dialect}`;
  for (const r of old?.rows ?? []) byKey.set(k(r), r);
  for (const r of fresh) byKey.set(k(r), r);
  const rows: RecordRow[] = [];
  for (const c of order) {
    for (const d of c.dialects) {
      const r = byKey.get(k({ claim: c.name, dialect: d }));
      if (r) rows.push(r);
    }
  }
  return { format: recordFormat, ...stamp, rows };
}
