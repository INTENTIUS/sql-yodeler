/**
 * The audit log in chant's format (#385): each entry `deriveAudit` gives
 * (`./audit.ts`) as a `chant.audit/v1` line, by chant's own `readAuditLine`
 * (`@intentius/chant/report-store`). chant owns the mapping, so a reader that
 * understands chant's line (behold) reads every line yodel writes the same
 * way, and `toProductAuditLine` gives the entry back as derived: nothing the
 * entry says is lost.
 *
 * The line's `kind` is chant's word (`approved`, `override-recorded`,
 * `applied`, `refused`, `recorded`, ...) and `product_kind` keeps yodel's own
 * (`silenced`, `failed`, `repaired`, `step`, `wave-run`, `spent`, `override`).
 */

import { readAuditLine, toProductAuditLine, type AuditLine } from "@intentius/chant/report-store";
import type { AuditEntry } from "./audit.js";

export type { AuditLine };

/** The product named in every line yodel writes. */
export const AUDIT_PRODUCT = "sql-yodeler";

/** One derived entry as `chant.audit/v1`. `project` is the project directory, as in the report. */
export function toAuditLine(entry: AuditEntry, project: string): AuditLine {
  const line = readAuditLine(entry, { product: AUDIT_PRODUCT, project });
  if (!line) throw new Error(`audit entry ${entry.id} is not a line chant reads`);
  return line;
}

export function toAuditLines(entries: readonly AuditEntry[], project: string): AuditLine[] {
  return entries.map((e) => toAuditLine(e, project));
}

/** A line, of either format, as the entry yodel derived it. */
export function toAuditEntry(line: AuditLine): AuditEntry {
  return toProductAuditLine(line, "sql-yodeler") as unknown as AuditEntry;
}
